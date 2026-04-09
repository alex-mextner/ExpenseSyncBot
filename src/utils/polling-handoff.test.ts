// Tests for polling-handoff coordinator.
// Each test simulates a process with a clean module state via dynamic import.
// The module reads PORT_A/PORT_B/STATE_FILE from env at load time — must be set before import.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_FILE = join(tmpdir(), `test-handoff-${process.pid}`);
const PORT_A = 14311;
const PORT_B = 14312;

// Must be set before polling-handoff.ts is loaded (module reads these at evaluation time).
process.env['POLLING_HANDOFF_PORT_A'] = String(PORT_A);
process.env['POLLING_HANDOFF_PORT_B'] = String(PORT_B);
process.env['POLLING_HANDOFF_STATE'] = STATE_FILE;
process.env['POLLING_HANDOFF_TIMEOUT'] = '2000';

// Dynamic import so env vars are already set when the module is evaluated.
const { acquirePolling } = await import('./polling-handoff');

afterEach(() => {
  try {
    unlinkSync(STATE_FILE);
  } catch {
    // Already removed — ignore.
  }
});

describe('acquirePolling', () => {
  test('no prior state → acquires PORT_A and writes state file', async () => {
    const cleanup = await acquirePolling(async () => {});

    expect(existsSync(STATE_FILE)).toBe(true);
    expect(readFileSync(STATE_FILE, 'utf8').trim()).toBe(String(PORT_A));

    cleanup();
    expect(existsSync(STATE_FILE)).toBe(false);
  });

  test('prior PORT_A in state file → signals old server, acquires PORT_B', async () => {
    let onStopCalled = false;

    // Simulate old instance: a real handoff server on PORT_A.
    const oldServer = Bun.serve({
      port: PORT_A,
      fetch: async () => {
        onStopCalled = true;
        return new Response('OK');
      },
    });
    writeFileSync(STATE_FILE, String(PORT_A));

    try {
      const cleanup = await acquirePolling(async () => {});

      expect(onStopCalled).toBe(true);
      expect(readFileSync(STATE_FILE, 'utf8').trim()).toBe(String(PORT_B));

      cleanup();
    } finally {
      oldServer.stop(true);
    }
  });

  test('stale state file (server not listening) → skips handoff, acquires PORT_B', async () => {
    // Write stale state without actually starting a server — connection will be refused.
    writeFileSync(STATE_FILE, String(PORT_A));

    const cleanup = await acquirePolling(async () => {});

    expect(existsSync(STATE_FILE)).toBe(true);
    expect(readFileSync(STATE_FILE, 'utf8').trim()).toBe(String(PORT_B));

    cleanup();
  });

  test('prior PORT_B in state file → acquires PORT_A', async () => {
    // Simulate old instance on PORT_B.
    const oldServer = Bun.serve({
      port: PORT_B,
      fetch: async () => new Response('OK'),
    });
    writeFileSync(STATE_FILE, String(PORT_B));

    try {
      const cleanup = await acquirePolling(async () => {});

      expect(readFileSync(STATE_FILE, 'utf8').trim()).toBe(String(PORT_A));

      cleanup();
    } finally {
      oldServer.stop(true);
    }
  });

  test('new instance waits for old onStop to complete before proceeding', async () => {
    const events: string[] = [];

    // Simulate old instance's handoff server: runs a slow onStop before responding 200.
    // The protocol guarantees 200 is only sent after onStop() completes.
    const oldServer = Bun.serve({
      port: PORT_A,
      fetch: async () => {
        await Bun.sleep(50); // Simulate bot.stop() latency.
        events.push('old-stopped');
        return new Response('OK');
      },
    });
    writeFileSync(STATE_FILE, String(PORT_A));

    try {
      const cleanup = await acquirePolling(async () => {});
      events.push('new-ready');

      // acquirePolling must have blocked on the HTTP response, so old-stopped comes first.
      expect(events).toEqual(['old-stopped', 'new-ready']);

      cleanup();
    } finally {
      oldServer.stop(true);
    }
  });

  test('cleanup is idempotent — safe to call twice', async () => {
    const cleanup = await acquirePolling(async () => {});
    cleanup();
    expect(() => cleanup()).not.toThrow();
  });
});
