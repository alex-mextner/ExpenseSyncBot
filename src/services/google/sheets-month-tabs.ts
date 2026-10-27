/** Monthly budget tabs (Jan..Dec) inside the expense spreadsheet */

import { google } from 'googleapis';
import type { CurrencyCode } from '../../config/constants';
import { createLogger } from '../../utils/logger.ts';
import { MONTH_ABBREVS, type MonthAbbr } from './month-abbr';
import { authClient, type GoogleConn, withSheetsRetry } from './sheets-core';

const logger = createLogger('sheets');

// ── Monthly budget tab functions ────────────────────────────────────────────

export interface BudgetRow {
  category: string;
  limit: number;
  currency: CurrencyCode;
}

const MONTH_TAB_HEADERS = ['Category', 'Limit', 'Currency'];

/**
 * Check if a monthly budget tab (e.g. "Mar") exists in the spreadsheet
 */
export async function monthTabExists(
  conn: GoogleConn,
  spreadsheetId: string,
  month: MonthAbbr,
): Promise<boolean> {
  try {
    const auth = authClient(conn);
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheet = await withSheetsRetry(
      () => sheets.spreadsheets.get({ spreadsheetId }),
      `monthTabExists ${month}`,
    );
    return !!spreadsheet.data.sheets?.find((s) => s.properties?.title === month);
  } catch (err) {
    logger.error({ err }, `[SHEETS] monthTabExists failed for ${month}`);
    return false;
  }
}

/**
 * Fetch all month-abbreviation tabs (e.g. "Jan", "Feb", …) present in the
 * spreadsheet with a single `spreadsheets.get` call. Used to avoid the N× per-
 * month `monthTabExists` probe that hits Sheets quota in bulk-sync loops.
 *
 * Rethrows underlying errors (including 429/403) so the caller can classify
 * or retry at a higher level — this is deliberate, unlike the defensive
 * catch in `monthTabExists`.
 */
export async function listMonthTabs(conn: GoogleConn, spreadsheetId: string): Promise<MonthAbbr[]> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheet = await withSheetsRetry(
    () => sheets.spreadsheets.get({ spreadsheetId }),
    'listMonthTabs',
  );
  const titles = new Set(
    spreadsheet.data.sheets
      ?.map((s) => s.properties?.title)
      .filter((t): t is string => typeof t === 'string') ?? [],
  );
  return MONTH_ABBREVS.filter((abbr) => titles.has(abbr));
}

/**
 * Create an empty monthly budget tab with header row (Category | Limit | Currency)
 */
export async function createEmptyMonthTab(
  conn: GoogleConn,
  spreadsheetId: string,
  month: MonthAbbr,
): Promise<void> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  const addResponse = await withSheetsRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: month,
                  gridProperties: { frozenRowCount: 1 },
                },
              },
            },
          ],
        },
      }),
    `createEmptyMonthTab.addSheet ${month}`,
  );

  const sheetId = addResponse.data.replies?.[0]?.addSheet?.properties?.sheetId;
  if (sheetId === undefined || sheetId === null) {
    throw new Error(
      `Failed to get sheetId for new month tab "${month}" in spreadsheet ${spreadsheetId}`,
    );
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
                    values: MONTH_TAB_HEADERS.map((header) => ({
                      userEnteredValue: { stringValue: header },
                      userEnteredFormat: {
                        textFormat: { bold: true },
                        backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                      },
                    })),
                  },
                ],
                fields: 'userEnteredValue,userEnteredFormat',
                start: { sheetId, rowIndex: 0, columnIndex: 0 },
              },
            },
            {
              autoResizeDimensions: {
                dimensions: {
                  sheetId,
                  dimension: 'COLUMNS',
                  startIndex: 0,
                  endIndex: 3,
                },
              },
            },
          ],
        },
      }),
    `createEmptyMonthTab.format ${month}`,
  );

  logger.info(`[SHEETS] Created empty month tab: ${month}`);
}

/**
 * Read all budget rows from a monthly tab
 */
export async function readMonthBudget(
  conn: GoogleConn,
  spreadsheetId: string,
  month: MonthAbbr,
): Promise<BudgetRow[]> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const response = await withSheetsRetry(
      () =>
        sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `${month}!A2:C`,
        }),
      `readMonthBudget ${month}`,
    );

    const rows = response.data.values ?? [];
    return rows
      .filter((r) => r.length >= 2)
      .map(([category, limitStr, currencyStr]) => ({
        category: (category as string).trim(),
        limit: parseFloat(limitStr as string),
        currency: ((currencyStr as string | undefined)?.trim() || 'EUR') as CurrencyCode,
      }))
      .filter((r) => r.category && !Number.isNaN(r.limit));
  } catch (err) {
    logger.error({ err }, `[SHEETS] readMonthBudget failed for ${month}`);
    return [];
  }
}

