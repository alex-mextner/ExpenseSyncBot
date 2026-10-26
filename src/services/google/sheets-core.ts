/** Shared Google Sheets primitives: connection, retry/backoff, write queue, column layout helpers */
import type { google } from 'googleapis';
import { SPREADSHEET_CONFIG } from '../../config/constants';
import type { OAuthClientType } from '../../database/types';
import { createLogger } from '../../utils/logger.ts';
import { getAuthenticatedClient } from './oauth';

const logger = createLogger('sheets');

/**
 * Google connection credentials: refresh token + which OAuth client to use.
 * All sheets functions accept this to route through the correct credentials.
 */
export interface GoogleConn {
  refreshToken: string;
  oauthClient: OAuthClientType;
}

export function authClient(conn: GoogleConn) {
  return getAuthenticatedClient(conn.refreshToken, conn.oauthClient);
}

/** Build GoogleConn from a group-like object with refresh token and oauth_client */
export function googleConn(group: {
  google_refresh_token: string | null;
  oauth_client: OAuthClientType;
}): GoogleConn {
  if (!group.google_refresh_token) {
    throw new Error('Group has no Google refresh token');
  }
  return {
    refreshToken: group.google_refresh_token,
    oauthClient: group.oauth_client,
  };
}

/** Name of the tab holding expense rows */
export const EXPENSES_TAB = 'Expenses';

/**
 * Column letter for a 0-based index (0=A, 1=B, ..., 25=Z, 26=AA)
 */
export function colLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

/**
 * Rate column header constant
 */
export const RATE_COLUMN_HEADER = 'Rate (→EUR)';

/**
 * Build the self-positioning EUR(calc) formula: amount × rate.
 *
 * `INDIRECT("<col>"&ROW())` resolves the cell from the formula's OWN row, so
 * the formula text is identical for every data row and needs no absolute row
 * number — which lets `append()` bake it inline instead of a second write
 * round-trip (see appendExpenseRowsImpl for the quota rationale). The flip side
 * is that the column letters live inside a string Google can't see into, so a
 * column insert/move does NOT auto-adjust them: any caller that shifts columns
 * must recompute these formulas itself (see rewriteEurFormulasForLayout).
 */
export function buildEurCalcFormula(amountColIdx: number, rateColIdx: number): string {
  return `=INDIRECT("${colLetter(amountColIdx)}"&ROW())*INDIRECT("${colLetter(rateColIdx)}"&ROW())`;
}

/**
 * True when a sheet header names a currency AMOUNT column: a 3-letter currency
 * code followed by a parenthesised symbol, e.g. "USD ($)", "RSD (дин.)",
 * "EUR (€)". Excludes the computed "EUR (calc)" column and the "Rate (→EUR)"
 * column — both share the CODE-then-paren shape but hold a derived value, not a
 * user-entered amount. The EUR *currency* column IS a currency column here;
 * callers that must also skip EUR (formula repair, rate derivation) use
 * nonEurCurrencyColumnIndices, which layers the EUR exclusion on top. This is
 * the single detector shared with scripts/repair-all-sheets.ts (#112) so the
 * script's untestable copy can't drift from the tested one.
 */
export function isCurrencyColumnHeader(header: string): boolean {
  return (
    /^[A-Z]{3}\s*\(/.test(header) &&
    header !== SPREADSHEET_CONFIG.eurColumnHeader &&
    header !== RATE_COLUMN_HEADER
  );
}

/**
 * Indices of non-EUR currency amount columns (e.g. "USD ($)") in header order.
 * Excludes the computed "EUR (calc)" column, the Rate column, and the EUR
 * currency column — EUR rows keep a static EUR(calc), never a formula.
 */
export function nonEurCurrencyColumnIndices(headers: string[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (header && isCurrencyColumnHeader(header) && !header.startsWith('EUR')) {
      indices.push(i);
    }
  }
  return indices;
}

/** A cell value Sheets treats as empty (no value / cleared). */
export function isEmptyCell(value: unknown): boolean {
  return value === '' || value === undefined || value === null;
}

/**
 * True when a cell's COMPUTED value is a Google Sheets formula error
 * (#VALUE!, #REF!, #N/A, #NAME?, …). Read with a value render option, not
 * FORMULA — under FORMULA render an erroring cell returns its formula text, not
 * the error. Only meaningful for cells that actually hold a formula.
 */
export function isFormulaError(computedValue: unknown): boolean {
  return typeof computedValue === 'string' && computedValue.startsWith('#');
}

/**
 * Max ValueRange entries per spreadsheets.values.batchUpdate request. A single
 * unbounded batchUpdate on a multi-thousand-row sheet can exceed the API's
 * request payload limit and fail the whole repair atomically; chunking keeps
 * each request bounded and re-runnable (a failed chunk leaves earlier chunks
 * written). Matches the 300-row chunk used by scripts/repair-all-sheets.ts.
 */
const SHEETS_VALUE_BATCH_CHUNK = 300;

/** Split an array into fixed-size chunks (the final chunk may be smaller). */
export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Authenticated Google Sheets API client */
export type SheetsClient = ReturnType<typeof google.sheets>;

/**
 * Write value-range updates via spreadsheets.values.batchUpdate, split into
 * bounded chunks so a large repair can't exceed the API payload limit. One
 * shared path for every chunked value write (rewrite-on-insert + repair).
 */
export async function writeValueUpdatesInChunks(
  sheets: SheetsClient,
  spreadsheetId: string,
  data: { range: string; values: (string | number)[][] }[],
  retryLabel: string,
): Promise<void> {
  for (const chunk of chunkArray(data, SHEETS_VALUE_BATCH_CHUNK)) {
    await withSheetsRetry(
      () =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'USER_ENTERED', data: chunk },
        }),
      retryLabel,
    );
  }
}

