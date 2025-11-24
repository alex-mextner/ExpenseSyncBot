import { google } from 'googleapis';
import { getAuthenticatedClient } from './oauth';
import type { CurrencyCode } from '../../config/constants';
import { CURRENCY_SYMBOLS, SPREADSHEET_CONFIG } from '../../config/constants';

/**
 * Create a new expense tracking spreadsheet
 */
export async function createExpenseSpreadsheet(
  refreshToken: string,
  defaultCurrency: CurrencyCode,
  enabledCurrencies: CurrencyCode[]
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Build headers
  const headers = [
    SPREADSHEET_CONFIG.headers[0], // Дата
    ...enabledCurrencies.map(code => `${code} (${CURRENCY_SYMBOLS[code]})`),
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
                  values: headers.map(header => ({
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

  const spreadsheetId = response.data.spreadsheetId!;
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
  }
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Get headers to determine column order
  const headersResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!A1:Z1`,
  });

  const headers = headersResponse.data.values?.[0] || [];
  console.log(`[SHEETS] Headers from spreadsheet:`, headers);
  console.log(`[SHEETS] Data to append:`, data);

  // Build row values based on header order
  const row: (string | number | null)[] = [];

  for (const header of headers) {
    if (header === SPREADSHEET_CONFIG.headers[0]) {
      // Дата
      console.log(`[SHEETS] Adding date: ${data.date}`);
      row.push(data.date);
    } else if (header === SPREADSHEET_CONFIG.headers[1]) {
      // Категория
      console.log(`[SHEETS] Adding category: ${data.category}`);
      row.push(data.category);
    } else if (header === SPREADSHEET_CONFIG.headers[2]) {
      // Комментарий
      console.log(`[SHEETS] Adding comment: ${data.comment}`);
      row.push(data.comment);
    } else if (header === SPREADSHEET_CONFIG.eurColumnHeader) {
      // EUR (calc)
      console.log(`[SHEETS] Adding EUR (calc): ${data.eurAmount}`);
      row.push(data.eurAmount);
    } else {
      // Currency columns
      const currencyCode = header.split(' ')[0] as CurrencyCode;
      const value = data.amounts[currencyCode] || null;
      console.log(`[SHEETS] Header "${header}" -> currency "${currencyCode}" -> value ${value}`);
      row.push(value);
    }
  }

  console.log(`[SHEETS] Final row:`, row);

  // Append row
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!A2:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [row],
    },
  });
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
  spreadsheetId: string
): Promise<boolean> {
  try {
    const auth = getAuthenticatedClient(refreshToken);
    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.get({ spreadsheetId });
    return true;
  } catch (err) {
    console.error('Failed to verify spreadsheet access:', err);
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
 * Create empty Budget sheet with headers only
 */
async function createEmptyBudgetSheet(
  refreshToken: string,
  spreadsheetId: string
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Check if Budget sheet already exists
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheet = spreadsheet.data.sheets?.find(
    sheet => sheet.properties?.title === BUDGET_SHEET_CONFIG.sheetName
  );

  if (existingSheet) {
    console.log('[SHEETS] Budget sheet already exists');
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

  const budgetSheetId = addSheetResponse.data.replies?.[0]?.addSheet?.properties?.sheetId;

  // Build header row
  const headers = BUDGET_SHEET_CONFIG.headers;
  const headerRow = headers.map(header => ({
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

  console.log('[SHEETS] Empty Budget sheet created');
}

/**
 * Create Budget sheet in existing spreadsheet
 */
export async function createBudgetSheet(
  refreshToken: string,
  spreadsheetId: string,
  categories: string[],
  defaultLimit: number = 100,
  currency: CurrencyCode = 'EUR'
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Check if Budget sheet already exists
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheet = spreadsheet.data.sheets?.find(
    sheet => sheet.properties?.title === BUDGET_SHEET_CONFIG.sheetName
  );

  if (existingSheet) {
    console.log('[SHEETS] Budget sheet already exists');
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

  const budgetSheetId = addSheetResponse.data.replies?.[0]?.addSheet?.properties?.sheetId;

  // Build header row
  const headers = BUDGET_SHEET_CONFIG.headers;

  // Build data rows (header + default budgets for categories)
  const rows = [
    // Header row
    headers.map(header => ({
      userEnteredValue: { stringValue: header },
      userEnteredFormat: {
        textFormat: { bold: true },
        backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
      },
    })),
    // Budget rows for each category
    ...categories.map(category => [
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
            rows: rows.map(row => ({ values: row })),
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

  console.log(`[SHEETS] Budget sheet created with ${categories.length} categories`);
}

/**
 * Read all budget data from Budget sheet
 */
export async function readBudgetData(
  refreshToken: string,
  spreadsheetId: string
): Promise<Array<{ month: string; category: string; limit: number; currency: CurrencyCode }>> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${BUDGET_SHEET_CONFIG.sheetName}!A2:D`,
    });

    const rows = response.data.values || [];
    const budgets: Array<{ month: string; category: string; limit: number; currency: CurrencyCode }> = [];

    for (const row of rows) {
      if (row.length >= 3) {
        const [month, category, limitStr, currencyStr] = row;
        const limit = parseFloat(limitStr);

        if (month && category && !Number.isNaN(limit)) {
          budgets.push({
            month: month.trim(),
            category: category.trim(),
            limit,
            currency: (currencyStr?.trim() || 'EUR') as CurrencyCode,
          });
        }
      }
    }

    return budgets;
  } catch (err) {
    console.error('[SHEETS] Failed to read budget data:', err);
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
  }
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

  // Find existing row for this month+category
  for (let i = 0; i < rows.length; i++) {
    const [month, category] = rows[i];
    if (
      month?.trim() === data.month &&
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
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [row],
      },
    });
  } else {
    // Append new row
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${BUDGET_SHEET_CONFIG.sheetName}!A2:D`,
      valueInputOption: 'USER_ENTERED',
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
  spreadsheetId: string
): Promise<boolean> {
  try {
    const auth = getAuthenticatedClient(refreshToken);
    const sheets = google.sheets({ version: 'v4', auth });

    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const budgetSheet = spreadsheet.data.sheets?.find(
      sheet => sheet.properties?.title === BUDGET_SHEET_CONFIG.sheetName
    );

    return !!budgetSheet;
  } catch (err) {
    console.error('[SHEETS] Failed to check Budget sheet:', err);
    return false;
  }
}
