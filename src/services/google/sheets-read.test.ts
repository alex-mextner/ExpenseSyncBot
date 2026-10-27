/** Tests for sheets.ts expense reads — headers, raw rows, parsed expenses with EUR recalculation */
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
const { readExpenseHeaders, readExpenseRowsRaw, readExpensesFromSheet } = await import('./sheets');

beforeEach(resetSheetsMocks);

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
