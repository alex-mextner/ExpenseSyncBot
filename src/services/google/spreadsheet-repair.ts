// Audit and recreate Google spreadsheets that the bot has lost access to
// (file deleted, scope downgraded, permission revoked, etc.).

import type { CurrencyCode } from '../../config/constants';
import type { Budget, Expense } from '../../database/types';
import { OAuthError } from '../../errors';
import { buildAmountsRecord } from '../expense-recorder';
import { type MonthAbbr, monthAbbrFromYYYYMM } from './month-abbr';
import type { ExpenseRowData, GoogleConn } from './sheets';

/**
 * Classification of why we can't reach a spreadsheet:
 *   - ok            — accessible
 *   - not_found     — Drive returned 404 (file deleted, never created, or
 *                     drive.file scope can't see it)
 *   - forbidden     — Drive returned 403 (permission denied without ambiguity)
 *   - token_expired — refresh token revoked / expired
 *   - unknown_error — anything else (network, 5xx, malformed response)
 */
export type SpreadsheetAccessStatus =
  | 'ok'
  | 'not_found'
  | 'forbidden'
  | 'token_expired'
  | 'unknown_error';

interface SpreadsheetAccessResult {
  status: SpreadsheetAccessStatus;
  errorMessage?: string;
}

interface GaxiosLike {
  code?: number | string;
  status?: number | string;
  message?: string;
  response?: {
    data?: {
      error?: {
        code?: number;
        message?: string;
        errors?: Array<{ reason?: string; message?: string }>;
      };
    };
  };
}

/**
 * Map a sheets-API error to a SpreadsheetAccessStatus. Pure function — no I/O.
 */
export function classifySheetError(err: unknown): SpreadsheetAccessResult {
  if (err instanceof OAuthError) {
    return { status: 'token_expired', errorMessage: err.message };
  }

  if (err === null || err === undefined || typeof err === 'string') {
    return { status: 'unknown_error', errorMessage: typeof err === 'string' ? err : 'Unknown' };
  }

  const e = err as GaxiosLike;
  const code = Number(e.code ?? e.status ?? e.response?.data?.error?.code ?? 0);
  const reason = e.response?.data?.error?.errors?.[0]?.reason;
  const message =
    e.response?.data?.error?.message ?? e.message ?? (err instanceof Error ? err.message : '');

  if (code === 404 || reason === 'notFound') {
    return { status: 'not_found', errorMessage: message || 'File not found' };
  }
  if (code === 403 || reason === 'forbidden') {
    return { status: 'forbidden', errorMessage: message || 'Permission denied' };
  }

  return { status: 'unknown_error', errorMessage: message || 'Unknown error' };
}

export interface AuditEntry {
  year: number;
  spreadsheetId: string;
  status: SpreadsheetAccessStatus;
  errorMessage?: string;
}

/**
 * Probe function: should attempt the cheapest reachable sheets call (e.g.
 * `spreadsheets.get`) and resolve normally on success, throw on any failure.
 * Injected so callers can test without a live Sheets API.
 */
type SpreadsheetAccessProbe = (conn: GoogleConn, spreadsheetId: string) => Promise<unknown>;

/**
 * Run the access probe for each (year, spreadsheetId) pair sequentially and
 * classify each result. Sequential — not parallel — to avoid hammering the
 * Google API with N parallel requests when a group has many years configured.
 */
export async function auditAllYears(
  probe: SpreadsheetAccessProbe,
  conn: GoogleConn,
  spreadsheets: { year: number; spreadsheetId: string }[],
): Promise<AuditEntry[]> {
  const results: AuditEntry[] = [];
  for (const { year, spreadsheetId } of spreadsheets) {
    try {
      await probe(conn, spreadsheetId);
      results.push({ year, spreadsheetId, status: 'ok' });
    } catch (err) {
      const { status, errorMessage } = classifySheetError(err);
      const entry: AuditEntry = { year, spreadsheetId, status };
      if (errorMessage !== undefined) entry.errorMessage = errorMessage;
      results.push(entry);
    }
  }
  return results;
}

export interface RecreateResult {
  year: number;
  oldSpreadsheetId: string;
  newSpreadsheetId: string;
  newSpreadsheetUrl: string;
  expensesCopied: number;
  budgetsCopied: number;
  budgetTabsCreated: MonthAbbr[];
}

/**
 * Dependencies for recreate. Each side-effect is injected so the function
 * is testable without a live Sheets API or DB. In production, callers wire
 * these to `sheets.ts` exports + `database` repositories.
 */
