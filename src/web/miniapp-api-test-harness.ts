// Shared harness for the miniapp-api test files: mocks, DB/service spies and request builders.
// Split out of miniapp-api.test.ts so each route group lives in its own <=1200-line test file;
// every test file imports this module BEFORE ./miniapp-api.ts so the mocks are installed first.

import type { SQLQueryBindings } from 'bun:sqlite';
import { mock, spyOn } from 'bun:test';
import { createHmac } from 'node:crypto';
import { env } from '../config/env.ts';
import { database } from '../database/index.ts';
import type { Category, Group, User } from '../database/types.ts';
import type {
  RecordExpenseData,
  RecordExpenseResult,
  RecorderApi,
  RecordReceiptData,
  RecordReceiptResult,
} from '../services/expense-recorder.ts';
import * as expenseRecorderModule from '../services/expense-recorder.ts';
import type { CategoryExample } from '../services/receipt/ai-extractor.ts';
import * as ocrExtractorModule from '../services/receipt/ocr-extractor.ts';
import type { BrowserLike } from '../services/receipt/receipt-fetcher.ts';
import * as receiptFetcherModule from '../services/receipt/receipt-fetcher.ts';
import type { ParseResult } from '../services/receipt/receipt-parser.ts';
import * as receiptParserModule from '../services/receipt/receipt-parser.ts';
import { createMockLogger } from '../test-utils/mocks/logger';
import * as loggerModule from '../utils/logger.ts';
import type { SseEventType } from './sse-emitter.ts';
import * as sseEmitterModule from './sse-emitter.ts';

export const TEST_BOT_TOKEN = 'test_bot_token_12345';
export const CORS_ORIGIN = 'https://app.example.com';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Build a full Expense stub with sensible defaults, overriding only what the test cares about */
export function stubExpense(
  overrides: Partial<import('../database/types.ts').Expense> & { id: number },
): import('../database/types.ts').Expense {
  return {
    group_id: 7,
    user_id: 1,
    date: '2024-01-15',
    category: 'test',
    comment: '',
    amount: 10,
    currency: 'EUR',
    eur_amount: 10,
    receipt_id: null,
    receipt_file_id: null,
    created_at: '2024-01-15',
    ...overrides,
  };
}

/** Build a full Category stub — tests only care about `name` */
export function stubCategory(name: string, overrides?: Partial<Category>): Category {
  return { id: 1, group_id: 7, name, created_at: '2024-01-01', ...overrides };
}

/** Build a full Group stub */
export function stubGroup(overrides?: Partial<Group>): Group {
  return {
    id: 7,
    telegram_group_id: -1001234567,
    title: null,
    invite_link: null,
    default_currency: 'RSD',
    enabled_currencies: ['RSD'],
    google_refresh_token: null,
    spreadsheet_id: null,
    custom_prompt: null,
    active_topic_id: null,
    bank_panel_summary_message_id: null,
    bank_cards_enabled: 1,
    oauth_client: 'current',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
    ...overrides,
  };
}

// ── Mocks (must be declared before importing the module under test) ───────────

export const mockFindByTelegramId = mock((_id: number): User | null => null);
// Generic queryOne/queryAll — spyOn preserves the generic type parameter, but
// mockImplementation() can't accept a non-generic function. We define concrete
// function types matching the erased signature so mocks type-check at call sites.
// Union covers all row shapes returned across the different query calls in tests.
export type MockDbRow =
  | { id: number }
  | { config: string; updated_at: string }
  | { updated_at: string }
  | null;
