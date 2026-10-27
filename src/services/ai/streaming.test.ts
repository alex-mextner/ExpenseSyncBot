// Tests for the pure policy of AI streaming: request params, retry/backoff/cooldown decisions, the
// representative error of a failed chain, think-tag stripping and the user-facing error classes.
// The provider fallback chain is pinned in streaming.chains / requests / fallback / breaker tests.

import { beforeEach, describe, expect, it } from 'bun:test';
import OpenAI from 'openai';
import { streamingModule } from './streaming.test-support';

const {
  CLAUDE_THINKING_RESERVE_TOKENS,
  chatRequestParams,
  classifyAiError,
  claudeRequestParams,
  getBackoffDelay,
  getRateLimitCooldownMs,
  isRetryableError,
  pickRepresentativeError,
} = streamingModule;

describe('claudeRequestParams', () => {
  // Anthropic's OpenAI-compat endpoint ignores reasoning_effort (measured 2026-10-10, #146), so it
  // is never sent; thinking spends the same max_tokens budget as the visible answer, hence the reserve.
  it.each([
    'claude-sonnet-5-5',
    'claude-sonnet-5-5-20261001',
    'claude-opus-5-5',
    'claude-fable-5-1',
    // Legacy and unlisted IDs (#144): a config swap must still get the safe thinking-on shape.
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-unlisted-9-9',
  ])('%s keeps thinking on with a reserve on top of the caller budget', (model) => {
    expect(claudeRequestParams(model, 200)).toEqual({
      max_tokens: 200 + CLAUDE_THINKING_RESERVE_TOKENS,
    });
  });

  it.each([
    'claude-haiku-5-5',
    'claude-haiku-4-5-20251001',
  ])('%s runs with thinking disabled and the caller budget unchanged', (model) => {
    expect(claudeRequestParams(model, 200)).toEqual({
      thinking: { type: 'disabled' },
      max_tokens: 200,
    });
  });
});

describe('chatRequestParams', () => {
  it('builds the Claude shape (no temperature) for anthropic slots', () => {
    expect(chatRequestParams('claude-sonnet-5-5', 256, 0.1, true)).toEqual({
      max_tokens: 256 + CLAUDE_THINKING_RESERVE_TOKENS,
    });
  });

  it('passes max_tokens and temperature through for other providers', () => {
    expect(chatRequestParams('glm-5', 256, 0.1, false)).toEqual({
      max_tokens: 256,
      temperature: 0.1,
    });
  });
});

describe('isRetryableError', () => {
  it('returns true for 429 rate limit', () => {
    const err = new OpenAI.APIError(
      429,
      { message: 'rate limited' },
      'rate limited',
      new Headers(),
    );
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for 500 server error', () => {
    const err = new OpenAI.APIError(500, { message: 'internal' }, 'internal', new Headers());
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns false for 400 bad request', () => {
    const err = new OpenAI.APIError(400, { message: 'bad request' }, 'bad request', new Headers());
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns false for 401 unauthorized', () => {
    const err = new OpenAI.APIError(401, { message: 'unauth' }, 'unauth', new Headers());
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns true for AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for timeout error', () => {
    const err = new Error('Request timed out');
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    const err = new Error('Connection refused') as NodeJS.ErrnoException;
    err.code = 'ECONNREFUSED';
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for APIError with undefined status (SDK v6 abort)', () => {
    const err = new OpenAI.APIError(undefined as unknown as number, {}, 'abort', new Headers());
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns false for generic Error', () => {
    expect(isRetryableError(new Error('some error'))).toBe(false);
  });

  it('returns false (never throws) for a thrown null/undefined/primitive', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError('boom')).toBe(false);
  });

  it('returns true for a connection-outage aggregate (plain Error, no status/code)', () => {
    // An all-APIConnectionError chain yields a plain aggregate with no status/code, only a joined
    // "Connection error" message — it must still be retryable (matched connection-like by message).
    const aggregate = new Error('All 3 providers in smart chain failed: z.ai: Connection error.');
    expect(isRetryableError(aggregate)).toBe(true);
  });

  it('returns false for a concrete 4xx whose message mentions connection/timeout', () => {
    // A defined status is authoritative — a 400 is a client error and must stay non-retryable even
    // though its message says "connection error" (matches classifyAiError keeping it generic).
    const err = new OpenAI.APIError(
      400,
      { message: 'connection error' },
      'connection error',
      new Headers(),
    );
    expect(isRetryableError(err)).toBe(false);
  });
});

