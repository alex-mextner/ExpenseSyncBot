/** Tests for sheets.ts batch append — verifies headers handling, row building, formula batchUpdate */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GoogleConn } from './sheets';

// ── Mock googleapis sheets client ─────────────────────────────────────────────

interface ValuesGetResponse {
  data: { values: string[][] };
}
interface ValuesAppendResponse {
  data: { updates: { updatedRange: string; updatedRows: number } };
}
interface ValuesAppendArgs {
  requestBody: { values: unknown[][] };
}

const mockValuesGet = mock(
  (..._args: unknown[]): Promise<ValuesGetResponse> => Promise.resolve({ data: { values: [[]] } }),
);
const mockValuesAppend = mock(
  (..._args: unknown[]): Promise<ValuesAppendResponse> =>
    Promise.resolve({
      data: { updates: { updatedRange: 'Expenses!A2:G2', updatedRows: 1 } },
    }),
);
const mockValuesBatchUpdate = mock(
  (..._args: unknown[]): Promise<{ data: Record<string, never> }> => Promise.resolve({ data: {} }),
);
const mockValuesUpdate = mock(
  (..._args: unknown[]): Promise<{ data: Record<string, never> }> => Promise.resolve({ data: {} }),
);
const mockSpreadsheetsBatchUpdate = mock(
  (..._args: unknown[]): Promise<{ data: Record<string, never> }> => Promise.resolve({ data: {} }),
);

const mockSheets = {
  spreadsheets: {
    values: {
      get: mockValuesGet,
      append: mockValuesAppend,
      batchUpdate: mockValuesBatchUpdate,
      update: mockValuesUpdate,
    },
    batchUpdate: mockSpreadsheetsBatchUpdate,
    get: mock(() =>
      Promise.resolve({
        data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
      }),
    ),
  },
};

mock.module('googleapis', () => ({
  google: {
    sheets: () => mockSheets,
  },
}));

mock.module('./oauth', () => ({
  getAuthenticatedClient: () => ({}),
  isTokenExpiredError: () => false,
}));

import { appendExpenseRows, isRateLimitError, withSheetsRetry } from './sheets';

const TEST_CONN: GoogleConn = { refreshToken: 'token', oauthClient: 'legacy' };
const TEST_SPREADSHEET = 'sheet-123';

beforeEach(() => {
  mockValuesGet.mockReset().mockResolvedValue({
    data: {
      values: [['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)']],
    },
  });
  mockValuesAppend.mockReset().mockResolvedValue({
    data: { updates: { updatedRange: 'Expenses!A2:F2', updatedRows: 1 } },
  });
  mockValuesBatchUpdate.mockReset().mockResolvedValue({ data: {} });
  mockValuesUpdate.mockReset().mockResolvedValue({ data: {} });
});

