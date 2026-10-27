// Tests for Mini App API receipt endpoints: POST /api/receipt/scan and /api/receipt/ocr

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { handleMiniAppRequest } from './miniapp-api.ts';
import {
  buildInitData,
  CORS_ORIGIN,
  installTestMocks,
  MOCK_USER,
  makePostRequest,
  mockCategoriesFindByGroupId,
  mockDbQueryOne,
  mockExtractTextFromImageBuffer,
  mockFetch,
  mockFetchReceiptData,
  mockFindByTelegramId,
  mockGroupMembersIsMember,
  mockGroupsFindByTelegramGroupId,
  mockParseReceipt,
  mockSharp,
  mockSharpJpeg,
  mockSharpResize,
  mockSharpToBuffer,
  mockUsersCreate,
  mockUsersUpdate,
  restoreTestGlobals,
  stubCategory,
  stubGroup,
  stubParseResult,
} from './miniapp-api-test-harness.ts';

describe('POST /api/receipt/scan', () => {
  const GROUP_ID = -1001234567;
  const SCAN_PATH = `/api/receipt/scan?groupId=${GROUP_ID}`;

  beforeEach(() => {
    mockFindByTelegramId.mockReset();
    mockDbQueryOne.mockReset();
    mockGroupsFindByTelegramGroupId.mockReset();
    mockUsersCreate.mockClear();
    mockUsersUpdate.mockClear();
    mockGroupMembersIsMember.mockReset().mockReturnValue(false);
    mockCategoriesFindByGroupId.mockReset();
    mockFetchReceiptData.mockReset();
    mockParseReceipt.mockReset();
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    mockCategoriesFindByGroupId.mockImplementation(() => []);
    mockFetchReceiptData.mockImplementation(() => Promise.resolve('<html>receipt</html>'));
    mockParseReceipt.mockImplementation(() => Promise.reject(new Error('AI extraction failed')));

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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    mockCategoriesFindByGroupId.mockImplementation(() => [
      stubCategory('Продукты'),
      stubCategory('Разное'),
    ]);
    mockFetchReceiptData.mockImplementation(() => Promise.resolve('<html>receipt</html>'));
    mockParseReceipt.mockImplementation(() =>
      Promise.resolve(
        stubParseResult({
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
      ),
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    mockCategoriesFindByGroupId.mockImplementation(() => []);
    mockFetchReceiptData.mockImplementation(() => Promise.resolve('<html>receipt</html>'));
    mockParseReceipt.mockImplementation(() =>
      Promise.resolve(
        stubParseResult({
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
      ),
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    mockCategoriesFindByGroupId.mockImplementation(() => [
      stubCategory('Еда'),
      stubCategory('Транспорт'),
    ]);
    mockFetchReceiptData.mockImplementation(() => Promise.resolve('<html>receipt</html>'));
    mockParseReceipt.mockImplementation(() =>
      Promise.resolve(
        stubParseResult({
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
      ),
    );

    const initData = buildInitData(42);
    const req = makePostRequest(SCAN_PATH, { qr: 'https://receipt.example.com' }, initData);
    await handleMiniAppRequest(req, CORS_ORIGIN);

    expect(mockCategoriesFindByGroupId.mock.calls.length).toBe(1);
    expect(mockCategoriesFindByGroupId.mock.calls[0]?.[0]).toBe(7); // internalGroupId
    expect(mockParseReceipt.mock.calls[0]?.[1]).toEqual(['Еда', 'Транспорт']);
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
    mockGroupsFindByTelegramGroupId.mockReset();
    mockUsersCreate.mockClear();
    mockUsersUpdate.mockClear();
    mockGroupMembersIsMember.mockReset().mockReturnValue(false);
    mockCategoriesFindByGroupId.mockReset();
    mockParseReceipt.mockReset();
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true); // membership check
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true); // membership check
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true); // membership check
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    mockCategoriesFindByGroupId.mockImplementation(() => [stubCategory('Продукты')]);
    mockExtractTextFromImageBuffer.mockImplementation(() =>
      Promise.resolve('Store: TestMart\nMilk 2x85.50'),
    );
    mockParseReceipt.mockImplementation(() =>
      Promise.resolve(
        stubParseResult({
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
      ),
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    mockCategoriesFindByGroupId.mockImplementation(() => []);
    mockExtractTextFromImageBuffer.mockImplementation(() => Promise.resolve('some receipt text'));
    mockParseReceipt.mockImplementation(() =>
      Promise.resolve(
        stubParseResult({
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
      ),
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

afterAll(restoreTestGlobals);
beforeAll(installTestMocks);