describe('getBackoffDelay', () => {
  it('honors Retry-After on a 429', () => {
    const err = new OpenAI.APIError(
      429,
      { message: 'rate limited' },
      'rate limited',
      new Headers({ 'retry-after': '3' }),
    );
    expect(getBackoffDelay(0, err)).toBe(3000);
  });

  it('exponential backoff for non-429', () => {
    expect(getBackoffDelay(0, new Error('fail'))).toBe(2000);
    expect(getBackoffDelay(1, new Error('fail'))).toBe(6000);
    expect(getBackoffDelay(2, new Error('fail'))).toBe(18000);
    expect(getBackoffDelay(3, new Error('fail'))).toBe(30_000); // capped
  });

  it('uses the 429 backoff for an aggregate plain Error carrying status 429', () => {
    const aggregate = Object.assign(new Error('All 3 providers failed'), { status: 429 });
    expect(getBackoffDelay(0, aggregate)).toBe(5000); // rate-limit path, not the 2000ms exponential
  });
});

describe('getRateLimitCooldownMs', () => {
  it('honors Retry-After without the short retry cap', () => {
    const err = new OpenAI.APIError(
      429,
      { message: 'rate limited' },
      'rate limited',
      new Headers({ 'retry-after': '120' }),
    );
    expect(getRateLimitCooldownMs(err, 1_000)).toBe(120_000);
  });

  it('honors an explicit quota reset timestamp from the provider message', () => {
    const now = Date.parse('2026-09-24T20:00:00Z');
    const err = Object.assign(
      new Error('Weekly quota limit reached; reset at 2026-09-24T21:15:09Z'),
      { status: 429 },
    );
    expect(getRateLimitCooldownMs(err, now)).toBe(4_510_000);
  });

  it('uses a five-minute fallback when no reset hint is available', () => {
    const err = Object.assign(new Error('rate limit'), { status: 429 });
    expect(getRateLimitCooldownMs(err, 1_000)).toBe(300_000);
  });
});

