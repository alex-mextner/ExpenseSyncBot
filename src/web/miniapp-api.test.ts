// Tests for Mini App API handler: HMAC validation, group membership, routing, CORS

import type { SQLQueryBindings } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { env } from '../config/env.ts';
import { database } from '../database/index.ts';
import type { Category, Group, User } from '../database/types.ts';
import type {
  RecordExpenseData,
  RecordExpenseResult,
  RecorderApi,
} from '../services/expense-recorder.ts';
import * as expenseRecorderModule from '../services/expense-recorder.ts';
import type { AIExtractionResult, CategoryExample } from '../services/receipt/ai-extractor.ts';
import * as aiExtractorModule from '../services/receipt/ai-extractor.ts';
import * as ocrExtractorModule from '../services/receipt/ocr-extractor.ts';
import type { BrowserLike } from '../services/receipt/receipt-fetcher.ts';
import * as receiptFetcherModule from '../services/receipt/receipt-fetcher.ts';
import { createMockLogger } from '../test-utils/mocks/logger';
import * as loggerModule from '../utils/logger.ts';
import type { SseEventType } from './sse-emitter.ts';
import * as sseEmitterModule from './sse-emitter.ts';

const TEST_BOT_TOKEN = 'test_bot_token_12345';
const CORS_ORIGIN = 'https://app.example.com';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Build a full Expense stub with sensible defaults, overriding only what the test cares about */
function stubExpense(
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
    created_at: '2024-01-15',
    ...overrides,
  };
}

/** Build a full Category stub — tests only care about `name` */
function stubCategory(name: string, overrides?: Partial<Category>): Category {
  return { id: 1, group_id: 7, name, created_at: '2024-01-01', ...overrides };
}

/** Build a full Group stub */
function stubGroup(overrides?: Partial<Group>): Group {
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
    oauth_client: 'current',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
    ...overrides,
  };
}

// ── Mocks (must be declared before importing the module under test) ───────────

const mockFindByTelegramId = mock((_id: number): User | null => null);
// Generic queryOne/queryAll — spyOn preserves the generic type parameter, but
// mockImplementation() can't accept a non-generic function. We define concrete
// function types matching the erased signature so mocks type-check at call sites.
// Union covers all row shapes returned across the different query calls in tests.
type MockDbRow =
  | { id: number }
  | { config: string; updated_at: string }
  | { updated_at: string }
  | null;
type QueryOneFn = (sql: string, ...params: SQLQueryBindings[]) => MockDbRow;
type QueryAllFn = (sql: string, ...params: SQLQueryBindings[]) => unknown[];
const mockDbQueryOne = mock<QueryOneFn>((_sql, ..._params) => null);
const mockDbQueryAll = mock<QueryAllFn>((_sql, ..._params) => []);
// Generic exec mock — used by UPDATE/INSERT statements
const mockDbExec = mock((_sql: string, ..._params: SQLQueryBindings[]): void => {});
const mockCategoriesFindByGroupId = mock((_groupId: number): Category[] => []);
const mockGroupsFindById = mock((_id: number): Group | null => null);
const mockFetchReceiptData = mock(
  (_qrData: string, _getBrowserFn?: () => Promise<BrowserLike>): Promise<string> =>
    Promise.resolve(''),
);
const mockExtractExpensesFromReceipt = mock(
  (
    _data: string,
    _categories: string[],
    _categoryExamples?: Map<string, CategoryExample[]>,
    _maxRetries?: number,
  ): Promise<AIExtractionResult> => Promise.resolve({ items: [] }),
);
const mockExtractTextFromImageBuffer = mock(
  (_buf: Buffer): Promise<string> => Promise.resolve('OCR text'),
);
const mockExpenseRecorderRecord = mock(
  (_groupId: number, _userId: number, _data: RecordExpenseData): Promise<RecordExpenseResult> =>
    Promise.resolve({ expense: stubExpense({ id: 99 }), eurAmount: 10 }),
);
const mockGetExpenseRecorder = mock(
  (): RecorderApi => ({
    record: mockExpenseRecorderRecord,
    recordBatch: () => Promise.resolve([]),
    pushToSheet: () => Promise.resolve(),
  }),
);
const mockEmitForGroup = mock((_groupId: number, _eventType: SseEventType): void => {});
const mockSubscribeGroup = mock(
  (_groupId: number, _send: (event: string) => void): (() => void) =>
    () => {},
);

