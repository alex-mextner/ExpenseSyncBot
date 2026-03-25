import { google } from 'googleapis';
import type { CurrencyCode } from '../../config/constants';
import { CURRENCY_SYMBOLS, SPREADSHEET_CONFIG } from '../../config/constants';
import { OAuthError } from '../../errors';
import { createLogger } from '../../utils/logger.ts';
import { convertToEUR } from '../currency/converter';
import { getAuthenticatedClient, isTokenExpiredError } from './oauth';

const logger = createLogger('sheets');


/**
 * Row data from spreadsheet
 */
export interface SheetRow {
  date: string;
  amounts: Record<string, number>; // currency -> amount
  eurAmount: number;
  category: string;
  comment: string;
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

  // Build headers
  const headers = [
    SPREADSHEET_CONFIG.headers[0], // Дата
    ...enabledCurrencies.map((code) => `${code} (${CURRENCY_SYMBOLS[code]})`),
    SPREADSHEET_CONFIG.eurColumnHeader, // EUR (calc)
    SPREADSHEET_CONFIG.headers[1], // Категория
    SPREADSHEET_CONFIG.headers[2], // Комментарий
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
export async function appendExpenseRow(
  refreshToken: string,
  spreadsheetId: string,
  data: {
    date: string;
    category: string;
    comment: string;
    amounts: Record<CurrencyCode, number | null>; // Currency -> amount
    eurAmount: number;
  },
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Get headers to determine column order
  const headersResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!A1:Z1`,
  });

  const headers = headersResponse.data.values?.[0] || [];
  logger.info({ data: headers }, `[SHEETS] Headers from spreadsheet`);
  logger.info({ data }, `[SHEETS] Data to append`);

  // Build row values based on header order
  const row: (string | number | null)[] = [];

  for (const header of headers) {
    if (header === SPREADSHEET_CONFIG.headers[0]) {
      // Дата
      logger.info(`[SHEETS] Adding date: ${data.date}`);
      row.push(data.date);
    } else if (header === SPREADSHEET_CONFIG.headers[1]) {
      // Категория
      logger.info(`[SHEETS] Adding category: ${data.category}`);
      row.push(data.category);
    } else if (header === SPREADSHEET_CONFIG.headers[2]) {
      // Комментарий
      logger.info(`[SHEETS] Adding comment: ${data.comment}`);
      row.push(data.comment);
    } else if (header === SPREADSHEET_CONFIG.eurColumnHeader) {
      // EUR (calc)
      logger.info(`[SHEETS] Adding EUR (calc): ${data.eurAmount}`);
      row.push(data.eurAmount);
    } else {
      // Currency columns
      const currencyCode = header.split(' ')[0] as CurrencyCode;
      const value = data.amounts[currencyCode] ?? '';
      logger.info(`[SHEETS] Header "${header}" -> currency "${currencyCode}" -> value ${value}`);
      row.push(value);
    }
  }

  logger.info({ data: row }, `[SHEETS] Final row`);

  // Find last row with data in column A
  const dataResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!A:A`,
  });

  const existingRows = dataResponse.data.values || [];
  const nextRow = existingRows.length + 1; // +1 because rows are 1-indexed

  logger.info(`[SHEETS] Last row with data: ${existingRows.length}, inserting at row ${nextRow}`);

  // Calculate last column letter dynamically based on row length
  const lastColLetter = String.fromCharCode(64 + row.length); // 1=A, 2=B, ..., 9=I, etc.

  // Update specific row instead of append
  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!A${nextRow}:${lastColLetter}${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [row],
    },
  });

  // Log API response for debugging
  const updatedRange = response.data.updatedRange;
  const updatedRows = response.data.updatedRows;
  const updatedCells = response.data.updatedCells;

  logger.info(
    `[SHEETS] API response: range=${updatedRange}, rows=${updatedRows}, cells=${updatedCells}`,
  );

  if (!updatedRows || updatedRows === 0) {
    logger.error(
      `[SHEETS] ⚠️ No rows were updated! Full response: ${JSON.stringify(response.data, null, 2)}`,
    );
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

/**
 * Read all expenses from Google Sheet
 */
export async function readExpensesFromSheet(
  refreshToken: string,
  spreadsheetId: string,
): Promise<SheetRow[]> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Read all data from sheet
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!A:Z`,
  });

  const rows = response.data.values || [];

  if (rows.length === 0) {
    return [];
  }

  // First row is headers
  const headers = rows[0] as string[];
  logger.info({ data: headers }, `[SHEETS] Headers`);

  // Find column indices
  const dateCol = headers.indexOf(SPREADSHEET_CONFIG.headers[0] ?? ''); // Дата
  const categoryCol = headers.indexOf(SPREADSHEET_CONFIG.headers[1] ?? ''); // Категория
  const commentCol = headers.indexOf(SPREADSHEET_CONFIG.headers[2] ?? ''); // Комментарий
  const eurCol = headers.indexOf(SPREADSHEET_CONFIG.eurColumnHeader); // EUR (calc)

  if (dateCol === -1 || categoryCol === -1 || commentCol === -1) {
    throw new Error('Required columns not found in spreadsheet');
  }

  // Find currency columns (e.g., "USD ($)", "RSD (RSD)")
  const currencyColumns: Array<{ index: number; currency: string }> = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (
      header &&
      header !== SPREADSHEET_CONFIG.headers[0] &&
      header !== SPREADSHEET_CONFIG.headers[1] &&
      header !== SPREADSHEET_CONFIG.headers[2] &&
      header !== SPREADSHEET_CONFIG.eurColumnHeader
    ) {
      // Extract currency code from "USD ($)" -> "USD"
      const match = header.match(/^([A-Z]{3})\s*\(/);
      if (match) {
        currencyColumns.push({ index: i, currency: match[1] ?? '' });
      }
    }
  }

  logger.info({ data: currencyColumns }, `[SHEETS] Currency columns`);

  // Parse data rows (skip header)
  const expenses: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as string[];

    // Skip empty rows
    if (!row || row.length === 0 || !row[dateCol]) {
      continue;
    }

    const date = row[dateCol];
    const category = row[categoryCol] || 'Без категории';
    const comment = row[commentCol] || '';
    const eurAmountStr = eurCol !== -1 ? row[eurCol] : null;

    // Parse amounts for each currency
    const amounts: Record<string, number> = {};
    let foundAmount = false;

    for (const { index, currency } of currencyColumns) {
      const value = row[index];
      if (value && value.trim() !== '') {
        const parsed = parseFloat(value);
        if (!Number.isNaN(parsed) && parsed > 0) {
          amounts[currency] = parsed;
          foundAmount = true;
        }
      }
    }

    // Skip rows without any amounts
    if (!foundAmount) {
      continue;
    }

    // Use EUR amount from sheet if available, otherwise calculate
    let eurAmount: number;

    if (eurAmountStr && eurAmountStr.trim() !== '') {
      const parsed = parseFloat(eurAmountStr);
      eurAmount = !Number.isNaN(parsed) ? parsed : 0;
    } else {
      // Calculate EUR amount from the first non-null currency
      eurAmount = 0;
      for (const [curr, amt] of Object.entries(amounts)) {
        eurAmount = convertToEUR(amt, curr as CurrencyCode);
        break;
      }
    }

    expenses.push({
      date,
      amounts,
      eurAmount,
      category,
      comment,
    });
  }

  return expenses;
}
