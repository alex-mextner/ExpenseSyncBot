/** Tests for sheets.ts batch append — verifies headers handling, row building, formula batchUpdate */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { GoogleConn } from './sheets';

// Silence + assert on logger calls. The source file imports from
// '../../utils/logger.ts' (explicit extension) — match that exactly so
// mock.module substitutes the right module identity.
const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Mock googleapis sheets client ─────────────────────────────────────────────

interface ValuesGetResponse {
  data: { values: unknown[][] };
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
  (..._args: unknown[]): Promise<{ data: Record<string, unknown> }> =>
    Promise.resolve({ data: {} }),
);
const mockSpreadsheetsGet = mock(() =>
  Promise.resolve({
    data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
  }),
);
const mockSpreadsheetsCreate = mock(
  (
    ..._args: unknown[]
  ): Promise<{
    data: { spreadsheetId?: string; sheets?: Array<{ properties?: { sheetId?: number } }> };
  }> =>
    Promise.resolve({
      data: { spreadsheetId: 'new-sheet-id', sheets: [{ properties: { sheetId: 0 } }] },
    }),
);
const mockSheetsCopyTo = mock(
  (..._args: unknown[]): Promise<{ data: { sheetId?: number } }> =>
    Promise.resolve({ data: { sheetId: 42 } }),
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
    get: mockSpreadsheetsGet,
    create: mockSpreadsheetsCreate,
    sheets: {
      copyTo: mockSheetsCopyTo,
    },
  },
};

mock.module('googleapis', () => ({
  google: {
    sheets: () => mockSheets,
  },
}));

const mockIsTokenExpiredError = mock((_err: unknown) => false);
mock.module('./oauth', () => ({
  getAuthenticatedClient: () => ({}),
  isTokenExpiredError: mockIsTokenExpiredError,
}));

// Deterministic currency conversion for readExpensesFromSheet tests
mock.module('../currency/converter', () => ({
  convertToEUR: (amount: number, currency: string) => {
    if (currency === 'EUR') return amount;
    if (currency === 'USD') return Math.round(amount * 0.9 * 100) / 100;
    if (currency === 'RSD') return Math.round(amount * 0.0086 * 100) / 100;
    return amount;
  },
}));

// Dynamic import ensures sheets.ts is evaluated AFTER `mock.module` above.
// Without this, bun hoists static imports, sheets.ts binds the real logger,
// and `logMock.*` never records the calls we want to assert on.
const sheetsMod = await import('./sheets');
const {
  appendExpenseRow,
  appendExpenseRows,
  appendExpenseRowsRaw,
  cloneMonthTab,
  createEmptyMonthTab,
  createExpenseSpreadsheet,
  deleteExpenseRowsByIndex,
  enqueueSheetWrite,
  ensureSheetColumns,
  findAndDeleteExpenseRow,
  GOOGLE_SHEETS_LIMITS,
  getSpreadsheetUrl,
  googleConn,
  isRateLimitError,
  listMonthTabs,
  monthTabExists,
  readExpenseHeaders,
  readExpenseRowsRaw,
  readExpensesFromSheet,
  readMonthBudget,
  renameSpreadsheet,
  repairDateSerials,
  sortExpensesTab,
  verifySpreadsheetAccess,
  withSheetsRetry,
  writeMonthBudgetRow,
} = sheetsMod;

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
  mockSpreadsheetsBatchUpdate.mockReset().mockResolvedValue({ data: {} });
  mockSpreadsheetsGet.mockReset().mockResolvedValue({
    data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
  });
  mockSpreadsheetsCreate.mockReset().mockResolvedValue({
    data: { spreadsheetId: 'new-sheet-id', sheets: [{ properties: { sheetId: 0 } }] },
  });
  mockSheetsCopyTo.mockReset().mockResolvedValue({ data: { sheetId: 42 } });
  mockIsTokenExpiredError.mockReset().mockReturnValue(false);
  logMock.trace.mockReset();
  logMock.debug.mockReset();
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();
  logMock.fatal.mockReset();
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

// ── findAndDeleteExpenseRow ────────────────────────────────────────────────

