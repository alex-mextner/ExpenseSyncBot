// Year-split migration: moves current-year expense rows and budget months from the old
// mixed-year spreadsheet to a freshly created current-year spreadsheet.

import { format } from 'date-fns';
import { google } from 'googleapis';
import type { CurrencyCode } from '../../config/constants';
import { createLogger } from '../../utils/logger.ts';
import { monthAbbrFromYYYYMM } from './month-abbr';
import { getAuthenticatedClient } from './oauth';
import {
  appendExpenseRowsRaw,
  createEmptyMonthTab,
  deleteExpenseRowsByIndex,
  monthTabExists,
  readExpenseRowsRaw,
  repairEurFormulas,
  writeMonthBudgetRow,
} from './sheets';

const logger = createLogger('budget-migration');

export interface FlatBudgetRow {
  month: string; // YYYY-MM
  category: string;
  limit: number;
  currency: CurrencyCode;
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

  const explicit = new Map<string, Map<string, { limit: number; currency: CurrencyCode }>>();
  for (const row of rows) {
    if (!explicit.has(row.month)) explicit.set(row.month, new Map());
    explicit.get(row.month)?.set(row.category, { limit: row.limit, currency: row.currency });
  }

  const result = new Map<string, { category: string; limit: number; currency: CurrencyCode }[]>();

  for (const month of months) {
    const monthRows: { category: string; limit: number; currency: CurrencyCode }[] = [];

    for (const category of categories) {
      const explicitEntry = explicit.get(month)?.get(category);
      if (explicitEntry) {
        monthRows.push({ category, ...explicitEntry });
        continue;
      }

      // Find latest prior month with this category
      const priorMonths = months.filter((m) => m < month).reverse();
      for (const prior of priorMonths) {
        const priorEntry = explicit.get(prior)?.get(category);
        if (priorEntry) {
          monthRows.push({ category, ...priorEntry });
          break;
        }
      }
      // No prior entry → skip this category for this month
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
  refreshToken: string,
  oldSpreadsheetId: string,
  newSpreadsheetId: string,
  splitYear: number,
): Promise<string | null> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheetsApi = google.sheets({ version: 'v4', auth });

  // Check what needs to be done
  const oldSpreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId: oldSpreadsheetId });
  const budgetSheet = oldSpreadsheet.data.sheets?.find((s) => s.properties?.title === 'Budget');
  const budgetSheetId = budgetSheet?.properties?.sheetId;

  const allExpenseRows = await readExpenseRowsRaw(refreshToken, oldSpreadsheetId);
  const splitYearRows = allExpenseRows
    .map((row, idx) => ({ row, sheetRowIdx: idx + 2 })) // +2: 1-based + skip header
    .filter(({ row }) => yearFromDateCell(row[0] ?? '') === splitYear);

  const hasSomethingToMigrate = splitYearRows.length > 0 || budgetSheet !== undefined;
  if (!hasSomethingToMigrate) {
    logger.info('[MIGRATION] Nothing to migrate for this spreadsheet');
    return null;
  }

  // 1. Backup old spreadsheet before any modifications
  const drive = google.drive({ version: 'v3', auth });
  const copy = await drive.files.copy({
    fileId: oldSpreadsheetId,
    requestBody: { name: `Expenses Tracker — backup ${format(new Date(), 'yyyy-MM-dd')}` },
  });
  const backupId = copy.data.id;
  if (!backupId) throw new Error('[MIGRATION] Drive backup failed: no file ID returned');
  const backupUrl = `https://docs.google.com/spreadsheets/d/${backupId}`;
  logger.info(`[MIGRATION] Backup created: ${backupUrl}`);

  // 2. Copy splitYear expense rows to new spreadsheet
  if (splitYearRows.length > 0) {
    await appendExpenseRowsRaw(
      refreshToken,
      newSpreadsheetId,
      splitYearRows.map(({ row }) => row),
    );
    logger.info(`[MIGRATION] Copied ${splitYearRows.length} expense rows to new spreadsheet`);

    const fixedFormulas = await repairEurFormulas(refreshToken, newSpreadsheetId);
    if (fixedFormulas > 0) {
      logger.info(`[MIGRATION] Restored ${fixedFormulas} EUR formula(s) in new spreadsheet`);
    }

    // 3. Delete those rows from the old spreadsheet
    await deleteExpenseRowsByIndex(
      refreshToken,
      oldSpreadsheetId,
      splitYearRows.map(({ sheetRowIdx }) => sheetRowIdx),
    );
    logger.info(`[MIGRATION] Deleted ${splitYearRows.length} expense rows from old spreadsheet`);
  }

  // 4. Migrate Budget flat sheet (if present), splitting months by year
  if (budgetSheet !== undefined) {
    const budgetResponse = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: oldSpreadsheetId,
      range: 'Budget!A2:D',
    });
    const rawRows = budgetResponse.data.values ?? [];

    const flatRows: FlatBudgetRow[] = rawRows
      .filter((r) => r.length >= 3)
      .map(([month, category, limitStr, currencyStr]) => ({
        month: normalizeMonth(String(month ?? '').trim()),
        category: String(category ?? '').trim(),
        limit: parseFloat(String(limitStr ?? '')),
        currency: (String(currencyStr ?? '').trim() || 'EUR') as CurrencyCode,
      }))
      .filter((r) => r.category && !Number.isNaN(r.limit));

    logger.info(`[MIGRATION] Read ${flatRows.length} rows from Budget sheet`);
    const resolved = applyInheritance(flatRows);

    for (const [month, budgetRows] of resolved) {
      // Route to the correct spreadsheet based on the month's year
      const monthYear = parseInt(month.slice(0, 4), 10);
      const targetSpreadsheetId = monthYear >= splitYear ? newSpreadsheetId : oldSpreadsheetId;

      const tabName = monthAbbrFromYYYYMM(month);
      const tabExists = await monthTabExists(refreshToken, targetSpreadsheetId, tabName);
      if (!tabExists) {
        await createEmptyMonthTab(refreshToken, targetSpreadsheetId, tabName);
      }
      for (const row of budgetRows) {
        await writeMonthBudgetRow(refreshToken, targetSpreadsheetId, tabName, row);
      }
      logger.info(
        `[MIGRATION] Wrote ${budgetRows.length} budget rows to ${monthYear >= splitYear ? 'new' : 'old'} spreadsheet tab ${tabName}`,
      );
    }

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
