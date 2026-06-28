// Sends a detailed, throttled report to the bot admin when the AI agent hits a terminal
// failure. The user only sees a short classified message (see classifyAiError); this is where
// the operator gets the group, the request, the provider-chain failure summary, and the stack.
// Reached from ExpenseBotAgent's terminal catch as fire-and-forget — it never throws.

import { env } from '../../config/env';
import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';
import { sendDirect } from '../bank/telegram-sender';

const logger = createLogger('ai-error-reporter');

/** After a delivered alert, stay quiet for the same failure signature this long. */
const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
/**
 * After a FAILED send (Telegram blip), allow a retry this soon — short enough that a real
 * outage isn't hidden for the full window, long enough that repeated AI failures don't hammer
 * a down Telegram on every single one.
 */
const FAILED_SEND_RETRY_MS = 60 * 1000;
const USER_MESSAGE_MAX = 400;
const PROVIDER_SUMMARY_MAX = 700;
const STACK_MAX = 1200;

/**
 * signature → earliest epoch ms a new send is allowed. In-memory; a process restart resets it
 * (acceptable). Intentionally GLOBAL, not per-group: when a provider is down it fails for every
 * group, and the operator wants ONE "smart chain is down" alert — not one per group (which would
 * be the spam this throttle exists to prevent). The signature is keyed by failure class, not group.
 */
const nextAllowedAt = new Map<string, number>();

/** Test-only: clear the throttle state so each test case starts from a clean slate. */
export function resetAiFailureThrottle(): void {
  nextAllowedAt.clear();
}

