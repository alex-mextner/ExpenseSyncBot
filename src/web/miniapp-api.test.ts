// Tests for Mini App API handler: routing envelope, CORS, HMAC validation and group membership

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { handleMiniAppRequest, validateAndResolveContext } from './miniapp-api.ts';
import {
  buildInitData,
  CORS_ORIGIN,
  installTestMocks,
  MOCK_USER,
  makeRequest,
  mockCategoriesFindByGroupId,
  mockDbQueryOne,
  mockExtractTextFromImageBuffer,
  mockFetch,
  mockFetchReceiptData,
  mockFindByTelegramId,
  mockGroupMembersIsMember,
  mockGroupsFindByTelegramGroupId,
  mockParseReceipt,
  mockUsersCreate,
  mockUsersUpdate,
  restoreTestGlobals,
  stubGroup,
} from './miniapp-api-test-harness.ts';

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

  test('valid initData + group exists + user absent → auto-creates user, returns ok', async () => {
    // First Mini App open before any message to the bot: HMAC is valid,
    // group is configured, user row doesn't exist yet.
    mockFindByTelegramId.mockImplementation(() => null);
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);

    const initData = buildInitData(42);
    const req = makeRequest('/api/test', 'GET', initData);
    const result = await validateAndResolveContext(req, CORS_ORIGIN, -1001234567);

    expect(result.ok).toBe(true);
    // User was auto-created with the correct telegram_id and group_id
    expect(mockUsersCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockUsersCreate.mock.calls[0]?.[0];
    expect(createArgs?.telegram_id).toBe(42);
    expect(createArgs?.group_id).toBe(7);
  });

  test('valid initData + group not configured → 403 FORBIDDEN_GROUP', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockGroupsFindByTelegramGroupId.mockReturnValue(null); // group row missing
    const initData = buildInitData(42);
    const req = makeRequest('/api/test', 'GET', initData);
    const result = await validateAndResolveContext(req, CORS_ORIGIN, -1001234567);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as { code: string };
      expect(body.code).toBe('FORBIDDEN_GROUP');
    }
    // No user should be created when the group isn't configured
    expect(mockUsersCreate).not.toHaveBeenCalled();
  });

  test('valid initData + user in different group → updates group_id', async () => {
    // User exists but was previously linked to another group — Mini App auth
    // should silently migrate them to the current group (matches
    // message.handler / ensureUserInGroup behaviour).
    const otherGroupUser = { ...MOCK_USER, group_id: 99 };
    mockFindByTelegramId.mockImplementation(() => otherGroupUser);
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);

    const initData = buildInitData(42);
    const req = makeRequest('/api/test', 'GET', initData);
    const result = await validateAndResolveContext(req, CORS_ORIGIN, -1001234567);

    expect(result.ok).toBe(true);
    expect(mockUsersUpdate).toHaveBeenCalledTimes(1);
    expect(mockUsersUpdate.mock.calls[0]?.[1]).toEqual({ group_id: 7 });
    expect(mockUsersCreate).not.toHaveBeenCalled();
  });

  test('valid initData + group member → ok with resolved IDs', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
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

afterAll(restoreTestGlobals);
beforeAll(installTestMocks);