// sharp mock: returns an object with chainable .resize().jpeg().toBuffer()
const mockSharpToBuffer = mock(() => Promise.resolve(Buffer.from('compressed')));
const mockSharpJpeg = mock(() => ({ toBuffer: mockSharpToBuffer }));
const mockSharpResize = mock(() => ({ jpeg: mockSharpJpeg }));
const mockSharp = mock((_input: Buffer) => ({ resize: mockSharpResize }));

// global fetch mock for Telegram sendDocument
const mockFetch = mock(
  (_url: string, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { document: { file_id: 'tg_file_123' } } })),
    ),
);
// Bun's typeof fetch includes namespace.preconnect which a plain mock can't satisfy structurally
const originalFetch = global.fetch;
global.fetch = mockFetch as unknown as typeof fetch;

// Override env properties directly instead of mock.module (which pollutes globally)
const originalBotToken = env.BOT_TOKEN;
const originalMiniappUrl = env.MINIAPP_URL;
(env as { BOT_TOKEN: string }).BOT_TOKEN = TEST_BOT_TOKEN;
(env as { MINIAPP_URL: string }).MINIAPP_URL = CORS_ORIGIN;

mock.module('sharp', () => ({ default: mockSharp }));

// Use spyOn instead of mock.module for all project modules.
// mock.module pollutes Bun's global module cache, breaking unrelated tests.
spyOn(database.users, 'findByTelegramId').mockImplementation(mockFindByTelegramId);
spyOn(database.categories, 'findByGroupId').mockImplementation(mockCategoriesFindByGroupId);
spyOn(database.groups, 'findById').mockImplementation(mockGroupsFindById);
// queryOne/queryAll are generic — TypeScript can't match a concrete mock to a generic signature,
// so we widen the mock type to the erased method signature via `as typeof database.queryOne`.
spyOn(database, 'queryOne').mockImplementation(mockDbQueryOne as typeof database.queryOne);
spyOn(database, 'queryAll').mockImplementation(mockDbQueryAll as typeof database.queryAll);
spyOn(database, 'exec').mockImplementation(mockDbExec);
spyOn(database, 'transaction').mockImplementation(<T>(fn: () => T): T => fn());
spyOn(receiptFetcherModule, 'fetchReceiptData').mockImplementation(mockFetchReceiptData);
spyOn(aiExtractorModule, 'extractExpensesFromReceipt').mockImplementation(
  mockExtractExpensesFromReceipt,
);
spyOn(ocrExtractorModule, 'extractTextFromImageBuffer').mockImplementation(
  mockExtractTextFromImageBuffer,
);
spyOn(expenseRecorderModule, 'getExpenseRecorder').mockImplementation(mockGetExpenseRecorder);
spyOn(sseEmitterModule, 'emitForGroup').mockImplementation(mockEmitForGroup);
spyOn(sseEmitterModule, 'subscribeGroup').mockImplementation(mockSubscribeGroup);
const logMock = createMockLogger();
spyOn(loggerModule, 'createLogger').mockImplementation(
  (_module: string) => logMock as unknown as ReturnType<typeof loggerModule.createLogger>,
);

