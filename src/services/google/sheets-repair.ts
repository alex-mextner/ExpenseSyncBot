/** Repairs for migration artifacts: date serials and broken EUR(calc) formulas */
import { google } from 'googleapis';
import { SPREADSHEET_CONFIG } from '../../config/constants';
import { createLogger } from '../../utils/logger.ts';
import {
  authClient,
  buildEurCalcFormula,
  colLetter,
  EXPENSES_TAB,
  type GoogleConn,
  isEmptyCell,
  isFormulaError,
  nonEurCurrencyColumnIndices,
  RATE_COLUMN_HEADER,
  type SheetsClient,
  withSheetsRetry,
  writeValueUpdatesInChunks,
} from './sheets-core';

const logger = createLogger('sheets');

/**
 * Scan the Expenses tab for date cells stored as serial numbers (migration artifact)
 * and rewrite them as ISO yyyy-MM-dd strings. Returns the number of cells fixed.
 */
export async function repairDateSerials(conn: GoogleConn, spreadsheetId: string): Promise<number> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${EXPENSES_TAB}!A2:A`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
    'repairDateSerials.read',
  );

  const rows = response.data.values ?? [];
  const updates: { row: number; isoDate: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const cell = String(rows[i]?.[0] ?? '');
    const serial = Number(cell);
    if (!Number.isNaN(serial) && serial > 25569 && serial < 99999) {
      const date = new Date((serial - 25569) * 86400 * 1000);
      const y = date.getUTCFullYear();
      const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
      const d = String(date.getUTCDate()).padStart(2, '0');
      updates.push({ row: i + 2, isoDate: `${y}-${mo}-${d}` }); // +2: 1-based row + skip header
    }
  }

  if (updates.length === 0) return 0;

  await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updates.map(({ row, isoDate }) => ({
            range: `${EXPENSES_TAB}!A${row}`,
            values: [[isoDate]],
          })),
        },
      }),
    'repairDateSerials.write',
  );

  return updates.length;
}

/** Column positions repairEurFormulas needs to plan a single row's repair. */
interface EurRepairColumns {
  eurColIdx: number;
  rateColIdx: number;
  amountColIndices: number[];
}

/** One planned repair: a rebuilt EUR(calc) formula, plus a derived rate when one was missing. */
interface EurRowRepair {
  rate?: number;
  formula: string;
}

/**
 * Decide what (if anything) to fix for one Expenses data row, given its FORMULA
 * render and its computed (value) render:
 *   - a stale self-positioning EUR(calc) formula whose baked-in INDIRECT letters
 *     no longer match the live layout → rebuild; the rate was stored at append
 *     time. A shift makes such a formula either ERROR (#VALUE!) or — when the
 *     shifted letter lands on an empty/numeric cell — silently compute a WRONG
 *     number, so a text comparison against the expected formula catches both;
 *   - a static EUR(calc) number (migration artifact) → derive the rate if absent,
 *     then attach a formula;
 *   - a correct formula, an auto-adjusting relative-ref formula, or an empty cell
 *     → leave untouched.
 */
function planEurRowRepair(
  formulaRow: (string | number | null | undefined)[],
  computedRow: (string | number | null | undefined)[],
  cols: EurRepairColumns,
): EurRowRepair | null {
  const amountColIdx = cols.amountColIndices.find((idx) => Number(formulaRow[idx]) > 0);
  if (amountColIdx === undefined) return null;

  const formula = buildEurCalcFormula(amountColIdx, cols.rateColIdx);
  const eurCell = formulaRow[cols.eurColIdx];
  const hasFormula = typeof eurCell === 'string' && eurCell.startsWith('=');

  if (hasFormula) {
    // Already the correct formula for the live layout — nothing to do.
    if (eurCell === formula) return null;
    // Rebuild when the formula ERRORS, or when it is a self-positioning
    // (INDIRECT) formula whose letters drifted from the layout — the latter can
    // compute a wrong number without ever raising #VALUE!. Plain relative refs
    // auto-adjust on a column shift, so a non-INDIRECT formula that computes a
    // number is left alone.
    const stale = isFormulaError(computedRow[cols.eurColIdx]) || eurCell.includes('INDIRECT');
    if (!stale) return null;
    // Without a rate we can't produce a correct value (the rebuilt formula would
    // just multiply by an empty cell) → skip.
    if (isEmptyCell(formulaRow[cols.rateColIdx])) return null;
    return { formula };
  }

  // Static EUR(calc) number (migration artifact) — needs a formula.
  if (isEmptyCell(eurCell)) return null;
  if (!isEmptyCell(formulaRow[cols.rateColIdx])) return { formula };

  // Rate missing: derive it from EUR / amount (preserves that day's rate).
  const eurNum = Number(eurCell);
  const amountNum = Number(formulaRow[amountColIdx]);
  if (amountNum > 0 && eurNum > 0) {
    return { rate: Math.round((eurNum / amountNum) * 1_000_000) / 1_000_000, formula };
  }
  return null; // Can't derive rate — skip
}

type SheetCell = string | number | null | undefined;

/**
 * Read the Expenses data rows twice: formulas AND computed values. Under
 * FORMULA render a broken cell returns its (stale) formula text; under a value
 * render it returns the #VALUE!/#REF! error — both are needed to tell a correct
 * formula from a stale one without clobbering working formulas.
 */
async function readFormulaAndValueRows(
  sheets: SheetsClient,
  spreadsheetId: string,
  lastCol: string,
): Promise<{ formulaRows: unknown[][]; valueRows: unknown[][] }> {
  const [formulaResp, valueResp] = await Promise.all([
    withSheetsRetry(
      () =>
        sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${EXPENSES_TAB}!A2:${lastCol}`,
          valueRenderOption: 'FORMULA',
        }),
      'repairEurFormulas.readFormulas',
    ),
    withSheetsRetry(
      () =>
        sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${EXPENSES_TAB}!A2:${lastCol}`,
          valueRenderOption: 'FORMATTED_VALUE',
        }),
      'repairEurFormulas.readValues',
    ),
  ]);
  return {
    formulaRows: formulaResp.data.values ?? [],
    valueRows: valueResp.data.values ?? [],
  };
}

/** Plan every row's repair; sheet rows are 1-based and offset by the header row. */
function planAllEurRepairs(
  formulaRows: unknown[][],
  valueRows: unknown[][],
  cols: EurRepairColumns,
): {
  eurFormulaUpdates: { row: number; formula: string }[];
  rateUpdates: { row: number; rate: number }[];
} {
  const eurFormulaUpdates: { row: number; formula: string }[] = [];
  const rateUpdates: { row: number; rate: number }[] = [];

  for (let i = 0; i < formulaRows.length; i++) {
    const formulaRow = formulaRows[i] as SheetCell[];
    if (!formulaRow || formulaRow.length === 0) continue;
    const computedRow = (valueRows[i] ?? []) as SheetCell[];

    const plan = planEurRowRepair(formulaRow, computedRow, cols);
    if (!plan) continue;

    const sheetRow = i + 2; // 1-based row + skip header
    if (plan.rate !== undefined) rateUpdates.push({ row: sheetRow, rate: plan.rate });
    eurFormulaUpdates.push({ row: sheetRow, formula: plan.formula });
  }
  return { eurFormulaUpdates, rateUpdates };
}

/**
 * Scan the Expenses tab and repair broken EUR (calc) cells, rewriting each as a
 * self-positioning amount × rate formula (see buildEurCalcFormula). Heals:
 *   - static numbers left by a sheet migration;
 *   - formulas that ERROR (#VALUE!/#REF!) because a column insert shifted the
 *     columns their baked-in INDIRECT letters reference.
 * Correct formulas and EUR-denominated rows are left untouched. Returns the
 * number of EUR(calc) cells rewritten.
 */
export async function repairEurFormulas(conn: GoogleConn, spreadsheetId: string): Promise<number> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  const headerResponse = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${EXPENSES_TAB}!1:1`,
        valueRenderOption: 'FORMATTED_VALUE',
      }),
    'repairEurFormulas.readHeaders',
  );
  const headers = (headerResponse.data.values?.[0] ?? []) as string[];

  const eurColIdx = headers.indexOf(SPREADSHEET_CONFIG.eurColumnHeader);
  const rateColIdx = headers.indexOf(RATE_COLUMN_HEADER);
  if (eurColIdx === -1 || rateColIdx === -1) return 0;

  const amountColIndices = nonEurCurrencyColumnIndices(headers);
  if (amountColIndices.length === 0) return 0;

  const { formulaRows, valueRows } = await readFormulaAndValueRows(
    sheets,
    spreadsheetId,
    colLetter(headers.length - 1),
  );

  const cols: EurRepairColumns = { eurColIdx, rateColIdx, amountColIndices };
  const { eurFormulaUpdates, rateUpdates } = planAllEurRepairs(formulaRows, valueRows, cols);

  if (eurFormulaUpdates.length === 0 && rateUpdates.length === 0) return 0;

  // Write derived rates first, then replace EUR values with formulas
  const batchData = [
    ...rateUpdates.map(({ row, rate }) => ({
      range: `${EXPENSES_TAB}!${colLetter(rateColIdx)}${row}`,
      values: [[rate]],
    })),
    ...eurFormulaUpdates.map(({ row, formula }) => ({
      range: `${EXPENSES_TAB}!${colLetter(eurColIdx)}${row}`,
      values: [[formula]],
    })),
  ];

  await writeValueUpdatesInChunks(sheets, spreadsheetId, batchData, 'repairEurFormulas.write');

  logger.info(
    `[SHEETS] repairEurFormulas: ${eurFormulaUpdates.length} formulas, ${rateUpdates.length} rates derived`,
  );

  return eurFormulaUpdates.length;
}
