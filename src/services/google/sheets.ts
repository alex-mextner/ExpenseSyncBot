import { google } from 'googleapis';
import type { CurrencyCode } from '../../config/constants';
import { CURRENCY_SYMBOLS, SPREADSHEET_CONFIG } from '../../config/constants';
import { createLogger } from '../../utils/logger.ts';
import { convertToEUR } from '../currency/converter';
import type { MonthAbbr } from './month-abbr';
import { getAuthenticatedClient } from './oauth';

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

/**
 * Create a new expense tracking spreadsheet
 */
export async function createExpenseSpreadsheet(
  refreshToken: string,
  _defaultCurrency: CurrencyCode,
  enabledCurrencies: CurrencyCode[],
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Build headers: Date | Currencies | EUR(calc) | Category | Comment | Rate
  const headers = [
    SPREADSHEET_CONFIG.headers[0], // Дата
    ...enabledCurrencies.map((code) => `${code} (${CURRENCY_SYMBOLS[code]})`),
    SPREADSHEET_CONFIG.eurColumnHeader, // EUR (calc)
    SPREADSHEET_CONFIG.headers[1], // Категория
    SPREADSHEET_CONFIG.headers[2], // Комментарий
    RATE_COLUMN_HEADER, // Rate (→EUR)
  ];

  // Create spreadsheet
  const response = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: `Expenses Tracker - ${new Date().toLocaleDateString()}`,
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
  });

  const spreadsheetId = response.data.spreadsheetId;
  if (!spreadsheetId) throw new Error('Spreadsheet creation did not return an ID');
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

  // Get real sheetId from response
  const sheetId = response.data.sheets?.[0]?.properties?.sheetId;

  if (sheetId !== undefined) {
    // Auto-resize columns
    await sheets.spreadsheets.batchUpdate({
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
    });
  }

  // Create empty Budget sheet with headers
  await createEmptyBudgetSheet(refreshToken, spreadsheetId);

  return { spreadsheetId, spreadsheetUrl };
}

/**
 * Append expense row to spreadsheet
 */
/**
 * Column letter for a 0-based index (0=A, 1=B, ..., 25=Z, 26=AA)
 */
