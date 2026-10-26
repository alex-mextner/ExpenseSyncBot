/** Reads the Expenses tab into typed rows, flagging ambiguous and EUR-mismatched rows */

import { google } from 'googleapis';
import type { CurrencyCode } from '../../config/constants';
import { SPREADSHEET_CONFIG } from '../../config/constants';
import { createLogger } from '../../utils/logger.ts';
import { convertToEUR } from '../currency/converter';
import { authClient, type GoogleConn, RATE_COLUMN_HEADER, withSheetsRetry } from './sheets-core';

const logger = createLogger('sheets');

/**
 * Row data from spreadsheet
 */
export interface SheetRow {
  date: string;
  amounts: Record<string, number>; // currency -> amount
  eurAmount: number;
  rate: number | null; // exchange rate stored at write time (1 CURRENCY = rate EUR)
  category: string;
  comment: string;
}

/**
 * Error describing a row with amounts in multiple currency columns
 */
export interface MultiCurrencyRowError {
  row: number; // 1-based spreadsheet row
  date: string;
  currencies: string[]; // e.g. ["USD", "RSD"]
  category: string;
}

export interface EurMismatchWarning {
  row: number;
  date: string;
  category: string;
  sheetEur: number;
  recalcEur: number;
}

interface ExpenseColumns {
  dateCol: number;
  categoryCol: number;
  commentCol: number;
  eurCol: number;
  rateCol: number;
  currencyColumns: Array<{ index: number; currency: string }>;
}

/** Parse a cell as a strictly positive number; blank, non-numeric and <= 0 cells yield null. */
function parsePositiveNumber(cell: string | null | undefined): number | null {
  if (!cell || cell.trim() === '') return null;
  const parsed = parseFloat(cell);
  return !Number.isNaN(parsed) && parsed > 0 ? parsed : null;
}

/** Currency amount columns: any header that is not a fixed column but looks like "USD ($)". */
function findCurrencyColumns(headers: string[]): Array<{ index: number; currency: string }> {
  const fixedHeaders: string[] = [
    SPREADSHEET_CONFIG.headers[0],
    SPREADSHEET_CONFIG.headers[1],
    SPREADSHEET_CONFIG.headers[2],
    SPREADSHEET_CONFIG.eurColumnHeader,
    RATE_COLUMN_HEADER,
  ];
  const currencyColumns: Array<{ index: number; currency: string }> = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i] ?? '';
    if (!header || fixedHeaders.includes(header)) continue;
    const match = header.match(/^([A-Z]{3})\s*\(/);
    if (match?.[1]) {
      currencyColumns.push({ index: i, currency: match[1] });
    }
  }
  return currencyColumns;
}

function locateColumns(headers: string[]): ExpenseColumns {
  const dateCol = headers.indexOf(SPREADSHEET_CONFIG.headers[0] ?? '');
  const categoryCol = headers.indexOf(SPREADSHEET_CONFIG.headers[1] ?? '');
  const commentCol = headers.indexOf(SPREADSHEET_CONFIG.headers[2] ?? '');
  const eurCol = headers.indexOf(SPREADSHEET_CONFIG.eurColumnHeader);
  const rateCol = headers.indexOf(RATE_COLUMN_HEADER);

  if (dateCol === -1 || categoryCol === -1 || commentCol === -1) {
    throw new Error('Required columns not found in spreadsheet');
  }

  return {
    dateCol,
    categoryCol,
    commentCol,
    eurCol,
    rateCol,
    currencyColumns: findCurrencyColumns(headers),
  };
}

/** EUR amount: prefer recalculated value; EUR expenses use the amount itself. */
function resolveEurAmount(
  currency: string | undefined,
  amount: number | undefined,
  rate: number | null,
): number {
  if (currency === 'EUR') {
    // EUR expenses: amount IS eur_amount
    return amount ?? 0;
  }
  if (rate && amount) {
    // Non-EUR with Rate column: recalculate (Rate stores "1 CURRENCY = rate EUR")
    return Math.round(amount * rate * 100) / 100;
  }
  if (currency && amount) {
    // No Rate column: use runtime converter
    return convertToEUR(amount, currency as CurrencyCode);
  }
  return 0;
}

/**
 * Sheet EUR(calc) value when it diverges more than 2x from the recalculated
 * EUR amount, otherwise null.
 */
function divergentSheetEur(
  eurAmountStr: string | null | undefined,
  eurAmount: number,
): number | null {
  if (eurAmount <= 0) return null;
  const sheetEur = parsePositiveNumber(eurAmountStr);
  if (sheetEur === null) return null;
  const ratio = sheetEur / eurAmount;
  return ratio < 0.5 || ratio > 2.0 ? sheetEur : null;
}

