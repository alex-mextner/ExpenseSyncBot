/** Raw Expenses-tab row access (migration helpers) and row deletion */
import { google } from 'googleapis';
import { SPREADSHEET_CONFIG } from '../../config/constants';
import { createLogger } from '../../utils/logger.ts';
import {
  authClient,
  EXPENSES_TAB,
  enqueueSheetWrite,
  type GoogleConn,
  withSheetsRetry,
} from './sheets-core';

const logger = createLogger('sheets');

// ── Raw expense row helpers (used by year-split migration) ──────────────────

/**
 * Read all data rows from the Expenses tab as raw string arrays.
 * Skips the header row. Uses UNFORMATTED_VALUE to capture calculated values, not formulas.
 * Note: formula cells (e.g. EUR calc column) become static values after a migration roundtrip.
 * Row-relative formula references would break in the destination sheet anyway, so this is intentional.
 */
export async function readExpenseRowsRaw(
  conn: GoogleConn,
  spreadsheetId: string,
): Promise<string[][]> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${EXPENSES_TAB}!A2:Z`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
    'readExpenseRowsRaw',
  );
  return (response.data.values ?? []).map((row) =>
    row.map((cell, colIdx) => {
      const str = String(cell ?? '');
      // Column 0 is always the date. Sheets stores date cells as serial numbers
      // (days since Dec 30, 1899) when read with UNFORMATTED_VALUE.
      // Convert back to ISO yyyy-MM-dd so the migration roundtrip preserves date format.
      if (colIdx === 0) {
        const serial = Number(str);
        // 25569 = days between Sheets epoch (Dec 30, 1899) and Unix epoch (Jan 1, 1970)
        if (!Number.isNaN(serial) && serial > 25569 && serial < 99999) {
          const date = new Date((serial - 25569) * 86400 * 1000);
          const y = date.getUTCFullYear();
          const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
          const d = String(date.getUTCDate()).padStart(2, '0');
          return `${y}-${mo}-${d}`;
        }
      }
      return str;
    }),
  );
}

/**
 * Sort the Expenses tab by column A (date) ascending, preserving the header row.
 */
export async function sortExpensesTab(conn: GoogleConn, spreadsheetId: string): Promise<void> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await withSheetsRetry(
    () => sheets.spreadsheets.get({ spreadsheetId }),
    'sortExpensesTab.getSheetId',
  );
  const expensesSheet = spreadsheet.data.sheets?.find((s) => s.properties?.title === EXPENSES_TAB);
  const sheetId = expensesSheet?.properties?.sheetId;
  if (sheetId === undefined) return;

  await withSheetsRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              sortRange: {
                range: {
                  sheetId,
                  startRowIndex: 1, // skip header
                  startColumnIndex: 0,
                },
                sortSpecs: [{ dimensionIndex: 0, sortOrder: 'ASCENDING' }],
              },
            },
          ],
        },
      }),
    'sortExpensesTab.sort',
  );
}

/** Rename a spreadsheet's title. */
export async function renameSpreadsheet(
  conn: GoogleConn,
  spreadsheetId: string,
  title: string,
): Promise<void> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });
  await withSheetsRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSpreadsheetProperties: {
                properties: { title },
                fields: 'title',
              },
            },
          ],
        },
      }),
    'renameSpreadsheet',
  );
}

/**
 * Read the header row from the Expenses tab.
 */
export async function readExpenseHeaders(
  conn: GoogleConn,
  spreadsheetId: string,
): Promise<string[]> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${EXPENSES_TAB}!1:1`,
      }),
    'readExpenseHeaders',
  );
  return (response.data.values?.[0] ?? []) as string[];
}

/**
 * Append raw rows to the Expenses tab.
 * When sourceHeaders and targetHeaders are provided, remaps columns by header name
 * so data from a differently-ordered source sheet lands in the correct columns.
 */
