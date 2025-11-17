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
    SPREADSHEET_CONFIG.usdColumnHeader, // USD (calc)
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
    usdAmount: number;
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

  // Build row values based on header order
  const row: (string | number | null)[] = [];

  for (const header of headers) {
    if (header === SPREADSHEET_CONFIG.headers[0]) {
      // Дата
      row.push(data.date);
    } else if (header === SPREADSHEET_CONFIG.headers[1]) {
      // Категория
      row.push(data.category);
    } else if (header === SPREADSHEET_CONFIG.headers[2]) {
      // Комментарий
      row.push(data.comment);
    } else if (header === SPREADSHEET_CONFIG.usdColumnHeader) {
      // USD (calc)
      row.push(data.usdAmount);
    } else {
      // Currency columns
      const currencyCode = header.split(' ')[0] as CurrencyCode;
      row.push(data.amounts[currencyCode] || null);
    }
  }

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
