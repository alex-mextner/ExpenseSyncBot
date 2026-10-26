// Year-split migration: moves current-year expense rows and budget months from the old
// mixed-year spreadsheet to a freshly created current-year spreadsheet.

import { format } from 'date-fns';
import { type drive_v3, google, type sheets_v4 } from 'googleapis';
import type { CurrencyCode } from '../../config/constants';
import { createLogger } from '../../utils/logger.ts';
import { monthAbbrFromYYYYMM } from './month-abbr';
import { getAuthenticatedClient } from './oauth';
import {
  appendExpenseRowsRaw,
  createEmptyMonthTab,
  deleteExpenseRowsByIndex,
  type GoogleConn,
  monthTabExists,
  readExpenseHeaders,
  readExpenseRowsRaw,
  repairEurFormulas,
  sortExpensesTab,
  withSheetsRetry,
  writeMonthBudgetRow,
} from './sheets';

const logger = createLogger('budget-migration');

export interface FlatBudgetRow {
  month: string; // YYYY-MM
  category: string;
  limit: number;
  currency: CurrencyCode;
}

type BudgetLimit = { limit: number; currency: CurrencyCode };
type ExplicitBudgets = Map<string, Map<string, BudgetLimit>>;

/** Explicit entry for the month, else the one from the latest prior month that has the category. */
function resolveBudgetEntry(
  explicit: ExplicitBudgets,
  months: string[],
  month: string,
  category: string,
): BudgetLimit | undefined {
  const own = explicit.get(month)?.get(category);
  if (own) return own;

  // Find latest prior month with this category (months is sorted ascending)
  const priorMonths = months.filter((m) => m < month).reverse();
  for (const prior of priorMonths) {
    const priorEntry = explicit.get(prior)?.get(category);
    if (priorEntry) return priorEntry;
  }
  return undefined; // No prior entry → skip this category for this month
}

/**
 * Expand flat budget rows using inheritance: for each (month, category) pair
 * that has no explicit entry, copy from the latest prior month that does.
 * Returns a map from YYYY-MM to resolved rows for that month.
 */
export function applyInheritance(
  rows: FlatBudgetRow[],
): Map<string, { category: string; limit: number; currency: CurrencyCode }[]> {
  if (rows.length === 0) return new Map();

  const months = [...new Set(rows.map((r) => r.month))].sort();
  const categories = [...new Set(rows.map((r) => r.category))];

  const explicit: ExplicitBudgets = new Map();
  for (const row of rows) {
    if (!explicit.has(row.month)) explicit.set(row.month, new Map());
    explicit.get(row.month)?.set(row.category, { limit: row.limit, currency: row.currency });
  }

  const result = new Map<string, { category: string; limit: number; currency: CurrencyCode }[]>();

  for (const month of months) {
    const monthRows: { category: string; limit: number; currency: CurrencyCode }[] = [];
    for (const category of categories) {
      const entry = resolveBudgetEntry(explicit, months, month, category);
      if (entry) monthRows.push({ category, ...entry });
    }
    result.set(month, monthRows);
  }

  return result;
}

/** Parse year from a date cell. Handles ISO yyyy-MM-dd, European DD.MM.YYYY, and numeric serials. */
export function yearFromDateCell(cell: string): number | null {
  // ISO yyyy-MM-dd — what the bot writes via appendExpenseRow with USER_ENTERED
  const iso = cell.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = parseInt(iso[1] ?? '', 10);
    return Number.isNaN(year) ? null : year;
  }

  // European DD.MM.YYYY — legacy / display format
  const dmy = cell.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dmy) {
    const year = parseInt(dmy[3] ?? '', 10);
    return Number.isNaN(year) ? null : year;
  }

  // Numeric date serial (UNFORMATTED_VALUE when Sheets stored the cell as a date type)
  // 25569 = days between 1899-12-30 (Sheets epoch) and 1970-01-01 (Unix epoch)
  const serial = Number(cell);
  if (!Number.isNaN(serial) && serial > 25569) {
    return new Date((serial - 25569) * 86400 * 1000).getUTCFullYear();
  }

  return null;
}

