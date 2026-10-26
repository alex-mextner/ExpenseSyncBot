/**
 * Shared googleapis/oauth/converter/logger mocks for the sheets*.test.ts files.
 * Split out of sheets.test.ts so each test file (isolated process) wires the same
 * mocks without duplicating them. Must be imported BEFORE './sheets' is loaded.
 */
import { mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { GoogleConn } from './sheets';

// Silence + assert on logger calls. The source file imports from
// '../../utils/logger.ts' (explicit extension) — match that exactly so
// mock.module substitutes the right module identity.
export const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Mock googleapis sheets client ─────────────────────────────────────────────

export interface ValuesGetResponse {
  data: { values: unknown[][] };
}
export interface ValuesAppendResponse {
  data: { updates: { updatedRange: string; updatedRows: number } };
}
export interface ValuesAppendArgs {
  requestBody: { values: unknown[][] };
}

export const mockValuesGet = mock(
  (..._args: unknown[]): Promise<ValuesGetResponse> => Promise.resolve({ data: { values: [[]] } }),
);
export const mockValuesAppend = mock(
  (..._args: unknown[]): Promise<ValuesAppendResponse> =>
    Promise.resolve({
      data: { updates: { updatedRange: 'Expenses!A2:G2', updatedRows: 1 } },
    }),
);
export const mockValuesBatchUpdate = mock(
  (..._args: unknown[]): Promise<{ data: Record<string, never> }> => Promise.resolve({ data: {} }),
);
export const mockValuesUpdate = mock(
  (..._args: unknown[]): Promise<{ data: Record<string, never> }> => Promise.resolve({ data: {} }),
);
export const mockSpreadsheetsBatchUpdate = mock(
  (..._args: unknown[]): Promise<{ data: Record<string, unknown> }> =>
    Promise.resolve({ data: {} }),
);
export const mockSpreadsheetsGet = mock(() =>
  Promise.resolve({
    data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
  }),
);
export const mockSpreadsheetsCreate = mock(
  (
    ..._args: unknown[]
  ): Promise<{
    data: { spreadsheetId?: string; sheets?: Array<{ properties?: { sheetId?: number } }> };
  }> =>
    Promise.resolve({
      data: { spreadsheetId: 'new-sheet-id', sheets: [{ properties: { sheetId: 0 } }] },
    }),
);
export const mockSheetsCopyTo = mock(
  (..._args: unknown[]): Promise<{ data: { sheetId?: number } }> =>
    Promise.resolve({ data: { sheetId: 42 } }),
);

export const mockSheets = {
  spreadsheets: {
    values: {
      get: mockValuesGet,
      append: mockValuesAppend,
      batchUpdate: mockValuesBatchUpdate,
      update: mockValuesUpdate,
    },
    batchUpdate: mockSpreadsheetsBatchUpdate,
    get: mockSpreadsheetsGet,
    create: mockSpreadsheetsCreate,
    sheets: {
      copyTo: mockSheetsCopyTo,
    },
  },
};

mock.module('googleapis', () => ({
  google: {
    sheets: () => mockSheets,
  },
}));

export const mockIsTokenExpiredError = mock((_err: unknown) => false);
mock.module('./oauth', () => ({
  getAuthenticatedClient: () => ({}),
  isTokenExpiredError: mockIsTokenExpiredError,
}));

// Deterministic currency conversion for readExpensesFromSheet tests
mock.module('../currency/converter', () => ({
  convertToEUR: (amount: number, currency: string) => {
    if (currency === 'EUR') return amount;
    if (currency === 'USD') return Math.round(amount * 0.9 * 100) / 100;
    if (currency === 'RSD') return Math.round(amount * 0.0086 * 100) / 100;
    return amount;
  },
}));

export const TEST_CONN: GoogleConn = { refreshToken: 'token', oauthClient: 'legacy' };
export const TEST_SPREADSHEET = 'sheet-123';

export function resetSheetsMocks(): void {
  mockValuesGet.mockReset().mockResolvedValue({
    data: {
      values: [['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)']],
    },
  });
  mockValuesAppend.mockReset().mockResolvedValue({
    data: { updates: { updatedRange: 'Expenses!A2:F2', updatedRows: 1 } },
  });
  mockValuesBatchUpdate.mockReset().mockResolvedValue({ data: {} });
  mockValuesUpdate.mockReset().mockResolvedValue({ data: {} });
  mockSpreadsheetsBatchUpdate.mockReset().mockResolvedValue({ data: {} });
  mockSpreadsheetsGet.mockReset().mockResolvedValue({
    data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
  });
  mockSpreadsheetsCreate.mockReset().mockResolvedValue({
    data: { spreadsheetId: 'new-sheet-id', sheets: [{ properties: { sheetId: 0 } }] },
  });
  mockSheetsCopyTo.mockReset().mockResolvedValue({ data: { sheetId: 42 } });
  mockIsTokenExpiredError.mockReset().mockReturnValue(false);
  logMock.trace.mockReset();
  logMock.debug.mockReset();
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();
  logMock.fatal.mockReset();
}