/**
 * Google Sheets API hard limits (write side — this bot's hot path).
 * Source: https://developers.google.com/workspace/sheets/api/limits
 *
 * Per-user and per-project limits are both enforced. We care about the
 * per-user limit because a single OAuth user writing a 70-item receipt can
 * exhaust it on its own without touching the project budget.
 */
export const GOOGLE_SHEETS_LIMITS = {
  writeRequestsPerMinutePerUser: 60,
  writeRequestsPerMinutePerProject: 300,
  readRequestsPerMinutePerUser: 60,
  readRequestsPerMinutePerProject: 300,
  /** Google's own recommended maximum backoff for 429 retries */
  maxBackoffMs: 32_000,
  /** Give up after this many attempts (original + retries) */
  maxAttempts: 6,
} as const;

/**
 * Sleep helper — isolated so tests can mock `setTimeout` without touching
 * the global loop
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Loosely-typed shape of the error fields we inspect (googleapis / Gaxios errors) */
interface GoogleErrorShape {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  response?: {
    status?: unknown;
    data?: {
      error?: {
        status?: unknown;
        errors?: Array<{ reason?: unknown }>;
      };
    };
  };
}

function is429(value: unknown): boolean {
  return value === 429 || value === '429';
}

/**
 * Google returns quota exhaustion as 403 with a rate-limit reason code —
 * not just 429. Must detect this shape so callers don't misclassify a
 * throttled request as a real permission-denied error.
 */
function hasRateLimitReason(e: GoogleErrorShape): boolean {
  const reasons = e.response?.data?.error?.errors;
  if (!Array.isArray(reasons)) return false;
  return reasons.some(
    (entry) => entry?.reason === 'rateLimitExceeded' || entry?.reason === 'userRateLimitExceeded',
  );
}

/** Message-based fallback for errors that carry no structured status */
function hasRateLimitMessage(e: GoogleErrorShape): boolean {
  if (typeof e.message !== 'string') return false;
  return e.message.includes('Quota exceeded') || e.message.includes('rateLimitExceeded');
}

/**
 * Check if a caught error is a Google API 429 (rate limit exceeded)
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as GoogleErrorShape;
  return (
    // Top-level code/status (most common path for googleapis SDK)
    is429(e.code) ||
    is429(e.status) ||
    // Nested response.status (GaxiosError wraps the HTTP response)
    is429(e.response?.status) ||
    // Nested response.data.error.status (Google JSON error body)
    e.response?.data?.error?.status === 'RESOURCE_EXHAUSTED' ||
    hasRateLimitReason(e) ||
    hasRateLimitMessage(e)
  );
}

/**
 * Wrap a Google Sheets API call with exponential backoff on 429. Retries
 * follow Google's recommended formula: `min(2^n * 1000 + jitter, maxBackoffMs)`.
 * Non-429 errors are rethrown immediately — we don't want to mask auth or
 * validation failures.
 *
 * The random jitter (`randomFn`) is injectable so tests are deterministic.
 */
export async function withSheetsRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts?: { sleepFn?: (ms: number) => Promise<void>; randomFn?: () => number },
): Promise<T> {
  const sleepFn = opts?.sleepFn ?? sleep;
  const randomFn = opts?.randomFn ?? Math.random;
  let lastErr: unknown;
  for (let attempt = 0; attempt < GOOGLE_SHEETS_LIMITS.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err)) throw err;
      if (attempt === GOOGLE_SHEETS_LIMITS.maxAttempts - 1) break;
      const base = Math.min(2 ** attempt * 1000, GOOGLE_SHEETS_LIMITS.maxBackoffMs);
      const jitter = Math.floor(randomFn() * 1000);
      const waitMs = base + jitter;
      logger.warn({ label, attempt: attempt + 1, waitMs }, '[SHEETS] 429 rate limit, backing off');
      await sleepFn(waitMs);
    }
  }
  throw lastErr;
}

// Per-spreadsheet write queue — serializes appends so EUR formula row references are correct
const sheetWriteQueues = new Map<string, Promise<void>>();

/** Exported for testing — serializes async operations per spreadsheet */
export function enqueueSheetWrite(spreadsheetId: string, fn: () => Promise<void>): Promise<void> {
  const prev = sheetWriteQueues.get(spreadsheetId) ?? Promise.resolve();
  // Chain runs fn after prev settles (success or failure)
  const chain = prev.catch(() => {}).then(fn);
  // Store the settled chain (never rejects) so next enqueue can chain off it
  const settled = chain.catch(() => {});
  sheetWriteQueues.set(spreadsheetId, settled);
  settled.then(() => {
    if (sheetWriteQueues.get(spreadsheetId) === settled) {
      sheetWriteQueues.delete(spreadsheetId);
    }
  });
  // Return the chain that DOES reject on fn failure — caller gets the error
  return chain;
}
