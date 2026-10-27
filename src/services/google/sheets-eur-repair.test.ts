/** Tests for sheets.ts repair paths — currency-column detection, EUR(calc) formula healing, date serial repair */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  mockValuesBatchUpdate,
  mockValuesGet,
  resetSheetsMocks,
  TEST_CONN,
  TEST_SPREADSHEET,
} from './sheets-test-support';

// Dynamic import keeps './sheets' evaluated AFTER the mock.module calls in
// sheets-test-support (otherwise bun binds the real logger/googleapis).
const {
  isCurrencyColumnHeader,
  nonEurCurrencyColumnIndices,
  repairDateSerials,
  repairEurFormulas,
} = await import('./sheets');

beforeEach(resetSheetsMocks);

// ── isCurrencyColumnHeader ───────────────────────────────────────────────────

describe('isCurrencyColumnHeader — shared currency-column detector (#112)', () => {
  test('EUR (calc) is never treated as a currency column', () => {
    // This is the single detector shared by sheets.ts and
    // scripts/repair-all-sheets.ts. If EUR (calc) leaked through, the repair
    // script's fillEurNativeRates would read the computed EUR(calc) value as an
    // "EUR-native" amount and set Rate=1 on non-EUR rows — the exact corruption
    // #113's review flagged as untested. The script is not importable
    // (module-top DB/network), so asserting the exclusion on the shared code is
    // what covers it.
    expect(isCurrencyColumnHeader('EUR (calc)')).toBe(false);
  });

  test('excludes the Rate column and non-currency headers', () => {
    expect(isCurrencyColumnHeader('Rate (→EUR)')).toBe(false);
    expect(isCurrencyColumnHeader('Дата')).toBe(false);
    expect(isCurrencyColumnHeader('Категория')).toBe(false);
    expect(isCurrencyColumnHeader('Комментарий')).toBe(false);
  });

  test('includes currency amount columns, the EUR currency column included', () => {
    expect(isCurrencyColumnHeader('USD ($)')).toBe(true);
    expect(isCurrencyColumnHeader('RSD (дин.)')).toBe(true);
    // The EUR *currency* column is a real amount column (distinct from EUR calc);
    // the repair script needs it in currCols to match EUR expenses and fill
    // EUR-native rates. nonEurCurrencyColumnIndices layers the EUR exclusion.
    expect(isCurrencyColumnHeader('EUR (€)')).toBe(true);
  });
});

// ── nonEurCurrencyColumnIndices ──────────────────────────────────────────────

describe('nonEurCurrencyColumnIndices', () => {
  test('excludes EUR (calc), the Rate column, and the EUR currency column', () => {
    // The "EUR (calc)" computed column matches the bare ^[A-Z]{3}\s*\( shape, so
    // it MUST be excluded explicitly — otherwise a static EUR(calc) number would
    // be mistaken for a currency amount and corrupt the repair/rewrite. This
    // builds on the shared isCurrencyColumnHeader the repair script also uses to
    // avoid setting Rate=1 on a non-EUR row (#112 robustness review).
    const headers = [
      'Дата',
      'USD ($)',
      'EUR (€)',
      'RSD (дин.)',
      'EUR (calc)',
      'Категория',
      'Комментарий',
      'Rate (→EUR)',
    ];
    // Only USD (idx 1) and RSD (idx 3) are non-EUR currency amount columns.
    expect(nonEurCurrencyColumnIndices(headers)).toEqual([1, 3]);
  });
});

// ── repairEurFormulas ───────────────────────────────────────────────────────

