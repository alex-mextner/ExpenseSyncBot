/**
 * Low-level readers of a thrown provider error: status, code, message, and the abort /
 * connection / provider-down questions every failure policy asks. Split from streaming.ts so the
 * attempt classifier, retry policy, breaker feedback and user-facing classifier share one
 * definition of each signal.
 */

import OpenAI from 'openai';

const NETWORK_ERROR_CODES = ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND'];

export function numericStatus(error: unknown): number | undefined {
  // Optional chain: isProviderDown/isRetryableError call this on `unknown`, which may be a thrown
  // null/undefined/primitive — those must classify as not-retryable, never throw a TypeError.
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

export function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const value = (error as { status?: unknown }).status;
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
}

export function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build an Error classified as an abort. A plain Error with name='AbortError'
 * (not a DOMException) so upstream `error.name === 'AbortError'` checks match
 * the existing convention and the timeout user message fires.
 */
export function makeAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** A provider answered 200 but produced no text and no tool call (z.ai reasoning-only replies, a refusal). */
export class EmptyProviderResponseError extends Error {
  constructor(slotName: string) {
    super(
      `Provider ${slotName} returned empty response (no text, no tool calls) — treating as failure`,
    );
    this.name = 'EmptyProviderResponseError';
  }
}

// Internal tag: marks a thrown stream error as "the provider had already emitted output (text or a
// tool-call chunk) before failing" — i.e. it was reachable. A Symbol keeps it off any real error
// shape so it never collides with status/code/message.
const PROVIDER_RESPONDED: unique symbol = Symbol('providerResponded');
interface RespondedTag {
  [PROVIDER_RESPONDED]?: boolean;
}

export function markProviderResponded(error: unknown, responded: boolean): void {
  if (responded && error && typeof error === 'object') {
    (error as RespondedTag)[PROVIDER_RESPONDED] = true;
  }
}

export function providerResponded(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as RespondedTag)[PROVIDER_RESPONDED]);
}

/** The agent's abort timer fired (or a user/SDK abort) — distinct from a provider being down. */
// INVARIANT (the provider breaker depends on this): this must distinguish APIUserAbortError (an
// abort → skip the breaker) from APIConnectionError (a real outage → must demote). Both are
// `APIError` with `status === undefined`, so the match is by name/message ("aborted"), NEVER by
// `status === undefined` — broadening it that way would silently stop demoting real connection
// outages, the main case the breaker exists for.
export function isAbortLike(error: unknown): boolean {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'APIUserAbortError')
  ) {
    return true;
  }
  return /\baborted\b|was aborted|operation was aborted/i.test(errorText(error));
}

/** Connection/network failure to a provider (includes the z.ai "Connection error." case). */
export function isConnectionLike(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true;
  const code = errorCode(error);
  if (code && NETWORK_ERROR_CODES.includes(code)) return true;
  return /connection error|connection refused|network error|fetch failed|socket hang up|timed out|econnreset|econnrefused|enotfound|enetunreach|etimedout/i.test(
    errorText(error),
  );
}

/**
 * Provider-down: 5xx or a connection/network failure. Means "try next", retrying same provider is
 * hopeless. A DEFINED status is authoritative (only >= 500 is down) — a concrete 4xx is a client
 * error and stays non-retryable even if its message mentions "connection"/"timed out", matching
 * classifyAiError (which keeps a non-429 4xx generic). Only a STATUS-LESS error falls through to
 * isConnectionLike (code/message), so an `APIConnectionError` outage aggregate (no status, joined
 * "Connection error" message) is still recognised. (429 retryability is handled by isRetryableError.)
 */
export function isProviderDown(error: unknown): boolean {
  const status = numericStatus(error);
  if (status !== undefined) return status >= 500;
  return isConnectionLike(error);
}

/**
 * Breaker-specific: only a STATUS-less connection error is a true "provider unreachable" event.
 * A 4xx/5xx response — even one whose message happens to mention "connection" / "timed out" — means
 * the provider WAS reachable, so it must not demote it (isConnectionLike also matches by message and
 * would otherwise count such responses).
 */
export function isUnreachableFailure(error: unknown): boolean {
  if (numericStatus(error) !== undefined) return false;
  return isConnectionLike(error);
}

/**
 * The "All N providers in <chain> chain failed: …" aggregate thrown by aiStreamRound once every
 * provider in the chain has failed. That exact prefix is produced ONLY there, so matching it can't
 * swallow an unrelated non-AI error (a bug elsewhere never carries this message). Used as a final
 * floor in classifyAiError: an exhausted chain is, by construction, always an AI failure.
 */
export function isExhaustedChainError(error: unknown): boolean {
  return /^All \d+ providers? in \w+ chain failed/.test(errorText(error));
}
