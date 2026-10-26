// Tests for the edges of the error policy that the main streaming tests leave implicit: attempt
// failure classes for status-less and unusual errors, Retry-After parsing, and the user-facing
// classification of non-Error throws.

import { describe, expect, it, mock } from 'bun:test';
import OpenAI from 'openai';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();

mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));
mock.module('../../config/env', () => ({ env: {} }));
mock.module('./clients', () => ({
  zaiClient: () => ({}),
  claudeClient: () => ({}),
  hfClient: () => ({}),
  openrouterClient: () => ({}),
}));
mock.module('./usage-recorder', () => ({ recordAiUsage: () => {} }));

// The logger is bound when streaming loads: import it after the mocks.
const {
  classifyAiError,
  classifyAttemptFailure,
  getBackoffDelay,
  getRateLimitCooldownMs,
  isRetryableError,
  pickRepresentativeError,
} = await import('./streaming');

const idle = { callerAborted: false, providerTimedOut: false };

function withStatus(status: number, message = 'x'): Error {
  return Object.assign(new Error(message), { status });
}

describe('classifyAttemptFailure: shapes without an SDK error class', () => {
  it.each([
    ['a status below 400', withStatus(302, 'moved'), 'other', 302],
    ['a status of 100', withStatus(100, 'continue'), 'other', 100],
    ['a 599', withStatus(599, 'edge'), 'server', 599],
    ['the first 4xx after the named ones', withStatus(409, 'conflict'), 'bad_request', 409],
    ['402 with a plain message', withStatus(402, 'pay up'), 'quota', 402],
    ['429 whose message is a quota phrase in any case', withStatus(429, 'QUOTA'), 'quota', 429],
    ['400 that mentions "will reset"', withStatus(400, 'will reset'), 'quota', 400],
    ['a status wins over a timeout message', withStatus(500, 'request timed out'), 'server', 500],
  ] as const)('%s', (_label, error, errorClass, httpStatus) => {
    expect(classifyAttemptFailure(error, idle)).toEqual({ errorClass, httpStatus });
  });

  it.each([
    ['an ETIMEDOUT code', Object.assign(new Error('socket'), { code: 'ETIMEDOUT' }), 'timeout'],
    ['a "timed out" message', new Error('Request timed out.'), 'timeout'],
    ['a "timeout" message', new Error('gateway TIMEOUT'), 'timeout'],
    ['an AbortError by name', Object.assign(new Error('x'), { name: 'AbortError' }), 'aborted'],
    ['an "operation was aborted" message', new Error('The operation was aborted'), 'aborted'],
    ['a thrown string that says aborted', 'request aborted', 'aborted'],
    ['ECONNREFUSED', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'server'],
    ['a "fetch failed" message', new Error('fetch failed'), 'server'],
    ['a thrown null', null, 'other'],
    ['an unrelated Error', new Error('boom'), 'other'],
  ] as const)('%s with no status → %s', (_label, error, errorClass) => {
    expect(classifyAttemptFailure(error, idle)).toEqual({ errorClass, httpStatus: null });
  });

  it('keeps the status of an error even when an abort signal explains it', () => {
    expect(classifyAttemptFailure(withStatus(500), { ...idle, providerTimedOut: true })).toEqual({
      errorClass: 'timeout',
      httpStatus: 500,
    });
  });

  it('reads a timed-out message before an abort name', () => {
    const error = Object.assign(new Error('timed out'), { name: 'AbortError' });
    expect(classifyAttemptFailure(error, idle).errorClass).toBe('timeout');
  });
});

describe('getBackoffDelay: Retry-After on a 429', () => {
  const rateLimited = (retryAfter: string | undefined) =>
    Object.assign(new Error('slow down'), {
      status: 429,
      headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
    });

  it.each([
    ['a plain header record', '2', 2000],
    ['fractional seconds', '1.5', 1500],
    ['a value above the cap', '100', 30_000],
    ['zero', '0', 5000],
    ['a negative value', '-3', 5000],
    ['an HTTP date it cannot parse as seconds', 'Wed, 21 Oct 2026 07:28:00 GMT', 5000],
    ['an empty header', '', 5000],
  ])('%s', (_label, header, expected) => {
    expect(getBackoffDelay(0, rateLimited(header))).toBe(expected);
  });

  it('ignores the attempt number on a 429 and uses 5s without a header', () => {
    expect(getBackoffDelay(4, rateLimited(undefined))).toBe(5000);
  });

  it('reads the header from a Headers-like object, case-insensitively through get()', () => {
    const error = Object.assign(new Error('x'), {
      status: 429,
      headers: new Headers({ 'Retry-After': '7' }),
    });
    expect(getBackoffDelay(0, error)).toBe(7000);
  });

  it('reads only the lowercase key from a plain record (a capitalised key is not seen)', () => {
    const error = Object.assign(new Error('x'), { status: 429, headers: { 'Retry-After': '4' } });
    expect(getBackoffDelay(0, error)).toBe(5000);
  });

  it('ignores a non-string record value', () => {
    const error = Object.assign(new Error('x'), { status: 429, headers: { 'retry-after': 4 } });
    expect(getBackoffDelay(0, error)).toBe(5000);
  });
});

