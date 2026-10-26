/** Google Sheets service — creates spreadsheets, appends expense rows, and syncs budget data */
import { google } from 'googleapis';
import type { CurrencyCode } from '../../config/constants';
import { getCurrencySymbol, SPREADSHEET_CONFIG } from '../../config/constants';
import { OAuthError } from '../../errors';
import { createLogger } from '../../utils/logger.ts';
import { monthAbbrFromDate } from './month-abbr';
import { isTokenExpiredError } from './oauth';
import {
  authClient,
  buildEurCalcFormula,
  colLetter,
  enqueueSheetWrite,
  type GoogleConn,
  nonEurCurrencyColumnIndices,
  RATE_COLUMN_HEADER,
  type SheetsClient,
  withSheetsRetry,
  writeValueUpdatesInChunks,
} from './sheets-core';

export type { GoogleConn } from './sheets-core';
export {
  chunkArray,
  enqueueSheetWrite,
  GOOGLE_SHEETS_LIMITS,
  googleConn,
  isCurrencyColumnHeader,
  isRateLimitError,
  nonEurCurrencyColumnIndices,
  withSheetsRetry,
} from './sheets-core';

import { createEmptyMonthTab } from './sheets-month-tabs';

export {
  cloneMonthTab,
  createEmptyMonthTab,
  listMonthTabs,
  monthTabExists,
  readMonthBudget,
  writeMonthBudgetRow,
} from './sheets-month-tabs';
export type { EurMismatchWarning, MultiCurrencyRowError, SheetRow } from './sheets-read';
export { readExpensesFromSheet } from './sheets-read';
export { repairDateSerials, repairEurFormulas } from './sheets-repair';
export {
  appendExpenseRowsRaw,
  deleteExpenseRowsByIndex,
  findAndDeleteExpenseRow,
  readExpenseHeaders,
  readExpenseRowsRaw,
  renameSpreadsheet,
  sortExpensesTab,
} from './sheets-rows';

const logger = createLogger('sheets');

/**
 * Create a new expense tracking spreadsheet
 */