export async function appendExpenseRowsRaw(
  conn: GoogleConn,
  spreadsheetId: string,
  rows: string[][],
  sourceHeaders?: string[],
  targetHeaders?: string[],
): Promise<void> {
  if (rows.length === 0) return;

  let outputRows = rows;

  // Remap columns if headers are provided and differ
  if (
    sourceHeaders &&
    targetHeaders &&
    JSON.stringify(sourceHeaders) !== JSON.stringify(targetHeaders)
  ) {
    logger.info(
      `[SHEETS] Remapping columns: source=${JSON.stringify(sourceHeaders)} → target=${JSON.stringify(targetHeaders)}`,
    );
    outputRows = rows.map((row) => {
      const newRow: string[] = [];
      for (const th of targetHeaders) {
        const srcIdx = sourceHeaders.indexOf(th);
        newRow.push(srcIdx >= 0 ? (row[srcIdx] ?? '') : '');
      }
      return newRow;
    });
  }

  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });
  await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${EXPENSES_TAB}!A2`,
        // USER_ENTERED so numeric strings are parsed as numbers (not stored as text).
        // Formulas are not preserved (see readExpenseRowsRaw doc for rationale).
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: outputRows },
      }),
    'appendExpenseRowsRaw',
  );
}

/**
 * Convert a sheet date cell to ISO yyyy-MM-dd. Handles two storage shapes:
 *   - UNFORMATTED_VALUE: the date is a Sheets serial number (days since 1899-12-30)
 *   - formatted string: already ISO-shaped (e.g. "2026-04-15")
 */
function normalizeSheetDate(cell: unknown): string {
  if (typeof cell === 'number' && Number.isFinite(cell) && cell > 25569 && cell < 99999) {
    const date = new Date((cell - 25569) * 86400 * 1000);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(cell ?? '');
}

/**
 * Find the FIRST sheet row matching all criteria fields, delete it, and return
 * the 1-based row index. Returns `{ deletedRowIndex: null }` if no row matches.
 *
 * Matching uses (date, category, comment, amount-in-currency-column). Multiple
 * matches are intentional: caller deletes one row per call, so repeated calls
 * naturally clean up duplicates.
 */
export async function findAndDeleteExpenseRow(
  conn: GoogleConn,
  spreadsheetId: string,
  criteria: ExpenseRowCriteria,
): Promise<{ deletedRowIndex: number | null }> {
  // Serialize with other operations on this spreadsheet. Without this, two
  // concurrent deletes can both read the same pre-delete row indices; the
  // first deleteDimension shifts row numbers, and the second batchUpdate
  // ends up targeting a stale index — removing the wrong row. Appends use
  // the same queue for the same reason (row-relative EUR formulas).
  let capturedResult: { deletedRowIndex: number | null } = { deletedRowIndex: null };
  await enqueueSheetWrite(spreadsheetId, async () => {
    capturedResult = await findAndDeleteExpenseRowImpl(conn, spreadsheetId, criteria);
  });
  return capturedResult;
}

/** Fields identifying the sheet row to delete. */
interface ExpenseRowCriteria {
  date: string;
  category: string;
  comment: string;
  amount: number;
  currency: string;
}

interface MatchColumns {
  dateCol: number;
  categoryCol: number;
  commentCol: number;
  currencyCol: number;
}

/** Locate the columns used for matching; any missing column is reported as -1. */
function locateMatchColumns(headers: string[], currency: string): MatchColumns {
  // `startsWith("EUR ")` alone would also match "EUR (calc)" — the computed
  // EUR column, not the EUR currency column. Exclude it explicitly so the
  // match is column-order-independent.
  return {
    dateCol: headers.indexOf(SPREADSHEET_CONFIG.headers[0] ?? ''),
    categoryCol: headers.indexOf(SPREADSHEET_CONFIG.headers[1] ?? ''),
    commentCol: headers.indexOf(SPREADSHEET_CONFIG.headers[2] ?? ''),
    currencyCol: headers.findIndex(
      (h) => h.startsWith(`${currency} `) && h !== SPREADSHEET_CONFIG.eurColumnHeader,
    ),
  };
}

/** True when a data row matches date, category, comment and amount (within half a cent). */
function rowMatchesCriteria(
  row: unknown[],
  cols: MatchColumns,
  criteria: ExpenseRowCriteria,
): boolean {
  if (normalizeSheetDate(row[cols.dateCol]) !== criteria.date) return false;
  if (String(row[cols.categoryCol] ?? '') !== criteria.category) return false;
  if (String(row[cols.commentCol] ?? '') !== criteria.comment) return false;

  const cellAmount = row[cols.currencyCol];
  const numAmount =
    typeof cellAmount === 'number' ? cellAmount : Number.parseFloat(String(cellAmount ?? ''));
  // Epsilon 0.005 = half of the smallest unit for 2-decimal currencies
  // (cents/копейки). Float round-trip through Sheets can drift by ~1e-14
  // for fractional values like $12.34; strict equality here would miss
  // those rows and leave them in the sheet, re-importable via /sync.
  // The gap between any two realistic neighboring sums (12.34 vs 12.35)
  // is 0.01 > 0.005, so false positives are impossible.
  return Number.isFinite(numAmount) && Math.abs(numAmount - criteria.amount) <= 0.005;
}

async function findAndDeleteExpenseRowImpl(
  conn: GoogleConn,
  spreadsheetId: string,
  criteria: ExpenseRowCriteria,
): Promise<{ deletedRowIndex: number | null }> {
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  // UNFORMATTED_VALUE so amounts come as numbers (not locale-formatted strings)
  // and dates as serial numbers (which we normalize back to ISO).
  const response = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${EXPENSES_TAB}!A:Z`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
    'findAndDeleteExpenseRow.read',
  );

  const rows = response.data.values ?? [];
  if (rows.length < 2) return { deletedRowIndex: null };

  const cols = locateMatchColumns((rows[0] ?? []) as string[], criteria.currency);

  if (Object.values(cols).includes(-1)) {
    logger.warn(
      { ...cols, currency: criteria.currency },
      '[SHEETS] findAndDeleteExpenseRow: required column not found',
    );
    return { deletedRowIndex: null };
  }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    if (!row || !rowMatchesCriteria(row, cols, criteria)) continue;

    // Match — delete this row (1-based for the public interface).
    const oneBasedRowIndex = i + 1;
    await deleteExpenseRowsByIndex(conn, spreadsheetId, [oneBasedRowIndex]);
    logger.info(
      { spreadsheetId, rowIndex: oneBasedRowIndex, criteria },
      '[SHEETS] findAndDeleteExpenseRow: deleted row',
    );
    return { deletedRowIndex: oneBasedRowIndex };
  }

  return { deletedRowIndex: null };
}

