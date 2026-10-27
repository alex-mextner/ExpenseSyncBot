/**
 * Characterization tests for readExpensesFromSheet — pin parsing quirks, EUR
 * recomputation and mismatch-warning boundaries so refactors of the reader keep
 * financial semantics bug-for-bug (rounding, falsy-vs-nullish, row numbering).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  logMock,
  mockValuesGet,
  resetSheetsMocks,
  TEST_CONN,
  TEST_SPREADSHEET,
} from './sheets-test-support';

// Dynamic import keeps './sheets' evaluated AFTER the mock.module calls in
// sheets-test-support (otherwise bun binds the real logger/googleapis).
const { readExpensesFromSheet } = await import('./sheets');

beforeEach(resetSheetsMocks);

const RSD_HEADERS = ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'];
const USD_HEADERS = ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'USD ($)', 'Rate (→EUR)'];

function sheetReturns(...rows: unknown[][]): void {
  mockValuesGet.mockResolvedValueOnce({ data: { values: rows } });
}

describe('readExpensesFromSheet — request and structure', () => {
  test('reads the whole Expenses tab A:Z', async () => {
    sheetReturns(RSD_HEADERS);
    await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(mockValuesGet.mock.calls[0]?.[0]).toEqual({
      spreadsheetId: TEST_SPREADSHEET,
      range: 'Expenses!A:Z',
    });
  });

  test('header-only sheet yields no expenses, errors or mismatches', async () => {
    sheetReturns(RSD_HEADERS);
    expect(await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET)).toEqual({
      expenses: [],
      errors: [],
      eurMismatches: [],
    });
  });

  test('missing values payload is treated as an empty sheet', async () => {
    mockValuesGet.mockResolvedValueOnce({ data: {} } as never);
    expect(await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET)).toEqual({
      expenses: [],
      errors: [],
      eurMismatches: [],
    });
  });

  test.each([
    ['Дата'],
    ['Категория'],
    ['Комментарий'],
  ])('throws when the %s column is absent', async (missing) => {
    sheetReturns(RSD_HEADERS.map((h) => (h === missing ? 'Other' : h)));
    await expect(readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET)).rejects.toThrow(
      'Required columns not found in spreadsheet',
    );
  });

  test('ignores non-currency headers and tolerates a sheet without EUR/Rate columns', async () => {
    sheetReturns(
      ['Дата', 'Категория', 'Комментарий', 'Notes', 'USD ($)'],
      ['2026-04-10', 'Food', 'x', 'hello', '10'],
    );
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses).toEqual([
      {
        date: '2026-04-10',
        amounts: { USD: 10 },
        eurAmount: 9, // converter fallback: 10 * 0.9
        rate: null,
        category: 'Food',
        comment: 'x',
      },
    ]);
  });
});

describe('readExpensesFromSheet — row skipping and defaults', () => {
  test('skips empty rows and rows without a date, keeps later rows with 1-based numbering', async () => {
    sheetReturns(
      RSD_HEADERS,
      [],
      ['', 'NoDate', 'c', '1', '100', '0.01'],
      ['2026-04-12', 'Food', 'x', '', '500', '0.0086'],
    );
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses.map((e) => e.date)).toEqual(['2026-04-12']);
  });

  test('defaults empty category to "Без категории" and a missing comment to ""', async () => {
    sheetReturns(RSD_HEADERS, ['2026-04-12', '', undefined, '', '500', '0.0086']);
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses[0]).toMatchObject({ category: 'Без категории', comment: '' });
  });

  test('handles rows shorter than the header row', async () => {
    sheetReturns(RSD_HEADERS, ['2026-04-12', 'Food']);
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    // no amounts anywhere and no EUR(calc) → truly empty row → skipped
    expect(result.expenses).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('readExpensesFromSheet — amount parsing', () => {
  test.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['non-numeric', 'abc'],
    ['whitespace only', '   '],
    ['empty', ''],
  ])('%s currency cell is not an amount, so the row falls back to EUR(calc)', async (_name, cell) => {
    sheetReturns(RSD_HEADERS, ['2026-04-12', 'Food', 'x', '12.5', cell, '0.0086']);
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses).toEqual([
      {
        date: '2026-04-12',
        amounts: { EUR: 12.5 },
        eurAmount: 12.5,
        rate: 0.0086,
        category: 'Food',
        comment: 'x',
      },
    ]);
  });

  test('parseFloat quirks are preserved: "1,5" reads as 1 and "12abc" as 12', async () => {
    sheetReturns(
      USD_HEADERS,
      ['2026-04-12', 'A', '', '', '1,5', '1'],
      ['2026-04-13', 'B', '', '', '12abc', '1'],
    );
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses.map((e) => e.amounts)).toEqual([{ USD: 1 }, { USD: 12 }]);
  });

  test('fallback to EUR(calc) is skipped when EUR(calc) is empty, zero, negative or garbage', async () => {
    sheetReturns(
      RSD_HEADERS,
      ['2026-04-12', 'A', '', '', '', ''],
      ['2026-04-12', 'B', '', '0', '', ''],
      ['2026-04-12', 'C', '', '-3', '', ''],
      ['2026-04-12', 'D', '', 'abc', '', ''],
    );
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses).toEqual([]);
  });

  test('EUR-denominated column: amount IS the EUR amount, stored rate is still reported', async () => {
    sheetReturns(
      ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'EUR (€)', 'Rate (→EUR)'],
      ['2026-04-12', 'Food', '', '999', '20.5', '0.5'],
    );
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses[0]).toMatchObject({
      amounts: { EUR: 20.5 },
      eurAmount: 20.5,
      rate: 0.5,
    });
  });

  test('multi-currency row is reported once and does not block the following rows', async () => {
    sheetReturns(
      [...USD_HEADERS.slice(0, 5), 'RSD (дин.)', 'Rate (→EUR)'],
      ['2026-04-10', 'Both', 'c', '4', '5', '500', '0.0086'],
      ['2026-04-11', 'Ok', 'c', '4', '5', '', '1'],
    );
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.errors).toEqual([
      { row: 2, date: '2026-04-10', currencies: ['USD', 'RSD'], category: 'Both' },
    ]);
    expect(result.expenses.map((e) => e.date)).toEqual(['2026-04-11']);
  });
});

describe('readExpensesFromSheet — EUR amount recomputation', () => {
  test('non-EUR amount with stored rate is rounded to cents: 10.5 × 0.123 = 1.29', async () => {
    sheetReturns(RSD_HEADERS, ['2026-04-12', 'Food', '', '1.29', '10.5', '0.123']);
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses[0]?.eurAmount).toBe(1.29);
  });

  test.each([
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-1'],
    ['garbage', 'abc'],
  ])('%s stored rate is ignored: rate=null and the runtime converter is used', async (_n, rateCell) => {
    sheetReturns(USD_HEADERS, ['2026-04-12', 'Food', '', '', '10', rateCell]);
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses[0]).toMatchObject({ rate: null, eurAmount: 9 });
  });

  test('recomputed EUR wins over the sheet EUR(calc) value', async () => {
    sheetReturns(USD_HEADERS, ['2026-04-12', 'Food', '', '11', '10', '1']);
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.expenses[0]?.eurAmount).toBe(10);
  });
});

describe('readExpensesFromSheet — EUR mismatch warnings', () => {
  // USD 100 at rate 1 recomputes to exactly 100 EUR.
  async function mismatchesForSheetEur(sheetEur: string) {
    sheetReturns(USD_HEADERS, ['2026-04-12', 'Food', '', sheetEur, '100', '1']);
    return (await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET)).eurMismatches;
  }

  test.each([
    '50',
    '100',
    '200',
  ])('sheet EUR %s (ratio within [0.5, 2]) is not flagged', async (v) => {
    expect(await mismatchesForSheetEur(v)).toEqual([]);
  });

  test.each([
    ['49', 49],
    ['201', 201],
  ])('sheet EUR %s (outside the ratio band) is flagged', async (v, sheetEur) => {
    expect(await mismatchesForSheetEur(v)).toEqual([
      { row: 2, date: '2026-04-12', category: 'Food', sheetEur, recalcEur: 100 },
    ]);
    expect(logMock.warn).toHaveBeenCalledWith(
      '[SHEETS] 1 rows have EUR mismatch (sheet formula vs recalculated)',
    );
  });

  test.each(['', '0', 'abc', '-5'])('sheet EUR %p is never compared', async (v) => {
    expect(await mismatchesForSheetEur(v)).toEqual([]);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  test('mismatch rows carry the 1-based sheet row of the offending data row', async () => {
    sheetReturns(
      USD_HEADERS,
      ['2026-04-10', 'A', '', '100', '100', '1'],
      ['2026-04-11', 'B', '', '1000', '100', '1'],
    );
    const result = await readExpensesFromSheet(TEST_CONN, TEST_SPREADSHEET);
    expect(result.eurMismatches.map((m) => m.row)).toEqual([3]);
  });
});
