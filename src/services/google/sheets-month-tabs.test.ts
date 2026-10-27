/** Tests for sheets.ts month budget tabs — existence, creation, read/upsert, cloning */
import { beforeEach, describe, expect, type mock, test } from 'bun:test';
import {
  logMock,
  mockSheets,
  mockSheetsCopyTo,
  mockSpreadsheetsBatchUpdate,
  mockSpreadsheetsGet,
  mockValuesAppend,
  mockValuesGet,
  mockValuesUpdate,
  resetSheetsMocks,
  TEST_CONN,
  TEST_SPREADSHEET,
} from './sheets-test-support';

// Dynamic import keeps './sheets' evaluated AFTER the mock.module calls in
// sheets-test-support (otherwise bun binds the real logger/googleapis).
const {
  cloneMonthTab,
  createEmptyMonthTab,
  listMonthTabs,
  monthTabExists,
  readMonthBudget,
  writeMonthBudgetRow,
} = await import('./sheets');

beforeEach(resetSheetsMocks);

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