export async function createExpenseSpreadsheet(
  conn: GoogleConn,
  _defaultCurrency: CurrencyCode,
  enabledCurrencies: CurrencyCode[],
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  // Build headers: Date | Currencies | EUR(calc) | Category | Comment | Rate
  const headers = [
    SPREADSHEET_CONFIG.headers[0], // Дата
    ...enabledCurrencies.map((code) => `${code} (${getCurrencySymbol(code)})`),
    SPREADSHEET_CONFIG.eurColumnHeader, // EUR (calc)
    SPREADSHEET_CONFIG.headers[1], // Категория
    SPREADSHEET_CONFIG.headers[2], // Комментарий
    RATE_COLUMN_HEADER, // Rate (→EUR)
  ];

  // Create spreadsheet
  const response = await withSheetsRetry(
    () =>
      sheets.spreadsheets.create({
        requestBody: {
          properties: {
            title: `Expenses Tracker ${new Date().getFullYear()}`,
          },
          sheets: [
            {
              properties: {
                title: SPREADSHEET_CONFIG.sheetName,
                gridProperties: {
                  frozenRowCount: 1, // Freeze header row
                },
              },
              data: [
                {
                  startRow: 0,
                  startColumn: 0,
                  rowData: [
                    {
                      values: headers.map((header) => ({
                        userEnteredValue: { stringValue: header },
                        userEnteredFormat: {
                          textFormat: { bold: true },
                          backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                        },
                      })),
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    'createExpenseSpreadsheet.create',
  );

  const spreadsheetId = response.data.spreadsheetId;
  if (!spreadsheetId) throw new Error('Spreadsheet creation did not return an ID');
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

  // Get real sheetId from response
  const sheetId = response.data.sheets?.[0]?.properties?.sheetId;

  if (sheetId !== undefined) {
    // Auto-resize columns
    await withSheetsRetry(
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                autoResizeDimensions: {
                  dimensions: {
                    sheetId: sheetId,
                    dimension: 'COLUMNS',
                    startIndex: 0,
                    endIndex: headers.length,
                  },
                },
              },
            ],
          },
        }),
      'createExpenseSpreadsheet.autoResize',
    );
  }

  // Create current month's budget tab alongside the expenses tab
  try {
    const currentMonthAbbr = monthAbbrFromDate(new Date());
    await createEmptyMonthTab(conn, spreadsheetId, currentMonthAbbr);
  } catch (err) {
    logger.error({ err }, '[SHEETS] Failed to create month budget tab during spreadsheet creation');
  }

  return { spreadsheetId, spreadsheetUrl };
}

export interface ExpenseRowData {
  date: string;
  category: string;
  comment: string;
  amounts: Record<string, number | null>; // Currency -> amount
  eurAmount: number;
  rate?: number; // Exchange rate used (1 CURRENCY = rate EUR)
}

export async function appendExpenseRow(
  conn: GoogleConn,
  spreadsheetId: string,
  data: ExpenseRowData,
): Promise<void> {
  return enqueueSheetWrite(spreadsheetId, () => appendExpenseRowImpl(conn, spreadsheetId, data));
}

/**
 * Batch append: reads headers once, inserts missing columns once,
 * appends all rows in one API call, writes EUR formulas in one batchUpdate.
 */
export async function appendExpenseRows(
  conn: GoogleConn,
  spreadsheetId: string,
  dataList: ExpenseRowData[],
): Promise<void> {
  if (dataList.length === 0) return;
  return enqueueSheetWrite(spreadsheetId, () =>
    appendExpenseRowsImpl(conn, spreadsheetId, dataList),
  );
}

/** Currency of the first non-null amount in the row, if any. */
function expenseCurrencyOf(data: ExpenseRowData): string | undefined {
  return Object.entries(data.amounts).find(([, v]) => v !== null)?.[0];
}

/** Read the header row of the Expenses sheet (empty when the sheet has no header). */
async function readSheetHeaders(
  sheets: SheetsClient,
  spreadsheetId: string,
  label: string,
): Promise<string[]> {
  const headersResponse = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SPREADSHEET_CONFIG.sheetName}!1:1`,
      }),
    label,
  );
  return headersResponse.data.values?.[0] || [];
}

function hasCurrencyColumn(headers: string[], currency: string): boolean {
  return headers.some((h) => h.startsWith(`${currency} (`));
}

/**
 * Build one sheet row in header order. EUR formulas for non-EUR rows are baked
 * in via `=INDIRECT("<amountCol>"&ROW())*INDIRECT("<rateCol>"&ROW())` — a
 * self-positioning formula that doesn't need to know its absolute row
 * number. This lets us put the formula inside the first append call
 * instead of doing a second values.batchUpdate, halving write quota usage.
 *
 * Trade-off: INDIRECT is volatile — it recalculates on any sheet change.
 * Immeasurable on the few-thousand rows an expense tracker accumulates.
 */
function buildExpenseRow(headers: string[], data: ExpenseRowData): (string | number)[] {
  const expenseCurrency = expenseCurrencyOf(data);
  const rateColIdx = headers.indexOf(RATE_COLUMN_HEADER);
  const amountColIdx = headers.findIndex((h) => h.split(' ')[0] === expenseCurrency);

  const needsFormula =
    expenseCurrency !== 'EUR' && !!data.rate && amountColIdx !== -1 && rateColIdx !== -1;
  const eurFormula = needsFormula ? buildEurCalcFormula(amountColIdx, rateColIdx) : null;

  return headers.map((header) => {
    if (header === SPREADSHEET_CONFIG.headers[0]) return data.date;
    if (header === SPREADSHEET_CONFIG.headers[1]) return data.category;
    if (header === SPREADSHEET_CONFIG.headers[2]) return data.comment;
    // Formula when we can derive EUR from amount*rate, otherwise literal
    if (header === SPREADSHEET_CONFIG.eurColumnHeader) return eurFormula ?? data.eurAmount;
    if (header === RATE_COLUMN_HEADER) return data.rate ?? '';
    const currencyCode = header?.split(' ')[0] as CurrencyCode;
    return data.amounts[currencyCode] ?? '';
  });
}

/** Insert the currency columns the rows need, then the Rate column; returns the final headers. */
async function ensureColumnsForCurrencies(
  sheets: SheetsClient,
  spreadsheetId: string,
  initialHeaders: string[],
  currencies: Iterable<string>,
): Promise<string[]> {
  let headers = initialHeaders;
  for (const curr of currencies) {
    if (!hasCurrencyColumn(headers, curr)) {
      headers = await insertCurrencyColumn(sheets, spreadsheetId, headers, curr as CurrencyCode);
    }
  }

  // Ensure Rate column exists
  if (!headers.includes(RATE_COLUMN_HEADER)) {
    headers = await ensureRateColumn(sheets, spreadsheetId, headers);
  }
  return headers;
}

async function appendExpenseRowsImpl(
  conn: GoogleConn,
  spreadsheetId: string,
  dataList: ExpenseRowData[],
): Promise<void> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  // Get headers once
  const initialHeaders = await readSheetHeaders(
    sheets,
    spreadsheetId,
    'appendExpenseRows.readHeaders',
  );
  logger.info({ data: initialHeaders }, '[SHEETS-BATCH] Headers from spreadsheet');

  // Collect all unique currencies that need columns
  const allCurrencies = new Set<string>();
  for (const data of dataList) {
    const curr = expenseCurrencyOf(data);
    if (curr) allCurrencies.add(curr);
  }

  // Insert missing currency columns (once per unique currency)
  const headers = await ensureColumnsForCurrencies(
    sheets,
    spreadsheetId,
    initialHeaders,
    allCurrencies,
  );

  const rows = dataList.map((data) => buildExpenseRow(headers, data));

  // Single append call — rows contain their own EUR formulas (no second round-trip)
  const response = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${SPREADSHEET_CONFIG.sheetName}!A:A`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      }),
    'appendExpenseRows.append',
  );

  const updatedRange = response.data.updates?.updatedRange;
  const updatedRows = response.data.updates?.updatedRows;
  logger.info(`[SHEETS-BATCH] Appended ${updatedRows} rows, range=${updatedRange}`);

  if (!updatedRows || updatedRows === 0) {
    logger.error('[SHEETS-BATCH] No rows appended');
  }
}

async function appendExpenseRowImpl(
  conn: GoogleConn,
  spreadsheetId: string,
  data: ExpenseRowData,
): Promise<void> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  // Get headers to determine column order
  const initialHeaders = await readSheetHeaders(
    sheets,
    spreadsheetId,
    'appendExpenseRow.readHeaders',
  );
  logger.info({ data: initialHeaders }, `[SHEETS] Headers from spreadsheet`);

  // Check if expense currency has a column; if not, insert one
  const expenseCurrency = expenseCurrencyOf(data);
  const headers = await ensureColumnsForCurrencies(
    sheets,
    spreadsheetId,
    initialHeaders,
    expenseCurrency ? [expenseCurrency] : [],
  );

  // Self-positioning EUR formula — see buildExpenseRow for rationale.
  // One append call, no second round-trip to attach the formula afterwards.
  const row = buildExpenseRow(headers, data);

  logger.info({ data: row }, `[SHEETS] Final row`);

  // Single append call — row already carries its own EUR formula
  const response = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${SPREADSHEET_CONFIG.sheetName}!A:A`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [row],
        },
      }),
    'appendExpenseRow.append',
  );

  const updatedRange = response.data.updates?.updatedRange;
  const updatedRows = response.data.updates?.updatedRows;
  logger.info(
    `[SHEETS] API response: range=${updatedRange}, rows=${updatedRows}, cells=${response.data.updates?.updatedCells}`,
  );

  if (!updatedRows || updatedRows === 0) {
    logger.error(
      `[SHEETS] No rows were appended! Full response: ${JSON.stringify(response.data, null, 2)}`,
    );
  }
}

/**
 * Insert a new currency column before EUR (calc) in an existing spreadsheet.
 * Returns the updated headers array.
 */
async function insertCurrencyColumn(
  sheets: SheetsClient,
  spreadsheetId: string,
  currentHeaders: string[],
  currency: CurrencyCode,
): Promise<string[]> {
  const symbol = getCurrencySymbol(currency);
  const newHeader = `${currency} (${symbol})`;

  // Insert before EUR (calc)
  const eurCalcIdx = currentHeaders.indexOf(SPREADSHEET_CONFIG.eurColumnHeader);
  const insertIdx = eurCalcIdx !== -1 ? eurCalcIdx : currentHeaders.length;

  // Get sheet ID
  const spreadsheet = await withSheetsRetry(
    () => sheets.spreadsheets.get({ spreadsheetId }),
    'insertCurrencyColumn.getSheetId',
  );
  const sheet = spreadsheet.data.sheets?.find(
    (s) => s.properties?.title === SPREADSHEET_CONFIG.sheetName,
  );
  const sheetId = sheet?.properties?.sheetId;

  if (sheetId === undefined) {
    logger.error('[SHEETS] Cannot find Expenses sheet ID for column insertion');
    return currentHeaders;
  }

  // Insert column at position
  await withSheetsRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId,
                  dimension: 'COLUMNS',
                  startIndex: insertIdx,
                  endIndex: insertIdx + 1,
                },
              },
            },
            {
              updateCells: {
                rows: [
                  {
                    values: [
                      {
                        userEnteredValue: { stringValue: newHeader },
                        userEnteredFormat: {
                          textFormat: { bold: true },
                          backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                        },
                      },
                    ],
                  },
                ],
                fields: 'userEnteredValue,userEnteredFormat',
                start: { sheetId, rowIndex: 0, columnIndex: insertIdx },
              },
            },
          ],
        },
      }),
    `insertCurrencyColumn.write ${currency}`,
  );

  logger.info(`[SHEETS] Inserted currency column "${newHeader}" at index ${insertIdx}`);

  // Compute the post-insert header layout.
  const updated = [...currentHeaders];
  updated.splice(insertIdx, 0, newHeader);

  // Inserting before "EUR (calc)" shifts the Rate column (and everything right
  // of the insert point) one position over. Existing rows' EUR(calc) formulas
  // hard-code the OLD column letters inside INDIRECT() strings, which Google
  // cannot auto-adjust — so the rate reference would now point at a text column
  // and evaluate to #VALUE!. Recompute them for the new layout to keep
  // historical EUR totals correct.
  await rewriteEurFormulasForLayout(sheets, spreadsheetId, updated);

  return updated;
}

/**
 * Recompute every data row's EUR(calc) formula against the given (current)
 * header layout. Used after a column insert/move shifts the columns the
 * formulas reference: the INDIRECT() column letters baked in at append time do
 * not follow the shift, so the rate/amount references silently break (#VALUE!).
 *
 * Only rows whose EUR(calc) is already a formula are rewritten — EUR-native and
 * empty rows hold static values that a column shift can't corrupt. Self-heals
 * on every insert, preserving the single-write append optimisation.
 */
async function rewriteEurFormulasForLayout(
  sheets: SheetsClient,
  spreadsheetId: string,
  headers: string[],
): Promise<void> {
  const eurCalcIdx = headers.indexOf(SPREADSHEET_CONFIG.eurColumnHeader);
  const rateColIdx = headers.indexOf(RATE_COLUMN_HEADER);
  if (eurCalcIdx === -1 || rateColIdx === -1) return;

  const amountColIndices = nonEurCurrencyColumnIndices(headers);
  if (amountColIndices.length === 0) return;

  const lastCol = colLetter(headers.length - 1);
  const dataResponse = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SPREADSHEET_CONFIG.sheetName}!A2:${lastCol}`,
        valueRenderOption: 'FORMULA',
      }),
    'rewriteEurFormulasForLayout.read',
  );
  const rows = dataResponse.data.values ?? [];

  const updates: { range: string; values: string[][] }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as (string | number | null | undefined)[];
    if (!row || row.length === 0) continue;

    // Only formula cells carry a broken reference; static numbers are fine.
    const eurVal = row[eurCalcIdx];
    if (typeof eurVal !== 'string' || !eurVal.startsWith('=')) continue;

    // The amount column is the non-EUR currency column holding a positive value.
    const amountColIdx = amountColIndices.find((idx) => Number(row[idx]) > 0);
    if (amountColIdx === undefined) continue;

    updates.push({
      range: `${SPREADSHEET_CONFIG.sheetName}!${colLetter(eurCalcIdx)}${i + 2}`, // +2: 1-based + header
      values: [[buildEurCalcFormula(amountColIdx, rateColIdx)]],
    });
  }

  if (updates.length === 0) return;

  await writeValueUpdatesInChunks(
    sheets,
    spreadsheetId,
    updates,
    'rewriteEurFormulasForLayout.write',
  );

  logger.info(`[SHEETS] Rewrote ${updates.length} EUR(calc) formulas after column shift`);
}