// Import after mocks are set up
import { handleMiniAppRequest, validateAndResolveContext } from './miniapp-api.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a valid Telegram initData string signed with TEST_BOT_TOKEN */
function buildInitData(userId: number, ageSeconds = 0): string {
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

function makeRequest(path: string, method = 'GET', initData?: string): Request {
  return new Request(`https://server${path}`, {
    method,
    headers: initData ? { 'X-Telegram-Init-Data': initData } : {},
  });
}

function makePostRequest(path: string, body: unknown, initData?: string): Request {
  return new Request(`https://server${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
    },
    body: JSON.stringify(body),
  });
}

const MOCK_USER = {
  id: 1,
  telegram_id: 42,
  group_id: 7,
  created_at: '2024-01-01',
  updated_at: '2024-01-01',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleMiniAppRequest — non-API paths', () => {
  test('returns null for /', async () => {
    const result = await handleMiniAppRequest(makeRequest('/'), CORS_ORIGIN);
    expect(result).toBeNull();
  });

  test('returns null for /callback', async () => {
    const result = await handleMiniAppRequest(makeRequest('/callback'), CORS_ORIGIN);
    expect(result).toBeNull();
  });

  test('returns null for /health', async () => {
    const result = await handleMiniAppRequest(makeRequest('/health'), CORS_ORIGIN);
    expect(result).toBeNull();
  });

  test('does not throw on relative/malformed URL (port-scanner regression)', async () => {
    // Bun hands us a relative URL for some HTTP/0.9 or malformed probes.
    // new URL(req.url) without a base would throw TypeError and crash the
    // process. The defensive parser wraps it with a base fallback.
    const fake = { url: '/', method: 'GET', headers: new Headers() } as unknown as Request;
    const result = await handleMiniAppRequest(fake, CORS_ORIGIN);
    expect(result).toBeNull();
  });

  test('returns null for unparseable URL input', async () => {
    const fake = { url: '', method: 'GET', headers: new Headers() } as unknown as Request;
    const result = await handleMiniAppRequest(fake, CORS_ORIGIN);
    expect(result).toBeNull();
  });
});

describe('handleMiniAppRequest — OPTIONS preflight', () => {
  test('returns 204 with CORS headers', async () => {
    const res = await handleMiniAppRequest(makeRequest('/api/something', 'OPTIONS'), CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CORS_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Telegram-Init-Data');
  });
});

describe('handleMiniAppRequest — unknown /api/* route', () => {
  test('returns 404 NOT_FOUND with CORS headers', async () => {
    const res = await handleMiniAppRequest(makeRequest('/api/unknown'), CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CORS_ORIGIN);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });
});

describe('validateAndResolveContext — HMAC validation', () => {
  beforeEach(() => {
    mockFindByTelegramId.mockReset();
    mockDbQueryOne.mockReset();
    mockCategoriesFindByGroupId.mockReset();
    mockFetchReceiptData.mockReset();
    mockExtractExpensesFromReceipt.mockReset();
    mockExtractTextFromImageBuffer.mockReset();
    mockFetch.mockReset();
  });

  test('missing header → 401 INVALID_INIT_DATA', async () => {
    const req = makeRequest('/api/test');
    const result = await validateAndResolveContext(req, CORS_ORIGIN, -1001234567);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = (await result.response.json()) as { code: string };
      expect(body.code).toBe('INVALID_INIT_DATA');
    }
  });

  test('wrong hash → 401 INVALID_INIT_DATA', async () => {
    const req = new Request('https://server/api/test', {
      headers: {
        'X-Telegram-Init-Data': 'auth_date=9999999999&user=%7B%22id%22%3A42%7D&hash=badhash',
      },
    });
    const result = await validateAndResolveContext(req, CORS_ORIGIN, -1001234567);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = (await result.response.json()) as { code: string };
      expect(body.code).toBe('INVALID_INIT_DATA');
    }
  });

  test('expired auth_date → 401 INIT_DATA_EXPIRED', async () => {
    const initData = buildInitData(42, 3700); // 3700 seconds ago > 3600 limit
    const req = makeRequest('/api/test', 'GET', initData);
    const result = await validateAndResolveContext(req, CORS_ORIGIN, -1001234567);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = (await result.response.json()) as { code: string };
      expect(body.code).toBe('INIT_DATA_EXPIRED');
    }
  });

  test('valid initData but user not in DB → 401', async () => {
    mockFindByTelegramId.mockImplementation(() => null);
    const initData = buildInitData(42);
    const req = makeRequest('/api/test', 'GET', initData);
    const result = await validateAndResolveContext(req, CORS_ORIGIN, -1001234567);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test('valid initData + known user but not group member → 403 FORBIDDEN_GROUP', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => null);
    const initData = buildInitData(42);
    const req = makeRequest('/api/test', 'GET', initData);
    const result = await validateAndResolveContext(req, CORS_ORIGIN, -1001234567);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as { code: string };
      expect(body.code).toBe('FORBIDDEN_GROUP');
    }
  });

  test('valid initData + group member → ok with resolved IDs', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    const initData = buildInitData(42);
    const req = makeRequest('/api/test', 'GET', initData);
    const result = await validateAndResolveContext(req, CORS_ORIGIN, -1001234567);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe(42);
      expect(result.internalUserId).toBe(MOCK_USER.id); // internal DB id, not telegram id
      expect(result.groupId).toBe(-1001234567);
      expect(result.internalGroupId).toBe(7);
      expect(result.corsHeaders['Access-Control-Allow-Origin']).toBe(CORS_ORIGIN);
    }
  });
});

describe('POST /api/receipt/scan', () => {
  const GROUP_ID = -1001234567;
  const SCAN_PATH = `/api/receipt/scan?groupId=${GROUP_ID}`;

  beforeEach(() => {
    mockFindByTelegramId.mockReset();
    mockDbQueryOne.mockReset();
    mockCategoriesFindByGroupId.mockReset();
    mockFetchReceiptData.mockReset();
    mockExtractExpensesFromReceipt.mockReset();
    mockExtractTextFromImageBuffer.mockReset();
    mockFetch.mockReset();
  });

  test('missing qr → 400 BAD_REQUEST', async () => {
    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, {}, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
  });

  test('empty qr string → 400 BAD_REQUEST', async () => {
    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, { qr: '   ' }, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
  });

  test('invalid JSON body → 400 BAD_REQUEST', async () => {
    const initData = buildInitData(42);
    const req = new Request(`https://server${SCAN_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: 'not json at all',
    });
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
  });

  test('auth failure propagates → 401', async () => {
    // No auth header — body validation happens before auth
    mockFindByTelegramId.mockImplementation(() => null);
    const req = makePostRequest(SCAN_PATH, { qr: 'https://receipt.example.com' });
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(401);
  });

  test('fetchReceiptData failure → 500 SCAN_FAILED', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => []);
    mockFetchReceiptData.mockImplementation(() => Promise.reject(new Error('Network error')));

    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, { qr: 'https://receipt.example.com' }, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('SCAN_FAILED');
    expect(body.error).toBe('Receipt scan failed');
  });

  test('extractExpensesFromReceipt failure → 500 SCAN_FAILED', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => []);
    mockFetchReceiptData.mockImplementation(() => Promise.resolve('<html>receipt</html>'));
    mockExtractExpensesFromReceipt.mockImplementation(() =>
      Promise.reject(new Error('AI extraction failed')),
    );

    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, { qr: 'https://receipt.example.com' }, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SCAN_FAILED');
  });

  test('successful scan → 200 with mapped items and currency', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => [
      stubCategory('Продукты'),
      stubCategory('Разное'),
    ]);
    mockFetchReceiptData.mockImplementation(() => Promise.resolve('<html>receipt</html>'));
    mockExtractExpensesFromReceipt.mockImplementation(() =>
      Promise.resolve({
        items: [
          {
            name_ru: 'Молоко 3.2%',
            quantity: 2,
            price: 85.5,
            total: 171.0,
            category: 'Продукты',
            possible_categories: ['Разное'],
          },
        ],
        currency: 'RSD',
      }),
    );

    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, { qr: 'https://receipt.example.com' }, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CORS_ORIGIN);

    const body = (await res.json()) as {
      items: { name: string; qty: number; price: number; total: number; category: string }[];
      currency?: string;
    };
    expect(body.currency).toBe('RSD');
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item).toBeDefined();
    if (item) {
      expect(item.name).toBe('Молоко 3.2%');
      expect(item.qty).toBe(2);
      expect(item.price).toBe(85.5);
      expect(item.total).toBe(171.0);
      expect(item.category).toBe('Продукты');
      // possible_categories must not be present in the response
      expect(Object.keys(item)).not.toContain('possible_categories');
    }
  });

  test('successful scan without currency → 200 without currency field', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => []);
    mockFetchReceiptData.mockImplementation(() => Promise.resolve('<html>receipt</html>'));
    mockExtractExpensesFromReceipt.mockImplementation(() =>
      Promise.resolve({
        items: [
          {
            name_ru: 'Хлеб',
            quantity: 1,
            price: 50.0,
            total: 50.0,
            category: 'Разное',
            possible_categories: [],
          },
        ],
      }),
    );

    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, { qr: 'https://receipt.example.com' }, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; currency?: string };
    expect(body.currency).toBeUndefined();
    expect(body.items).toHaveLength(1);
  });

  test('categories are loaded from DB and passed to extractor', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => [
      stubCategory('Еда'),
      stubCategory('Транспорт'),
    ]);
    mockFetchReceiptData.mockImplementation(() => Promise.resolve('<html>receipt</html>'));
    mockExtractExpensesFromReceipt.mockImplementation(() =>
      Promise.resolve({
        items: [
          {
            name_ru: 'Товар',
            quantity: 1,
            price: 10,
            total: 10,
            category: 'Еда',
            possible_categories: [],
          },
        ],
        currency: 'EUR',
      }),
    );

    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, { qr: 'https://receipt.example.com' }, initData);
    await handleMiniAppRequest(req, CORS_ORIGIN);

    expect(mockCategoriesFindByGroupId.mock.calls.length).toBe(1);
    expect(mockCategoriesFindByGroupId.mock.calls[0]?.[0]).toBe(7); // internalGroupId
    expect(mockExtractExpensesFromReceipt.mock.calls[0]?.[1]).toEqual(['Еда', 'Транспорт']);
  });
});

