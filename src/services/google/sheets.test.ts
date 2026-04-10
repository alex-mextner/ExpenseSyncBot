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
interface ValuesBatchUpdateArgs {
  requestBody: { data: Array<{ range: string; values: string[][] }> };
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

import { appendExpenseRows } from './sheets';

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

  test('writes all EUR formulas in one batchUpdate', async () => {
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

    // Single batchUpdate for all 3 formulas, not 3 separate update calls
    expect(mockValuesBatchUpdate).toHaveBeenCalledTimes(1);
    expect(mockValuesUpdate).not.toHaveBeenCalled();

    const batchArgs = mockValuesBatchUpdate.mock.calls[0]?.[0] as ValuesBatchUpdateArgs;
    expect(batchArgs.requestBody.data).toHaveLength(3);
    // Each formula references the corresponding row
    expect(batchArgs.requestBody.data[0]?.values[0]?.[0]).toContain('5'); // row 5
    expect(batchArgs.requestBody.data[1]?.values[0]?.[0]).toContain('6'); // row 6
    expect(batchArgs.requestBody.data[2]?.values[0]?.[0]).toContain('7'); // row 7
  });

  test('skips formula batchUpdate when all rows are EUR', async () => {
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

    // No formulas needed for EUR-native rows
    expect(mockValuesBatchUpdate).not.toHaveBeenCalled();
  });

  test('only writes formulas for rows that need them (mixed currencies)', async () => {
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

    expect(mockValuesBatchUpdate).toHaveBeenCalledTimes(1);
    const batchArgs = mockValuesBatchUpdate.mock.calls[0]?.[0] as ValuesBatchUpdateArgs;
    // Only 2 formulas (rows 5 and 7), row 6 is EUR
    expect(batchArgs.requestBody.data).toHaveLength(2);
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
    expect(row?.[0]).toBe('2026-04-10');
    expect(row?.[1]).toBe('Еда');
    expect(row?.[2]).toBe('lunch');
    expect(row?.[3]).toBe(4.3); // EUR amount
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