function normalizeMonth(month: string): string {
  const match = month.match(/^(\d{4})-(\d{1,2})$/);
  if (!match) {
    logger.warn(`[MIGRATION] normalizeMonth: unexpected month format "${month}", passing through`);
    return month;
  }
  const [, year, m] = match;
  return `${year}-${(m ?? '').padStart(2, '0')}`;
}

interface SplitYearRow {
  row: string[];
  sheetRowIdx: number;
}

/** Copy the old spreadsheet via Drive; returns the backup URL. */
async function backupSpreadsheet(drive: drive_v3.Drive, spreadsheetId: string): Promise<string> {
  const copy = await withSheetsRetry(
    () =>
      drive.files.copy({
        fileId: spreadsheetId,
        requestBody: { name: `Expenses Tracker — backup ${format(new Date(), 'yyyy-MM-dd')}` },
      }),
    'budget-migration.backup',
  );
  const backupId = copy.data.id;
  if (!backupId) throw new Error('[MIGRATION] Drive backup failed: no file ID returned');
  const backupUrl = `https://docs.google.com/spreadsheets/d/${backupId}`;
  logger.info(`[MIGRATION] Backup created: ${backupUrl}`);
  return backupUrl;
}

/** Copy split-year rows to the new spreadsheet (column-name-aware), then delete them from the old one. */
async function moveSplitYearRows(
  conn: GoogleConn,
  oldSpreadsheetId: string,
  newSpreadsheetId: string,
  splitYearRows: SplitYearRow[],
  sourceHeaders: string[],
): Promise<void> {
  const targetHeaders = await readExpenseHeaders(conn, newSpreadsheetId);
  await appendExpenseRowsRaw(
    conn,
    newSpreadsheetId,
    splitYearRows.map(({ row }) => row),
    sourceHeaders,
    targetHeaders,
  );
  logger.info(`[MIGRATION] Copied ${splitYearRows.length} expense rows to new spreadsheet`);

  const fixedFormulas = await repairEurFormulas(conn, newSpreadsheetId);
  if (fixedFormulas > 0) {
    logger.info(`[MIGRATION] Restored ${fixedFormulas} EUR formula(s) in new spreadsheet`);
  }

  await sortExpensesTab(conn, newSpreadsheetId);
  logger.info('[MIGRATION] Sorted Expenses tab by date');

  // 3. Delete those rows from the old spreadsheet
  await deleteExpenseRowsByIndex(
    conn,
    oldSpreadsheetId,
    splitYearRows.map(({ sheetRowIdx }) => sheetRowIdx),
  );
  logger.info(`[MIGRATION] Deleted ${splitYearRows.length} expense rows from old spreadsheet`);
}

/** Read the legacy flat "Budget" sheet into normalized rows, dropping malformed ones. */
async function readFlatBudgetRows(
  sheetsApi: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<FlatBudgetRow[]> {
  const budgetResponse = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: 'Budget!A2:D',
  });
  const rawRows = budgetResponse.data.values ?? [];

  return rawRows
    .filter((r) => r.length >= 3)
    .map(([month, category, limitStr, currencyStr]) => ({
      month: normalizeMonth(String(month ?? '').trim()),
      category: String(category ?? '').trim(),
      limit: parseFloat(String(limitStr ?? '')),
      currency: (String(currencyStr ?? '').trim() || 'EUR') as CurrencyCode,
    }))
    .filter((r) => r.category && !Number.isNaN(r.limit));
}