/**
 * Delete rows from the Expenses tab by their 1-based sheet row indices.
 * Sorted and processed in reverse order to avoid index shifting.
 * Uses the Expenses tab's sheetId (resolved from spreadsheet metadata).
 */
export async function deleteExpenseRowsByIndex(
  conn: GoogleConn,
  spreadsheetId: string,
  rowIndices: number[],
): Promise<void> {
  if (rowIndices.length === 0) return;
  const auth = authClient(conn);
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await withSheetsRetry(
    () => sheets.spreadsheets.get({ spreadsheetId }),
    'deleteExpenseRowsByIndex.getSheetId',
  );
  const expensesSheet = spreadsheet.data.sheets?.find((s) => s.properties?.title === EXPENSES_TAB);
  const sheetId = expensesSheet?.properties?.sheetId;
  if (sheetId === undefined) throw new Error(`"${EXPENSES_TAB}" tab not found in ${spreadsheetId}`);

  // Process in reverse order to avoid row-index shifting
  const sorted = [...rowIndices].sort((a, b) => b - a);

  const requests = sorted.map((rowIdx) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: 'ROWS' as const,
        startIndex: rowIdx - 1, // 0-based
        endIndex: rowIdx, // exclusive
      },
    },
  }));

  await withSheetsRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      }),
    'deleteExpenseRowsByIndex.delete',
  );
}
