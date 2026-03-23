/**
 * GramIO hooks for Telegram API rate limiting.
 * preRequest: per-chat throttle + global backoff sleep.
 * onResponseError: captures 429 and sets global backoff for retry_after seconds.
 */
import type { Hooks } from 'gramio';
import { createLogger } from '../utils/logger.ts';

const logger = createLogger('rate-limit');

/** Timestamp until which ALL outgoing API calls must wait */
let backoffUntil = 0;

/** Per-chat last API call timestamps — prevents burst-spamming a single chat */
const chatLastSend = new Map<number | string, number>();

/** Minimum interval between API calls to the same chat (ms) */
const PER_CHAT_INTERVAL_MS = 200;

/** Max entries in chatLastSend before cleanup runs */
const CHAT_MAP_CLEANUP_THRESHOLD = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * preRequest hook — registered before all other hooks.
 * 1. If a 429 backoff is active, delays until it expires.
 * 2. Per-chat throttle: ensures at least PER_CHAT_INTERVAL_MS between calls.
 */
export const rateLimitPreRequest: Hooks.PreRequest = async (ctx) => {
  // Global 429 backoff
  const remaining = backoffUntil - Date.now();
  if (remaining > 0) {
    logger.warn(`[RATE-LIMIT] Backoff active, waiting ${remaining}ms before ${ctx.method}`);
    await sleep(remaining);
  }

  // Per-chat throttle
  const params = ctx.params as { chat_id?: number | string } | undefined;
  const chatId = params?.chat_id;
  if (chatId !== undefined) {
    const lastSend = chatLastSend.get(chatId) ?? 0;
    const elapsed = Date.now() - lastSend;
    if (elapsed < PER_CHAT_INTERVAL_MS) {
      await sleep(PER_CHAT_INTERVAL_MS - elapsed);
    }
    chatLastSend.set(chatId, Date.now());

    // Prevent unbounded Map growth
    if (chatLastSend.size > CHAT_MAP_CLEANUP_THRESHOLD) {
      const cutoff = Date.now() - 60_000;
      for (const [key, time] of chatLastSend) {
        if (time < cutoff) chatLastSend.delete(key);
      }
    }
  }

  return ctx;
};

/**
 * onResponseError hook — fires after Telegram returns an error.
 * On 429, sets global backoff so subsequent calls wait.
 */
export const rateLimitOnResponseError: Hooks.OnResponseError = (err) => {
  if (err.code === 429) {
    const retryAfter = err.payload?.retry_after ?? 5;
    const until = Date.now() + retryAfter * 1000;
    // Only extend backoff, never shorten it (concurrent 429s may arrive)
    if (until > backoffUntil) {
      backoffUntil = until;
    }
    logger.error(`[RATE-LIMIT] 429 from ${err.method}, backoff ${retryAfter}s`);
  }
};

/** Reset all state — exposed for testing */
export function resetRateLimitState(): void {
  backoffUntil = 0;
  chatLastSend.clear();
}

/** Get current backoff — exposed for testing */
export function getBackoffUntil(): number {
  return backoffUntil;
}