describe('findAndDeleteExpenseRow', () => {
  beforeEach(() => {
    mockSpreadsheetsBatchUpdate.mockReset().mockResolvedValue({ data: {} });
  });

  test('finds matching row and deletes via batchUpdate; returns 1-based row index', async () => {
    // Headers row + 3 data rows. The match is on row 3 (1-based: header=1, data start=2).
    // Headers: Дата | Категория | Комментарий | EUR (calc) | RSD (дин.) | Rate (→EUR)
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['2026-04-15', 'Алекс', 'Кофе', '4.3', 500, 0.0086], // row 2
          ['2026-04-15', 'Алекс', 'Ноут для умного дома', '348.5', 41000, 0.0085], // row 3 — match
          ['2026-04-15', 'Еда', 'Пицца', '8.5', 1000, 0.0085], // row 4
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Ноут для умного дома',
      amount: 41000,
      currency: 'RSD',
    });

    expect(result.deletedRowIndex).toBe(3);
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
    const call = mockSpreadsheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: {
        requests: Array<{
          deleteDimension: { range: { dimension: string; startIndex: number; endIndex: number } };
        }>;
      };
    };
    const req = call.requestBody.requests[0];
    expect(req?.deleteDimension.range.dimension).toBe('ROWS');
    expect(req?.deleteDimension.range.startIndex).toBe(2); // 0-based: row 3 -> startIndex 2
    expect(req?.deleteDimension.range.endIndex).toBe(3);
  });

  test('returns deletedRowIndex=null when no row matches', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['2026-04-15', 'Еда', 'Пицца', '8.5', 1000, 0.0085],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Ноут для умного дома',
      amount: 41000,
      currency: 'RSD',
    });

    expect(result.deletedRowIndex).toBeNull();
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
  });

  test('matches first row when multiple identical rows exist (delete-one-per-call semantics)', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['2026-04-15', 'Алекс', 'Ноут', '348.5', 41000, 0.0085], // row 2 — first match
          ['2026-04-15', 'Алекс', 'Ноут', '348.5', 41000, 0.0085], // row 3 — also matches
          ['2026-04-15', 'Алекс', 'Ноут', '348.5', 41000, 0.0085], // row 4 — also matches
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Ноут',
      amount: 41000,
      currency: 'RSD',
    });

    // First match (row 2) is deleted — repeated calls handle dups
    expect(result.deletedRowIndex).toBe(2);
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
  });

  test('does not match if comment differs (avoids deleting unrelated expense)', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['2026-04-15', 'Алекс', 'Совершенно другой расход', '348.5', 41000, 0.0085],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Ноут',
      amount: 41000,
      currency: 'RSD',
    });

    expect(result.deletedRowIndex).toBeNull();
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
  });

  test('tolerates float round-trip error for fractional amounts (regression)', async () => {
    // Sheets round-trip often drifts fractional floats by ~1e-14.
    // Strict === would miss the row and silently leave it in the sheet.
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'USD ($)', 'Rate (→EUR)'],
          // criteria.amount = 12.34; sheet returns what Sheets actually stores
          ['2026-04-15', 'Coffee', 'latte', 10.61, 12.339999999999996, 0.86],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Coffee',
      comment: 'latte',
      amount: 12.34,
      currency: 'USD',
    });

    expect(result.deletedRowIndex).toBe(2);
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
  });

  test('still rejects amounts that differ by more than half a cent', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'USD ($)', 'Rate (→EUR)'],
          ['2026-04-15', 'Coffee', 'latte', 10.61, 12.35, 0.86],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Coffee',
      comment: 'latte',
      amount: 12.34, // sheet has 12.35 — a real different amount
      currency: 'USD',
    });

    expect(result.deletedRowIndex).toBeNull();
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
  });

  test('does NOT match "EUR (calc)" column when looking up EUR currency (regression)', async () => {
    // Layout where EUR (calc) comes BEFORE the EUR currency column —
    // defensive against future column reorders.
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'EUR (€)', 'Rate (→EUR)'],
          // EUR (calc) column holds the computed value 100.  EUR currency column holds 100 too.
          // Without the fix, findIndex would match "EUR (calc)" first (index 3)
          // and read the computed EUR from the wrong column.
          ['2026-04-15', 'Алекс', 'Coffee', 100, 100, 1.0],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Coffee',
      amount: 100,
      currency: 'EUR',
    });

    // Even with both columns present in the wrong order, the correct row is found.
    expect(result.deletedRowIndex).toBe(2);
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
  });

  test('serializes concurrent deletes through the per-spreadsheet queue (regression)', async () => {
    // Two concurrent deletes must not run read-then-delete in parallel —
    // otherwise both can read the pre-delete row numbers and the second
    // deleteDimension shifts a stale index, removing the wrong row.
    // The queue guarantees strict sequencing: second values.get runs only
    // after the first batchUpdate has resolved.
    const callOrder: string[] = [];

    mockValuesGet.mockImplementation(async () => {
      callOrder.push('read');
      // Small delay lets a racy implementation interleave reads
      await Bun.sleep(5);
      return {
        data: {
          values: [
            ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
            ['2026-04-15', 'Алекс', 'Coffee', 4.3, 500, 0.0086],
          ],
        },
      };
    });

    mockSpreadsheetsBatchUpdate.mockImplementation(async () => {
      callOrder.push('delete');
      return { data: {} };
    });

    const criteria = {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Coffee',
      amount: 500,
      currency: 'RSD',
    };

    const p1 = findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, criteria);
    const p2 = findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, criteria);
    await Promise.all([p1, p2]);

    // Expected strict interleaving: read → delete → read → delete
    expect(callOrder).toEqual(['read', 'delete', 'read', 'delete']);
  });

  test('handles date stored as Sheets serial number (UNFORMATTED_VALUE)', async () => {
    // 2026-04-15 = serial 46127 (days since 1899-12-30)
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          [46127, 'Алекс', 'Ноут', '348.5', 41000, 0.0085],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Ноут',
      amount: 41000,
      currency: 'RSD',
    });

    expect(result.deletedRowIndex).toBe(2);
  });
});

describe('writeMonthBudgetRow ensureTab option', () => {
  const mockSpreadsheetsGet = mockSheets.spreadsheets.get as ReturnType<typeof mock>;

  beforeEach(() => {
    mockSpreadsheetsGet.mockReset().mockResolvedValue({
      data: { sheets: [{ properties: { sheetId: 1, title: 'Apr' } }] },
    });
    mockValuesGet.mockReset().mockResolvedValue({ data: { values: [] } });
    mockValuesAppend.mockReset().mockResolvedValue({
      data: { updates: { updatedRange: 'Apr!A2:C2', updatedRows: 1 } },
    });
    mockValuesUpdate.mockReset().mockResolvedValue({ data: {} });
  });

  test('defaults to ensureTab:true — probes tab existence via spreadsheets.get', async () => {
    await writeMonthBudgetRow(TEST_CONN, TEST_SPREADSHEET, 'Apr', {
      category: 'Food',
      limit: 500,
      currency: 'EUR',
    });
    expect(mockSpreadsheetsGet).toHaveBeenCalledTimes(1);
    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
  });

  test('ensureTab:false skips the spreadsheets.get probe — saves one read per call', async () => {
    await writeMonthBudgetRow(
      TEST_CONN,
      TEST_SPREADSHEET,
      'Apr',
      { category: 'Food', limit: 500, currency: 'EUR' },
      { ensureTab: false },
    );
    expect(mockSpreadsheetsGet).not.toHaveBeenCalled();
    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
  });
});