function colLetter(index: number): string {
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
const RATE_COLUMN_HEADER = 'Rate (→EUR)';

export async function appendExpenseRow(
  refreshToken: string,
  spreadsheetId: string,
  data: {
    date: string;
    category: string;
    comment: string;
    amounts: Record<string, number | null>; // Currency -> amount
    eurAmount: number;
    rate?: number; // Exchange rate used (1 CURRENCY = rate EUR)
  },
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Get headers to determine column order
  const headersResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!1:1`,
  });

  let headers: string[] = headersResponse.data.values?.[0] || [];
  logger.info({ data: headers }, `[SHEETS] Headers from spreadsheet`);

  // Check if expense currency has a column; if not, insert one
  const expenseCurrency = Object.entries(data.amounts).find(([, v]) => v !== null)?.[0];
  if (expenseCurrency) {
    const hasCurrencyCol = headers.some((h) => h.startsWith(`${expenseCurrency} (`));
    if (!hasCurrencyCol) {
      headers = await insertCurrencyColumn(
        sheets,
        spreadsheetId,
        headers,
        expenseCurrency as CurrencyCode,
      );
    }
  }

  // Ensure Rate column exists
  if (!headers.includes(RATE_COLUMN_HEADER)) {
    headers = await ensureRateColumn(sheets, spreadsheetId, headers);
  }

  // Find column indices for formula generation
  const rateColIdx = headers.indexOf(RATE_COLUMN_HEADER);
  let amountColIdx = -1;
  for (let i = 0; i < headers.length; i++) {
    const code = headers[i]?.split(' ')[0];
    if (code === expenseCurrency) {
      amountColIdx = i;
      break;
    }
  }

  // Build row values based on header order
  const row: (string | number | null)[] = [];

  for (let colIdx = 0; colIdx < headers.length; colIdx++) {
    const header = headers[colIdx];
    if (header === SPREADSHEET_CONFIG.headers[0]) {
      row.push(data.date);
    } else if (header === SPREADSHEET_CONFIG.headers[1]) {
      row.push(data.category);
    } else if (header === SPREADSHEET_CONFIG.headers[2]) {
      row.push(data.comment);
    } else if (header === SPREADSHEET_CONFIG.eurColumnHeader) {
      // EUR(calc) as formula: =AMOUNT*RATE (or static for EUR expenses / missing rate)
      if (expenseCurrency === 'EUR' || !data.rate || amountColIdx === -1 || rateColIdx === -1) {
        row.push(data.eurAmount);
      } else {
        // Formula placeholder — row number is filled in below after we know nextRow
        row.push(`__EUR_FORMULA__`);
      }
    } else if (header === RATE_COLUMN_HEADER) {
      row.push(data.rate ?? '');
    } else {
      const currencyCode = header?.split(' ')[0] as CurrencyCode;
      const value = data.amounts[currencyCode] ?? '';
      row.push(value);
    }
  }

  // Find last row with data in column A
  const dataResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!A:A`,
  });

  const existingRows = dataResponse.data.values || [];
  const nextRow = existingRows.length + 1;

  // Replace EUR formula placeholder with actual formula now that we know the row
  const formulaIdx = row.indexOf('__EUR_FORMULA__');
  if (formulaIdx !== -1 && amountColIdx !== -1 && rateColIdx !== -1) {
    const amountCell = `${colLetter(amountColIdx)}${nextRow}`;
    const rateCell = `${colLetter(rateColIdx)}${nextRow}`;
    row[formulaIdx] = `=${amountCell}*${rateCell}`;
  }

  logger.info({ data: row }, `[SHEETS] Final row`);

  const lastCol = colLetter(row.length - 1);

  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!A${nextRow}:${lastCol}${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [row],
    },
  });

  const updatedRows = response.data.updatedRows;
  logger.info(
    `[SHEETS] API response: range=${response.data.updatedRange}, rows=${updatedRows}, cells=${response.data.updatedCells}`,
  );

  if (!updatedRows || updatedRows === 0) {
    logger.error(
      `[SHEETS] No rows were updated! Full response: ${JSON.stringify(response.data, null, 2)}`,
    );
  }
}

/**
 * Insert a new currency column before EUR (calc) in an existing spreadsheet.
 * Returns the updated headers array.
 */
async function insertCurrencyColumn(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  currentHeaders: string[],
  currency: CurrencyCode,
): Promise<string[]> {
  const symbol = CURRENCY_SYMBOLS[currency] || currency;
  const newHeader = `${currency} (${symbol})`;

  // Insert before EUR (calc)
  const eurCalcIdx = currentHeaders.indexOf(SPREADSHEET_CONFIG.eurColumnHeader);
  const insertIdx = eurCalcIdx !== -1 ? eurCalcIdx : currentHeaders.length;

  // Get sheet ID
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = spreadsheet.data.sheets?.find(
    (s) => s.properties?.title === SPREADSHEET_CONFIG.sheetName,
  );
  const sheetId = sheet?.properties?.sheetId;

  if (sheetId === undefined) {
    logger.error('[SHEETS] Cannot find Expenses sheet ID for column insertion');
    return currentHeaders;
  }

  // Insert column at position
  await sheets.spreadsheets.batchUpdate({
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
  });

  logger.info(`[SHEETS] Inserted currency column "${newHeader}" at index ${insertIdx}`);

  // Return updated headers
  const updated = [...currentHeaders];
  updated.splice(insertIdx, 0, newHeader);
  return updated;
}

/**
 * Ensure the Rate (→EUR) column exists, appending it at the end if missing.
 * Returns the updated headers array.
 */
async function ensureRateColumn(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  currentHeaders: string[],
): Promise<string[]> {
  // Append at end
  const insertIdx = currentHeaders.length;

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = spreadsheet.data.sheets?.find(
    (s) => s.properties?.title === SPREADSHEET_CONFIG.sheetName,
  );
  const sheetId = sheet?.properties?.sheetId;

  if (sheetId === undefined) {
    logger.error('[SHEETS] Cannot find Expenses sheet ID for rate column');
    return currentHeaders;
  }

  await sheets.spreadsheets.batchUpdate({
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
  });

  logger.info(`[SHEETS] Added Rate column at index ${insertIdx}`);
  return [...currentHeaders, RATE_COLUMN_HEADER];
}

