/**
 * What a failed provider attempt means: the usage-event failure class, whether the same provider
 * is worth retrying, how long to back off or demote it, which error represents a failed chain,
 * and the user-safe message of an AI error. Pure functions of the thrown error — no I/O.
 */

import OpenAI from 'openai';
import type { AiUsageErrorClass } from '../../../database/repositories/ai-usage-events.repository';
import {
  EmptyProviderResponseError,
  errorCode,
  errorStatus,
  errorText,
  isAbortLike,
  isConnectionLike,
  isExhaustedChainError,
  isProviderDown,
  numericStatus,
} from './error-signals';

/**
 * An out-of-credits / exhausted-quota answer, as opposed to a plain per-minute rate limit. z.ai
 * answers 429 "Weekly/Monthly Limit Exhausted. Your limit will reset at …" (live, 2026-10-23).
 */
const QUOTA_TEXT = /quota|credit|usage limit|limit exhausted|will reset/i;

export interface AttemptFailure {
  errorClass: AiUsageErrorClass;
  /** HTTP status when the provider answered with one. */
  httpStatus: number | null;
}

/** Statuses whose failure class does not depend on the message. */
const FIXED_STATUS_CLASSES: ReadonlyMap<number, AiUsageErrorClass> = new Map([
  [402, 'quota'],
  [401, 'auth'],
  [403, 'auth'],
  [408, 'timeout'],
]);

/** Failure class of an answer that carried an HTTP status. */
function classifyHttpStatus(status: number, error: unknown): AiUsageErrorClass {
  const fixed = FIXED_STATUS_CLASSES.get(status);
  if (fixed) return fixed;
  if (status === 429 || status === 400) {
    if (QUOTA_TEXT.test(errorText(error))) return 'quota';
    return status === 429 ? 'rate_limit' : 'bad_request';
  }
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'other';
}

/** Failure class of an error with no HTTP status: a timeout, an abort or a connection failure. */
function classifyStatuslessFailure(error: unknown): AiUsageErrorClass {
  if (
    error instanceof OpenAI.APIConnectionTimeoutError ||
    errorCode(error) === 'ETIMEDOUT' ||
    /timed out|timeout/i.test(errorText(error))
  ) {
    return 'timeout';
  }
  if (isAbortLike(error)) return 'aborted';
  if (isConnectionLike(error)) return 'server';
  return 'other';
}

/**
 * Failure class of one provider attempt, from the SDK error's status, code and name. Only the
 * class and status are kept — never the provider's error body. `callerAborted` (the caller's
 * overall deadline) and `providerTimedOut` (this slot's own timer) take precedence over the error
 * shape: both surface as the same APIUserAbortError. A status-less connection failure is `server`
 * (provider unreachable), matching classifyAiError's provider_down.
 */
export function classifyAttemptFailure(
  error: unknown,
  signals: { callerAborted: boolean; providerTimedOut: boolean },
): AttemptFailure {
  const status = numericStatus(error);
  const failure = (errorClass: AiUsageErrorClass): AttemptFailure => ({
    errorClass,
    httpStatus: status ?? null,
  });

  if (signals.callerAborted) return failure('aborted');
  if (signals.providerTimedOut) return failure('timeout');
  if (error instanceof EmptyProviderResponseError) return failure('empty');
  if (status !== undefined) return failure(classifyHttpStatus(status, error));
  return failure(classifyStatuslessFailure(error));
}

/**
 * Retryable for same-provider retry (backoff): 429, 5xx, timeout, abort.
 * NOT used for cross-provider fallback — the chain always tries the next provider.
 * Status is read structurally so the aggregate chain error (a plain `Error` with a copied transient
 * `status`) stays retryable — otherwise a chain that ends in 5xx/429 would silently lose its retry.
 */
export function isRetryableError(error: unknown): boolean {
  if (isProviderDown(error)) return true;
  if (numericStatus(error) === 429) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  // OpenAI SDK v6: APIUserAbortError extends APIError with status=undefined —
  // catches abort errors that don't set .name to 'AbortError'.
  if (error instanceof OpenAI.APIError && error.status === undefined) return true;
  return false;
}

function readErrorHeader(error: unknown, name: string): string | undefined {
  const headers = (error as { headers?: unknown } | null | undefined)?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const maybeGet = (headers as { get?: (key: string) => string | null }).get;
  if (typeof maybeGet === 'function') {
    return maybeGet.call(headers, name) ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

/** Exponential backoff: 2s → 6s → 18s capped at 30s. 429 uses Retry-After if present. */
export function getBackoffDelay(attempt: number, error: unknown): number {
  if (numericStatus(error) === 429) {
    const retryAfter = readErrorHeader(error, 'retry-after');
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter);
      if (!Number.isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
    }
    return 5000;
  }
  return Math.min(2000 * 3 ** attempt, 30_000);
}

/** The reset instant named by an ISO timestamp in a quota/limit message, or undefined. */
function quotaResetAt(text: string): number | undefined {
  if (!/reset|quota|limit/i.test(text)) return undefined;
  const iso = text.match(
    /20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/i,
  )?.[0];
  return iso ? Date.parse(iso) : undefined;
}

/**
 * Cooldown used to move a rate-limited provider to the back of subsequent chains.
 * Prefer Retry-After. For quota messages that include an ISO reset timestamp, honor that reset.
 * Otherwise use five minutes so a quota-limited head provider does not penalize every request.
 */
export function getRateLimitCooldownMs(error: unknown, now = Date.now()): number {
  const retryAfter = readErrorHeader(error, 'retry-after');
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return Math.max(1_000, seconds * 1000);
  }

  const resetAt = quotaResetAt(errorText(error));
  if (resetAt !== undefined && Number.isFinite(resetAt) && resetAt > now) {
    return Math.max(1_000, resetAt - now + 1_000);
  }

  return 5 * 60_000;
}