/**
 * Ensure the Rate (→EUR) column exists, appending it at the end if missing.
 * Returns the updated headers array.
 */
async function ensureRateColumn(
  sheets: SheetsClient,
  spreadsheetId: string,
  currentHeaders: string[],
): Promise<string[]> {
  // Append at end
  const insertIdx = currentHeaders.length;

  const spreadsheet = await withSheetsRetry(
    () => sheets.spreadsheets.get({ spreadsheetId }),
    'ensureRateColumn.getSheetId',
  );
  const sheet = spreadsheet.data.sheets?.find(
    (s) => s.properties?.title === SPREADSHEET_CONFIG.sheetName,
  );
  const sheetId = sheet?.properties?.sheetId;

  if (sheetId === undefined) {
    logger.error('[SHEETS] Cannot find Expenses sheet ID for rate column');
    return currentHeaders;
  }

  await withSheetsRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateCells: {
                rows: [
                  {
                    values: [
                      {
                        userEnteredValue: { stringValue: RATE_COLUMN_HEADER },
                        userEnteredFormat: {
                          textFormat: { bold: true },
                          backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                        },
                      },
                    ],
                  },
                ],
                fields: 'userEnteredValue,userEnteredFormat',
                start: { sheetId, rowIndex: 0, columnIndex: insertIdx },
              },
            },
          ],
        },
      }),
    'ensureRateColumn.write',
  );

  logger.info(`[SHEETS] Added Rate column at index ${insertIdx}`);
  return [...currentHeaders, RATE_COLUMN_HEADER];
}