describe('listMonthTabs', () => {
  const mockSpreadsheetsGet = mockSheets.spreadsheets.get as ReturnType<typeof mock>;

  beforeEach(() => {
    mockSpreadsheetsGet.mockReset();
  });

  test('returns only month-abbreviation tabs, filters Expenses and custom sheets', async () => {
    mockSpreadsheetsGet.mockResolvedValue({
      data: {
        sheets: [
          { properties: { sheetId: 0, title: 'Expenses' } },
          { properties: { sheetId: 1, title: 'Jan' } },
          { properties: { sheetId: 2, title: 'Feb' } },
          { properties: { sheetId: 3, title: 'MySheet' } },
          { properties: { sheetId: 4, title: 'Apr' } },
        ],
      },
    });

    const tabs = await listMonthTabs(TEST_CONN, TEST_SPREADSHEET);

    expect(tabs).toEqual(['Jan', 'Feb', 'Apr']);
    expect(mockSpreadsheetsGet).toHaveBeenCalledTimes(1);
  });

  test('returns empty array when no month tabs exist', async () => {
    mockSpreadsheetsGet.mockResolvedValue({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
    });

    const tabs = await listMonthTabs(TEST_CONN, TEST_SPREADSHEET);
    expect(tabs).toEqual([]);
  });

  test('returns empty array and does not throw when API returns malformed data', async () => {
    mockSpreadsheetsGet.mockResolvedValue({ data: {} });
    const tabs = await listMonthTabs(TEST_CONN, TEST_SPREADSHEET);
    expect(tabs).toEqual([]);
  });

  test('rethrows underlying error so caller can classify it (rate-limit, etc.)', async () => {
    mockSpreadsheetsGet.mockRejectedValue({ code: 403, message: 'permissionDenied' });
    await expect(listMonthTabs(TEST_CONN, TEST_SPREADSHEET)).rejects.toMatchObject({ code: 403 });
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

// ── googleConn ──────────────────────────────────────────────────────────────

describe('googleConn', () => {
  test('builds GoogleConn from a group object', () => {
    const conn = googleConn({
      google_refresh_token: 'tok-abc',
      oauth_client: 'current',
    });
    expect(conn).toEqual({ refreshToken: 'tok-abc', oauthClient: 'current' });
  });

  test('throws when refresh token is null', () => {
    expect(() => googleConn({ google_refresh_token: null, oauth_client: 'current' })).toThrow(
      /refresh token/,
    );
  });

  test('propagates oauth_client value unchanged (legacy)', () => {
    const conn = googleConn({
      google_refresh_token: 'tok',
      oauth_client: 'legacy',
    });
    expect(conn.oauthClient).toBe('legacy');
  });
});

// ── getSpreadsheetUrl ───────────────────────────────────────────────────────

describe('getSpreadsheetUrl', () => {
  test('formats the canonical Google Sheets URL', () => {
    expect(getSpreadsheetUrl('abc123')).toBe('https://docs.google.com/spreadsheets/d/abc123');
  });

  test('does not URL-encode the id (caller responsibility)', () => {
    expect(getSpreadsheetUrl('A_B-C_1')).toBe('https://docs.google.com/spreadsheets/d/A_B-C_1');
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

// ── appendExpenseRow (single-row variant) ───────────────────────────────────

describe('appendExpenseRow', () => {
  test('appends a single row using existing currency column', async () => {
    await appendExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-10',
      category: 'Еда',
      comment: 'lunch',
      amounts: { RSD: 500 },
      eurAmount: 4.3,
      rate: 0.0086,
    });
    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
    const callArgs = mockValuesAppend.mock.calls[0]?.[0] as ValuesAppendArgs;
    expect(callArgs.requestBody.values).toHaveLength(1);
    expect(callArgs.requestBody.values[0]?.[0]).toBe('2026-04-10');
    expect(callArgs.requestBody.values[0]?.[1]).toBe('Еда');
    expect(callArgs.requestBody.values[0]?.[4]).toBe(500);
    expect(callArgs.requestBody.values[0]?.[5]).toBe(0.0086);
  });

  test('inserts a missing currency column before writing', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'Rate (→EUR)']],
      },
    });

    await appendExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-10',
      category: 'Travel',
      comment: 'taxi',
      amounts: { USD: 20 },
      eurAmount: 18.1,
      rate: 0.905,
    });

    expect(mockSpreadsheetsGet).toHaveBeenCalled();
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalled();
    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
  });

  test('omits EUR formula (writes literal eurAmount) when rate is missing', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'USD ($)', 'Rate (→EUR)']],
      },
    });

    await appendExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-10',
      category: 'Travel',
      comment: 'taxi',
      amounts: { USD: 20 },
      eurAmount: 18.1,
    });

    const callArgs = mockValuesAppend.mock.calls[0]?.[0] as ValuesAppendArgs;
    expect(callArgs.requestBody.values[0]?.[3]).toBe(18.1);
    expect(callArgs.requestBody.values[0]?.[5]).toBe('');
  });

  test('serializes with enqueueSheetWrite — concurrent single-row calls do not overlap appends', async () => {
    let overlap = false;
    let active = 0;
    mockValuesAppend.mockImplementation(async () => {
      active++;
      if (active > 1) overlap = true;
      await Bun.sleep(10);
      active--;
      return { data: { updates: { updatedRange: 'Expenses!A2:F2', updatedRows: 1 } } };
    });

    await Promise.all([
      appendExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
        date: '2026-04-10',
        category: 'A',
        comment: '',
        amounts: { EUR: 1 },
        eurAmount: 1,
      }),
      appendExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
        date: '2026-04-10',
        category: 'B',
        comment: '',
        amounts: { EUR: 2 },
        eurAmount: 2,
      }),
    ]);

    expect(overlap).toBe(false);
    expect(mockValuesAppend).toHaveBeenCalledTimes(2);
  });
});