/** A 5xx response or, with no status at all, a connection failure: the provider is down, not the request. */
function isTransientFailure(error: Error): boolean {
  const status = numericStatus(error);
  return (
    (status !== undefined && status >= 500) || (status === undefined && isConnectionLike(error))
  );
}

/**
 * Pick the error whose status/code best represents an all-providers-failed chain. The aggregate
 * feeds BOTH the user-facing classifier (classifyAiError) and the retry decision (isRetryableError),
 * so a transient signal must win over a co-occurring 4xx — otherwise a chain where one provider 400s
 * and the rest 5xx would lose its retry. Priority:
 *   1. 429 (rate limit) / 529 (overloaded) — the most actionable, retryable signals.
 *   2. any other transient failure — a 5xx response or a connection error — → provider_down + retry.
 *   3. otherwise a 4xx response — the request itself is the problem (generic, not retryable).
 *   4. fallback (the last error) when nothing else matched.
 *
 * The resulting CATEGORY is independent of the order providers were tried (the breaker can reorder
 * the chain). The exact status WITHIN a tier follows try order — but every error in a tier maps to
 * the same classifyAiError/isRetryableError category, so the user-facing outcome is stable.
 */
export function pickRepresentativeError(errors: Error[], fallback: Error | null): Error | null {
  const rateLimited = errors.find((e) => numericStatus(e) === 429);
  if (rateLimited) return rateLimited;
  const overloaded = errors.find((e) => numericStatus(e) === 529);
  if (overloaded) return overloaded;

  const transient = errors.find(isTransientFailure);
  if (transient) return transient;

  const clientError = errors.find((e) => numericStatus(e) !== undefined);
  return clientError ?? fallback;
}

// ── Error classification (informative, user-safe) ────────────────────────────

/** User-facing Telegram messages per error class. Short, no internals, address user as "ты". */
const AI_ERROR_MESSAGES = {
  rateLimit: '⏳ Слишком много запросов к AI. Подожди минуту.',
  overloaded: '⚡ AI сервер перегружен. Попробуй позже.',
  timeout: '⏳ Время ожидания истекло. Попробуй ещё раз.',
  providerDown:
    '⚠️ AI временно недоступен (сбой на стороне провайдера). Уже разбираемся — попробуй через минуту.',
  generic: '❌ Ошибка AI. Попробуй позже.',
} as const;

/**
 * Error classes the agent surfaces to the user. `provider_down` covers connection/network
 * failures and 5xx from the providers (the whole chain is unreachable); `generic` is a
 * recognized-but-uncategorized API error; a null classification (see `classifyAiError`)
 * means "not an AI error" and the caller should rethrow.
 */
export type AiErrorKind = 'rate_limit' | 'overloaded' | 'timeout' | 'provider_down' | 'generic';

export interface AiErrorClassification {
  kind: AiErrorKind;
  /** Short, user-safe Telegram message (no stack, no IDs, no provider internals). */
  userMessage: string;
}

/**
 * Classify an error from the AI pipeline into a user-facing message.
 *
 * Returns `null` when the error is not recognizably an AI/network/timeout failure, so the
 * caller can rethrow it instead of masking an unrelated bug behind a generic AI message.
 *
 * Order matters: rate-limit/overloaded are checked by status first; a concrete non-429 4xx
 * is authoritative next (a request/client error — don't let an aggregate's text about an
 * earlier provider's connection blip mask it as an outage); then the agent-level abort
 * (60s timeout) is detected before connection failures so a timed-out chain reads as
 * "timeout" rather than "provider down". Aggregated "All N providers failed" errors are
 * thus classified by their real status/code/message (e.g. all-400 stays generic, not masked
 * as an outage), since the aggregate carries the last provider's status/code and the joined
 * messages. As a final floor, an exhausted-chain aggregate with NO classifiable signal — every
 * provider returned an empty body (a plain Error: no status, no abort, no connection match) — is
 * still `generic` rather than `null`, so the user gets a safe message and the admin a report
 * instead of the in-progress message silently vanishing on a rethrow.
 */
export function classifyAiError(error: unknown): AiErrorClassification | null {
  const status = errorStatus(error);
  if (status === 429) return { kind: 'rate_limit', userMessage: AI_ERROR_MESSAGES.rateLimit };
  if (status === 529) return { kind: 'overloaded', userMessage: AI_ERROR_MESSAGES.overloaded };
  if (status !== undefined && status >= 400 && status < 500) {
    return { kind: 'generic', userMessage: AI_ERROR_MESSAGES.generic };
  }
  if (isAbortLike(error)) return { kind: 'timeout', userMessage: AI_ERROR_MESSAGES.timeout };
  if (isConnectionLike(error) || (status !== undefined && status >= 500)) {
    return { kind: 'provider_down', userMessage: AI_ERROR_MESSAGES.providerDown };
  }
  if (status !== undefined) return { kind: 'generic', userMessage: AI_ERROR_MESSAGES.generic };
  if (isExhaustedChainError(error)) {
    return { kind: 'generic', userMessage: AI_ERROR_MESSAGES.generic };
  }
  return null;
}