describe('getRateLimitCooldownMs edges', () => {
  const NOW = Date.parse('2026-09-24T20:00:00Z');

  it('floors a sub-second Retry-After at one second', () => {
    const error = Object.assign(new Error('x'), { status: 429, headers: { 'retry-after': '0.2' } });
    expect(getRateLimitCooldownMs(error, NOW)).toBe(1_000);
  });

  it('adds one second of margin to a reset timestamp in the future', () => {
    const error = withStatus(429, 'limit reached, reset at 2026-09-24T20:10:00Z');
    expect(getRateLimitCooldownMs(error, NOW)).toBe(601_000);
  });

  it('accepts an offset timestamp and fractional seconds', () => {
    const error = withStatus(429, 'quota resets 2026-09-24T23:00:00.500+03:00');
    expect(getRateLimitCooldownMs(error, NOW)).toBe(1_500);
  });

  it('falls back to five minutes for a reset time already in the past', () => {
    const error = withStatus(429, 'quota reset at 2026-09-24T19:00:00Z');
    expect(getRateLimitCooldownMs(error, NOW)).toBe(300_000);
  });

  it('ignores a timestamp in a message that never mentions reset, quota or limit', () => {
    const error = withStatus(429, 'try again after 2026-09-24T21:00:00Z');
    expect(getRateLimitCooldownMs(error, NOW)).toBe(300_000);
  });

  it('prefers Retry-After over a timestamp in the message', () => {
    const error = Object.assign(withStatus(429, 'quota reset at 2026-09-24T23:00:00Z'), {
      headers: { 'retry-after': '30' },
    });
    expect(getRateLimitCooldownMs(error, NOW)).toBe(30_000);
  });

  it('treats a thrown non-Error as a message', () => {
    expect(getRateLimitCooldownMs('limit exhausted', NOW)).toBe(300_000);
  });
});

describe('isRetryableError edges', () => {
  it('treats a 529 as retryable (a 5xx)', () => {
    expect(isRetryableError(withStatus(529))).toBe(true);
  });

  it('keeps a plain-object 429 retryable and a plain-object 404 not', () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ status: 404 })).toBe(false);
  });

  it('does not retry a status-less plain Error with an abort-ish message', () => {
    expect(isRetryableError(new Error('was aborted'))).toBe(false);
  });

  it('retries an SDK abort error with no status', () => {
    expect(isRetryableError(new OpenAI.APIUserAbortError())).toBe(true);
  });
});

describe('pickRepresentativeError edges', () => {
  it('returns the fallback for an empty list and null when there is none either', () => {
    const fallback = new Error('last');
    expect(pickRepresentativeError([], fallback)).toBe(fallback);
    expect(pickRepresentativeError([], null)).toBeNull();
  });

  it('prefers the first 429 over a later 529 and the first of equal-tier 5xx', () => {
    const first = withStatus(503);
    const second = withStatus(500);
    expect(pickRepresentativeError([first, second], null)).toBe(first);
    const overloaded = withStatus(529);
    const limited = withStatus(429);
    expect(pickRepresentativeError([overloaded, limited], null)).toBe(limited);
  });
});

describe('classifyAiError edges', () => {
  it('classifies a thrown connection string and a thrown abort string', () => {
    expect(classifyAiError('fetch failed')?.kind).toBe('provider_down');
    expect(classifyAiError('request was aborted')?.kind).toBe('timeout');
  });

  it('checks the status tiers before the abort message', () => {
    expect(classifyAiError(withStatus(429, 'aborted'))?.kind).toBe('rate_limit');
    expect(classifyAiError(withStatus(404, 'aborted'))?.kind).toBe('generic');
    expect(classifyAiError(withStatus(500, 'aborted'))?.kind).toBe('timeout');
  });

  it('keeps a status below 400 generic once no abort or connection signal matched', () => {
    expect(classifyAiError(withStatus(302, 'moved'))?.kind).toBe('generic');
  });

  it('returns null for null, undefined and a plain object', () => {
    expect(classifyAiError(null)).toBeNull();
    expect(classifyAiError(undefined)).toBeNull();
    expect(classifyAiError({ message: 'x' })).toBeNull();
  });

  it('recognises an exhausted chain of one provider by its singular message', () => {
    expect(classifyAiError(new Error('All 1 provider in smart chain failed: x'))?.kind).toBe(
      'generic',
    );
  });
});
