import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from './logger';

/**
 * Polling handoff coordinator for blue-green deploys.
 *
 * Problem: getUpdates (long polling) allows only ONE active caller per bot token.
 * Two simultaneous callers → Telegram 409 Conflict.
 *
 * Solution: two alternating handoff ports (PORT_A / PORT_B).
 * The active poller listens on one; the incoming instance signals it to stop,
 * then takes the other port. They never collide.
 *
 * Protocol:
 *   1. New instance reads STATE_FILE → finds active port of running poller.
 *   2. POSTs /handoff to that port → running poller calls onStop() → responds 200.
 *   3. New instance starts its own handoff server on the alternate port.
 *   4. New instance writes its port to STATE_FILE.
 *   5. New instance starts polling.
 *
 * On process exit (or SIGINT/SIGTERM), call the returned cleanup() to release the port.
 *
 * Configuration (env vars, all optional):
 *   POLLING_HANDOFF_PORT_A  — first handoff port  (default: 4311)
 *   POLLING_HANDOFF_PORT_B  — second handoff port (default: 4312)
 *   POLLING_HANDOFF_STATE   — state file path      (default: /tmp/esb-handoff-port)
 *   POLLING_HANDOFF_TIMEOUT — ms to wait for old instance to stop (default: 8000)
 */

const PORT_A = Number(process.env['POLLING_HANDOFF_PORT_A'] ?? 4311);
const PORT_B = Number(process.env['POLLING_HANDOFF_PORT_B'] ?? 4312);
const STATE_FILE = process.env['POLLING_HANDOFF_STATE'] ?? '/tmp/esb-handoff-port';
const SIGNAL_TIMEOUT_MS = Number(process.env['POLLING_HANDOFF_TIMEOUT'] ?? 8_000);

const logger = createLogger('polling-handoff');

let handoffServer: ReturnType<typeof Bun.serve> | null = null;

/**
 * Acquires the polling token for this instance.
 *
 * Must be called BEFORE bot.start(). Blocks until the previous instance has
 * acknowledged the handoff (or until SIGNAL_TIMEOUT_MS if no instance is running).
 *
 * @param onStop  Called when a future instance signals us to stop.
 *                Must stop polling (e.g. await bot.stop()) before returning —
 *                the caller blocks on our response until we return here.
 * @returns cleanup  Call on graceful shutdown to release the handoff port.
 */
export async function acquirePolling(onStop: () => Promise<void>): Promise<() => void> {
  const otherPort = readActivePort();

  // Signal the currently running poller to stop (if any).
  if (otherPort !== null) {
    try {
      const res = await fetch(`http://localhost:${otherPort}/handoff`, {
        method: 'POST',
        signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn(
          { status: res.status, port: otherPort },
          '[polling-handoff] Unexpected handoff response',
        );
      }
      // Old instance has stopped polling — it returned 200 only after onStop() completed.
    } catch {
      // Connection refused or timeout: old instance is already gone. Proceed.
    }
  }

  // Choose the alternate port so we never collide with the (still-exiting) old process.
  const myPort = otherPort === PORT_A ? PORT_B : PORT_A;

  // Start our own handoff listener for the next deploy.
  handoffServer = Bun.serve({
    port: myPort,
    fetch: async (_req) => {
      // A new instance is taking over. Stop polling, then return 200.
      // The caller (new instance) is blocked waiting for this response.
      await onStop();
      return new Response('OK');
    },
  });

  // Persist our port so the next instance knows where to signal us.
  writeActivePort(myPort);

  return function cleanup() {
    handoffServer?.stop(true);
    handoffServer = null;
    try {
      unlinkSync(STATE_FILE);
    } catch {
      // Already removed or never written — ignore.
    }
  };
}

function readActivePort(): number | null {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8').trim();
    const port = parseInt(raw, 10);
    return Number.isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

function writeActivePort(port: number): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, String(port));
}
