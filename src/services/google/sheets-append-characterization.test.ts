/**
 * Characterization tests for appendExpenseRow / appendExpenseRows row building —
 * pin A1 ranges, API options, formula placement and per-column value mapping so
 * the shared row-building refactor stays bug-for-bug identical for both paths.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  logMock,
  mockValuesAppend,
  mockValuesGet,
  resetSheetsMocks,
  TEST_CONN,
  TEST_SPREADSHEET,
  type ValuesAppendArgs,
} from './sheets-test-support';

// Dynamic import keeps './sheets' evaluated AFTER the mock.module calls in
// sheets-test-support (otherwise bun binds the real logger/googleapis).
const { appendExpenseRow, appendExpenseRows } = await import('./sheets');

beforeEach(resetSheetsMocks);

type Writer = (data: Parameters<typeof appendExpenseRow>[2]) => Promise<void>;

// Both write paths must build identical rows for a single record.
const WRITERS: [string, Writer][] = [
  ['appendExpenseRow', (d) => appendExpenseRow(TEST_CONN, TEST_SPREADSHEET, d)],
  ['appendExpenseRows', (d) => appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [d])],
];

function useHeaders(headers: string[]): void {
  mockValuesGet.mockResolvedValue({ data: { values: [headers] } });
}

function appendedRow(): unknown[] | undefined {
  const args = mockValuesAppend.mock.calls[0]?.[0] as ValuesAppendArgs;
  return args.requestBody.values[0];
}

describe.each(WRITERS)('%s — row building', (_name, write) => {
  test('reads headers from Expenses!1:1 and appends to Expenses!A:A with INSERT_ROWS', async () => {
    useHeaders(['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)']);
    await write({
      date: '2026-04-10',
      category: 'Food',
      comment: 'c',
      amounts: { RSD: 500 },
      eurAmount: 4.3,
      rate: 0.0086,
    });
    expect(mockValuesGet.mock.calls[0]?.[0]).toEqual({
      spreadsheetId: TEST_SPREADSHEET,
      range: 'Expenses!1:1',
    });
    expect(mockValuesAppend.mock.calls[0]?.[0]).toMatchObject({
      spreadsheetId: TEST_SPREADSHEET,
      range: 'Expenses!A:A',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
    });
  });

  test('formula references the amount and rate columns by their letters in a shifted layout', async () => {
    // Дата | EUR (calc) | Rate | Категория | Комментарий | USD ($)
    useHeaders(['Дата', 'EUR (calc)', 'Rate (→EUR)', 'Категория', 'Комментарий', 'USD ($)']);
    await write({
      date: '2026-04-10',
      category: 'Food',
      comment: 'c',
      amounts: { USD: 12.5 },
      eurAmount: 11,
      rate: 0.9,
    });
    expect(appendedRow()).toEqual([
      '2026-04-10',
      '=INDIRECT("F"&ROW())*INDIRECT("C"&ROW())',
      0.9,
      'Food',
      'c',
      12.5,
    ]);
  });

  test('EUR-native rows keep a literal EUR amount and no formula, rate cell empty when absent', async () => {
    useHeaders(['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'EUR (€)', 'Rate (→EUR)']);
    await write({
      date: '2026-04-10',
      category: 'Food',
      comment: 'c',
      amounts: { EUR: 20 },
      eurAmount: 20,
    });
    expect(appendedRow()).toEqual(['2026-04-10', 'Food', 'c', 20, 20, '']);
  });

  test('non-EUR row without a rate stores the literal EUR amount', async () => {
    useHeaders(['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)']);
    await write({
      date: '2026-04-10',
      category: 'Food',
      comment: 'c',
      amounts: { RSD: 500 },
      eurAmount: 4.3,
    });
    expect(appendedRow()).toEqual(['2026-04-10', 'Food', 'c', 4.3, 500, '']);
  });

  test('a rate of 0 is falsy: no formula, but the 0 rate is still written (nullish, not falsy)', async () => {
    useHeaders(['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)']);
    await write({
      date: '2026-04-10',
      category: 'Food',
      comment: 'c',
      amounts: { RSD: 500 },
      eurAmount: 4.3,
      rate: 0,
    });
    expect(appendedRow()).toEqual(['2026-04-10', 'Food', 'c', 4.3, 500, 0]);
  });

  test('currency columns without an amount are blank, unknown headers are blank, an amount of 0 is kept', async () => {
    useHeaders([
      'Дата',
      'Категория',
      'Комментарий',
      'EUR (calc)',
      'USD ($)',
      'RSD (дин.)',
      'Notes',
      'Rate (→EUR)',
    ]);
    await write({
      date: '2026-04-10',
      category: 'Food',
      comment: 'c',
      amounts: { USD: null, RSD: 0 },
      eurAmount: 0,
      rate: 0.0086,
    });
    // RSD is the first non-null amount; 0 is a value, and 0 * rate is not
    // formula-eligible only through `rate`, which is truthy here.
    expect(appendedRow()).toEqual([
      '2026-04-10',
      'Food',
      'c',
      '=INDIRECT("F"&ROW())*INDIRECT("H"&ROW())',
      '',
      0,
      '',
      0.0086,
    ]);
  });

  test('when every amount is null no formula is built and the literal EUR amount is used', async () => {
    useHeaders(['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)']);
    await write({
      date: '2026-04-10',
      category: 'Food',
      comment: 'c',
      amounts: { RSD: null },
      eurAmount: 7,
      rate: 0.0086,
    });
    expect(appendedRow()).toEqual(['2026-04-10', 'Food', 'c', 7, '', 0.0086]);
  });

  test('logs an error when the API reports zero appended rows', async () => {
    useHeaders(['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)']);
    mockValuesAppend.mockResolvedValueOnce({
      data: { updates: { updatedRange: 'Expenses!A2', updatedRows: 0 } },
    });
    await write({
      date: '2026-04-10',
      category: 'Food',
      comment: 'c',
      amounts: { RSD: 500 },
      eurAmount: 4.3,
      rate: 0.0086,
    });
    expect(logMock.error).toHaveBeenCalledTimes(1);
  });

  test('no error is logged when a row was appended', async () => {
    useHeaders(['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)']);
    await write({
      date: '2026-04-10',
      category: 'Food',
      comment: 'c',
      amounts: { RSD: 500 },
      eurAmount: 4.3,
      rate: 0.0086,
    });
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe('appendExpenseRows — multi-row payload', () => {
  test('mixed currencies share one append; each row resolves its own amount column', async () => {
    useHeaders([
      'Дата',
      'Категория',
      'Комментарий',
      'EUR (calc)',
      'USD ($)',
      'RSD (дин.)',
      'Rate (→EUR)',
    ]);
    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: 'd1',
        category: 'a',
        comment: '1',
        amounts: { USD: 5 },
        eurAmount: 4.5,
        rate: 0.9,
      },
      {
        date: 'd2',
        category: 'b',
        comment: '2',
        amounts: { RSD: 100 },
        eurAmount: 0.86,
        rate: 0.0086,
      },
    ]);
    expect(mockValuesAppend).toHaveBeenCalledTimes(1);
    const args = mockValuesAppend.mock.calls[0]?.[0] as ValuesAppendArgs;
    expect(args.requestBody.values).toEqual([
      ['d1', 'a', '1', '=INDIRECT("E"&ROW())*INDIRECT("G"&ROW())', 5, '', 0.9],
      ['d2', 'b', '2', '=INDIRECT("F"&ROW())*INDIRECT("G"&ROW())', '', 100, 0.0086],
    ]);
  });
});