// ── appendExpenseRows — additional scenarios ────────────────────────────────

describe('appendExpenseRows — column-insertion paths', () => {
  test('adds Rate column when missing, then appends', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)']],
      },
    });

    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-10',
        category: 'X',
        comment: '',
        amounts: { RSD: 500 },
        eurAmount: 4.3,
        rate: 0.0086,
      },
    ]);

    expect(mockSpreadsheetsGet).toHaveBeenCalled();
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalled();
    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
  });

  test('inserts new currency column when missing in batch path', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'Rate (→EUR)']],
      },
    });

    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-10',
        category: 'Y',
        comment: '',
        amounts: { GBP: 10 },
        eurAmount: 11.5,
        rate: 1.15,
      },
    ]);

    const callArgs = mockValuesAppend.mock.calls[0]?.[0] as ValuesAppendArgs;
    expect(callArgs.requestBody.values).toHaveLength(1);
    expect(callArgs.requestBody.values[0]?.[0]).toBe('2026-04-10');
    // GBP column was inserted before EUR (calc)
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalled();
  });
});

// ── ensureSheetColumns ──────────────────────────────────────────────────────

describe('ensureSheetColumns', () => {
  test('no-op when all currency columns and Rate exist', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'USD ($)', 'Rate (→EUR)']],
      },
    });

    await ensureSheetColumns(TEST_CONN, TEST_SPREADSHEET, ['USD']);

    expect(mockValuesGet).toHaveBeenCalledTimes(1);
    expect(mockSpreadsheetsGet).not.toHaveBeenCalled();
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
  });

  test('inserts each missing currency column and appends Rate if absent', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [['Дата', 'Категория', 'Комментарий', 'EUR (calc)']],
      },
    });

    await ensureSheetColumns(TEST_CONN, TEST_SPREADSHEET, ['USD', 'RSD']);

    // 2 inserts + 1 rate column = 3 get+batchUpdate pairs
    expect(mockSpreadsheetsGet).toHaveBeenCalledTimes(3);
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(3);
  });
});

// ── verifySpreadsheetAccess ─────────────────────────────────────────────────

describe('verifySpreadsheetAccess', () => {
  test('returns true on successful spreadsheets.get', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
    });
    const ok = await verifySpreadsheetAccess(TEST_CONN, TEST_SPREADSHEET);
    expect(ok).toBe(true);
  });

  test('returns false on non-auth error (e.g., 404)', async () => {
    mockSpreadsheetsGet.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 404 }));
    const ok = await verifySpreadsheetAccess(TEST_CONN, TEST_SPREADSHEET);
    expect(ok).toBe(false);
    expect(logMock.error).toHaveBeenCalled();
  });

  test('throws OAuthError when token is expired/revoked', async () => {
    mockIsTokenExpiredError.mockReturnValue(true);
    mockSpreadsheetsGet.mockRejectedValueOnce(new Error('invalid_grant'));
    await expect(verifySpreadsheetAccess(TEST_CONN, TEST_SPREADSHEET)).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
  });
});

// ── monthTabExists ──────────────────────────────────────────────────────────

describe('monthTabExists', () => {
  test('true when a sheet with the month title is present', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: {
        sheets: [
          { properties: { sheetId: 0, title: 'Expenses' } },
          { properties: { sheetId: 1, title: 'Mar' } },
        ],
      },
    });
    expect(await monthTabExists(TEST_CONN, TEST_SPREADSHEET, 'Mar')).toBe(true);
  });

  test('false when the month is absent', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
    });
    expect(await monthTabExists(TEST_CONN, TEST_SPREADSHEET, 'Mar')).toBe(false);
  });

  test('swallows errors and returns false (defensive path)', async () => {
    mockSpreadsheetsGet.mockRejectedValueOnce(new Error('transient'));
    expect(await monthTabExists(TEST_CONN, TEST_SPREADSHEET, 'Mar')).toBe(false);
    expect(logMock.error).toHaveBeenCalled();
  });
});

// ── createEmptyMonthTab ─────────────────────────────────────────────────────

describe('createEmptyMonthTab', () => {
  test('issues addSheet + format batchUpdate and uses returned sheetId', async () => {
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({
      data: {
        replies: [{ addSheet: { properties: { sheetId: 77 } } }],
      },
    });
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({ data: {} });

    await createEmptyMonthTab(TEST_CONN, TEST_SPREADSHEET, 'Apr');

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(2);
    const formatCall = mockSpreadsheetsBatchUpdate.mock.calls[1]?.[0];
    const serialized = JSON.stringify(formatCall);
    expect(serialized).toContain('"sheetId":77');
    expect(serialized).toContain('"Category"');
    expect(serialized).toContain('"Limit"');
    expect(serialized).toContain('"Currency"');
  });

  test('throws when addSheet reply has no sheetId', async () => {
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({
      data: { replies: [{ addSheet: { properties: {} } }] },
    });
    await expect(createEmptyMonthTab(TEST_CONN, TEST_SPREADSHEET, 'Apr')).rejects.toThrow(
      /Failed to get sheetId/,
    );
  });
});

