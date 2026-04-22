// Tests for the pure inheritance-expansion logic used in Budget sheet migration,
// plus integration-style tests for runYearSplitMigration with mocked googleapis/sheets.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { GoogleConn } from './sheets';

// Silence + assert on logger calls. Source imports '../../utils/logger.ts' with
// explicit extension — mock path must match exactly for identity substitution.
const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Mocks for googleapis (spreadsheets.get, drive.files.copy, values.get, batchUpdate) ─

const mockSpreadsheetsGet = mock(
  (
    ..._args: unknown[]
  ): Promise<{ data: { sheets?: Array<{ properties?: { title?: string; sheetId?: number } }> } }> =>
    Promise.resolve({ data: { sheets: [{ properties: { title: 'Expenses', sheetId: 0 } }] } }),
);
const mockValuesGet = mock(
  (..._args: unknown[]): Promise<{ data: { values?: unknown[][] } }> =>
    Promise.resolve({ data: { values: [] } }),
);
const mockSpreadsheetsBatchUpdate = mock(
  (..._args: unknown[]): Promise<{ data: Record<string, unknown> }> =>
    Promise.resolve({ data: {} }),
);
const mockDriveFilesCopy = mock(
  (..._args: unknown[]): Promise<{ data: { id?: string } }> =>
    Promise.resolve({ data: { id: 'backup-file-id-123' } }),
);

mock.module('googleapis', () => ({
  google: {
    sheets: () => ({
      spreadsheets: {
        get: mockSpreadsheetsGet,
        values: { get: mockValuesGet },
        batchUpdate: mockSpreadsheetsBatchUpdate,
      },
    }),
    drive: () => ({
      files: { copy: mockDriveFilesCopy },
    }),
  },
}));

mock.module('./oauth', () => ({
  getAuthenticatedClient: () => ({}),
}));

// ── Mocks for ./sheets helpers used by budget-migration ──────────────────────

const mockReadExpenseHeaders = mock(
  (..._args: unknown[]): Promise<string[]> =>
    Promise.resolve(['Date', 'Category', 'Comment', 'EUR (calc)', 'Rate (→EUR)']),
);
const mockReadExpenseRowsRaw = mock(
  (..._args: unknown[]): Promise<string[][]> => Promise.resolve([]),
);
const mockAppendExpenseRowsRaw = mock((..._args: unknown[]): Promise<void> => Promise.resolve());
const mockDeleteExpenseRowsByIndex = mock(
  (..._args: unknown[]): Promise<void> => Promise.resolve(),
);
const mockMonthTabExists = mock((..._args: unknown[]): Promise<boolean> => Promise.resolve(false));
const mockCreateEmptyMonthTab = mock((..._args: unknown[]): Promise<void> => Promise.resolve());
const mockWriteMonthBudgetRow = mock((..._args: unknown[]): Promise<void> => Promise.resolve());
const mockRepairEurFormulas = mock((..._args: unknown[]): Promise<number> => Promise.resolve(0));
const mockSortExpensesTab = mock((..._args: unknown[]): Promise<void> => Promise.resolve());

