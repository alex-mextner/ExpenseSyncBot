/** Tests for sheets.ts rate-limit classification, 429 retry/backoff, per-spreadsheet write queue and chunking */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { resetSheetsMocks } from './sheets-test-support';

// Dynamic import keeps './sheets' evaluated AFTER the mock.module calls in
// sheets-test-support (otherwise bun binds the real logger/googleapis).
const { chunkArray, enqueueSheetWrite, GOOGLE_SHEETS_LIMITS, isRateLimitError, withSheetsRetry } =
  await import('./sheets');

beforeEach(resetSheetsMocks);

// ── 429 retry behaviour ─────────────────────────────────────────────────────

describe('isRateLimitError', () => {
  test('detects code 429', () => {
    expect(isRateLimitError({ code: 429 })).toBe(true);
    expect(isRateLimitError({ code: '429' })).toBe(true);
    expect(isRateLimitError({ status: 429 })).toBe(true);
  });

  test('detects "Quota exceeded" and "rateLimitExceeded" messages', () => {
    expect(isRateLimitError({ message: 'Quota exceeded for write_requests' })).toBe(true);
    expect(isRateLimitError({ message: 'rateLimitExceeded' })).toBe(true);
  });

  test('returns false for non-rate-limit errors', () => {
    expect(isRateLimitError(new Error('invalid credentials'))).toBe(false);
    expect(isRateLimitError({ code: 400 })).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError('string')).toBe(false);
  });
});