// ── readMonthBudget ─────────────────────────────────────────────────────────

describe('readMonthBudget', () => {
  test('parses category/limit/currency rows, dropping incomplete ones', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [['Food', '500', 'EUR'], ['Rent', '800', 'EUR'], ['', '', ''], ['Bad']],
      },
    });
    const rows = await readMonthBudget(TEST_CONN, TEST_SPREADSHEET, 'Apr');
    expect(rows).toEqual([
      { category: 'Food', limit: 500, currency: 'EUR' },
      { category: 'Rent', limit: 800, currency: 'EUR' },
    ]);
  });

  test('defaults currency to EUR when missing', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: [['Food', '250']] },
    });
    const rows = await readMonthBudget(TEST_CONN, TEST_SPREADSHEET, 'Apr');
    expect(rows).toEqual([{ category: 'Food', limit: 250, currency: 'EUR' }]);
  });

  test('filters rows with non-numeric limit', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: [['Cat', 'abc', 'EUR']] },
    });
    const rows = await readMonthBudget(TEST_CONN, TEST_SPREADSHEET, 'Apr');
    expect(rows).toEqual([]);
  });

  test('returns empty array on read error (defensive)', async () => {
    mockValuesGet.mockRejectedValueOnce(new Error('nope'));
    const rows = await readMonthBudget(TEST_CONN, TEST_SPREADSHEET, 'Apr');
    expect(rows).toEqual([]);
    expect(logMock.error).toHaveBeenCalled();
  });

  test('returns empty array when sheet has no data', async () => {
    mockValuesGet.mockResolvedValueOnce({ data: { values: [] } });
    const rows = await readMonthBudget(TEST_CONN, TEST_SPREADSHEET, 'Apr');
    expect(rows).toEqual([]);
  });
});

// ── writeMonthBudgetRow — upsert semantics ──────────────────────────────────

describe('writeMonthBudgetRow — upsert', () => {
  test('updates existing row when category already present (case-insensitive)', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 1, title: 'Apr' } }] },
    });
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Food', '300', 'EUR'],
          ['Rent', '800', 'EUR'],
        ],
      },
    });

    await writeMonthBudgetRow(TEST_CONN, TEST_SPREADSHEET, 'Apr', {
      category: 'food',
      limit: 500,
      currency: 'EUR',
    });

    expect(mockValuesAppend).not.toHaveBeenCalled();
    expect(mockValuesUpdate).toHaveBeenCalledTimes(1);
    const call = mockValuesUpdate.mock.calls[0]?.[0] as {
      range: string;
      requestBody: { values: unknown[][] };
    };
    expect(call.range).toBe('Apr!A2:C2');
    expect(call.requestBody.values).toEqual([['food', 500, 'EUR']]);
  });

  test('appends new row when category not present', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 1, title: 'Apr' } }] },
    });
    mockValuesGet.mockResolvedValueOnce({ data: { values: [['Rent', '800', 'EUR']] } });

    await writeMonthBudgetRow(TEST_CONN, TEST_SPREADSHEET, 'Apr', {
      category: 'Food',
      limit: 500,
      currency: 'EUR',
    });

    expect(mockValuesUpdate).not.toHaveBeenCalled();
    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
  });

  test('creates the tab when ensureTab:true and tab is missing', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
    });
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({
      data: { replies: [{ addSheet: { properties: { sheetId: 99 } } }] },
    });
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({ data: {} });
    mockValuesGet.mockResolvedValueOnce({ data: { values: [] } });

    await writeMonthBudgetRow(TEST_CONN, TEST_SPREADSHEET, 'Apr', {
      category: 'Food',
      limit: 500,
      currency: 'EUR',
    });

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(2);
    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
  });
});

// ── cloneMonthTab ───────────────────────────────────────────────────────────

describe('cloneMonthTab', () => {
  test('copies source sheet to target and renames it', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 7, title: 'Mar' } }] },
    });
    mockSheetsCopyTo.mockResolvedValueOnce({ data: { sheetId: 999 } });

    await cloneMonthTab(TEST_CONN, 'src-sheet', 'Mar', 'dst-sheet', 'Apr');

    expect(mockSheetsCopyTo).toHaveBeenCalledTimes(1);
    const copyArgs = mockSheetsCopyTo.mock.calls[0]?.[0] as {
      spreadsheetId: string;
      sheetId: number;
      requestBody: { destinationSpreadsheetId: string };
    };
    expect(copyArgs.spreadsheetId).toBe('src-sheet');
    expect(copyArgs.sheetId).toBe(7);
    expect(copyArgs.requestBody.destinationSpreadsheetId).toBe('dst-sheet');

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
    const renameArgs = mockSpreadsheetsBatchUpdate.mock.calls[0]?.[0] as {
      spreadsheetId: string;
      requestBody: {
        requests: Array<{ updateSheetProperties: { properties: { title: string } } }>;
      };
    };
    expect(renameArgs.spreadsheetId).toBe('dst-sheet');
    expect(renameArgs.requestBody.requests[0]?.updateSheetProperties.properties.title).toBe('Apr');
  });

  test('throws when source month tab not found', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
    });
    await expect(cloneMonthTab(TEST_CONN, 'src-sheet', 'Mar', 'dst-sheet', 'Apr')).rejects.toThrow(
      /Source tab "Mar" not found/,
    );
    expect(mockSheetsCopyTo).not.toHaveBeenCalled();
  });

  test('throws when copyTo returns no sheetId', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 7, title: 'Mar' } }] },
    });
    mockSheetsCopyTo.mockResolvedValueOnce({ data: {} });
    await expect(cloneMonthTab(TEST_CONN, 'src-sheet', 'Mar', 'dst-sheet', 'Apr')).rejects.toThrow(
      /copyTo did not return a sheetId/,
    );
  });
});

