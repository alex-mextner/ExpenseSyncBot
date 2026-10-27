// Tests for Mini App API: analytics, dashboard widgets and dashboard SSE events

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { handleMiniAppRequest } from './miniapp-api.ts';
import {
  buildInitData,
  CORS_ORIGIN,
  installTestMocks,
  MOCK_USER,
  makeRequest,
  mockDbExec,
  mockDbQueryAll,
  mockDbQueryOne,
  mockFindByTelegramId,
  mockGroupMembersIsMember,
  mockGroupsFindById,
  mockGroupsFindByTelegramGroupId,
  mockSubscribeGroup,
  mockUsersCreate,
  mockUsersUpdate,
  restoreTestGlobals,
  stubGroup,
} from './miniapp-api-test-harness.ts';

describe('GET /api/analytics', () => {
  const GROUP_ID = -1001234567;

  beforeEach(() => {
    mockFindByTelegramId.mockReset();
    mockDbQueryOne.mockReset();
    mockGroupsFindByTelegramGroupId.mockReset();
    mockUsersCreate.mockClear();
    mockUsersUpdate.mockClear();
    mockGroupMembersIsMember.mockReset().mockReturnValue(false);
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
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
    mockGroupsFindByTelegramGroupId.mockReset();
    mockUsersCreate.mockClear();
    mockUsersUpdate.mockClear();
    mockGroupMembersIsMember.mockReset().mockReturnValue(false);
  });

  test('auth failure → 401', async () => {
    const req = makeRequest(`/api/dashboard?groupId=${GROUP_ID}`);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(401);
  });

  test('no saved config → 200 { widgets: [], updatedAt: null }', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);

    // dashboard query returns null — no existing row
    mockDbQueryOne.mockImplementation(() => null);

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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);

    mockDbQueryOne.mockImplementation(() => ({
      config: '[{"id":"w1"}]',
      updated_at: '2025-03-01T00:00:00.000Z',
    }));

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
    mockGroupsFindByTelegramGroupId.mockReset();
    mockUsersCreate.mockClear();
    mockUsersUpdate.mockClear();
    mockGroupMembersIsMember.mockReset().mockReturnValue(false);
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    mockDbQueryOne.mockImplementation(() => null); // no existing dashboard row

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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    mockDbQueryOne.mockImplementation(
      () => ({ updated_at: '2025-01-01T00:00:00.000Z' }), // existing row with different timestamp
    );

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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);

    const storedUpdatedAt = '2025-01-01T00:00:00.000Z';
    mockDbQueryOne.mockImplementation(() => ({ updated_at: storedUpdatedAt }));

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
    mockGroupsFindByTelegramGroupId.mockReset();
    mockUsersCreate.mockClear();
    mockUsersUpdate.mockClear();
    mockGroupMembersIsMember.mockReset().mockReturnValue(false);
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
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);

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

afterAll(restoreTestGlobals);
beforeAll(installTestMocks);