export interface RecreateDeps {
  createExpenseSpreadsheet(
    conn: GoogleConn,
    defaultCurrency: CurrencyCode,
    enabledCurrencies: CurrencyCode[],
  ): Promise<{ spreadsheetId: string; spreadsheetUrl: string }>;
  appendExpenseRows(conn: GoogleConn, spreadsheetId: string, rows: ExpenseRowData[]): Promise<void>;
  writeMonthBudgetRow(
    conn: GoogleConn,
    spreadsheetId: string,
    month: MonthAbbr,
    row: { category: string; limit: number; currency: CurrencyCode },
  ): Promise<void>;
  loadExpensesForYear(groupId: number, year: number): Expense[];
  loadBudgetsForYear(groupId: number, year: number): Budget[];
  setSpreadsheetIdForYear(groupId: number, year: number, spreadsheetId: string): void;
  getExchangeRate(currency: CurrencyCode): number;
}

/**
 * Recreate a single lost spreadsheet for the given year:
 *   1. Create a fresh spreadsheet (so drive.file scope owns it definitively).
 *   2. Copy all DB expenses for that year into the new sheet (one batched
 *      append per call — relies on appendExpenseRows being already chunk-aware
 *      and quota-friendly).
 *   3. Copy all DB budgets for that year, one writeMonthBudgetRow per row
 *      (writeMonthBudgetRow auto-creates month tabs as needed).
 *   4. Update the DB pointer in `group_spreadsheets` to the new ID.
 *
 * The DB pointer update happens LAST so any failure mid-recreate leaves the
 * old (broken) ID in place — re-running /repair just retries.
 */
export async function recreateSpreadsheet(
  deps: RecreateDeps,
  conn: GoogleConn,
  group: { id: number; default_currency: CurrencyCode; enabled_currencies: CurrencyCode[] },
  audit: AuditEntry,
): Promise<RecreateResult> {
  const { spreadsheetId: newId, spreadsheetUrl } = await deps.createExpenseSpreadsheet(
    conn,
    group.default_currency,
    group.enabled_currencies,
  );

  const expenses = deps.loadExpensesForYear(group.id, audit.year);
  if (expenses.length > 0) {
    const rows: ExpenseRowData[] = expenses.map((e) => {
      const currency = e.currency as CurrencyCode;
      return {
        date: e.date,
        category: e.category,
        comment: e.comment,
        amounts: buildAmountsRecord(e.amount, currency, group.enabled_currencies),
        eurAmount: e.eur_amount,
        rate: deps.getExchangeRate(currency),
      };
    });
    await deps.appendExpenseRows(conn, newId, rows);
  }

  const budgets = deps.loadBudgetsForYear(group.id, audit.year);
  const budgetTabsCreated: MonthAbbr[] = [];
  const seenTabs = new Set<MonthAbbr>();
  for (const b of budgets) {
    const month = monthAbbrFromYYYYMM(b.month);
    if (!seenTabs.has(month)) {
      seenTabs.add(month);
      budgetTabsCreated.push(month);
    }
    await deps.writeMonthBudgetRow(conn, newId, month, {
      category: b.category,
      limit: b.limit_amount,
      currency: b.currency as CurrencyCode,
    });
  }

  // Persist the new pointer LAST — only if the data made it across.
  deps.setSpreadsheetIdForYear(group.id, audit.year, newId);

  return {
    year: audit.year,
    oldSpreadsheetId: audit.spreadsheetId,
    newSpreadsheetId: newId,
    newSpreadsheetUrl: spreadsheetUrl,
    expensesCopied: expenses.length,
    budgetsCopied: budgets.length,
    budgetTabsCreated,
  };
}

/**
 * Recreate every spreadsheet whose audit status indicates it's unreachable
 * (`not_found` or `forbidden`). Sequential to keep Drive quota usage modest
 * and so a partial failure surfaces before kicking off the next year.
 */
export async function recreateLostSpreadsheets(
  deps: RecreateDeps,
  conn: GoogleConn,
  group: { id: number; default_currency: CurrencyCode; enabled_currencies: CurrencyCode[] },
  audits: AuditEntry[],
): Promise<RecreateResult[]> {
  const results: RecreateResult[] = [];
  for (const audit of audits) {
    if (audit.status !== 'not_found' && audit.status !== 'forbidden') continue;
    results.push(await recreateSpreadsheet(deps, conn, group, audit));
  }
  return results;
}
