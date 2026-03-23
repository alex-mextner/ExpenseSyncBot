// Tests for the universal Telegram API rate limiter hooks
import { afterEach, describe, expect, test } from 'bun:test';
import { TelegramError } from 'gramio';
import {
  getBackoffUntil,
  rateLimitOnResponseError,
  rateLimitPreRequest,
  resetRateLimitState,
} from './rate-limit.hook';

afterEach(() => {
  resetRateLimitState();
});

/**
 * Helper to construct TelegramError instances.
 */
function makeTelegramError(
  description: string,
  errorCode: number,
  method: string,
  parameters: { retry_after?: number } = {},
): TelegramError<'sendMessage'> {
  return new TelegramError(
    { ok: false as const, description, error_code: errorCode, parameters },
    // biome-ignore lint/suspicious/noExplicitAny: test stub — generic method type
    method as any,
    // biome-ignore lint/suspicious/noExplicitAny: test stub — full API params not needed
    {} as any,
  );
}

/** Call the onResponseError hook with a fake api object (second arg is unused) */
function fireOnResponseError(err: TelegramError<'sendMessage'>): void {
  // biome-ignore lint/suspicious/noExplicitAny: test stub — api object not used by hook
  (rateLimitOnResponseError as (err: TelegramError<'sendMessage'>, api: any) => void)(err, {});
}

describe('rateLimitOnResponseError', () => {
  test('sets backoff on 429 error', () => {
    const err = makeTelegramError('Too Many Requests: retry after 5', 429, 'editMessageText', {
      retry_after: 5,
    });
    fireOnResponseError(err);

    const backoff = getBackoffUntil();
    // Backoff should be ~5 seconds from now
    expect(backoff).toBeGreaterThan(Date.now() + 4000);
    expect(backoff).toBeLessThanOrEqual(Date.now() + 6000);
  });

  test('ignores non-429 errors', () => {
    const err = makeTelegramError('Bad Request: chat not found', 400, 'sendMessage');
    fireOnResponseError(err);

    expect(getBackoffUntil()).toBe(0);
  });

  test('extends backoff but never shortens it', () => {
    // First 429: retry_after 10
    const err1 = makeTelegramError('Too Many Requests: retry after 10', 429, 'sendMessage', {
      retry_after: 10,
    });
    fireOnResponseError(err1);
    const firstBackoff = getBackoffUntil();

    // Second 429: retry_after 3 (shorter) — should NOT shorten
    const err2 = makeTelegramError('Too Many Requests: retry after 3', 429, 'editMessageText', {
      retry_after: 3,
    });
    fireOnResponseError(err2);

    expect(getBackoffUntil()).toBe(firstBackoff);
  });

  test('defaults to 5s when retry_after is missing', () => {
    const err = makeTelegramError('Too Many Requests', 429, 'sendMessage');
    fireOnResponseError(err);

    const backoff = getBackoffUntil();
    expect(backoff).toBeGreaterThan(Date.now() + 3000);
    expect(backoff).toBeLessThanOrEqual(Date.now() + 6000);
  });
});

describe('rateLimitPreRequest', () => {
  test('passes through immediately when no backoff is active', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub — simplified preRequest context
    const ctx = { method: 'sendMessage', params: { chat_id: 123, text: 'hi' } } as any;
    const start = Date.now();
    const result = await rateLimitPreRequest(ctx);
    const elapsed = Date.now() - start;

    expect(result).toBe(ctx);
    expect(elapsed).toBeLessThan(50);
  });

  test('sleeps through active backoff', async () => {
    // Use minimal retry_after (1s) for fast test
    const err = makeTelegramError('Too Many Requests: retry after 1', 429, 'sendMessage', {
      retry_after: 1,
    });
    fireOnResponseError(err);

    // biome-ignore lint/suspicious/noExplicitAny: test stub — simplified preRequest context
    const ctx = { method: 'sendMessage', params: { chat_id: 123, text: 'hi' } } as any;
    const start = Date.now();
    const result = await rateLimitPreRequest(ctx);
    const elapsed = Date.now() - start;

    expect(result).toBe(ctx);
    // Should have waited ~1 second (retry_after: 1)
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2000);
  });

  test('does not modify context params', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub — simplified preRequest context
    const ctx = { method: 'sendMessage', params: { chat_id: 123, text: 'original' } } as any;
    const result = await rateLimitPreRequest(ctx);

    // biome-ignore lint/suspicious/noExplicitAny: accessing test stub params
    expect((result.params as any).text).toBe('original');
  });
});

// ── Per-chat throttle ───────────────────────────────────────────────

describe('per-chat throttle', () => {
  test('second call to same chat is delayed by PER_CHAT_INTERVAL_MS', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx1 = { method: 'sendMessage', params: { chat_id: 42, text: 'a' } } as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx2 = { method: 'editMessageText', params: { chat_id: 42, text: 'b' } } as any;

    await rateLimitPreRequest(ctx1);
    const start = Date.now();
    await rateLimitPreRequest(ctx2);
    const elapsed = Date.now() - start;

    // Should wait ~200ms (PER_CHAT_INTERVAL_MS)
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(400);
  });

  test('calls to different chats are not delayed', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx1 = { method: 'sendMessage', params: { chat_id: 100, text: 'a' } } as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx2 = { method: 'sendMessage', params: { chat_id: 200, text: 'b' } } as any;

    await rateLimitPreRequest(ctx1);
    const start = Date.now();
    await rateLimitPreRequest(ctx2);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  test('calls without chat_id are not throttled', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx1 = { method: 'getMe', params: {} } as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx2 = { method: 'getMe', params: {} } as any;

    await rateLimitPreRequest(ctx1);
    const start = Date.now();
    await rateLimitPreRequest(ctx2);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });
});
