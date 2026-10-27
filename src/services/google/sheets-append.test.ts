/** Tests for sheets.ts append paths — single/batch row building, EUR formulas, column insertion, raw appends */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  mockSpreadsheetsBatchUpdate,
  mockSpreadsheetsGet,
  mockValuesAppend,
  mockValuesBatchUpdate,
  mockValuesGet,
  mockValuesUpdate,
  resetSheetsMocks,
  TEST_CONN,
  TEST_SPREADSHEET,
  type ValuesAppendArgs,
} from './sheets-test-support';

// Dynamic import keeps './sheets' evaluated AFTER the mock.module calls in
// sheets-test-support (otherwise bun binds the real logger/googleapis).
const { appendExpenseRow, appendExpenseRows, appendExpenseRowsRaw, ensureSheetColumns } =
  await import('./sheets');

beforeEach(resetSheetsMocks);

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

// ── insertCurrencyColumn — EUR(calc) formula integrity (regression: #VALUE!) ──

describe('insertCurrencyColumn — rewrites EUR(calc) formulas after column shift', () => {
  // Real sheet layout: Дата | <currencies> | EUR (calc) | Категория | Комментарий | Rate
  // A=0     B=1(USD)   C=2(EUR calc)   D=3(Кат)   E=4(Комм)   F=5(Rate)
  const PRE_INSERT_HEADERS = [
    'Дата',
    'USD ($)',
    'EUR (calc)',
    'Категория',
    'Комментарий',
    'Rate (→EUR)',
  ];

  interface BatchUpdateArgs {
    requestBody: { data: { range: string; values: string[][] }[] };
  }

  // Wire the header read to return the PRE-insert layout, and any data read
  // (FORMULA render) to return rows in the POST-insert layout — exactly what
  // Google returns after the column insert: cells move with the inserted
  // column, but the column letters baked into INDIRECT() strings do not.
  function wireSheet(dataRows: unknown[][]): void {
    mockValuesGet.mockReset().mockImplementation((args: unknown) => {
      const range = (args as { range: string }).range;
      if (range.includes('!1:1')) {
        return Promise.resolve({ data: { values: [PRE_INSERT_HEADERS] } });
      }
      return Promise.resolve({ data: { values: dataRows } });
    });
  }

  test('reproduces #VALUE! break: rewrites the rate-column reference to the shifted column', async () => {
    // Existing USD row. After EGP is inserted before EUR(calc), Rate shifts
    // F→G and EUR(calc) C→D, but the stored formula still says "F" (now the
    // Комментарий text column) → #VALUE!.
    wireSheet([
      [
        '2026-04-10',
        20, // USD amount (B, unchanged by the insert)
        '', // EGP (C, newly inserted, empty for old rows)
        '=INDIRECT("B"&ROW())*INDIRECT("F"&ROW())', // EUR(calc) at D, still points at old F
        'Travel', // Категория (E)
        'taxi', // Комментарий (F) — the text column the broken formula now hits
        0.905, // Rate (G, shifted from F)
      ],
    ]);

    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-11',
        category: 'Food',
        comment: '',
        amounts: { EGP: 50 },
        eurAmount: 0.95,
        rate: 0.019,
      },
    ]);

    expect(mockValuesBatchUpdate).toHaveBeenCalled();
    const batchArgs = mockValuesBatchUpdate.mock.calls[0]?.[0] as BatchUpdateArgs;
    const eurUpdate = batchArgs.requestBody.data.find((d) => d.range.endsWith('!D2'));
    expect(eurUpdate).toBeDefined();
    const formula = eurUpdate?.values[0]?.[0];
    // Amount column (USD = B) unchanged; rate reference now points at the
    // SHIFTED Rate column (G), no longer at the text column (F).
    expect(formula).toBe('=INDIRECT("B"&ROW())*INDIRECT("G"&ROW())');
    expect(formula).not.toContain('"F"');
  });

  test('leaves rows with a static EUR(calc) value untouched', async () => {
    // A row whose EUR(calc) is a literal number (not a formula) cannot break on
    // a column shift — it must NOT be rewritten.
    wireSheet([['2026-04-10', 20, '', 18.1, 'Travel', 'taxi', 0.905]]);

    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-11',
        category: 'Food',
        comment: '',
        amounts: { EGP: 50 },
        eurAmount: 0.95,
        rate: 0.019,
      },
    ]);

    expect(mockValuesBatchUpdate).not.toHaveBeenCalled();
  });

  test('rewrites each row against its own currency column in a multi-currency sheet', async () => {
    // Pre-insert: Дата | USD | RSD | EUR (calc) | Категория | Комментарий | Rate
    //              A=0   B=1   C=2   D=3          E=4         F=5           G=6
    const MULTI_HEADERS = [
      'Дата',
      'USD ($)',
      'RSD (дин.)',
      'EUR (calc)',
      'Категория',
      'Комментарий',
      'Rate (→EUR)',
    ];
    mockValuesGet.mockReset().mockImplementation((args: unknown) => {
      const range = (args as { range: string }).range;
      if (range.includes('!1:1')) {
        return Promise.resolve({ data: { values: [MULTI_HEADERS] } });
      }
      // Post-insert (EGP inserted at D): Rate shifts G→H, EUR(calc) D→E.
      // Row 1 is a USD expense (amount in B), row 2 is RSD (amount in C).
      return Promise.resolve({
        data: {
          values: [
            ['2026-04-10', 20, '', '', '=INDIRECT("B"&ROW())*INDIRECT("G"&ROW())', 'A', 'a', 0.905],
            [
              '2026-04-10',
              '',
              500,
              '',
              '=INDIRECT("C"&ROW())*INDIRECT("G"&ROW())',
              'B',
              'b',
              0.0086,
            ],
          ],
        },
      });
    });

    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-11',
        category: 'Food',
        comment: '',
        amounts: { EGP: 50 },
        eurAmount: 0.95,
        rate: 0.019,
      },
    ]);

    const batchArgs = mockValuesBatchUpdate.mock.calls[0]?.[0] as BatchUpdateArgs;
    // EUR(calc) moved to column E (post-insert), Rate to H.
    const usdRow = batchArgs.requestBody.data.find((d) => d.range.endsWith('!E2'));
    const rsdRow = batchArgs.requestBody.data.find((d) => d.range.endsWith('!E3'));
    expect(usdRow?.values[0]?.[0]).toBe('=INDIRECT("B"&ROW())*INDIRECT("H"&ROW())');
    expect(rsdRow?.values[0]?.[0]).toBe('=INDIRECT("C"&ROW())*INDIRECT("H"&ROW())');
  });

  test('chunks the rewrite across >300 existing rows (regression: unbounded batchUpdate)', async () => {
    // A currency insert on a large history must not pile every row's rewrite
    // into one batchUpdate that can blow the payload limit.
    const ROW_COUNT = 301;
    wireSheet(
      Array.from({ length: ROW_COUNT }, () => [
        '2026-04-10',
        20, // USD amount (B)
        '', // EGP (C, inserted, empty for old rows)
        '=INDIRECT("B"&ROW())*INDIRECT("F"&ROW())', // stale rate ref → must be rewritten
        'Travel',
        'taxi',
        0.905,
      ]),
    );

    await appendExpenseRows(TEST_CONN, TEST_SPREADSHEET, [
      {
        date: '2026-04-11',
        category: 'Food',
        comment: '',
        amounts: { EGP: 50 },
        eurAmount: 0.95,
        rate: 0.019,
      },
    ]);

    // 301 rewrites chunked at 300 → two batchUpdate requests covering D2..D302.
    expect(mockValuesBatchUpdate).toHaveBeenCalledTimes(2);
    const writtenRanges = mockValuesBatchUpdate.mock.calls
      .flatMap((c) => (c[0] as BatchUpdateArgs).requestBody.data)
      .map((d) => d.range);
    expect(writtenRanges).toHaveLength(ROW_COUNT);
    const expectedRanges = Array.from({ length: ROW_COUNT }, (_, i) => `Expenses!D${i + 2}`);
    expect(new Set(writtenRanges)).toEqual(new Set(expectedRanges));
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