/**
 * Ensure spreadsheet has all required columns (currency columns + Rate).
 * Call at bot startup for each configured group.
 */
export async function ensureSheetColumns(
  refreshToken: string,
  spreadsheetId: string,
  enabledCurrencies: CurrencyCode[],
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  const headersResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!1:1`,
  });

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
  refreshToken: string,
  spreadsheetId: string,
): Promise<boolean> {
  try {
    const auth = getAuthenticatedClient(refreshToken);
    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.get({ spreadsheetId });
    return true;
  } catch (err) {
    logger.error({ err: err }, 'Failed to verify spreadsheet access');
    return false;
  }
}

/**
 * Budget sheet configuration
 */
const BUDGET_SHEET_CONFIG = {
  sheetName: 'Budget',
  headers: ['Month', 'Category', 'Limit', 'Currency'],
};

/**
 * Normalize month string to YYYY-MM format with leading zero.
 * Google Sheets may strip leading zeros (e.g., "2026-03" → "2026-3").
 */
function normalizeMonth(month: string): string {
  const match = month.match(/^(\d{4})-(\d{1,2})$/);
  if (!match) return month;
  const [, year, m] = match;
  return `${year}-${(m ?? '').padStart(2, '0')}`;
}

/**
 * Create empty Budget sheet with headers only
 */
async function createEmptyBudgetSheet(refreshToken: string, spreadsheetId: string): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Check if Budget sheet already exists
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheet = spreadsheet.data.sheets?.find(
    (sheet) => sheet.properties?.title === BUDGET_SHEET_CONFIG.sheetName,
  );

  if (existingSheet) {
    logger.info('[SHEETS] Budget sheet already exists');
    return;
  }

  // Create Budget sheet with headers only
  const addSheetResponse = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: BUDGET_SHEET_CONFIG.sheetName,
              gridProperties: {
                frozenRowCount: 1,
              },
            },
          },
        },
      ],
    },
  });

  const budgetSheetId = addSheetResponse.data.replies?.[0]?.addSheet?.properties?.sheetId ?? null;

  // Build header row
  const headers = BUDGET_SHEET_CONFIG.headers;
  const headerRow = headers.map((header) => ({
    userEnteredValue: { stringValue: header },
    userEnteredFormat: {
      textFormat: { bold: true },
      backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
    },
  }));

  // Write header
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateCells: {
            rows: [{ values: headerRow }],
            fields: 'userEnteredValue,userEnteredFormat',
            start: {
              sheetId: budgetSheetId,
              rowIndex: 0,
              columnIndex: 0,
            },
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: budgetSheetId,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: headers.length,
            },
          },
        },
      ],
    },
  });

  logger.info('[SHEETS] Empty Budget sheet created');
}

/**
 * Create Budget sheet in existing spreadsheet
 */
export async function createBudgetSheet(
  refreshToken: string,
  spreadsheetId: string,
  categories: string[],
  defaultLimit: number = 100,
  currency: CurrencyCode = 'EUR',
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Check if Budget sheet already exists
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheet = spreadsheet.data.sheets?.find(
    (sheet) => sheet.properties?.title === BUDGET_SHEET_CONFIG.sheetName,
  );

  if (existingSheet) {
    logger.info('[SHEETS] Budget sheet already exists');
    return;
  }

  // Get current month in YYYY-MM format
  const currentMonth = new Date().toISOString().slice(0, 7);

  // Create Budget sheet
  const addSheetResponse = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: BUDGET_SHEET_CONFIG.sheetName,
              gridProperties: {
                frozenRowCount: 1,
              },
            },
          },
        },
      ],
    },
  });

  const budgetSheetId = addSheetResponse.data.replies?.[0]?.addSheet?.properties?.sheetId ?? null;

  // Build header row
  const headers = BUDGET_SHEET_CONFIG.headers;

  // Build data rows (header + default budgets for categories)
  const rows = [
    // Header row
    headers.map((header) => ({
      userEnteredValue: { stringValue: header },
      userEnteredFormat: {
        textFormat: { bold: true },
        backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
      },
    })),
    // Budget rows for each category
    ...categories.map((category) => [
      { userEnteredValue: { stringValue: currentMonth } },
      { userEnteredValue: { stringValue: category } },
      { userEnteredValue: { numberValue: defaultLimit } },
      { userEnteredValue: { stringValue: currency } },
    ]),
  ];

  // Write header and data
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateCells: {
            rows: rows.map((row) => ({ values: row })),
            fields: 'userEnteredValue,userEnteredFormat',
            start: {
              sheetId: budgetSheetId,
              rowIndex: 0,
              columnIndex: 0,
            },
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: budgetSheetId,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: headers.length,
            },
          },
        },
      ],
    },
  });

  logger.info(`[SHEETS] Budget sheet created with ${categories.length} categories`);
}

/**
 * Read all budget data from Budget sheet
 */
export async function readBudgetData(
  refreshToken: string,
  spreadsheetId: string,
): Promise<Array<{ month: string; category: string; limit: number; currency: CurrencyCode }>> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${BUDGET_SHEET_CONFIG.sheetName}!A2:D`,
    });

    const rows = response.data.values || [];
    const budgets: Array<{
      month: string;
      category: string;
      limit: number;
      currency: CurrencyCode;
    }> = [];

    for (const row of rows) {
      if (row.length >= 3) {
        const [month, category, limitStr, currencyStr] = row;
        const limit = parseFloat(limitStr);

        if (month && category && !Number.isNaN(limit)) {
          budgets.push({
            month: normalizeMonth(month.trim()),
            category: category.trim(),
            limit,
            currency: (currencyStr?.trim() || 'EUR') as CurrencyCode,
          });
        }
      }
    }

    return budgets;
  } catch (err) {
    logger.error({ err: err }, '[SHEETS] Failed to read budget data');
    return [];
  }
}