// ── Helpers for OCR tests ─────────────────────────────────────────────────────

/** Build a multipart request with an image field */
function makeOcrRequest(path: string, hasImage: boolean, initData?: string): Request {
  const formData = new FormData();
  if (hasImage) {
    formData.append(
      'image',
      new Blob([Buffer.from('fake-jpeg')], { type: 'image/jpeg' }),
      'receipt.jpg',
    );
  }
  return new Request(`https://server${path}`, {
    method: 'POST',
    headers: initData ? { 'X-Telegram-Init-Data': initData } : {},
    body: formData,
  });
}

describe('POST /api/receipt/ocr', () => {
  const GROUP_ID = -1001234567;
  const OCR_PATH = `/api/receipt/ocr?groupId=${GROUP_ID}`;

  beforeEach(() => {
    mockFindByTelegramId.mockReset();
    mockDbQueryOne.mockReset();
    mockCategoriesFindByGroupId.mockReset();
    mockExtractExpensesFromReceipt.mockReset();
    mockExtractTextFromImageBuffer.mockReset();
    mockSharpToBuffer.mockReset();
    mockFetch.mockReset();

    // Default sharp chain returns compressed buffer
    mockSharpToBuffer.mockImplementation(() => Promise.resolve(Buffer.from('compressed')));
    mockSharpJpeg.mockImplementation(() => ({ toBuffer: mockSharpToBuffer }));
    mockSharpResize.mockImplementation(() => ({ jpeg: mockSharpJpeg }));
    mockSharp.mockImplementation((_input: Buffer) => ({ resize: mockSharpResize }));
  });

  test('missing image field → 400 BAD_REQUEST', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 })); // membership check
    const initData = buildInitData(42);
    const req = makeOcrRequest(OCR_PATH, false, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
  });

  test('auth failure → 401', async () => {
    // No initData header
    const req = makeOcrRequest(OCR_PATH, true);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(401);
  });

  test('wrong MIME type → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 })); // membership check
    const initData = buildInitData(42);
    const formData = new FormData();
    formData.append(
      'image',
      new Blob([Buffer.from('fake-png')], { type: 'image/png' }),
      'receipt.png',
    );
    const req = new Request(`https://server${OCR_PATH}`, {
      method: 'POST',
      headers: { 'X-Telegram-Init-Data': initData },
      body: formData,
    });
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(415);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  test('image exceeds 2 MB → 413 PAYLOAD_TOO_LARGE', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 })); // membership check
    const initData = buildInitData(42);
    const bigBuffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const formData = new FormData();
    formData.append('image', new Blob([bigBuffer], { type: 'image/jpeg' }), 'big.jpg');
    const req = new Request(`https://server${OCR_PATH}`, {
      method: 'POST',
      headers: { 'X-Telegram-Init-Data': initData },
      body: formData,
    });
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('OCR failure → 500 OCR_FAILED', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => []);
    mockExtractTextFromImageBuffer.mockImplementation(() =>
      Promise.reject(new Error('Qwen API down')),
    );

    const initData = buildInitData(42);
    const req = makeOcrRequest(OCR_PATH, true, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('OCR_FAILED');
    expect(body.error).toBe('OCR processing failed');
  });

  test('success → 200 with items and file_id', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => [stubCategory('Продукты')]);
    mockExtractTextFromImageBuffer.mockImplementation(() =>
      Promise.resolve('Store: TestMart\nMilk 2x85.50'),
    );
    mockExtractExpensesFromReceipt.mockImplementation(() =>
      Promise.resolve({
        items: [
          {
            name_ru: 'Молоко',
            quantity: 2,
            price: 85.5,
            total: 171.0,
            category: 'Продукты',
            possible_categories: [],
          },
        ],
        currency: 'RSD',
      }),
    );
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, result: { document: { file_id: 'tg_file_abc' } } }),
        ),
      ),
    );

    const initData = buildInitData(42);
    const req = makeOcrRequest(OCR_PATH, true, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CORS_ORIGIN);

    const body = (await res.json()) as {
      items: { name: string; qty: number; price: number; total: number; category: string }[];
      currency?: string;
      file_id: string | null;
    };
    expect(body.file_id).toBe('tg_file_abc');
    expect(body.currency).toBe('RSD');
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    if (item) {
      expect(item.name).toBe('Молоко');
      expect(item.qty).toBe(2);
      expect(item.price).toBe(85.5);
      expect(item.total).toBe(171.0);
      expect(item.category).toBe('Продукты');
    }
  });

  test('success with Telegram upload failure → 200 with file_id: null', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => []);
    mockExtractTextFromImageBuffer.mockImplementation(() => Promise.resolve('some receipt text'));
    mockExtractExpensesFromReceipt.mockImplementation(() =>
      Promise.resolve({
        items: [
          {
            name_ru: 'Товар',
            quantity: 1,
            price: 10,
            total: 10,
            category: 'Разное',
            possible_categories: [],
          },
        ],
      }),
    );
    mockFetch.mockImplementation(() => Promise.reject(new Error('network error')));

    const initData = buildInitData(42);
    const req = makeOcrRequest(OCR_PATH, true, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { file_id: string | null; items: unknown[] };
    expect(body.file_id).toBeNull();
    expect(body.items).toHaveLength(1);
  });
});

