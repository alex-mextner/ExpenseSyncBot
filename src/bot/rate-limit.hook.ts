/**
 * GramIO hooks for Telegram API rate limiting.
 * preRequest: sleeps through global backoff set by a previous 429.
 * onResponseError: captures 429 and sets global backoff for retry_after seconds.
 */
import type { Hooks } from 'gramio';
import { createLogger } from '../utils/logger.ts';

const logger = createLogger('rate-limit');

/** Timestamp until which ALL outgoing API calls must wait */
let backoffUntil = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * preRequest hook — registered before all other hooks.
 * If a 429 backoff is active, delays the API call until it expires.
 */
export const rateLimitPreRequest: Hooks.PreRequest = async (ctx) => {
  const remaining = backoffUntil - Date.now();
  if (remaining > 0) {
    logger.warn(`[RATE-LIMIT] Backoff active, waiting ${remaining}ms before ${ctx.method}`);
    await sleep(remaining);
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

/** Reset backoff — exposed for testing */
export function resetRateLimitState(): void {
  backoffUntil = 0;
}

/** Get current backoff — exposed for testing */
export function getBackoffUntil(): number {
  return backoffUntil;
}
