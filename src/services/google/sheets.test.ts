/** Tests for sheets.ts connection helpers, spreadsheet creation, rename, sort and access verification */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  logMock,
  mockIsTokenExpiredError,
  mockSpreadsheetsBatchUpdate,
  mockSpreadsheetsCreate,
  mockSpreadsheetsGet,
  resetSheetsMocks,
  TEST_CONN,
  TEST_SPREADSHEET,
} from './sheets-test-support';

// Dynamic import keeps './sheets' evaluated AFTER the mock.module calls in
// sheets-test-support (otherwise bun binds the real logger/googleapis).
const {
  createExpenseSpreadsheet,
  getSpreadsheetUrl,
  googleConn,
  renameSpreadsheet,
  sortExpensesTab,
  verifySpreadsheetAccess,
} = await import('./sheets');

beforeEach(resetSheetsMocks);

// ── googleConn ──────────────────────────────────────────────────────────────

describe('googleConn', () => {
  test('builds GoogleConn from a group object', () => {
    const conn = googleConn({
      google_refresh_token: 'tok-abc',
      oauth_client: 'current',
    });
    expect(conn).toEqual({ refreshToken: 'tok-abc', oauthClient: 'current' });
  });

  test('throws when refresh token is null', () => {
    expect(() => googleConn({ google_refresh_token: null, oauth_client: 'current' })).toThrow(
      /refresh token/,
    );
  });

  test('propagates oauth_client value unchanged (legacy)', () => {
    const conn = googleConn({
      google_refresh_token: 'tok',
      oauth_client: 'legacy',
    });
    expect(conn.oauthClient).toBe('legacy');
  });
});

// ── getSpreadsheetUrl ───────────────────────────────────────────────────────

describe('getSpreadsheetUrl', () => {
  test('formats the canonical Google Sheets URL', () => {
    expect(getSpreadsheetUrl('abc123')).toBe('https://docs.google.com/spreadsheets/d/abc123');
  });

  test('does not URL-encode the id (caller responsibility)', () => {
    expect(getSpreadsheetUrl('A_B-C_1')).toBe('https://docs.google.com/spreadsheets/d/A_B-C_1');
  });
});

// ── verifySpreadsheetAccess ─────────────────────────────────────────────────

describe('verifySpreadsheetAccess', () => {
  test('returns true on successful spreadsheets.get', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
    });
    const ok = await verifySpreadsheetAccess(TEST_CONN, TEST_SPREADSHEET);
    expect(ok).toBe(true);
  });

  test('returns false on non-auth error (e.g., 404)', async () => {
    mockSpreadsheetsGet.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 404 }));
    const ok = await verifySpreadsheetAccess(TEST_CONN, TEST_SPREADSHEET);
    expect(ok).toBe(false);
    expect(logMock.error).toHaveBeenCalled();
  });

  test('throws OAuthError when token is expired/revoked', async () => {
    mockIsTokenExpiredError.mockReturnValue(true);
    mockSpreadsheetsGet.mockRejectedValueOnce(new Error('invalid_grant'));
    await expect(verifySpreadsheetAccess(TEST_CONN, TEST_SPREADSHEET)).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
  });
});

// ── renameSpreadsheet ───────────────────────────────────────────────────────

describe('renameSpreadsheet', () => {
  test('issues updateSpreadsheetProperties batchUpdate with new title', async () => {
    await renameSpreadsheet(TEST_CONN, TEST_SPREADSHEET, 'New Title');

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
    const call = mockSpreadsheetsBatchUpdate.mock.calls[0]?.[0] as {
      spreadsheetId: string;
      requestBody: {
        requests: Array<{
          updateSpreadsheetProperties: { properties: { title: string }; fields: string };
        }>;
      };
    };
    expect(call.spreadsheetId).toBe(TEST_SPREADSHEET);
    expect(call.requestBody.requests[0]?.updateSpreadsheetProperties.properties.title).toBe(
      'New Title',
    );
    expect(call.requestBody.requests[0]?.updateSpreadsheetProperties.fields).toBe('title');
  });
});

// ── sortExpensesTab ─────────────────────────────────────────────────────────