/**
 * Write or update a single budget row in a monthly tab (upsert by category).
 *
 * By default, defensively ensures the month tab exists before writing —
 * costs one extra `spreadsheets.get`. Callers that already guaranteed the
 * tab (e.g. via a single upfront `listMonthTabs` + selective
 * `createEmptyMonthTab`) should pass `{ ensureTab: false }` to skip the
 * redundant probe; this is what keeps the 60/min read quota from being
 * burned during bulk budget sync.
 */
export async function writeMonthBudgetRow(
  conn: GoogleConn,
  spreadsheetId: string,
  month: MonthAbbr,
  row: BudgetRow,
  options?: { ensureTab?: boolean },
): Promise<void> {
  const ensureTab = options?.ensureTab ?? true;
  if (ensureTab) {
    const tabExists = await monthTabExists(conn, spreadsheetId, month);
    if (!tabExists) {
      await createEmptyMonthTab(conn, spreadsheetId, month);
    }
  }

  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${month}!A2:C`,
      }),
    `writeMonthBudgetRow.get ${month}`,
  );

  const existingRows = response.data.values ?? [];
  let targetRow = -1;
  for (let i = 0; i < existingRows.length; i++) {
    if (
      (existingRows[i]?.[0] as string | undefined)?.toLowerCase() === row.category.toLowerCase()
    ) {
      targetRow = i + 2; // 1-indexed + header row
      break;
    }
  }

  const values = [[row.category, row.limit, row.currency]];

  if (targetRow !== -1) {
    await withSheetsRetry(
      () =>
        sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${month}!A${targetRow}:C${targetRow}`,
          valueInputOption: 'RAW',
          requestBody: { values },
        }),
      `writeMonthBudgetRow.update ${month}`,
    );
  } else {
    await withSheetsRetry(
      () =>
        sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `${month}!A2:C`,
          valueInputOption: 'RAW',
          requestBody: { values },
        }),
      `writeMonthBudgetRow.append ${month}`,
    );
  }
}

/**
 * Clone a monthly tab from one spreadsheet to another (cross-spreadsheet supported).
 * Uses the Google Sheets copyTo API, then renames the resulting sheet.
 */
export async function cloneMonthTab(
  conn: GoogleConn,
  sourceSpreadsheetId: string,
  sourceMonth: MonthAbbr,
  targetSpreadsheetId: string,
  targetMonth: MonthAbbr,
): Promise<void> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  // Find source sheet ID
  const sourceSpreadsheet = await withSheetsRetry(
    () => sheets.spreadsheets.get({ spreadsheetId: sourceSpreadsheetId }),
    `cloneMonthTab.getSource ${sourceMonth}`,
  );
  const sourceSheet = sourceSpreadsheet.data.sheets?.find(
    (s) => s.properties?.title === sourceMonth,
  );
  const sourceSheetId = sourceSheet?.properties?.sheetId;
  if (sourceSheetId === undefined || sourceSheetId === null) {
    throw new Error(`Source tab "${sourceMonth}" not found in ${sourceSpreadsheetId}`);
  }

  // Copy sheet to target spreadsheet
  const copyResponse = await withSheetsRetry(
    () =>
      sheets.spreadsheets.sheets.copyTo({
        spreadsheetId: sourceSpreadsheetId,
        sheetId: sourceSheetId,
        requestBody: { destinationSpreadsheetId: targetSpreadsheetId },
      }),
    `cloneMonthTab.copyTo ${sourceMonth}`,
  );

  const newSheetId = copyResponse.data.sheetId;
  if (newSheetId === undefined || newSheetId === null) {
    throw new Error('copyTo did not return a sheetId');
  }

  // Rename the copied sheet to targetMonth
  await withSheetsRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: targetSpreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId: newSheetId, title: targetMonth },
                fields: 'title',
              },
            },
          ],
        },
      }),
    `cloneMonthTab.rename ${targetMonth}`,
  );

  logger.info(`[SHEETS] Cloned ${sourceMonth} → ${targetMonth}`);
}