// ── renameSpreadsheet ───────────────────────────────────────────────────────

describe('renameSpreadsheet', () => {
  test('issues updateSpreadsheetProperties batchUpdate with new title', async () => {
    await renameSpreadsheet(TEST_CONN, TEST_SPREADSHEET, 'New Title');

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
    const call = mockSpreadsheetsBatchUpdate.mock.calls[0]?.[0] as {
      spreadsheetId: string;
      requestBody: {
        requests: Array<{
          updateSpreadsheetProperties: { properties: { title: string }; fields: string };
        }>;
      };
    };
    expect(call.spreadsheetId).toBe(TEST_SPREADSHEET);
    expect(call.requestBody.requests[0]?.updateSpreadsheetProperties.properties.title).toBe(
      'New Title',
    );
    expect(call.requestBody.requests[0]?.updateSpreadsheetProperties.fields).toBe('title');
  });
});

// ── sortExpensesTab ─────────────────────────────────────────────────────────

describe('sortExpensesTab', () => {
  test('issues sortRange request with ASCENDING on column A', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
    });

    await sortExpensesTab(TEST_CONN, TEST_SPREADSHEET);

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
    const call = mockSpreadsheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: {
        requests: Array<{
          sortRange: {
            range: { sheetId: number; startRowIndex: number };
            sortSpecs: Array<{ dimensionIndex: number; sortOrder: string }>;
          };
        }>;
      };
    };
    const req = call.requestBody.requests[0];
    expect(req?.sortRange.range.startRowIndex).toBe(1);
    expect(req?.sortRange.sortSpecs[0]?.dimensionIndex).toBe(0);
    expect(req?.sortRange.sortSpecs[0]?.sortOrder).toBe('ASCENDING');
  });

  test('no-op when Expenses tab is missing', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Other' } }] },
    });
    await sortExpensesTab(TEST_CONN, TEST_SPREADSHEET);
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
  });
});

// ── readExpenseHeaders ──────────────────────────────────────────────────────

describe('readExpenseHeaders', () => {
  test('returns first row as string array', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: [['Дата', 'Категория']] },
    });
    const headers = await readExpenseHeaders(TEST_CONN, TEST_SPREADSHEET);
    expect(headers).toEqual(['Дата', 'Категория']);
  });

  test('returns empty array when no header row', async () => {
    mockValuesGet.mockResolvedValueOnce({ data: { values: [] } });
    const headers = await readExpenseHeaders(TEST_CONN, TEST_SPREADSHEET);
    expect(headers).toEqual([]);
  });
});

// ── readExpenseRowsRaw ──────────────────────────────────────────────────────

describe('readExpenseRowsRaw', () => {
  test('reads rows and converts serial dates back to ISO', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          [46127, 'Food', 'pizza'],
          ['2026-04-16', 'Coffee', 'latte'],
        ],
      },
    });

    const rows = await readExpenseRowsRaw(TEST_CONN, TEST_SPREADSHEET);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.[0]).toBe('2026-04-15');
    expect(rows[0]?.[1]).toBe('Food');
    expect(rows[1]?.[0]).toBe('2026-04-16');
  });

  test('returns empty array for empty sheet', async () => {
    mockValuesGet.mockResolvedValueOnce({ data: { values: [] } });
    const rows = await readExpenseRowsRaw(TEST_CONN, TEST_SPREADSHEET);
    expect(rows).toEqual([]);
  });

  test('stringifies non-zero columns', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [['2026-04-15', 'Food', '', 4.3, 500]],
      },
    });
    const rows = await readExpenseRowsRaw(TEST_CONN, TEST_SPREADSHEET);
    expect(rows[0]).toEqual(['2026-04-15', 'Food', '', '4.3', '500']);
  });
});

// ── appendExpenseRowsRaw ────────────────────────────────────────────────────

describe('appendExpenseRowsRaw', () => {
  test('no-op for empty rows', async () => {
    await appendExpenseRowsRaw(TEST_CONN, TEST_SPREADSHEET, []);
    expect(mockValuesAppend).not.toHaveBeenCalled();
  });

  test('appends rows as-is when headers match (or omitted)', async () => {
    await appendExpenseRowsRaw(TEST_CONN, TEST_SPREADSHEET, [
      ['2026-04-10', 'Food', 'pizza', '500', '0.0086'],
    ]);
    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
    const args = mockValuesAppend.mock.calls[0]?.[0] as {
      range: string;
      requestBody: { values: string[][] };
    };
    expect(args.range).toBe('Expenses!A2');
    expect(args.requestBody.values).toEqual([['2026-04-10', 'Food', 'pizza', '500', '0.0086']]);
  });

  test('remaps columns when source/target headers differ', async () => {
    await appendExpenseRowsRaw(
      TEST_CONN,
      TEST_SPREADSHEET,
      [
        ['2026-04-10', '500', 'Food'],
        ['2026-04-11', '300', 'Coffee'],
      ],
      ['Date', 'Amount', 'Category'],
      ['Date', 'Category', 'Amount'],
    );
    const args = mockValuesAppend.mock.calls[0]?.[0] as {
      requestBody: { values: string[][] };
    };
    expect(args.requestBody.values).toEqual([
      ['2026-04-10', 'Food', '500'],
      ['2026-04-11', 'Coffee', '300'],
    ]);
  });

  test('fills missing target columns with empty string', async () => {
    await appendExpenseRowsRaw(
      TEST_CONN,
      TEST_SPREADSHEET,
      [['2026-04-10', 'Food']],
      ['Date', 'Category'],
      ['Date', 'Category', 'Rate'],
    );
    const args = mockValuesAppend.mock.calls[0]?.[0] as {
      requestBody: { values: string[][] };
    };
    expect(args.requestBody.values).toEqual([['2026-04-10', 'Food', '']]);
  });
});