/**
 * Write or update budget row in Budget sheet
 */
export async function writeBudgetRow(
  refreshToken: string,
  spreadsheetId: string,
  data: {
    month: string;
    category: string;
    limit: number;
    currency: CurrencyCode;
  },
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Get all budget data to find if row exists
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${BUDGET_SHEET_CONFIG.sheetName}!A2:D`,
  });

  const rows = response.data.values || [];
  let rowIndex = -1;

  // Find existing row for this month+category (normalize month for comparison)
  const normalizedMonth = normalizeMonth(data.month);
  for (let i = 0; i < rows.length; i++) {
    const [month, category] = rows[i] ?? [];
    if (
      normalizeMonth(month?.trim() || '') === normalizedMonth &&
      category?.trim().toLowerCase() === data.category.toLowerCase()
    ) {
      rowIndex = i + 2; // +2 because: 1-indexed + header row
      break;
    }
  }

  const row = [data.month, data.category, data.limit, data.currency];

  if (rowIndex !== -1) {
    // Update existing row
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${BUDGET_SHEET_CONFIG.sheetName}!A${rowIndex}:D${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [row],
      },
    });
  } else {
    // Append new row
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${BUDGET_SHEET_CONFIG.sheetName}!A2:D`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [row],
      },
    });
  }
}

/**
 * Check if Budget sheet exists
 */
export async function hasBudgetSheet(
  refreshToken: string,
  spreadsheetId: string,
): Promise<boolean> {
  try {
    const auth = getAuthenticatedClient(refreshToken);
    const sheets = google.sheets({ version: 'v4', auth });

    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const budgetSheet = spreadsheet.data.sheets?.find(
      (sheet) => sheet.properties?.title === BUDGET_SHEET_CONFIG.sheetName,
    );

    return !!budgetSheet;
  } catch (err) {
    logger.error({ err: err }, '[SHEETS] Failed to check Budget sheet');
    return false;
  }
}

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
  refreshToken: string,
  spreadsheetId: string,
  month: MonthAbbr,
): Promise<boolean> {
  try {
    const auth = getAuthenticatedClient(refreshToken);
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    return !!spreadsheet.data.sheets?.find((s) => s.properties?.title === month);
  } catch (err) {
    logger.error({ err }, `[SHEETS] monthTabExists failed for ${month}`);
    return false;
  }
}

/**
 * Create an empty monthly budget tab with header row (Category | Limit | Currency)
 */