export type QueryOneFn = (sql: string, ...params: SQLQueryBindings[]) => MockDbRow;
export type QueryAllFn = (sql: string, ...params: SQLQueryBindings[]) => unknown[];
export const mockDbQueryOne = mock<QueryOneFn>((_sql, ..._params) => null);
export const mockDbQueryAll = mock<QueryAllFn>((_sql, ..._params) => []);
// Generic exec mock — used by UPDATE/INSERT statements
export const mockDbExec = mock((_sql: string, ..._params: SQLQueryBindings[]): void => {});
export const mockCategoriesFindByGroupId = mock((_groupId: number): Category[] => []);
export const mockGroupsFindById = mock((_id: number): Group | null => null);
export const mockGroupsFindByTelegramGroupId = mock(
  (_telegramGroupId: number): Group | null => null,
);
export const mockUsersCreate = mock(
  (data: { telegram_id: number; group_id: number }): User =>
    ({
      id: 1,
      telegram_id: data.telegram_id,
      group_id: data.group_id,
      created_at: '2024-01-01',
    }) as User,
);
export const mockUsersUpdate = mock(
  (_telegramId: number, _data: { group_id?: number }): User | null => null,
);
export const mockGroupMembersIsMember = mock(
  (_telegramId: number, _groupId: number): boolean => false,
);
export const mockFetchReceiptData = mock(
  (_qrData: string, _getBrowserFn?: () => Promise<BrowserLike>): Promise<string> =>
    Promise.resolve(''),
);
/** Build a ParseResult stub — tests only care about items + currency, fill required fields */
export function stubParseResult(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    items: [],
    sumVerified: false,
    computedSum: 0,
    providerUsed: 'mock',
    calculateSumRounds: 0,
    ...overrides,
  };
}

export const mockParseReceipt = mock(
  (
    _data: string,
    _categories: string[],
    _categoryExamples?: Map<string, CategoryExample[]>,
    _onProgress?: (delta: string) => void,
  ): Promise<ParseResult> => Promise.resolve(stubParseResult()),
);
export const mockExtractTextFromImageBuffer = mock(
  (_buf: Buffer): Promise<string> => Promise.resolve('OCR text'),
);
export const mockExpenseRecorderRecord = mock(
  (_groupId: number, _userId: number, _data: RecordExpenseData): Promise<RecordExpenseResult> =>
    Promise.resolve({ expense: stubExpense({ id: 99 }), eurAmount: 10 }),
);
export const mockExpenseRecorderRecordReceipt = mock(
  (_groupId: number, _userId: number, _data: RecordReceiptData): Promise<RecordReceiptResult> =>
    Promise.resolve({
      expenses: [{ expense: stubExpense({ id: 99 }), eurAmount: 10 }],
      categoriesAffected: [],
    }),
);
export const mockGetExpenseRecorder = mock(
  (): RecorderApi => ({
    record: mockExpenseRecorderRecord,
    recordReceipt: mockExpenseRecorderRecordReceipt,
    pushToSheet: () => Promise.resolve(),
    deleteFromSheet: () => Promise.resolve({ deletedRowIndex: null }),
  }),
);
export const mockEmitForGroup = mock((_groupId: number, _eventType: SseEventType): void => {});
export const mockSubscribeGroup = mock(
  (_groupId: number, _send: (event: string) => void): (() => void) =>
    () => {},
);

// sharp mock: returns an object with chainable .resize().jpeg().toBuffer()
export const mockSharpToBuffer = mock(() => Promise.resolve(Buffer.from('compressed')));
export const mockSharpJpeg = mock(() => ({ toBuffer: mockSharpToBuffer }));
export const mockSharpResize = mock(() => ({ jpeg: mockSharpJpeg }));
export const mockSharp = mock((_input: Buffer) => ({ resize: mockSharpResize }));

// global fetch mock for Telegram sendDocument
export const mockFetch = mock(
  (_url: string, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { document: { file_id: 'tg_file_123' } } })),
    ),
);
// Bun's typeof fetch includes namespace.preconnect which a plain mock can't satisfy structurally
export const originalFetch = global.fetch;
export const originalBotToken = env.BOT_TOKEN;
export const originalMiniappUrl = env.MINIAPP_URL;
export const logMock = createMockLogger();

/**
 * Installs every global/env override and spyOn used by the Mini App API suites. Runs once at
 * import (so the handler sees the mocks) and again from each file's beforeAll: the harness module
 * is cached, so after one file's restoreTestGlobals() a later file in the same bun process would
 * otherwise run against the restored production dependencies.
 */