// ── deleteExpenseRowsByIndex ────────────────────────────────────────────────

describe('deleteExpenseRowsByIndex', () => {
  test('no-op for empty indices', async () => {
    await deleteExpenseRowsByIndex(TEST_CONN, TEST_SPREADSHEET, []);
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
  });

  test('processes indices in reverse sorted order (avoids shifting)', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
    });

    await deleteExpenseRowsByIndex(TEST_CONN, TEST_SPREADSHEET, [3, 8, 5]);

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
    const args = mockSpreadsheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: {
        requests: Array<{
          deleteDimension: { range: { startIndex: number; endIndex: number; dimension: string } };
        }>;
      };
    };
    const reqs = args.requestBody.requests;
    expect(reqs.map((r) => r.deleteDimension.range.startIndex)).toEqual([7, 4, 2]);
    for (const r of reqs) {
      expect(r.deleteDimension.range.endIndex - r.deleteDimension.range.startIndex).toBe(1);
      expect(r.deleteDimension.range.dimension).toBe('ROWS');
    }
  });

  test('throws when Expenses tab is missing from spreadsheet', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Other' } }] },
    });
    await expect(deleteExpenseRowsByIndex(TEST_CONN, TEST_SPREADSHEET, [2])).rejects.toThrow(
      /"Expenses" tab not found/,
    );
  });
});

// ── repairDateSerials ───────────────────────────────────────────────────────

describe('repairDateSerials', () => {
  test('returns 0 and skips write when no serials found', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: [['2026-04-15'], ['2026-04-16']] },
    });
    const count = await repairDateSerials(TEST_CONN, TEST_SPREADSHEET);
    expect(count).toBe(0);
    expect(mockValuesBatchUpdate).not.toHaveBeenCalled();
  });

  test('writes ISO dates for cells that look like Sheets serials', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [['2026-04-15'], [46127], ['2026-04-17']],
      },
    });

    const count = await repairDateSerials(TEST_CONN, TEST_SPREADSHEET);
    expect(count).toBe(1);
    expect(mockValuesBatchUpdate).toHaveBeenCalledTimes(1);
    const args = mockValuesBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: {
        valueInputOption: string;
        data: Array<{ range: string; values: string[][] }>;
      };
    };
    expect(args.requestBody.valueInputOption).toBe('USER_ENTERED');
    expect(args.requestBody.data).toEqual([{ range: 'Expenses!A3', values: [['2026-04-15']] }]);
  });

  test('ignores out-of-range numeric cells', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: [[12345]] },
    });
    const count = await repairDateSerials(TEST_CONN, TEST_SPREADSHEET);
    expect(count).toBe(0);
    expect(mockValuesBatchUpdate).not.toHaveBeenCalled();
  });
});

// ── createExpenseSpreadsheet ────────────────────────────────────────────────

describe('createExpenseSpreadsheet', () => {
  test('creates spreadsheet, auto-resizes columns, creates current month tab', async () => {
    mockSpreadsheetsCreate.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'new-sheet-id',
        sheets: [{ properties: { sheetId: 5 } }],
      },
    });
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({ data: {} }); // auto-resize
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({
      data: { replies: [{ addSheet: { properties: { sheetId: 100 } } }] },
    });
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({ data: {} }); // format month tab

    const result = await createExpenseSpreadsheet(TEST_CONN, 'EUR', ['EUR', 'USD', 'RSD']);

    expect(result.spreadsheetId).toBe('new-sheet-id');
    expect(result.spreadsheetUrl).toBe('https://docs.google.com/spreadsheets/d/new-sheet-id');

    expect(mockSpreadsheetsCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockSpreadsheetsCreate.mock.calls[0]?.[0] as {
      requestBody: {
        properties: { title: string };
        sheets: Array<{
          properties: { title: string; gridProperties?: { frozenRowCount: number } };
          data: Array<{ rowData: Array<{ values: Array<{ userEnteredValue: unknown }> }> }>;
        }>;
      };
    };
    expect(createArgs.requestBody.properties.title).toContain('Expenses Tracker');
    expect(createArgs.requestBody.sheets[0]?.properties.title).toBe('Expenses');
    expect(createArgs.requestBody.sheets[0]?.properties.gridProperties?.frozenRowCount).toBe(1);

    const headerValues = createArgs.requestBody.sheets[0]?.data[0]?.rowData[0]?.values ?? [];
    const titles = headerValues.map(
      (c) => (c.userEnteredValue as { stringValue?: string }).stringValue,
    );
    expect(titles[0]).toBe('Дата');
    expect(titles).toContain('EUR (calc)');
    expect(titles).toContain('Rate (→EUR)');
    expect(titles.some((t) => t?.startsWith('EUR '))).toBe(true);
    expect(titles.some((t) => t?.startsWith('USD '))).toBe(true);
    expect(titles.some((t) => t?.startsWith('RSD '))).toBe(true);

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(3);
  });

  test('throws when spreadsheet creation does not return an id', async () => {
    mockSpreadsheetsCreate.mockResolvedValueOnce({ data: {} });
    await expect(createExpenseSpreadsheet(TEST_CONN, 'EUR', ['EUR'])).rejects.toThrow(
      /did not return an ID/,
    );
  });

  test('swallows month-tab creation failure — still returns spreadsheet', async () => {
    mockSpreadsheetsCreate.mockResolvedValueOnce({
      data: { spreadsheetId: 'id-x', sheets: [{ properties: { sheetId: 5 } }] },
    });
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({ data: {} }); // auto-resize
    mockSpreadsheetsBatchUpdate.mockRejectedValueOnce(new Error('tab create boom'));

    const result = await createExpenseSpreadsheet(TEST_CONN, 'EUR', ['EUR']);
    expect(result.spreadsheetId).toBe('id-x');
    expect(logMock.error).toHaveBeenCalled();
  });
});