// ── POST /api/receipt/confirm ─────────────────────────────────────────────────

describe('POST /api/receipt/confirm', () => {
  const GROUP_ID = -1001234567;
  const CONFIRM_PATH = '/api/receipt/confirm';

  beforeEach(() => {
    mockFindByTelegramId.mockReset();
    mockDbQueryOne.mockReset();
    mockDbExec.mockReset();
    mockGroupsFindById.mockReset();
    mockExpenseRecorderRecord.mockReset();
    mockEmitForGroup.mockReset();
  });

  test('missing expenses array → 400 BAD_REQUEST', async () => {
    const initData = buildInitData(42);
    const req = makePostRequest(CONFIRM_PATH, { groupId: GROUP_ID }, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
  });

  test('expense missing required field → 400 BAD_REQUEST', async () => {
    const initData = buildInitData(42);
    const req = makePostRequest(
      CONFIRM_PATH,
      { groupId: GROUP_ID, expenses: [{ name: 'Milk', total: 100 }] }, // missing category and currency
      initData,
    );
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
  });

  test('auth failure → 401', async () => {
    const req = makePostRequest(CONFIRM_PATH, {
      groupId: GROUP_ID,
      expenses: [{ name: 'Milk', total: 100, category: 'Food', currency: 'RSD' }],
    });
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(401);
  });

  test('success → 200 { created: N }', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockExpenseRecorderRecord.mockImplementation(() =>
      Promise.resolve({ expense: stubExpense({ id: 55 }), eurAmount: 8.5 }),
    );

    const initData = buildInitData(42);
    const req = makePostRequest(
      CONFIRM_PATH,
      {
        groupId: GROUP_ID,
        fileId: null,
        expenses: [
          { name: 'Milk', total: 171, category: 'Food', currency: 'RSD', date: '2025-03-15' },
          { name: 'Bread', total: 85, category: 'Food', currency: 'RSD' },
        ],
      },
      initData,
    );
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number };
    expect(body.created).toBe(2);
    expect(mockEmitForGroup.mock.calls.length).toBe(1);
    expect(mockEmitForGroup.mock.calls[0]?.[1]).toBe('expense_added');
  });

  test('recorder receives internal DB user id, not telegram id', async () => {
    // MOCK_USER.id = 1 (internal), telegram_id = 42
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockExpenseRecorderRecord.mockImplementation(() =>
      Promise.resolve({ expense: stubExpense({ id: 88 }), eurAmount: 5 }),
    );

    const initData = buildInitData(42);
    const req = makePostRequest(
      CONFIRM_PATH,
      {
        groupId: GROUP_ID,
        expenses: [{ name: 'Milk', total: 100, category: 'Food', currency: 'RSD' }],
      },
      initData,
    );
    await handleMiniAppRequest(req, CORS_ORIGIN);

    // Second arg to record() must be internal DB user id (1), not telegram id (42)
    expect(mockExpenseRecorderRecord.mock.calls[0]?.[1]).toBe(MOCK_USER.id);
    expect(mockExpenseRecorderRecord.mock.calls[0]?.[1]).not.toBe(42);
  });

  test('success with fileId → updates receipt_file_id in DB', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockExpenseRecorderRecord.mockImplementation(() =>
      Promise.resolve({ expense: stubExpense({ id: 77 }), eurAmount: 5 }),
    );

    const initData = buildInitData(42);
    const req = makePostRequest(
      CONFIRM_PATH,
      {
        groupId: GROUP_ID,
        fileId: 'tg_file_abc',
        expenses: [{ name: 'Apples', total: 50, category: 'Food', currency: 'RSD' }],
      },
      initData,
    );
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    // run() should have been called to set receipt_file_id
    expect(mockDbExec.mock.calls.length).toBeGreaterThan(0);
  });
});