/**
 * Ensure spreadsheet has all required columns (currency columns + Rate).
 * Call at bot startup for each configured group.
 */
export async function ensureSheetColumns(
  conn: GoogleConn,
  spreadsheetId: string,
  enabledCurrencies: CurrencyCode[],
): Promise<void> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  const headersResponse = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SPREADSHEET_CONFIG.sheetName}!1:1`,
      }),
    'ensureSheetColumns.readHeaders',
  );

  let headers: string[] = headersResponse.data.values?.[0] || [];

  // Add missing currency columns
  for (const currency of enabledCurrencies) {
    const hasCurrencyCol = headers.some((h) => h.startsWith(`${currency} (`));
    if (!hasCurrencyCol) {
      headers = await insertCurrencyColumn(sheets, spreadsheetId, headers, currency);
    }
  }

  // Add Rate column if missing
  if (!headers.includes(RATE_COLUMN_HEADER)) {
    await ensureRateColumn(sheets, spreadsheetId, headers);
  }
}

/**
 * Get spreadsheet URL
 */
export function getSpreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

/**
 * Verify spreadsheet access
 */
export async function verifySpreadsheetAccess(
  conn: GoogleConn,
  spreadsheetId: string,
): Promise<boolean> {
  try {
    const auth = authClient(conn);
    const sheets = google.sheets({ version: 'v4', auth });

    await withSheetsRetry(
      () => sheets.spreadsheets.get({ spreadsheetId }),
      'verifySpreadsheetAccess',
    );
    return true;
  } catch (err) {
    if (isTokenExpiredError(err)) {
      throw new OAuthError(
        'Токен доступа истёк или был отозван. Используй /reconnect',
        'TOKEN_EXPIRED',
        err,
      );
    }
    logger.error({ err }, 'Failed to verify spreadsheet access');
    return false;
  }
}