// ── readExpensesFromSheet ───────────────────────────────────────────────────

describe('readExpensesFromSheet', () => {
  test('parses expenses with currency columns and calculates EUR from rate', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['2026-04-10', 'Food', 'lunch', '4.3', '500', '0.0086'],
          ['2026-04-11', 'Coffee', 'latte', '2.58', '300', '0.0086'],
        ],
      },
    });

    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses).toHaveLength(2);
    expect(result.expenses[0]).toMatchObject({
      date: '2026-04-10',
      category: 'Food',
      comment: 'lunch',
      amounts: { RSD: 500 },
      rate: 0.0086,
    });
    expect(result.expenses[0]?.eurAmount).toBeCloseTo(4.3, 2);
    expect(result.errors).toEqual([]);
  });

  test('flags rows with amounts in multiple currency columns', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          [
            'Дата',
            'Категория',
            'Комментарий',
            'EUR (calc)',
            'USD ($)',
            'RSD (дин.)',
            'Rate (→EUR)',
          ],
          ['2026-04-10', 'X', 'c', '4.3', '5', '500', '0.0086'],
        ],
      },
    });
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses).toEqual([]);
    expect(result.errors).toEqual([
      { row: 2, date: '2026-04-10', currencies: ['USD', 'RSD'], category: 'X' },
    ]);
  });

  test('returns empty result set for empty sheet', async () => {
    mockValuesGet.mockResolvedValueOnce({ data: { values: [] } });
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result).toEqual({ expenses: [], errors: [], eurMismatches: [] });
  });

  test('throws when required header columns missing', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: { values: [['Дата', 'Категория']] },
    });
    await expect(readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET)).rejects.toThrow(
      /Required columns not found/,
    );
  });

  test('EUR-native row: eurAmount equals amount', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'EUR (€)', 'Rate (→EUR)'],
          ['2026-04-10', 'Food', '', '10', '10', ''],
        ],
      },
    });
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses).toHaveLength(1);
    expect(result.expenses[0]?.eurAmount).toBe(10);
    expect(result.expenses[0]?.amounts).toEqual({ EUR: 10 });
  });

  test('falls back to EUR(calc) when no currency column amount present', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'USD ($)', 'Rate (→EUR)'],
          ['2026-04-10', 'Old', 'import', '42', '', ''],
        ],
      },
    });
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses).toHaveLength(1);
    expect(result.expenses[0]?.amounts).toEqual({ EUR: 42 });
    expect(result.expenses[0]?.eurAmount).toBe(42);
  });

  test('skips rows without date', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['', 'Food', '', '', '500', '0.0086'],
          ['2026-04-11', 'Coffee', '', '', '300', '0.0086'],
        ],
      },
    });
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses).toHaveLength(1);
    expect(result.expenses[0]?.date).toBe('2026-04-11');
  });

  test('uses converter fallback when no rate column stored', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'USD ($)'],
          ['2026-04-10', 'Food', '', '', '10'],
        ],
      },
    });
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses).toHaveLength(1);
    // Mocked convertToEUR: 10 * 0.9 = 9.0
    expect(result.expenses[0]?.eurAmount).toBe(9);
  });

  test('reports EUR mismatch when sheet EUR diverges >2x from recalculated', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['2026-04-10', 'Food', 'lunch', '100', '500', '0.0086'],
        ],
      },
    });
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.eurMismatches).toHaveLength(1);
    expect(result.eurMismatches[0]).toMatchObject({
      row: 2,
      date: '2026-04-10',
      category: 'Food',
      sheetEur: 100,
    });
    expect(logMock.warn).toHaveBeenCalled();
  });

  test('no mismatch reported when sheet EUR is within 2x of recalculated', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['2026-04-10', 'Food', 'lunch', '4.4', '500', '0.0086'],
        ],
      },
    });
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.eurMismatches).toEqual([]);
  });
});

// ── findAndDeleteExpenseRow — additional edge cases ─────────────────────────

describe('findAndDeleteExpenseRow — edge cases', () => {
  test('returns null and does NOT delete when currency column not in headers', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'Rate (→EUR)'],
          ['2026-04-15', 'Coffee', 'latte', '4.3', '0.86'],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Coffee',
      comment: 'latte',
      amount: 5,
      currency: 'USD',
    });

    expect(result.deletedRowIndex).toBeNull();
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalled();
  });

  test('returns null when sheet has only header row', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'USD ($)', 'Rate (→EUR)']],
      },
    });
    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'x',
      comment: '',
      amount: 1,
      currency: 'USD',
    });
    expect(result.deletedRowIndex).toBeNull();
  });
});