describe('appendExpenseRows', () => {
  test('does nothing for empty array', async () => {
    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, []);
    expect(mockValuesGet).not.toHaveBeenCalled();
    expect(mockValuesAppend).not.toHaveBeenCalled();
  });

  test('reads headers exactly once for batch of 3 rows', async () => {
    mockValuesAppend.mockResolvedValue({
      data: { updates: { updatedRange: 'Expenses!A5:F7', updatedRows: 3 } },
    });

    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-10',
        category: 'Еда',
        comment: 'обед',
        amounts: { RSD: 500 },
        eurAmount: 4.3,
        rate: 0.0086,
      },
      {
        date: '2026-04-10',
        category: 'Еда',
        comment: 'кофе',
        amounts: { RSD: 200 },
        eurAmount: 1.72,
        rate: 0.0086,
      },
      {
        date: '2026-04-10',
        category: 'Транспорт',
        comment: 'такси',
        amounts: { RSD: 800 },
        eurAmount: 6.88,
        rate: 0.0086,
      },
    ]);

    // Headers fetched once, not 3 times
    expect(mockValuesGet).toHaveBeenCalledTimes(1);
  });

  test('appends all rows in one append call', async () => {
    mockValuesAppend.mockResolvedValue({
      data: { updates: { updatedRange: 'Expenses!A5:F6', updatedRows: 2 } },
    });

    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-10',
        category: 'Еда',
        comment: '',
        amounts: { RSD: 100 },
        eurAmount: 0.86,
        rate: 0.0086,
      },
      {
        date: '2026-04-10',
        category: 'Еда',
        comment: '',
        amounts: { RSD: 200 },
        eurAmount: 1.72,
        rate: 0.0086,
      },
    ]);

    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
    const callArgs = mockValuesAppend.mock.calls[0]?.[0] as ValuesAppendArgs;
    expect(callArgs.requestBody.values).toHaveLength(2);
  });

  test('bakes EUR formulas into the append payload (no second API call)', async () => {
    mockValuesAppend.mockResolvedValue({
      data: { updates: { updatedRange: 'Expenses!A5:F7', updatedRows: 3 } },
    });

    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-10',
        category: 'A',
        comment: '',
        amounts: { RSD: 100 },
        eurAmount: 0.86,
        rate: 0.0086,
      },
      {
        date: '2026-04-10',
        category: 'B',
        comment: '',
        amounts: { RSD: 200 },
        eurAmount: 1.72,
        rate: 0.0086,
      },
      {
        date: '2026-04-10',
        category: 'C',
        comment: '',
        amounts: { RSD: 300 },
        eurAmount: 2.58,
        rate: 0.0086,
      },
    ]);

    // No second round-trip: neither batchUpdate nor update are called
    expect(mockValuesBatchUpdate).not.toHaveBeenCalled();
    expect(mockValuesUpdate).not.toHaveBeenCalled();

    // Single append carries the formulas inline — self-positioning via INDIRECT+ROW
    // Headers: Дата(0) Категория(1) Комментарий(2) EUR(calc)(3) RSD(4) Rate(5)
    const callArgs = mockValuesAppend.mock.calls[0]?.[0] as ValuesAppendArgs;
    expect(callArgs.requestBody.values).toHaveLength(3);
    for (const row of callArgs.requestBody.values) {
      // EUR (calc) column = index 3
      const eurCell = row?.[3];
      expect(typeof eurCell).toBe('string');
      expect(eurCell).toContain('INDIRECT');
      expect(eurCell).toContain('ROW()');
    }
  });

  test('uses literal EUR value when all rows are EUR-native', async () => {
    mockValuesGet.mockResolvedValue({
      data: { values: [['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'Rate (→EUR)']] },
    });
    mockValuesAppend.mockResolvedValue({
      data: { updates: { updatedRange: 'Expenses!A5:E6', updatedRows: 2 } },
    });

    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      { date: '2026-04-10', category: 'A', comment: '', amounts: { EUR: 10 }, eurAmount: 10 },
      { date: '2026-04-10', category: 'B', comment: '', amounts: { EUR: 20 }, eurAmount: 20 },
    ]);

    // No formulas needed for EUR-native rows — no second round-trip at all
    expect(mockValuesBatchUpdate).not.toHaveBeenCalled();
    expect(mockValuesUpdate).not.toHaveBeenCalled();

    // EUR column holds the literal amount, not a formula
    const callArgs = mockValuesAppend.mock.calls[0]?.[0] as ValuesAppendArgs;
    expect(callArgs.requestBody.values[0]?.[3]).toBe(10);
    expect(callArgs.requestBody.values[1]?.[3]).toBe(20);
  });

  test('puts formula only on non-EUR rows in a mixed-currency batch', async () => {
    mockValuesAppend.mockResolvedValue({
      data: { updates: { updatedRange: 'Expenses!A5:F7', updatedRows: 3 } },
    });

    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-10',
        category: 'A',
        comment: '',
        amounts: { RSD: 100 },
        eurAmount: 0.86,
        rate: 0.0086,
      },
      { date: '2026-04-10', category: 'B', comment: '', amounts: { EUR: 5 }, eurAmount: 5 }, // EUR — no formula
      {
        date: '2026-04-10',
        category: 'C',
        comment: '',
        amounts: { RSD: 300 },
        eurAmount: 2.58,
        rate: 0.0086,
      },
    ]);

    // Single call, no second round-trip
    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
    expect(mockValuesBatchUpdate).not.toHaveBeenCalled();

    const callArgs = mockValuesAppend.mock.calls[0]?.[0] as ValuesAppendArgs;
    // Row 1 (RSD) — formula
    expect(String(callArgs.requestBody.values[0]?.[3])).toContain('INDIRECT');
    // Row 2 (EUR) — literal
    expect(callArgs.requestBody.values[1]?.[3]).toBe(5);
    // Row 3 (RSD) — formula
    expect(String(callArgs.requestBody.values[2]?.[3])).toContain('INDIRECT');
  });

  test('handles single-row batch', async () => {
    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-10',
        category: 'Еда',
        comment: 'lunch',
        amounts: { RSD: 500 },
        eurAmount: 4.3,
        rate: 0.0086,
      },
    ]);

    expect(mockValuesGet).toHaveBeenCalledTimes(1);
    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
  });

  test('builds row in correct column order based on headers', async () => {
    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-10',
        category: 'Еда',
        comment: 'lunch',
        amounts: { RSD: 500 },
        eurAmount: 4.3,
        rate: 0.0086,
      },
    ]);

    const callArgs = mockValuesAppend.mock.calls[0]?.[0] as ValuesAppendArgs;
    const row = callArgs.requestBody.values[0];
    // Headers: ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)']
    //           A=0      B=1         C=2             D=3            E=4           F=5
    expect(row?.[0]).toBe('2026-04-10');
    expect(row?.[1]).toBe('Еда');
    expect(row?.[2]).toBe('lunch');
    // EUR column holds a self-positioning formula: amount col (E) × rate col (F)
    expect(row?.[3]).toBe('=INDIRECT("E"&ROW())*INDIRECT("F"&ROW())');
    expect(row?.[4]).toBe(500); // RSD amount
    expect(row?.[5]).toBe(0.0086); // rate
  });

  test('serializes batch writes through queue', async () => {
    // Two parallel batch writes to the same spreadsheet
    let firstFinished = false;
    mockValuesAppend.mockImplementation(async () => {
      if (!firstFinished) {
        await Bun.sleep(20);
        firstFinished = true;
      }
      return { data: { updates: { updatedRange: 'Expenses!A5:F5', updatedRows: 1 } } };
    });

    const p1 = appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      { date: '2026-04-10', category: 'A', comment: '', amounts: { EUR: 10 }, eurAmount: 10 },
    ]);
    const p2 = appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      { date: '2026-04-10', category: 'B', comment: '', amounts: { EUR: 20 }, eurAmount: 20 },
    ]);

    await Promise.all([p1, p2]);
    expect(mockValuesAppend).toHaveBeenCalledTimes(2);
  });
});

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