mock.module('./sheets', () => ({
  readExpenseHeaders: mockReadExpenseHeaders,
  readExpenseRowsRaw: mockReadExpenseRowsRaw,
  appendExpenseRowsRaw: mockAppendExpenseRowsRaw,
  deleteExpenseRowsByIndex: mockDeleteExpenseRowsByIndex,
  monthTabExists: mockMonthTabExists,
  createEmptyMonthTab: mockCreateEmptyMonthTab,
  writeMonthBudgetRow: mockWriteMonthBudgetRow,
  repairEurFormulas: mockRepairEurFormulas,
  sortExpensesTab: mockSortExpensesTab,
  // withSheetsRetry is used — pass the fn through
  withSheetsRetry: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

// Dynamic import AFTER mocks so budget-migration.ts binds the mocked modules.
const bm = await import('./budget-migration');
const { applyInheritance, yearFromDateCell, runYearSplitMigration } = bm;
type FlatBudgetRow = import('./budget-migration').FlatBudgetRow;

const CONN: GoogleConn = { refreshToken: 'rt', oauthClient: 'current' };

beforeEach(() => {
  mockSpreadsheetsGet.mockReset().mockResolvedValue({
    data: { sheets: [{ properties: { title: 'Expenses', sheetId: 0 } }] },
  });
  mockValuesGet.mockReset().mockResolvedValue({ data: { values: [] } });
  mockSpreadsheetsBatchUpdate.mockReset().mockResolvedValue({ data: {} });
  mockDriveFilesCopy.mockReset().mockResolvedValue({ data: { id: 'backup-file-id-123' } });
  mockReadExpenseHeaders
    .mockReset()
    .mockResolvedValue(['Date', 'Category', 'Comment', 'EUR (calc)', 'Rate (→EUR)']);
  mockReadExpenseRowsRaw.mockReset().mockResolvedValue([]);
  mockAppendExpenseRowsRaw.mockReset().mockResolvedValue(undefined);
  mockDeleteExpenseRowsByIndex.mockReset().mockResolvedValue(undefined);
  mockMonthTabExists.mockReset().mockResolvedValue(false);
  mockCreateEmptyMonthTab.mockReset().mockResolvedValue(undefined);
  mockWriteMonthBudgetRow.mockReset().mockResolvedValue(undefined);
  mockRepairEurFormulas.mockReset().mockResolvedValue(0);
  mockSortExpensesTab.mockReset().mockResolvedValue(undefined);
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();
});

describe('yearFromDateCell', () => {
  test('parses ISO yyyy-MM-dd (what the bot writes)', () => {
    expect(yearFromDateCell('2026-03-28')).toBe(2026);
    expect(yearFromDateCell('2025-01-01')).toBe(2025);
  });

  test('parses European DD.MM.YYYY', () => {
    expect(yearFromDateCell('28.03.2026')).toBe(2026);
    expect(yearFromDateCell('01.01.2025')).toBe(2025);
  });

  test('parses numeric date serial (UNFORMATTED_VALUE from Sheets)', () => {
    // 46109 = 2026-03-28 in Sheets serial (days since 1899-12-30)
    expect(yearFromDateCell('46109')).toBe(2026); // 2026-03-28
  });

  test('returns null for empty string', () => {
    expect(yearFromDateCell('')).toBeNull();
  });

  test('returns null for unrecognized formats', () => {
    expect(yearFromDateCell('March 28, 2026')).toBeNull();
    expect(yearFromDateCell('28/03/2026')).toBeNull();
    expect(yearFromDateCell('invalid')).toBeNull();
  });
});

describe('applyInheritance', () => {
  test('returns empty map for empty input', () => {
    expect(applyInheritance([])).toEqual(new Map());
  });

  test('keeps explicit entries unchanged', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Food', limit: 500, currency: 'EUR' },
      { month: '2026-02', category: 'Food', limit: 600, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    expect(result.get('2026-01')).toEqual([{ category: 'Food', limit: 500, currency: 'EUR' }]);
    expect(result.get('2026-02')).toEqual([{ category: 'Food', limit: 600, currency: 'EUR' }]);
  });

  test('inherits from latest prior month when no explicit entry', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Food', limit: 500, currency: 'EUR' },
      { month: '2026-03', category: 'Food', limit: 700, currency: 'EUR' },
      // March also has a new category
      { month: '2026-03', category: 'Rent', limit: 1000, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    // January: only Food (Rent has no prior entry, skip)
    const jan = result.get('2026-01');
    expect(jan).toHaveLength(1);
    expect(jan?.[0]).toEqual({ category: 'Food', limit: 500, currency: 'EUR' });
    // March: Food explicit + Rent explicit
    const march = result.get('2026-03');
    expect(march).toHaveLength(2);
    expect(march).toContainEqual({ category: 'Food', limit: 700, currency: 'EUR' });
    expect(march).toContainEqual({ category: 'Rent', limit: 1000, currency: 'EUR' });
  });

  test('inherits from the LATEST prior month, not earliest', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Food', limit: 100, currency: 'EUR' },
      { month: '2026-02', category: 'Food', limit: 200, currency: 'EUR' },
      // March: Food missing → should inherit from Feb (200), not Jan (100)
      { month: '2026-03', category: 'Transport', limit: 150, currency: 'USD' },
    ];
    const result = applyInheritance(rows);
    const march = result.get('2026-03');
    const food = march?.find((r) => r.category === 'Food');
    expect(food?.limit).toBe(200);
  });

  test('skips category in a month when no prior entry exists', () => {
    const rows: FlatBudgetRow[] = [
      // Rent only appears in Feb for the first time
      { month: '2026-01', category: 'Food', limit: 500, currency: 'EUR' },
      { month: '2026-02', category: 'Rent', limit: 1000, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    // Jan: Food only (Rent has no prior, skip)
    expect(result.get('2026-01')).toHaveLength(1);
    // Feb: both (Food inherited from Jan, Rent explicit)
    const feb = result.get('2026-02');
    expect(feb).toHaveLength(2);
    expect(feb).toContainEqual({ category: 'Food', limit: 500, currency: 'EUR' });
    expect(feb).toContainEqual({ category: 'Rent', limit: 1000, currency: 'EUR' });
  });

  test('preserves currency when inheriting across months', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Rent', limit: 1000, currency: 'USD' },
      { month: '2026-03', category: 'Food', limit: 200, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    const march = result.get('2026-03');
    const rent = march?.find((r) => r.category === 'Rent');
    expect(rent?.currency).toBe('USD');
    expect(rent?.limit).toBe(1000);
  });

  test('handles a single-month dataset', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Food', limit: 500, currency: 'EUR' },
      { month: '2026-01', category: 'Rent', limit: 1000, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    expect(result.size).toBe(1);
    expect(result.get('2026-01')).toHaveLength(2);
  });

  test('returns months in sorted (ascending) order', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-03', category: 'Food', limit: 300, currency: 'EUR' },
      { month: '2026-01', category: 'Food', limit: 100, currency: 'EUR' },
      { month: '2026-02', category: 'Food', limit: 200, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    expect([...result.keys()]).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  test('skips month entirely when every category lacks prior entries', () => {
    // Single-month dataset where every category is new — nothing to inherit from.
    const rows: FlatBudgetRow[] = [
      { month: '2027-06', category: 'Gym', limit: 50, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    expect(result.get('2027-06')).toEqual([{ category: 'Gym', limit: 50, currency: 'EUR' }]);
  });

  test('later explicit value overrides earlier one when categories repeat in input', () => {
    // Input has two rows for the same (month, category) — Map behaviour: last write wins.
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Food', limit: 100, currency: 'EUR' },
      { month: '2026-01', category: 'Food', limit: 150, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    const jan = result.get('2026-01');
    expect(jan).toHaveLength(1);
    expect(jan?.[0]?.limit).toBe(150);
  });

  test('inherits across year boundaries (Dec -> Jan)', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2025-12', category: 'Rent', limit: 1200, currency: 'EUR' },
      { month: '2026-01', category: 'Food', limit: 300, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    const jan = result.get('2026-01');
    expect(jan).toHaveLength(2);
    expect(jan).toContainEqual({ category: 'Rent', limit: 1200, currency: 'EUR' });
  });
});

describe('yearFromDateCell — additional formats', () => {
  test('handles whitespace/leading zero variants only if they match pattern exactly', () => {
    // Must be strict: DD.MM.YYYY with zero-padding
    expect(yearFromDateCell(' 2026-03-28')).toBeNull();
    expect(yearFromDateCell('2026-3-28')).toBeNull();
  });

  test('returns null for date serial at/below Sheets epoch boundary', () => {
    // 25569 is exactly 1970-01-01 in Sheets serials — function requires strictly greater
    expect(yearFromDateCell('25569')).toBeNull();
    expect(yearFromDateCell('0')).toBeNull();
    expect(yearFromDateCell('100')).toBeNull();
  });

  test('parses a late-1970s date serial correctly', () => {
    // 30000 days after 1899-12-30 → 1982-02-13
    const year = yearFromDateCell('30000');
    expect(year).toBe(1982);
  });

  test('returns null for non-numeric garbage', () => {
    expect(yearFromDateCell('abc-de-fg')).toBeNull();
  });
});

describe('runYearSplitMigration', () => {
  test('returns null when there are no split-year rows and no Budget sheet', async () => {
    // spreadsheets.get returns only an Expenses sheet — no Budget
    mockSpreadsheetsGet.mockResolvedValue({
      data: { sheets: [{ properties: { title: 'Expenses', sheetId: 0 } }] },
    });
    mockReadExpenseRowsRaw.mockResolvedValue([]); // no rows to split

    const result = await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    expect(result).toBeNull();
    // Backup must NOT be taken when there's nothing to do
    expect(mockDriveFilesCopy).not.toHaveBeenCalled();
  });

  test('creates a backup before mutating anything when there IS work to do', async () => {
    mockReadExpenseRowsRaw.mockResolvedValue([
      ['2026-03-28', 'Food', 'Lunch', '10'],
      ['2025-12-01', 'Rent', '-', '500'],
    ]);

    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    expect(mockDriveFilesCopy).toHaveBeenCalledTimes(1);
    const [arg] = mockDriveFilesCopy.mock.calls[0] ?? [];
    expect((arg as { fileId: string }).fileId).toBe('old-sheet');
    expect((arg as { requestBody: { name: string } }).requestBody.name).toContain('backup');
  });

  test('returns a Drive backup URL when migration runs', async () => {
    mockReadExpenseRowsRaw.mockResolvedValue([['2026-03-28', 'Food', '-', '10']]);
    mockDriveFilesCopy.mockResolvedValue({ data: { id: 'the-backup-id' } });

    const url = await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    expect(url).toBe('https://docs.google.com/spreadsheets/d/the-backup-id');
  });

  test('throws when Drive backup returns no file ID', async () => {
    mockReadExpenseRowsRaw.mockResolvedValue([['2026-01-01', 'Food', '-', '10']]);
    mockDriveFilesCopy.mockResolvedValue({ data: {} }); // no id

    await expect(runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026)).rejects.toThrow(
      /backup failed/i,
    );
  });

  test('moves only split-year expense rows to the new spreadsheet', async () => {
    mockReadExpenseRowsRaw.mockResolvedValue([
      ['2026-03-28', 'Food', 'a', '10'], // splitYear → move
      ['2025-12-01', 'Rent', 'b', '500'], // prior year → stay
      ['2026-01-15', 'Food', 'c', '20'], // splitYear → move
    ]);

    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    expect(mockAppendExpenseRowsRaw).toHaveBeenCalledTimes(1);
    const [, targetId, rows] = mockAppendExpenseRowsRaw.mock.calls[0] ?? [];
    expect(targetId).toBe('new-sheet');
    expect(rows).toHaveLength(2);
  });

  test('deletes split-year rows from the old spreadsheet by 1-based sheet row index', async () => {
    mockReadExpenseRowsRaw.mockResolvedValue([
      ['2025-12-01', 'Rent', '-', '500'], // row 2 — stays
      ['2026-03-28', 'Food', '-', '10'], // row 3 — move & delete
      ['2024-01-01', 'Foo', '-', '1'], // row 4 — stays
      ['2026-02-10', 'Bar', '-', '5'], // row 5 — move & delete
    ]);

    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    expect(mockDeleteExpenseRowsByIndex).toHaveBeenCalledTimes(1);
    const [, oldId, indices] = mockDeleteExpenseRowsByIndex.mock.calls[0] ?? [];
    expect(oldId).toBe('old-sheet');
    expect(indices).toEqual([3, 5]); // 1-based, skipping header row 1
  });

  test('repairs EUR formulas and sorts tab after moving rows', async () => {
    mockReadExpenseRowsRaw.mockResolvedValue([['2026-03-28', 'Food', '-', '10']]);

    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    expect(mockRepairEurFormulas).toHaveBeenCalledTimes(1);
    expect(mockSortExpensesTab).toHaveBeenCalledTimes(1);
  });

  test('migrates Budget flat sheet rows and deletes the old Budget tab', async () => {
    // spreadsheet has both Expenses and Budget tabs
    mockSpreadsheetsGet.mockResolvedValue({
      data: {
        sheets: [
          { properties: { title: 'Expenses', sheetId: 0 } },
          { properties: { title: 'Budget', sheetId: 99 } },
        ],
      },
    });
    mockReadExpenseRowsRaw.mockResolvedValue([]);
    mockValuesGet.mockResolvedValue({
      data: {
        values: [
          ['2026-01', 'Food', '500', 'EUR'],
          ['2025-12', 'Rent', '1000', 'EUR'],
        ],
      },
    });

    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    // Budget rows written via writeMonthBudgetRow (at least one per month)
    expect(mockWriteMonthBudgetRow).toHaveBeenCalled();
    // Old "Budget" sheet is deleted via batchUpdate with deleteSheet request
    const deleteCalls = mockSpreadsheetsBatchUpdate.mock.calls.filter((call) => {
      const body = (call[0] as { requestBody?: { requests?: Array<{ deleteSheet?: unknown }> } })
        .requestBody?.requests;
      return body?.some((r) => 'deleteSheet' in r);
    });
    expect(deleteCalls.length).toBe(1);
  });

  test('routes pre-split-year budget months to the OLD spreadsheet and split-year months to NEW', async () => {
    mockSpreadsheetsGet.mockResolvedValue({
      data: {
        sheets: [
          { properties: { title: 'Expenses', sheetId: 0 } },
          { properties: { title: 'Budget', sheetId: 99 } },
        ],
      },
    });
    mockReadExpenseRowsRaw.mockResolvedValue([]);
    mockValuesGet.mockResolvedValue({
      data: {
        values: [
          ['2025-06', 'Food', '500', 'EUR'], // year < split → old
          ['2026-01', 'Food', '500', 'EUR'], // year >= split → new
        ],
      },
    });

    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    const targetsForBudgetWrites = mockWriteMonthBudgetRow.mock.calls.map(
      (call) => call[1] as string,
    );
    expect(targetsForBudgetWrites).toContain('old-sheet');
    expect(targetsForBudgetWrites).toContain('new-sheet');
  });

  test('creates month tab only when it does not already exist', async () => {
    mockSpreadsheetsGet.mockResolvedValue({
      data: {
        sheets: [
          { properties: { title: 'Expenses', sheetId: 0 } },
          { properties: { title: 'Budget', sheetId: 99 } },
        ],
      },
    });
    mockReadExpenseRowsRaw.mockResolvedValue([]);
    mockValuesGet.mockResolvedValue({
      data: { values: [['2026-01', 'Food', '500', 'EUR']] },
    });
    mockMonthTabExists.mockResolvedValue(true); // tab already exists

    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    expect(mockCreateEmptyMonthTab).not.toHaveBeenCalled();
    expect(mockWriteMonthBudgetRow).toHaveBeenCalled();
  });

  test('skips malformed Budget rows (missing category or non-numeric limit)', async () => {
    mockSpreadsheetsGet.mockResolvedValue({
      data: {
        sheets: [
          { properties: { title: 'Expenses', sheetId: 0 } },
          { properties: { title: 'Budget', sheetId: 99 } },
        ],
      },
    });
    mockReadExpenseRowsRaw.mockResolvedValue([]);
    mockValuesGet.mockResolvedValue({
      data: {
        values: [
          ['2026-01', 'Food', '500', 'EUR'], // valid
          ['2026-01', '', '500', 'EUR'], // empty category → skipped
          ['2026-01', 'Rent', 'not-a-number', 'EUR'], // NaN limit → skipped
          ['2026-01'], // too short → skipped
        ],
      },
    });

    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    // Only 1 valid row makes it to writeMonthBudgetRow for this month
    expect(mockWriteMonthBudgetRow).toHaveBeenCalledTimes(1);
  });

  test('defaults currency to EUR when Budget row omits it', async () => {
    mockSpreadsheetsGet.mockResolvedValue({
      data: {
        sheets: [
          { properties: { title: 'Expenses', sheetId: 0 } },
          { properties: { title: 'Budget', sheetId: 99 } },
        ],
      },
    });
    mockReadExpenseRowsRaw.mockResolvedValue([]);
    mockValuesGet.mockResolvedValue({
      data: { values: [['2026-01', 'Food', '500']] }, // no currency column
    });

    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    const [, , , row] = mockWriteMonthBudgetRow.mock.calls[0] ?? [];
    expect((row as { currency: string }).currency).toBe('EUR');
  });

  test('returns backup URL even when only Budget (no expense rows) needs migrating', async () => {
    mockSpreadsheetsGet.mockResolvedValue({
      data: {
        sheets: [
          { properties: { title: 'Expenses', sheetId: 0 } },
          { properties: { title: 'Budget', sheetId: 99 } },
        ],
      },
    });
    mockReadExpenseRowsRaw.mockResolvedValue([]);
    mockValuesGet.mockResolvedValue({
      data: { values: [['2026-01', 'Food', '500', 'EUR']] },
    });

    const url = await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);
    expect(url).toBe('https://docs.google.com/spreadsheets/d/backup-file-id-123');
  });

  test('normalizes month format in Budget sheet (e.g. 2026-1 -> 2026-01)', async () => {
    mockSpreadsheetsGet.mockResolvedValue({
      data: {
        sheets: [
          { properties: { title: 'Expenses', sheetId: 0 } },
          { properties: { title: 'Budget', sheetId: 99 } },
        ],
      },
    });
    mockReadExpenseRowsRaw.mockResolvedValue([]);
    mockValuesGet.mockResolvedValue({
      data: { values: [['2026-1', 'Food', '500', 'EUR']] }, // unpadded month
    });

    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    // monthAbbrFromYYYYMM('2026-01') → 'Jan'; tab name passed to createEmptyMonthTab
    const [, , tabName] = mockCreateEmptyMonthTab.mock.calls[0] ?? [];
    expect(tabName).toBe('Jan');
  });

  test('does not call repairEurFormulas / sortExpensesTab when no expense rows were moved', async () => {
    mockSpreadsheetsGet.mockResolvedValue({
      data: {
        sheets: [
          { properties: { title: 'Expenses', sheetId: 0 } },
          { properties: { title: 'Budget', sheetId: 99 } },
        ],
      },
    });
    mockReadExpenseRowsRaw.mockResolvedValue([]); // no expense rows
    mockValuesGet.mockResolvedValue({
      data: { values: [['2026-01', 'Food', '500', 'EUR']] },
    });

    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);

    expect(mockRepairEurFormulas).not.toHaveBeenCalled();
    expect(mockSortExpensesTab).not.toHaveBeenCalled();
    expect(mockAppendExpenseRowsRaw).not.toHaveBeenCalled();
    expect(mockDeleteExpenseRowsByIndex).not.toHaveBeenCalled();
  });

  test('does not log error on happy path', async () => {
    mockReadExpenseRowsRaw.mockResolvedValue([['2026-03-28', 'Food', '-', '10']]);
    await runYearSplitMigration(CONN, 'old-sheet', 'new-sheet', 2026);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