export interface AiFailureContext {
  /** Internal DB group id (used to resolve the human-readable title). */
  groupId: number;
  /** Telegram group id — always shown so the operator can locate the chat. */
  telegramGroupId: number;
  /** The user message that triggered the AI run (truncated in the report). */
  userMessage: string;
  /** The terminal error surfaced from the agent. */
  error: unknown;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const value = (error as { status?: unknown }).status;
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/**
 * Group failures so a single dead provider doesn't spam the admin: prefer the provider-chain
 * name from the aggregated "All N providers in <chain> chain failed" message; otherwise key on
 * the error name plus its status/code so distinct error classes (429 vs 500 vs ECONNREFUSED)
 * don't suppress each other.
 */
function failureSignature(error: unknown): string {
  const status = errorStatus(error) ?? '';
  const code = errorCode(error) ?? '';
  const chain = /in (\w+) chain failed/i.exec(errorMessage(error))?.[1];
  // Include status/code so distinct incidents on the same chain (429 vs 500 vs a network
  // error) aren't collapsed into one throttle bucket.
  if (chain) return `chain:${chain}:${status}:${code}`;
  return `err:${errorName(error)}:${status}:${code}`;
}

/** Pure check — true when this signature is still inside its throttle window. */
function isThrottled(signature: string, now: number): boolean {
  const next = nextAllowedAt.get(signature);
  return next !== undefined && now < next;
}

const NAME_MAX = 80;

/**
 * Make untrusted text safe inside the HTML report. A plain escapeHtml() would be UNDONE here:
 * the outgoing-HTML sanitizer (sanitizeHtmlForTelegram) decodes entities and restores whitelisted
 * tags, so a user's `<b>` / `<a href>` would become real markup in the admin alert. So neutralize
 * angle brackets to look-alikes (no tag can form) and escape `&` (idempotent through the sanitizer).
 */
function neutralizeHtml(raw: string): string {
  return raw.replace(/</g, '‹').replace(/>/g, '›').replace(/&/g, '&amp;');
}

/** Cap to `max` chars, dropping a trailing half-written `&entity;` so the HTML stays valid. */
function capSafe(safe: string, max: number): string {
  if (safe.length <= max) return safe;
  let cut = safe.slice(0, max);
  // Don't split a UTF-16 surrogate pair (would leave a stray replacement char before the …).
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  const lastAmp = cut.lastIndexOf('&');
  if (lastAmp !== -1 && !cut.slice(lastAmp).includes(';')) cut = cut.slice(0, lastAmp);
  return `${cut}…`;
}

/**
 * Inline (single-line) field: neutralize HTML and collapse newlines so user content can't inject
 * fake `\n`-delimited report lines (e.g. a spoofed "Провайдеры:" / "Ошибка:" line), then cap.
 */
function clip(raw: string, max: number): string {
  return capSafe(neutralizeHtml(raw).replace(/[\r\n]+/g, ' '), max);
}

/** Multi-line block (a stack trace shown inside `<pre>`): keep newlines, just neutralize + cap. */
function clipBlock(raw: string, max: number): string {
  return capSafe(neutralizeHtml(raw), max);
}

function groupLabel(groupId: number, telegramGroupId: number): string {
  const title = database.groups.findById(groupId)?.title;
  const safeTitle = title ? `${clip(title, NAME_MAX)} ` : '';
  return `${safeTitle}(<code>${telegramGroupId}</code>)`;
}

function buildReport(input: AiFailureContext, now: number): string {
  const { error } = input;
  const status = errorStatus(error);
  const statusSuffix = status !== undefined ? ` (status ${status})` : '';
  const stack = error instanceof Error && error.stack ? error.stack : errorMessage(error);

  return [
    '🚨 <b>AI failure</b>',
    `Группа: ${groupLabel(input.groupId, input.telegramGroupId)}`,
    `Запрос: ${clip(input.userMessage, USER_MESSAGE_MAX)}`,
    `Провайдеры: ${clip(errorMessage(error), PROVIDER_SUMMARY_MAX)}`,
    `Ошибка: <code>${clip(errorName(error), NAME_MAX)}${statusSuffix}</code>`,
    `<pre>${clipBlock(stack, STACK_MAX)}</pre>`,
    `<i>${new Date(now).toISOString()}</i>`,
  ].join('\n');
}

/**
 * Fire-and-forget admin report. No-op when BOT_ADMIN_CHAT_ID is unset; throttled per failure
 * signature; never throws (a send failure is swallowed and logged). `now` is injectable so the
 * throttle is deterministic in tests — the throttle logic never calls Date.now() itself.
 */
export async function reportAiFailureToAdmin(
  input: AiFailureContext,
  now: number = Date.now(),
): Promise<void> {
  const adminChatId = env.BOT_ADMIN_CHAT_ID;
  if (!adminChatId) return;

  const signature = failureSignature(input.error);
  if (isThrottled(signature, now)) {
    logger.debug({ signature }, '[AI_REPORT] throttled duplicate admin alert');
    return;
  }
  // Reserve the full window synchronously BEFORE awaiting the send. In JS's single-threaded
  // model the check-and-set is atomic, so a burst of identical failures (a provider dying for
  // many groups at once) collapses to one alert instead of every concurrent call racing past
  // the check and sending its own.
  const reservedUntil = now + THROTTLE_WINDOW_MS;
  nextAllowedAt.set(signature, reservedUntil);

  try {
    const sent = await sendDirect(adminChatId, buildReport(input, now));
    // Didn't land → shorten our reservation to a quick-retry floor: a Telegram blip neither
    // suppresses the next real alert for the full window NOR lets every subsequent failure
    // hammer a down Telegram. The `=== reservedUntil` guard avoids clobbering a newer reserve.
    if (!sent && nextAllowedAt.get(signature) === reservedUntil) {
      nextAllowedAt.set(signature, now + FAILED_SEND_RETRY_MS);
    }
  } catch (sendError) {
    if (nextAllowedAt.get(signature) === reservedUntil) {
      nextAllowedAt.set(signature, now + FAILED_SEND_RETRY_MS);
    }
    logger.error({ err: sendError }, '[AI_REPORT] failed to send admin failure report');
  }
}