describe('withSheetsRetry', () => {
  test('returns immediately on success', async () => {
    const fn = mock(() => Promise.resolve('ok'));
    const result = await withSheetsRetry(fn, 'test', {
      sleepFn: () => Promise.resolve(),
      randomFn: () => 0,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on 429 and succeeds on second attempt', async () => {
    let call = 0;
    const fn = mock(() => {
      call++;
      if (call === 1) throw { code: 429, message: 'Quota exceeded' };
      return Promise.resolve('ok');
    });
    const sleeps: number[] = [];
    const result = await withSheetsRetry(fn, 'test', {
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      randomFn: () => 0.5,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    // First retry waits: 2^0 * 1000 + 0.5 * 1000 = 1500ms
    expect(sleeps).toEqual([1500]);
  });

  test('rethrows non-429 errors without retrying', async () => {
    const fn = mock(() => {
      throw new Error('permission denied');
    });
    await expect(
      withSheetsRetry(fn, 'test', {
        sleepFn: () => Promise.resolve(),
        randomFn: () => 0,
      }),
    ).rejects.toThrow('permission denied');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('gives up after maxAttempts consecutive 429s', async () => {
    const fn = mock(() => {
      throw { code: 429, message: 'Quota exceeded' };
    });
    await expect(
      withSheetsRetry(fn, 'test', {
        sleepFn: () => Promise.resolve(),
        randomFn: () => 0,
      }),
    ).rejects.toMatchObject({ code: 429 });
    // maxAttempts = 6
    expect(fn).toHaveBeenCalledTimes(6);
  });

  test('backoff doubles each retry and caps at maxBackoffMs', async () => {
    const fn = mock(() => {
      throw { code: 429 };
    });
    const sleeps: number[] = [];
    await expect(
      withSheetsRetry(fn, 'test', {
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
        randomFn: () => 0, // no jitter → deterministic
      }),
    ).rejects.toMatchObject({ code: 429 });
    // attempts 1..5 trigger sleeps: 2^0, 2^1, 2^2, 2^3, 2^4 * 1000
    // = 1000, 2000, 4000, 8000, 16000
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
  });
});

// ── GOOGLE_SHEETS_LIMITS shape ──────────────────────────────────────────────

describe('GOOGLE_SHEETS_LIMITS constants', () => {
  test('exposes documented quota limits', () => {
    expect(GOOGLE_SHEETS_LIMITS.writeRequestsPerMinutePerUser).toBe(60);
    expect(GOOGLE_SHEETS_LIMITS.writeRequestsPerMinutePerProject).toBe(300);
    expect(GOOGLE_SHEETS_LIMITS.readRequestsPerMinutePerUser).toBe(60);
    expect(GOOGLE_SHEETS_LIMITS.readRequestsPerMinutePerProject).toBe(300);
    expect(GOOGLE_SHEETS_LIMITS.maxBackoffMs).toBe(32_000);
    expect(GOOGLE_SHEETS_LIMITS.maxAttempts).toBe(6);
  });
});

// ── isRateLimitError — additional shapes ────────────────────────────────────

describe('isRateLimitError — nested error shapes', () => {
  test('detects GaxiosError wrapper with response.status=429', () => {
    expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
    expect(isRateLimitError({ response: { status: '429' } })).toBe(true);
  });

  test('detects RESOURCE_EXHAUSTED in google JSON body', () => {
    expect(
      isRateLimitError({
        response: { data: { error: { status: 'RESOURCE_EXHAUSTED' } } },
      }),
    ).toBe(true);
  });

  test('detects rateLimitExceeded reason (403 body, not 429)', () => {
    expect(
      isRateLimitError({
        code: 403,
        response: {
          data: {
            error: { errors: [{ reason: 'rateLimitExceeded' }] },
          },
        },
      }),
    ).toBe(true);
  });

  test('detects userRateLimitExceeded reason', () => {
    expect(
      isRateLimitError({
        response: {
          data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } },
        },
      }),
    ).toBe(true);
  });

  test('returns false for unrelated reason codes', () => {
    expect(
      isRateLimitError({
        response: {
          data: { error: { errors: [{ reason: 'permissionDenied' }] } },
        },
      }),
    ).toBe(false);
  });

  test('handles non-string message field gracefully', () => {
    expect(isRateLimitError({ message: 42 })).toBe(false);
  });
});

// ── enqueueSheetWrite — queueing semantics ──────────────────────────────────

describe('enqueueSheetWrite', () => {
  test('serializes two operations (second starts only after first resolves)', async () => {
    const order: string[] = [];
    const p1 = enqueueSheetWrite('sid-seq-1', async () => {
      order.push('a-start');
      await Bun.sleep(10);
      order.push('a-end');
    });
    const p2 = enqueueSheetWrite('sid-seq-1', async () => {
      order.push('b-start');
      await Bun.sleep(5);
      order.push('b-end');
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  test('runs concurrently for different spreadsheets', async () => {
    const order: string[] = [];
    const p1 = enqueueSheetWrite('sid-par-A', async () => {
      order.push('A-start');
      await Bun.sleep(15);
      order.push('A-end');
    });
    const p2 = enqueueSheetWrite('sid-par-B', async () => {
      order.push('B-start');
      await Bun.sleep(5);
      order.push('B-end');
    });
    await Promise.all([p1, p2]);
    expect(order[0]).toBe('A-start');
    expect(order[1]).toBe('B-start');
    expect(order.indexOf('B-end')).toBeLessThan(order.indexOf('A-end'));
  });

  test('propagates rejection to caller without breaking the queue', async () => {
    const failing = enqueueSheetWrite('sid-err', async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    let ran = false;
    await enqueueSheetWrite('sid-err', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

// ── chunkArray ──────────────────────────────────────────────────────────────

describe('chunkArray', () => {
  test('splits into fixed-size chunks with a smaller trailing chunk', () => {
    expect(chunkArray([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  test('returns a single chunk when the array fits', () => {
    expect(chunkArray([1, 2], 300)).toEqual([[1, 2]]);
  });

  test('splits exactly at the boundary with no empty trailing chunk', () => {
    const chunks = chunkArray(
      Array.from({ length: 600 }, (_, i) => i),
      300,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(300);
    expect(chunks[1]).toHaveLength(300);
  });

  test('returns no chunks for an empty array', () => {
    expect(chunkArray([], 300)).toEqual([]);
  });
});