// ── GET /api/analytics ────────────────────────────────────────────────────────

describe('GET /api/analytics', () => {
  const GROUP_ID = -1001234567;

  beforeEach(() => {
    mockFindByTelegramId.mockReset();
    mockDbQueryOne.mockReset();
    mockDbQueryAll.mockReset();
    mockGroupsFindById.mockReset();
  });

  test('auth failure → 401', async () => {
    const req = makeRequest(`/api/analytics?groupId=${GROUP_ID}`);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(401);
  });

  test('success → 200 with correct shape', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));
    mockGroupsFindById.mockImplementation(() => stubGroup({ telegram_group_id: GROUP_ID }));
    mockDbQueryAll.mockImplementation(() => [
      { category: 'Food', total: 100 },
      { category: 'Transport', total: 50 },
    ]);

    const initData = buildInitData(42);
    const req = makeRequest(`/api/analytics?groupId=${GROUP_ID}&period=2025-03`, 'GET', initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      period: string;
      defaultCurrency: string;
      income: number;
      expenses: number;
      balance: number;
      savings: number;
      byCategory: Record<string, number>;
    };
    expect(body.period).toBe('2025-03');
    expect(body.defaultCurrency).toBe('RSD');
    expect(body.income).toBe(0);
    expect(body.savings).toBe(0);
    expect(body.expenses).toBeGreaterThanOrEqual(0);
    expect(typeof body.byCategory).toBe('object');
    expect(body.byCategory['Food']).toBeDefined();
  });
});