describe('sortExpensesTab', () => {
  test('issues sortRange request with ASCENDING on column A', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
    });

    await sortExpensesTab(TEST_CONN, TEST_SPREADSHEET);

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
    const call = mockSpreadsheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: {
        requests: Array<{
          sortRange: {
            range: { sheetId: number; startRowIndex: number };
            sortSpecs: Array<{ dimensionIndex: number; sortOrder: string }>;
          };
        }>;
      };
    };
    const req = call.requestBody.requests[0];
    expect(req?.sortRange.range.startRowIndex).toBe(1);
    expect(req?.sortRange.sortSpecs[0]?.dimensionIndex).toBe(0);
    expect(req?.sortRange.sortSpecs[0]?.sortOrder).toBe('ASCENDING');
  });

  test('no-op when Expenses tab is missing', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Other' } }] },
    });
    await sortExpensesTab(TEST_CONN, TEST_SPREADSHEET);
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
  });
});

// ── createExpenseSpreadsheet ────────────────────────────────────────────────

describe('createExpenseSpreadsheet', () => {
  test('creates spreadsheet, auto-resizes columns, creates current month tab', async () => {
    mockSpreadsheetsCreate.mockResolvedValueOnce({
      data: {
        spreadsheetId: 'new-sheet-id',
        sheets: [{ properties: { sheetId: 5 } }],
      },
    });
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({ data: {} }); // auto-resize
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({
      data: { replies: [{ addSheet: { properties: { sheetId: 100 } } }] },
    });
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({ data: {} }); // format month tab

    const result = await createExpenseSpreadsheet(TEST_CONN, 'EUR', ['EUR', 'USD', 'RSD']);

    expect(result.spreadsheetId).toBe('new-sheet-id');
    expect(result.spreadsheetUrl).toBe('https://docs.google.com/spreadsheets/d/new-sheet-id');

    expect(mockSpreadsheetsCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockSpreadsheetsCreate.mock.calls[0]?.[0] as {
      requestBody: {
        properties: { title: string };
        sheets: Array<{
          properties: { title: string; gridProperties?: { frozenRowCount: number } };
          data: Array<{ rowData: Array<{ values: Array<{ userEnteredValue: unknown }> }> }>;
        }>;
      };
    };
    expect(createArgs.requestBody.properties.title).toContain('Expenses Tracker');
    expect(createArgs.requestBody.sheets[0]?.properties.title).toBe('Expenses');
    expect(createArgs.requestBody.sheets[0]?.properties.gridProperties?.frozenRowCount).toBe(1);

    const headerValues = createArgs.requestBody.sheets[0]?.data[0]?.rowData[0]?.values ?? [];
    const titles = headerValues.map(
      (c) => (c.userEnteredValue as { stringValue?: string }).stringValue,
    );
    expect(titles[0]).toBe('Дата');
    expect(titles).toContain('EUR (calc)');
    expect(titles).toContain('Rate (→EUR)');
    expect(titles.some((t) => t?.startsWith('EUR '))).toBe(true);
    expect(titles.some((t) => t?.startsWith('USD '))).toBe(true);
    expect(titles.some((t) => t?.startsWith('RSD '))).toBe(true);

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(3);
  });

  test('throws when spreadsheet creation does not return an id', async () => {
    mockSpreadsheetsCreate.mockResolvedValueOnce({ data: {} });
    await expect(createExpenseSpreadsheet(TEST_CONN, 'EUR', ['EUR'])).rejects.toThrow(
      /did not return an ID/,
    );
  });

  test('swallows month-tab creation failure — still returns spreadsheet', async () => {
    mockSpreadsheetsCreate.mockResolvedValueOnce({
      data: { spreadsheetId: 'id-x', sheets: [{ properties: { sheetId: 5 } }] },
    });
    mockSpreadsheetsBatchUpdate.mockResolvedValueOnce({ data: {} }); // auto-resize
    mockSpreadsheetsBatchUpdate.mockRejectedValueOnce(new Error('tab create boom'));

    const result = await createExpenseSpreadsheet(TEST_CONN, 'EUR', ['EUR']);
    expect(result.spreadsheetId).toBe('id-x');
    expect(logMock.error).toHaveBeenCalled();
  });
});