describe('pickRepresentativeError', () => {
  const api = (status: number) => new OpenAI.APIError(status, { message: 'x' }, 'x', new Headers());
  const conn = () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });

  const statusOf = (e: Error | null) => (e as { status?: number } | null)?.status;

  it('surfaces a 429 rate-limit over any smaller co-occurring status', () => {
    expect(statusOf(pickRepresentativeError([api(500), api(400), api(429)], null))).toBe(429);
  });

  it('surfaces 529 overloaded when no 429 is present', () => {
    expect(statusOf(pickRepresentativeError([api(500), api(529), api(400)], null))).toBe(529);
  });

  it('prefers a transient connection failure over a 4xx (keeps the chain retryable)', () => {
    const c = conn();
    expect(pickRepresentativeError([c, api(400)], null)).toBe(c);
  });

  it('prefers a 5xx transient over a co-occurring 4xx', () => {
    const five = api(500);
    expect(pickRepresentativeError([five, api(400)], null)).toBe(five);
  });

  it('surfaces a 4xx only when no transient (5xx/connection) failure occurred', () => {
    expect(statusOf(pickRepresentativeError([api(400), api(403)], null))).toBe(400);
  });

  it('falls back to the provided error when nothing matched (no status, not connection-like)', () => {
    const weird = new Error('totally unexpected');
    const fallback = new Error('the last error');
    expect(pickRepresentativeError([weird], fallback)).toBe(fallback);
  });

  it('always surfaces a transient signal (never the 4xx) regardless of try order', () => {
    const cases: Error[][] = [
      [api(500), api(400), conn()],
      [conn(), api(400), api(500)],
      [api(400), conn(), api(500)],
    ];
    for (const errors of cases) {
      const status = statusOf(pickRepresentativeError(errors, null));
      // A 5xx or a status-less connection error — both classify as retryable provider_down.
      expect(status === undefined || status >= 500).toBe(true);
    }
  });

  // Locks the docstring assumption: every member of the transient tier classifies identically, so
  // which one the breaker's reordering surfaces never changes the user-facing message.
  it('every transient-tier error (5xx / connection) classifies as provider_down', () => {
    expect(classifyAiError(api(500))?.kind).toBe('provider_down');
    expect(classifyAiError(api(503))?.kind).toBe('provider_down');
    expect(classifyAiError(conn())?.kind).toBe('provider_down');
  });

  // The aggregate is a plain Error with status/code COPIED on — classifyAiError must read it
  // structurally (not via `instanceof OpenAI.APIError`), or pickRepresentativeError's copy is moot.
  it('classifies the aggregate plain Error by its copied status', () => {
    const down = Object.assign(new Error('All 3 providers in smart chain failed: …'), {
      status: 503,
    });
    const bad = Object.assign(new Error('All 3 providers in smart chain failed: …'), {
      status: 400,
    });
    expect(classifyAiError(down)?.kind).toBe('provider_down');
    expect(classifyAiError(bad)?.kind).toBe('generic');
  });
});