/** Write inherited budget rows into per-month tabs, routing each month to the spreadsheet of its year. */
async function writeBudgetMonthTabs(
  conn: GoogleConn,
  resolved: Map<string, { category: string; limit: number; currency: CurrencyCode }[]>,
  oldSpreadsheetId: string,
  newSpreadsheetId: string,
  splitYear: number,
): Promise<void> {
  for (const [month, budgetRows] of resolved) {
    // Route to the correct spreadsheet based on the month's year
    const monthYear = parseInt(month.slice(0, 4), 10);
    const targetSpreadsheetId = monthYear >= splitYear ? newSpreadsheetId : oldSpreadsheetId;

    const tabName = monthAbbrFromYYYYMM(month);
    const tabExists = await monthTabExists(conn, targetSpreadsheetId, tabName);
    if (!tabExists) {
      await createEmptyMonthTab(conn, targetSpreadsheetId, tabName);
    }
    for (const row of budgetRows) {
      await writeMonthBudgetRow(conn, targetSpreadsheetId, tabName, row);
    }
    logger.info(
      `[MIGRATION] Wrote ${budgetRows.length} budget rows to ${monthYear >= splitYear ? 'new' : 'old'} spreadsheet tab ${tabName}`,
    );
  }
}

/**
 * Full year-split migration for a group's spreadsheet.
 *
 * - oldSpreadsheetId: the prior-year spreadsheet (will be backed up before modification).
 * - newSpreadsheetId: freshly created current-year spreadsheet (already exists, empty Expenses tab).
 * - splitYear: rows/budget-months with this year move to newSpreadsheetId; prior years stay in old.
 *
 * Returns backup spreadsheet URL. Returns null if there is nothing to migrate (no split-year rows
 * and no Budget sheet). Throws on backup failure or any subsequent error.
 */
export async function runYearSplitMigration(
  conn: GoogleConn,
  oldSpreadsheetId: string,
  newSpreadsheetId: string,
  splitYear: number,
): Promise<string | null> {
  const auth = getAuthenticatedClient(conn.refreshToken, conn.oauthClient);
  const sheetsApi = google.sheets({ version: 'v4', auth });

  // Check what needs to be done
  const oldSpreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId: oldSpreadsheetId });
  const budgetSheet = oldSpreadsheet.data.sheets?.find((s) => s.properties?.title === 'Budget');
  const budgetSheetId = budgetSheet?.properties?.sheetId;

  const sourceHeaders = await readExpenseHeaders(conn, oldSpreadsheetId);
  const allExpenseRows = await readExpenseRowsRaw(conn, oldSpreadsheetId);
  const splitYearRows = allExpenseRows
    .map((row, idx) => ({ row, sheetRowIdx: idx + 2 })) // +2: 1-based + skip header
    .filter(({ row }) => yearFromDateCell(row[0] ?? '') === splitYear);

  const hasSomethingToMigrate = splitYearRows.length > 0 || budgetSheet !== undefined;
  if (!hasSomethingToMigrate) {
    logger.info('[MIGRATION] Nothing to migrate for this spreadsheet');
    return null;
  }

  // 1. Backup old spreadsheet before any modifications
  const backupUrl = await backupSpreadsheet(
    google.drive({ version: 'v3', auth }),
    oldSpreadsheetId,
  );

  // 2. Copy splitYear expense rows to new spreadsheet, then 3. delete them from the old one
  if (splitYearRows.length > 0) {
    await moveSplitYearRows(conn, oldSpreadsheetId, newSpreadsheetId, splitYearRows, sourceHeaders);
  }

  // 4. Migrate Budget flat sheet (if present), splitting months by year
  if (budgetSheet !== undefined) {
    const flatRows = await readFlatBudgetRows(sheetsApi, oldSpreadsheetId);
    logger.info(`[MIGRATION] Read ${flatRows.length} rows from Budget sheet`);
    const resolved = applyInheritance(flatRows);
    await writeBudgetMonthTabs(conn, resolved, oldSpreadsheetId, newSpreadsheetId, splitYear);

    // 5. Delete old Budget flat sheet
    if (budgetSheetId !== undefined) {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: oldSpreadsheetId,
        requestBody: {
          requests: [{ deleteSheet: { sheetId: budgetSheetId } }],
        },
      });
      logger.info('[MIGRATION] Deleted old "Budget" sheet');
    }
  }

  return backupUrl;
}