describe('repairEurFormulas — heals broken/stale EUR(calc) formulas', () => {
  // Post-insert layout where a previously-correct INDIRECT formula now errors:
  // Дата | USD | EGP | EUR (calc) | Категория | Комментарий | Rate
  //  A=0   B=1   C=2   D=3          E=4         F=5           G=6
  const HEADERS = [
    'Дата',
    'USD ($)',
    'EGP (E£)',
    'EUR (calc)',
    'Категория',
    'Комментарий',
    'Rate (→EUR)',
  ];

  interface RepairBatchArgs {
    requestBody: { data: { range: string; values: (string | number)[][] }[] };
  }

  // formulaRows: what FORMULA render returns; valueRows: what FORMATTED_VALUE
  // render returns (computed value / error). Header read is FORMATTED_VALUE on
  // range !1:1.
  function wireRepair(formulaRows: unknown[][], valueRows: unknown[][]): void {
    mockValuesGet.mockReset().mockImplementation((args: unknown) => {
      const a = args as { range: string; valueRenderOption?: string };
      if (a.range.includes('!1:1')) {
        return Promise.resolve({ data: { values: [HEADERS] } });
      }
      if (a.valueRenderOption === 'FORMULA') {
        return Promise.resolve({ data: { values: formulaRows } });
      }
      return Promise.resolve({ data: { values: valueRows } });
    });
  }

  test('rebuilds a #VALUE!-producing INDIRECT formula to the correct current-layout columns', async () => {
    // Stale formula: rate ref "F" is now the Комментарий text column → #VALUE!.
    wireRepair(
      [['2026-04-10', 20, '', '=INDIRECT("B"&ROW())*INDIRECT("F"&ROW())', 'Travel', 'taxi', 0.905]],
      [['2026-04-10', '20', '', '#VALUE!', 'Travel', 'taxi', '0.905']],
    );

    const count = await repairEurFormulas(TEST_CONN, TEST_SPREADSHEET);

    expect(count).toBe(1);
    const args = mockValuesBatchUpdate.mock.calls[0]?.[0] as RepairBatchArgs;
    const eurUpdate = args.requestBody.data.find((d) => d.range.endsWith('!D2'));
    // Amount col B (USD) kept; rate ref repaired from F → G (the real Rate column).
    expect(eurUpdate?.values[0]?.[0]).toBe('=INDIRECT("B"&ROW())*INDIRECT("G"&ROW())');
  });

  test('rebuilds a stale INDIRECT formula that silently computes a WRONG number (no #VALUE!)', async () => {
    // After the shift, rate ref "F" lands on an empty Комментарий cell, so the
    // formula computes 0 (a wrong number) instead of erroring — still stale.
    wireRepair(
      [['2026-04-10', 20, '', '=INDIRECT("B"&ROW())*INDIRECT("F"&ROW())', 'Travel', '', 0.905]],
      [['2026-04-10', '20', '', '0', 'Travel', '', '0.905']],
    );

    const count = await repairEurFormulas(TEST_CONN, TEST_SPREADSHEET);

    expect(count).toBe(1);
    const args = mockValuesBatchUpdate.mock.calls[0]?.[0] as RepairBatchArgs;
    const eurUpdate = args.requestBody.data.find((d) => d.range.endsWith('!D2'));
    expect(eurUpdate?.values[0]?.[0]).toBe('=INDIRECT("B"&ROW())*INDIRECT("G"&ROW())');
  });

  test('leaves a correct formula (computes to a number) untouched', async () => {
    wireRepair(
      [['2026-04-10', 20, '', '=INDIRECT("B"&ROW())*INDIRECT("G"&ROW())', 'Travel', 'taxi', 0.905]],
      [['2026-04-10', '20', '', '18.1', 'Travel', 'taxi', '0.905']],
    );

    const count = await repairEurFormulas(TEST_CONN, TEST_SPREADSHEET);

    expect(count).toBe(0);
    expect(mockValuesBatchUpdate).not.toHaveBeenCalled();
  });

  test('leaves an auto-adjusting relative-ref formula (computes to a number) untouched', async () => {
    // Plain relative refs auto-adjust on a column shift, so a non-INDIRECT
    // formula that computes a number must NOT be rewritten.
    wireRepair(
      [['2026-04-10', 20, '', '=B2*G2', 'Travel', 'taxi', 0.905]],
      [['2026-04-10', '20', '', '18.1', 'Travel', 'taxi', '0.905']],
    );

    const count = await repairEurFormulas(TEST_CONN, TEST_SPREADSHEET);

    expect(count).toBe(0);
    expect(mockValuesBatchUpdate).not.toHaveBeenCalled();
  });

  test('converts a static EUR(calc) number into a formula and derives the missing rate', async () => {
    // Legacy migration artifact: EUR(calc) is a static number, Rate is empty.
    wireRepair(
      [['2026-04-10', 20, '', 18.1, 'Travel', 'taxi', '']],
      [['2026-04-10', '20', '', '18.1', 'Travel', 'taxi', '']],
    );

    const count = await repairEurFormulas(TEST_CONN, TEST_SPREADSHEET);

    expect(count).toBe(1);
    const args = mockValuesBatchUpdate.mock.calls[0]?.[0] as RepairBatchArgs;
    // Derived rate written to the Rate column (G), row 2: 18.1 / 20 = 0.905.
    const rateUpdate = args.requestBody.data.find((d) => d.range.endsWith('!G2'));
    expect(rateUpdate?.values[0]?.[0]).toBe(0.905);
    // EUR(calc) becomes a formula referencing amount (B) × rate (G).
    const eurUpdate = args.requestBody.data.find((d) => d.range.endsWith('!D2'));
    expect(eurUpdate?.values[0]?.[0]).toBe('=INDIRECT("B"&ROW())*INDIRECT("G"&ROW())');
  });

  test('skips a broken formula whose rate cell is empty (cannot derive from an error)', async () => {
    wireRepair(
      [['2026-04-10', 20, '', '=INDIRECT("B"&ROW())*INDIRECT("F"&ROW())', 'Travel', 'taxi', '']],
      [['2026-04-10', '20', '', '#VALUE!', 'Travel', 'taxi', '']],
    );

    const count = await repairEurFormulas(TEST_CONN, TEST_SPREADSHEET);

    expect(count).toBe(0);
    expect(mockValuesBatchUpdate).not.toHaveBeenCalled();
  });

  test('chunks the batch write across >300 rows (regression: unbounded batchUpdate payload)', async () => {
    // A single unbounded batchUpdate on a multi-thousand-row sheet can exceed
    // the API payload limit and fail the whole repair atomically. The write
    // must be split into bounded chunks, each covering a distinct row slice.
    const ROW_COUNT = 301;
    const formulaRows = Array.from({ length: ROW_COUNT }, () => [
      '2026-04-10',
      20,
      '',
      '=INDIRECT("B"&ROW())*INDIRECT("F"&ROW())', // stale: rate ref F now the text column
      'Travel',
      'taxi',
      0.905,
    ]);
    const valueRows = Array.from({ length: ROW_COUNT }, () => [
      '2026-04-10',
      '20',
      '',
      '#VALUE!',
      'Travel',
      'taxi',
      '0.905',
    ]);
    wireRepair(formulaRows, valueRows);

    const count = await repairEurFormulas(TEST_CONN, TEST_SPREADSHEET);

    expect(count).toBe(ROW_COUNT);
    // 301 updates chunked at 300 → two batchUpdate requests.
    expect(mockValuesBatchUpdate).toHaveBeenCalledTimes(2);

    // Every data row (D2..D302) must be covered exactly once across all chunks.
    const writtenRanges = mockValuesBatchUpdate.mock.calls
      .flatMap((c) => (c[0] as RepairBatchArgs).requestBody.data)
      .map((d) => d.range);
    expect(writtenRanges).toHaveLength(ROW_COUNT);
    const expectedRanges = Array.from({ length: ROW_COUNT }, (_, i) => `Expenses!D${i + 2}`);
    expect(new Set(writtenRanges)).toEqual(new Set(expectedRanges));
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