/**
 * Positive amounts found in the row, keyed by currency. `found` keeps one entry
 * per filled currency column (a duplicated currency header counts twice).
 */
function parseRowAmounts(
  row: string[],
  cols: ExpenseColumns,
): { amounts: Record<string, number>; found: string[] } {
  const amounts: Record<string, number> = {};
  const found: string[] = [];
  for (const { index, currency } of cols.currencyColumns) {
    const parsed = parsePositiveNumber(row[index]);
    if (parsed !== null) {
      amounts[currency] = parsed;
      found.push(currency);
    }
  }
  return { amounts, found };
}

interface ParsedExpenseRow {
  expense: SheetRow;
  mismatch: EurMismatchWarning | null;
}

/**
 * Parse one data row (`sheetRow` is its 1-based spreadsheet row). Returns an
 * ambiguity error when several currency columns are filled, or null when the
 * row holds no usable amount.
 */
function parseExpenseRow(
  row: string[],
  sheetRow: number,
  cols: ExpenseColumns,
): ParsedExpenseRow | MultiCurrencyRowError | null {
  const date = row[cols.dateCol] ?? '';
  const category = row[cols.categoryCol] || 'Без категории';
  const comment = row[cols.commentCol] || '';
  const eurAmountStr = cols.eurCol !== -1 ? row[cols.eurCol] : null;

  const { amounts, found } = parseRowAmounts(row, cols);

  // Flag rows with amounts in multiple currency columns — data is ambiguous
  if (found.length > 1) {
    return { row: sheetRow, date, currencies: found, category };
  }

  // No currency amount found — fall back to EUR(calc) as EUR amount
  // (happens when expense was in a currency without a column in the sheet)
  if (found.length === 0) {
    const eurCalcVal = eurAmountStr ? parseFloat(eurAmountStr) : 0;
    if (!eurCalcVal || eurCalcVal <= 0) return null; // truly empty row
    amounts['EUR'] = eurCalcVal;
  }

  const rate = cols.rateCol === -1 ? null : parsePositiveNumber(row[cols.rateCol]);
  const [firstCurr, firstAmt] = Object.entries(amounts)[0] ?? [];
  const eurAmount = resolveEurAmount(firstCurr, firstAmt, rate);

  // Warn if sheet EUR(calc) diverges significantly from recalculated value
  const sheetEur = divergentSheetEur(eurAmountStr, eurAmount);
  const mismatch =
    sheetEur === null ? null : { row: sheetRow, date, category, sheetEur, recalcEur: eurAmount };

  return { expense: { date, amounts, eurAmount, rate, category, comment }, mismatch };
}

/**
 * Read all expenses from Google Sheet.
 * Returns expenses, multi-currency errors, and EUR mismatch warnings.
 * EUR amounts are always recalculated from amount × Rate — sheet EUR(calc) is not trusted.
 */
export async function readExpensesFromSheet(
  conn: GoogleConn,
  spreadsheetId: string,
): Promise<{
  expenses: SheetRow[];
  errors: MultiCurrencyRowError[];
  eurMismatches: EurMismatchWarning[];
}> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SPREADSHEET_CONFIG.sheetName}!A:Z`,
      }),
    'readExpensesFromSheet',
  );

  const rows = response.data.values || [];

  if (rows.length === 0) {
    return { expenses: [], errors: [], eurMismatches: [] };
  }

  const headers = rows[0] as string[];
  logger.info({ data: headers }, `[SHEETS] Headers`);

  const cols = locateColumns(headers);

  const expenses: SheetRow[] = [];
  const errors: MultiCurrencyRowError[] = [];
  const eurMismatchRows: EurMismatchWarning[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as string[];
    if (!row || row.length === 0 || !row[cols.dateCol]) continue;

    const parsed = parseExpenseRow(row, i + 1, cols); // i + 1: 1-based for spreadsheet display
    if (!parsed) continue;
    if ('currencies' in parsed) {
      errors.push(parsed);
      continue;
    }
    if (parsed.mismatch) eurMismatchRows.push(parsed.mismatch);
    expenses.push(parsed.expense);
  }

  if (eurMismatchRows.length > 0) {
    logger.warn(
      `[SHEETS] ${eurMismatchRows.length} rows have EUR mismatch (sheet formula vs recalculated)`,
    );
  }

  return { expenses, errors, eurMismatches: eurMismatchRows };
}
