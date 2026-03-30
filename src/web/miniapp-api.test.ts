// Tests for Mini App API handler: HMAC validation, group membership, routing, CORS
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { AIExtractionResult } from '../services/receipt/ai-extractor.ts';

const TEST_BOT_TOKEN = 'test_bot_token_12345';
const CORS_ORIGIN = 'https://app.example.com';

// ── Mocks (must be declared before importing the module under test) ───────────

const mockFindByTelegramId = mock(
  (_id: number) =>
    null as {
      id: number;
      telegram_id: number;
      group_id: number | null;
      created_at: string;
      updated_at: string;
    } | null,
);
const mockDbQueryGet = mock(
  (_params: { groupId: number; userId: number }) => null as { id: number } | null,
);
const mockCategoriesFindByGroupId = mock((_groupId: number) => [] as { name: string }[]);
const mockFetchReceiptData = mock((_qrData: string) => Promise.resolve('') as Promise<string>);
const mockExtractExpensesFromReceipt = mock(
  (_data: string, _categories: string[]): Promise<AIExtractionResult> =>
    Promise.resolve({ items: [] }),
);

mock.module('../config/env.ts', () => ({
  env: {
    BOT_TOKEN: TEST_BOT_TOKEN,
    MINIAPP_URL: CORS_ORIGIN,
  },
}));

mock.module('../database/index.ts', () => ({
  database: {
    users: {
      findByTelegramId: mockFindByTelegramId,
    },
    categories: {
      findByGroupId: mockCategoriesFindByGroupId,
    },
    db: {
      query: (_sql: string) => ({
        get: mockDbQueryGet,
      }),
    },
  },
}));

mock.module('../services/receipt/receipt-fetcher.ts', () => ({
  fetchReceiptData: mockFetchReceiptData,
}));

mock.module('../services/receipt/ai-extractor.ts', () => ({
  extractExpensesFromReceipt: mockExtractExpensesFromReceipt,
}));

mock.module('../utils/logger.ts', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

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
    mockDbQueryGet.mockReset();
    mockCategoriesFindByGroupId.mockReset();
    mockFetchReceiptData.mockReset();
    mockExtractExpensesFromReceipt.mockReset();
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
    const initData = buildInitData(42, 400); // 400 seconds ago > 300 limit
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
    mockDbQueryGet.mockImplementation(() => null);
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
    mockDbQueryGet.mockImplementation(() => ({ id: 7 }));
    const initData = buildInitData(42);
    const req = makeRequest('/api/test', 'GET', initData);
    const result = await validateAndResolveContext(req, CORS_ORIGIN, -1001234567);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe(42);
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
    mockDbQueryGet.mockReset();
    mockCategoriesFindByGroupId.mockReset();
    mockFetchReceiptData.mockReset();
    mockExtractExpensesFromReceipt.mockReset();
  });

  test('missing qrData → 400 BAD_REQUEST', async () => {
    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, {}, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
  });

  test('empty qrData string → 400 BAD_REQUEST', async () => {
    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, { qrData: '   ' }, initData);
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
    const req = makePostRequest(SCAN_PATH, { qrData: 'https://receipt.example.com' });
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(401);
  });

  test('fetchReceiptData failure → 500 SCAN_FAILED', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryGet.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => []);
    mockFetchReceiptData.mockImplementation(() => Promise.reject(new Error('Network error')));

    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, { qrData: 'https://receipt.example.com' }, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('SCAN_FAILED');
    expect(body.error).toBe('Network error');
  });

  test('extractExpensesFromReceipt failure → 500 SCAN_FAILED', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryGet.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => []);
    mockFetchReceiptData.mockImplementation(() => Promise.resolve('<html>receipt</html>'));
    mockExtractExpensesFromReceipt.mockImplementation(() =>
      Promise.reject(new Error('AI extraction failed')),
    );

    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, { qrData: 'https://receipt.example.com' }, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('SCAN_FAILED');
  });

  test('successful scan → 200 with mapped items and currency', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryGet.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => [
      { name: 'Продукты' },
      { name: 'Разное' },
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
    const req = makePostRequest(SCAN_PATH, { qrData: 'https://receipt.example.com' }, initData);
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
    mockDbQueryGet.mockImplementation(() => ({ id: 7 }));
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
    const req = makePostRequest(SCAN_PATH, { qrData: 'https://receipt.example.com' }, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; currency?: string };
    expect(body.currency).toBeUndefined();
    expect(body.items).toHaveLength(1);
  });

  test('categories are loaded from DB and passed to extractor', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockDbQueryGet.mockImplementation(() => ({ id: 7 }));
    mockCategoriesFindByGroupId.mockImplementation(() => [{ name: 'Еда' }, { name: 'Транспорт' }]);
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
    const req = makePostRequest(SCAN_PATH, { qrData: 'https://receipt.example.com' }, initData);
    await handleMiniAppRequest(req, CORS_ORIGIN);

    expect(mockCategoriesFindByGroupId.mock.calls.length).toBe(1);
    expect(mockCategoriesFindByGroupId.mock.calls[0]?.[0]).toBe(7); // internalGroupId
    expect(mockExtractExpensesFromReceipt.mock.calls[0]?.[1]).toEqual(['Еда', 'Транспорт']);
  });
});