describe('stripThinkingTags', () => {
  let mod: typeof import('./streaming');
  beforeEach(async () => {
    mod = await import('./streaming');
  });

  it('removes <think>...</think> block', () => {
    expect(mod.stripThinkingTags('<think>hmm</think>answer')).toBe('answer');
  });

  it('removes multiline think block', () => {
    expect(mod.stripThinkingTags('<think>\nline1\nline2\n</think>\nfinal')).toBe('final');
  });

  it('removes multiple think blocks', () => {
    expect(mod.stripThinkingTags('<think>a</think>one<think>b</think>two')).toBe('onetwo');
  });

  it('trims whitespace', () => {
    expect(mod.stripThinkingTags('  hello  ')).toBe('hello');
  });

  it('leaves text without think tags unchanged', () => {
    expect(mod.stripThinkingTags('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(mod.stripThinkingTags('')).toBe('');
  });
});

describe('classifyAiError', () => {
  let mod: typeof import('./streaming');
  beforeEach(async () => {
    mod = await import('./streaming');
  });

  it('classifies an aggregated all-providers connection failure as provider_down', () => {
    const err = new Error(
      'All 3 providers in smart chain failed: z.ai (glm-5.1): Connection error.; ' +
        'Claude (c): Connection error.; HF (h): Connection error.',
    );
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('provider_down');
    expect(c?.userMessage).toContain('временно недоступен');
  });

  it('classifies an OpenAI APIConnectionError as provider_down', () => {
    const err = new OpenAI.APIConnectionError({ message: 'Connection error.' });
    expect(mod.classifyAiError(err)?.kind).toBe('provider_down');
  });

  it('classifies ECONNREFUSED as provider_down', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(mod.classifyAiError(err)?.kind).toBe('provider_down');
  });

  it('classifies a non-429/529 5xx as provider_down', () => {
    const err = Object.assign(new Error('Server error'), { status: 503 });
    expect(mod.classifyAiError(err)?.kind).toBe('provider_down');
  });

  it('classifies 429 as rate_limit', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('rate_limit');
    expect(c?.userMessage).toContain('Слишком много');
  });

  it('reads status off a real OpenAI.APIError instance (429 → rate_limit)', () => {
    const err = new OpenAI.APIError(429, { message: 'rl' }, 'rl', new Headers());
    expect(mod.classifyAiError(err)?.kind).toBe('rate_limit');
  });

  it('classifies an aggregate carrying code=ECONNREFUSED as provider_down', () => {
    // aiStreamRound copies the last error's status+code onto the aggregate, so a
    // connection-down chain stays classifiable even if the joined message is terse.
    const err = Object.assign(new Error('All 3 providers in smart chain failed: …'), {
      code: 'ECONNREFUSED',
    });
    expect(mod.classifyAiError(err)?.kind).toBe('provider_down');
  });

  it('classifies 529 as overloaded', () => {
    const err = Object.assign(new Error('overloaded'), { status: 529 });
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('overloaded');
    expect(c?.userMessage).toContain('перегружен');
  });

  it('classifies an AbortError as timeout', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('timeout');
    expect(c?.userMessage).toContain('ожидания');
  });

  it('classifies an aggregated abort (60s agent timeout) as timeout, not provider_down', () => {
    const err = new Error(
      'All 3 providers in smart chain failed: z.ai (glm-5.1): Request was aborted.; ' +
        'Claude (c): Request was aborted.; HF (h): Request was aborted.',
    );
    expect(mod.classifyAiError(err)?.kind).toBe('timeout');
  });

  it('classifies a 4xx (other than 429) as a generic recognized AI error', () => {
    const err = Object.assign(new Error('bad request'), { status: 400 });
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('generic');
    expect(c?.userMessage).toContain('Ошибка AI');
  });

  it('does NOT mask an aggregated all-400 failure as provider_down (stays generic)', () => {
    const err = Object.assign(
      new Error(
        'All 3 providers in smart chain failed: z.ai (glm-5.1): 400 Bad Request; ' +
          'Claude (c): 400 Bad Request; HF (h): 400 Bad Request',
      ),
      { status: 400 },
    );
    expect(mod.classifyAiError(err)?.kind).toBe('generic');
  });

  it('does NOT mask a mixed 4xx aggregate (last=400, earlier connection blip) as an outage', () => {
    // A concrete 4xx is a request bug — the earlier "Connection error." in the summary
    // must not flip it to provider_down.
    const err = Object.assign(
      new Error(
        'All 3 providers in smart chain failed: z.ai (glm-5.1): Connection error.; ' +
          'Claude (c): 400 Bad Request; HF (h): 400 Bad Request',
      ),
      { status: 400 },
    );
    expect(mod.classifyAiError(err)?.kind).toBe('generic');
  });

  it('classifies an aggregated empty-response failure (no status/connection signal) as generic', () => {
    // Every provider returned an empty body → a plain Error with no status, no abort, no connection
    // match. An exhausted chain is still an AI failure, so it must surface the safe generic message
    // (and let the agent page the admin) — NOT fall through to null and silently rethrow.
    const err = new Error(
      'All 3 providers in smart chain failed: z.ai (glm-5.1): Provider z.ai (glm-5.1) ' +
        'returned empty response (no text, no tool calls) — treating as failure; ' +
        'Claude (c): returned empty response; HF (h): returned empty response',
    );
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('generic');
    expect(c?.userMessage).toContain('Ошибка AI');
  });

  it('does NOT treat a non-aggregate plain Error as an exhausted-chain failure (stays null)', () => {
    // The exhausted-chain floor is scoped to the aggregate prefix only — a bare message that merely
    // mentions providers must still return null so the agent rethrows an unrelated bug.
    expect(
      mod.classifyAiError(new Error('the provider list in smart chain failed to load')),
    ).toBeNull();
  });

  it('classifies ECONNRESET as provider_down', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(mod.classifyAiError(err)?.kind).toBe('provider_down');
  });

  it('classifies a "fetch failed" message as provider_down', () => {
    expect(mod.classifyAiError(new Error('fetch failed'))?.kind).toBe('provider_down');
  });

  it('returns null for an unrecognized error so the caller can rethrow', () => {
    expect(mod.classifyAiError(new TypeError('boom'))).toBeNull();
  });
});