// ── GET /api/dashboard ────────────────────────────────────────────────────────

describe('GET /api/dashboard', () => {
  const GROUP_ID = -1001234567;

  beforeEach(() => {
    mockFindByTelegramId.mockReset();
    mockDbQueryOne.mockReset();
  });

  test('auth failure → 401', async () => {
    const req = makeRequest(`/api/dashboard?groupId=${GROUP_ID}`);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(401);
  });

  test('no saved config → 200 { widgets: [], updatedAt: null }', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));

    // Second query call (dashboard) returns null — no existing row
    let callCount = 0;
    mockDbQueryOne.mockImplementation(() => {
      callCount++;
      // First call = membership check, second = dashboard query
      if (callCount === 1) return { id: 7 };
      return null;
    });

    const initData = buildInitData(42);
    const req = makeRequest(`/api/dashboard?groupId=${GROUP_ID}`, 'GET', initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { widgets: unknown[]; updatedAt: unknown };
    expect(body.widgets).toEqual([]);
    expect(body.updatedAt).toBeNull();
  });

  test('existing config → 200 with widgets and updatedAt', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);

    let callCount = 0;
    mockDbQueryOne.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { id: 7 }; // membership
      return { config: '[{"id":"w1"}]', updated_at: '2025-03-01T00:00:00.000Z' };
    });

    const initData = buildInitData(42);
    const req = makeRequest(`/api/dashboard?groupId=${GROUP_ID}`, 'GET', initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { widgets: unknown[]; updatedAt: string };
    expect(body.widgets).toHaveLength(1);
    expect(body.updatedAt).toBe('2025-03-01T00:00:00.000Z');
  });
});