export function installTestMocks(): void {
  global.fetch = mockFetch as unknown as typeof fetch;

  // Override env properties directly instead of mock.module (which pollutes globally)
  (env as { BOT_TOKEN: string }).BOT_TOKEN = TEST_BOT_TOKEN;
  (env as { MINIAPP_URL: string }).MINIAPP_URL = CORS_ORIGIN;

  mock.module('sharp', () => ({ default: mockSharp }));

  // Use spyOn instead of mock.module for all project modules.
  // mock.module pollutes Bun's global module cache, breaking unrelated tests.
  spyOn(database.users, 'findByTelegramId').mockImplementation(mockFindByTelegramId);
  spyOn(database.users, 'create').mockImplementation(mockUsersCreate);
  spyOn(database.users, 'update').mockImplementation(mockUsersUpdate);
  spyOn(database.groupMembers, 'isMember').mockImplementation(mockGroupMembersIsMember);
  spyOn(database.categories, 'findByGroupId').mockImplementation(mockCategoriesFindByGroupId);
  spyOn(database.groups, 'findById').mockImplementation(mockGroupsFindById);
  spyOn(database.groups, 'findByTelegramGroupId').mockImplementation(
    mockGroupsFindByTelegramGroupId,
  );
  // queryOne/queryAll are generic — TypeScript can't match a concrete mock to a generic signature,
  // so we widen the mock type to the erased method signature via `as typeof database.queryOne`.
  spyOn(database, 'queryOne').mockImplementation(mockDbQueryOne as typeof database.queryOne);
  spyOn(database, 'queryAll').mockImplementation(mockDbQueryAll as typeof database.queryAll);
  spyOn(database, 'exec').mockImplementation(mockDbExec);
  spyOn(database, 'transaction').mockImplementation(<T>(fn: () => T): T => fn());
  spyOn(receiptFetcherModule, 'fetchReceiptData').mockImplementation(mockFetchReceiptData);
  spyOn(receiptParserModule, 'parseReceipt').mockImplementation(mockParseReceipt);
  spyOn(ocrExtractorModule, 'extractTextFromImageBuffer').mockImplementation(
    mockExtractTextFromImageBuffer,
  );
  spyOn(expenseRecorderModule, 'getExpenseRecorder').mockImplementation(mockGetExpenseRecorder);
  spyOn(sseEmitterModule, 'emitForGroup').mockImplementation(mockEmitForGroup);
  spyOn(sseEmitterModule, 'subscribeGroup').mockImplementation(mockSubscribeGroup);
  spyOn(loggerModule, 'createLogger').mockImplementation(
    (_module: string) => logMock as unknown as ReturnType<typeof loggerModule.createLogger>,
  );
}

installTestMocks();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a valid Telegram initData string signed with TEST_BOT_TOKEN */
export function buildInitData(userId: number, ageSeconds = 0): string {
  const authDate = Math.floor(Date.now() / 1000) - ageSeconds;
  const user = JSON.stringify({ id: userId, first_name: 'Test' });
  const params = new URLSearchParams({
    auth_date: String(authDate),
    user,
  });

  // Sort entries and build data check string
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(TEST_BOT_TOKEN).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  params.set('hash', hash);
  return params.toString();
}

export function makeRequest(path: string, method = 'GET', initData?: string): Request {
  return new Request(`https://server${path}`, {
    method,
    headers: initData ? { 'X-Telegram-Init-Data': initData } : {},
  });
}

export function makePostRequest(path: string, body: unknown, initData?: string): Request {
  return new Request(`https://server${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
    },
    body: JSON.stringify(body),
  });
}

export const MOCK_USER = {
  id: 1,
  telegram_id: 42,
  group_id: 7,
  created_at: '2024-01-01',
  updated_at: '2024-01-01',
};

/** Restore global.fetch, env overrides, and spyOn mocks so they do not pollute other test files. */
export function restoreTestGlobals(): void {
  global.fetch = originalFetch;
  (env as { BOT_TOKEN: string }).BOT_TOKEN = originalBotToken;
  (env as { MINIAPP_URL: string | undefined }).MINIAPP_URL = originalMiniappUrl;
  mock.restore();
}