export async function createEmptyMonthTab(
  refreshToken: string,
  spreadsheetId: string,
  month: MonthAbbr,
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  const addResponse = await sheets.spreadsheets.batchUpdate({
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
  });

  const sheetId = addResponse.data.replies?.[0]?.addSheet?.properties?.sheetId;

  await sheets.spreadsheets.batchUpdate({
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
            start: { sheetId: sheetId ?? 0, rowIndex: 0, columnIndex: 0 },
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: sheetId ?? 0,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: 3,
            },
          },
        },
      ],
    },
  });

  logger.info(`[SHEETS] Created empty month tab: ${month}`);
}

/**
 * Read all budget rows from a monthly tab
 */
export async function readMonthBudget(
  refreshToken: string,
  spreadsheetId: string,
  month: MonthAbbr,
): Promise<BudgetRow[]> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${month}!A2:C`,
    });

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
 * Write or update a single budget row in a monthly tab (upsert by category)
 */
export async function writeMonthBudgetRow(
  refreshToken: string,
  spreadsheetId: string,
  month: MonthAbbr,
  row: BudgetRow,
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${month}!A2:C`,
  });

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
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${month}!A${targetRow}:C${targetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${month}!A2:C`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  }
}

/**
 * Clone a monthly tab from one spreadsheet to another (cross-spreadsheet supported).
 * Uses the Google Sheets copyTo API, then renames the resulting sheet.
 */
export async function cloneMonthTab(
  refreshToken: string,
  sourceSpreadsheetId: string,
  sourceMonth: MonthAbbr,
  targetSpreadsheetId: string,
  targetMonth: MonthAbbr,
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Find source sheet ID
  const sourceSpreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sourceSpreadsheetId });
  const sourceSheet = sourceSpreadsheet.data.sheets?.find(
    (s) => s.properties?.title === sourceMonth,
  );
  const sourceSheetId = sourceSheet?.properties?.sheetId;
  if (sourceSheetId === undefined || sourceSheetId === null) {
    throw new Error(`Source tab "${sourceMonth}" not found in ${sourceSpreadsheetId}`);
  }

  // Copy sheet to target spreadsheet
  const copyResponse = await sheets.spreadsheets.sheets.copyTo({
    spreadsheetId: sourceSpreadsheetId,
    sheetId: sourceSheetId,
    requestBody: { destinationSpreadsheetId: targetSpreadsheetId },
  });

  const newSheetId = copyResponse.data.sheetId;
  if (newSheetId === undefined || newSheetId === null) {
    throw new Error('copyTo did not return a sheetId');
  }

  // Rename the copied sheet to targetMonth
  await sheets.spreadsheets.batchUpdate({
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
  });

  logger.info(`[SHEETS] Cloned ${sourceMonth} → ${targetMonth}`);
}

// ── Raw expense row helpers (used by year-split migration) ──────────────────

const EXPENSES_TAB = 'Expenses';

/**
 * Read all data rows from the Expenses tab as raw string arrays.
 * Skips the header row. Uses UNFORMATTED_VALUE to capture calculated values, not formulas.
 */
export async function readExpenseRowsRaw(
  refreshToken: string,
  spreadsheetId: string,
): Promise<string[][]> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${EXPENSES_TAB}!A2:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (response.data.values ?? []).map((row) => row.map((cell) => String(cell ?? '')));
}

/**
 * Append raw rows to the Expenses tab.
 */
export async function appendExpenseRowsRaw(
  refreshToken: string,
  spreadsheetId: string,
  rows: string[][],
): Promise<void> {
  if (rows.length === 0) return;
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${EXPENSES_TAB}!A2`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

/**
 * Delete rows from the Expenses tab by their 1-based sheet row indices.
 * Sorted and processed in reverse order to avoid index shifting.
 * Uses the Expenses tab's sheetId (resolved from spreadsheet metadata).
 */
export async function deleteExpenseRowsByIndex(
  refreshToken: string,
  spreadsheetId: string,
  rowIndices: number[],
): Promise<void> {
  if (rowIndices.length === 0) return;
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
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

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

/**
 * Read all expenses from Google Sheet.
 * Returns expenses and any rows with amounts in multiple currency columns (data errors).
 */
export async function readExpensesFromSheet(
  refreshToken: string,
  spreadsheetId: string,
): Promise<{ expenses: SheetRow[]; errors: MultiCurrencyRowError[] }> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!A:Z`,
  });

  const rows = response.data.values || [];

  if (rows.length === 0) {
    return { expenses: [], errors: [] };
  }

  const headers = rows[0] as string[];
  logger.info({ data: headers }, `[SHEETS] Headers`);

  const dateCol = headers.indexOf(SPREADSHEET_CONFIG.headers[0] ?? '');
  const categoryCol = headers.indexOf(SPREADSHEET_CONFIG.headers[1] ?? '');
  const commentCol = headers.indexOf(SPREADSHEET_CONFIG.headers[2] ?? '');
  const eurCol = headers.indexOf(SPREADSHEET_CONFIG.eurColumnHeader);
  const rateCol = headers.indexOf(RATE_COLUMN_HEADER);

  if (dateCol === -1 || categoryCol === -1 || commentCol === -1) {
    throw new Error('Required columns not found in spreadsheet');
  }

  // Find currency columns
  const currencyColumns: Array<{ index: number; currency: string }> = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i] ?? '';
    if (
      header &&
      header !== SPREADSHEET_CONFIG.headers[0] &&
      header !== SPREADSHEET_CONFIG.headers[1] &&
      header !== SPREADSHEET_CONFIG.headers[2] &&
      header !== SPREADSHEET_CONFIG.eurColumnHeader &&
      header !== RATE_COLUMN_HEADER
    ) {
      const match = header.match(/^([A-Z]{3})\s*\(/);
      if (match?.[1]) {
        currencyColumns.push({ index: i, currency: match[1] });
      }
    }
  }

  const expenses: SheetRow[] = [];
  const errors: MultiCurrencyRowError[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as string[];
    if (!row || row.length === 0 || !row[dateCol]) continue;

    const date = row[dateCol] ?? '';
    const category = row[categoryCol] || 'Без категории';
    const comment = row[commentCol] || '';
    const eurAmountStr = eurCol !== -1 ? row[eurCol] : null;

    // Parse amounts for each currency
    const amounts: Record<string, number> = {};
    const foundCurrencies: string[] = [];

    for (const { index, currency } of currencyColumns) {
      const value = row[index];
      if (value && value.trim() !== '') {
        const parsed = parseFloat(value);
        if (!Number.isNaN(parsed) && parsed > 0) {
          amounts[currency] = parsed;
          foundCurrencies.push(currency);
        }
      }
    }

    // Flag rows with amounts in multiple currency columns
    if (foundCurrencies.length > 1) {
      errors.push({
        row: i + 1, // 1-based for spreadsheet display
        date,
        currencies: foundCurrencies,
        category,
      });
      continue; // skip this row — data is ambiguous
    }

    // No currency amount found — fall back to EUR(calc) as EUR amount
    // (happens when expense was in a currency without a column in the sheet)
    if (foundCurrencies.length === 0) {
      const eurCalcVal = eurAmountStr ? parseFloat(eurAmountStr) : 0;
      if (!eurCalcVal || eurCalcVal <= 0) continue; // truly empty row

      amounts['EUR'] = eurCalcVal;
      foundCurrencies.push('EUR');
    }

    // Read stored exchange rate
    let rate: number | null = null;
    if (rateCol !== -1) {
      const rateStr = row[rateCol];
      if (rateStr && rateStr.trim() !== '') {
        const parsed = parseFloat(rateStr);
        if (!Number.isNaN(parsed) && parsed > 0) {
          rate = parsed;
        }
      }
    }

    // EUR amount: from sheet if available, otherwise recalculate
    let eurAmount: number;
    if (eurAmountStr && eurAmountStr.trim() !== '') {
      const parsed = parseFloat(eurAmountStr);
      eurAmount = !Number.isNaN(parsed) ? parsed : 0;
    } else {
      const [curr, amt] = Object.entries(amounts)[0] ?? [];
      if (curr && amt) {
        eurAmount = rate
          ? Math.round(amt * rate * 100) / 100
          : convertToEUR(amt, curr as CurrencyCode);
      } else {
        eurAmount = 0;
      }
    }

    expenses.push({ date, amounts, eurAmount, rate, category, comment });
  }

  return { expenses, errors };
}