// ── PUT /api/dashboard ────────────────────────────────────────────────────────

describe('PUT /api/dashboard', () => {
  const GROUP_ID = -1001234567;

  beforeEach(() => {
    mockFindByTelegramId.mockReset();
    mockDbQueryOne.mockReset();
    mockDbExec.mockReset();
  });

  test('auth failure → 401', async () => {
    const req = new Request('https://server/api/dashboard', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: GROUP_ID, widgets: [], updatedAt: null }),
    });
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(401);
  });

  test('success insert (no existing row) → 200 { ok: true, updatedAt }', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);

    let callCount = 0;
    mockDbQueryOne.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { id: 7 }; // membership
      return null; // no existing dashboard row
    });

    const initData = buildInitData(42);
    const req = new Request('https://server/api/dashboard', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
      body: JSON.stringify({ groupId: GROUP_ID, widgets: [{ id: 'w1' }], updatedAt: null }),
    });
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; updatedAt: string };
    expect(body.ok).toBe(true);
    expect(typeof body.updatedAt).toBe('string');
    expect(mockDbExec.mock.calls.length).toBe(1);
    // INSERT must use internal DB user id (1), not telegram id (42)
    const insertArgs = mockDbExec.mock.calls[0] as unknown[];
    expect(insertArgs).toContain(MOCK_USER.id);
    expect(insertArgs).not.toContain(42);
  });

  test('conflict when updatedAt mismatch → 409 CONFLICT', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);

    let callCount = 0;
    mockDbQueryOne.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { id: 7 }; // membership
      return { updated_at: '2025-01-01T00:00:00.000Z' }; // existing row with different timestamp
    });

    const initData = buildInitData(42);
    const req = new Request('https://server/api/dashboard', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
      body: JSON.stringify({
        groupId: GROUP_ID,
        widgets: [],
        updatedAt: '2025-02-01T00:00:00.000Z', // different from stored
      }),
    });
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('CONFLICT');
  });

  test('update success when updatedAt matches → 200', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);

    const storedUpdatedAt = '2025-01-01T00:00:00.000Z';
    let callCount = 0;
    mockDbQueryOne.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { id: 7 }; // membership
      return { updated_at: storedUpdatedAt };
    });

    const initData = buildInitData(42);
    const req = new Request('https://server/api/dashboard', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
      body: JSON.stringify({
        groupId: GROUP_ID,
        widgets: [{ id: 'w2' }],
        updatedAt: storedUpdatedAt,
      }),
    });
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    expect(mockDbExec.mock.calls.length).toBe(1);
  });
});

// ── GET /api/dashboard/events (SSE) ───────────────────────────────────────────

describe('GET /api/dashboard/events', () => {
  const GROUP_ID = -1001234567;

  beforeEach(() => {
    mockFindByTelegramId.mockReset();
    mockDbQueryOne.mockReset();
    mockSubscribeGroup.mockReset();
    mockSubscribeGroup.mockImplementation(() => () => {});
  });

  test('missing initData → 401', async () => {
    const req = makeRequest(`/api/dashboard/events?groupId=${GROUP_ID}`);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(401);
  });

  test('valid auth → 200 with text/event-stream Content-Type', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryOne.mockImplementation(() => ({ id: 7 }));

    const initData = buildInitData(42);
    const req = makeRequest(
      `/api/dashboard/events?groupId=${GROUP_ID}&initData=${encodeURIComponent(initData)}`,
    );
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CORS_ORIGIN);
  });
});

// Restore global.fetch, env overrides, and spyOn mocks so they don't pollute other test files
afterAll(() => {
  global.fetch = originalFetch;
  (env as { BOT_TOKEN: string }).BOT_TOKEN = originalBotToken;
  (env as { MINIAPP_URL: string | undefined }).MINIAPP_URL = originalMiniappUrl;
  mock.restore();
});
