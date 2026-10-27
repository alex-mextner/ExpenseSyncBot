// Tests for Mini App API: POST /api/receipt/confirm

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { handleMiniAppRequest } from './miniapp-api.ts';
import {
  buildInitData,
  CORS_ORIGIN,
  installTestMocks,
  MOCK_USER,
  makePostRequest,
  mockDbExec,
  mockDbQueryOne,
  mockEmitForGroup,
  mockExpenseRecorderRecord,
  mockExpenseRecorderRecordReceipt,
  mockFindByTelegramId,
  mockGroupMembersIsMember,
  mockGroupsFindById,
  mockGroupsFindByTelegramGroupId,
  mockUsersCreate,
  mockUsersUpdate,
  restoreTestGlobals,
  stubExpense,
  stubGroup,
} from './miniapp-api-test-harness.ts';

describe('POST /api/receipt/confirm', () => {
  const GROUP_ID = -1001234567;
  const CONFIRM_PATH = '/api/receipt/confirm';

  beforeEach(() => {
    mockFindByTelegramId.mockReset();
    mockDbQueryOne.mockReset();
    mockGroupsFindByTelegramGroupId.mockReset();
    mockUsersCreate.mockClear();
    mockUsersUpdate.mockClear();
    mockGroupMembersIsMember.mockReset().mockReturnValue(false);
    mockDbExec.mockReset();
    mockGroupsFindById.mockReset();
    mockExpenseRecorderRecord.mockReset();
    mockExpenseRecorderRecordReceipt.mockReset();
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

  test('success → 200 { created: N } with one expense per unique category', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    // Both items are Food → recordReceipt groups them into one category expense
    mockExpenseRecorderRecordReceipt.mockImplementation(() =>
      Promise.resolve({
        expenses: [{ expense: stubExpense({ id: 55 }), eurAmount: 8.5 }],
        categoriesAffected: ['Food'],
      }),
    );

    const initData = buildInitData(42);
    const req = makePostRequest(
      CONFIRM_PATH,
      {
        groupId: GROUP_ID,
        fileId: null,
        date: '2025-03-15',
        expenses: [
          { name: 'Milk', qty: 1, price: 171, total: 171, category: 'Food', currency: 'RSD' },
          { name: 'Bread', qty: 1, price: 85, total: 85, category: 'Food', currency: 'RSD' },
        ],
      },
      initData,
    );
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response, got null');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number };
    // One category → one expense row in the sheet → `created: 1`
    expect(body.created).toBe(1);
    expect(mockEmitForGroup.mock.calls.length).toBe(1);
    expect(mockEmitForGroup.mock.calls[0]?.[1]).toBe('expense_added');

    // The receipt date from the request body is passed through
    const call = mockExpenseRecorderRecordReceipt.mock.calls[0];
    if (!call) throw new Error('recordReceipt not called');
    expect(call[2].date).toBe('2025-03-15');
    expect(call[2].items).toHaveLength(2);
  });

  test('recordReceipt receives internal DB user id, not telegram id', async () => {
    // MOCK_USER.id = 1 (internal), telegram_id = 42
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    mockExpenseRecorderRecordReceipt.mockImplementation(() =>
      Promise.resolve({
        expenses: [{ expense: stubExpense({ id: 88 }), eurAmount: 5 }],
        categoriesAffected: ['Food'],
      }),
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

    // Second arg to recordReceipt() must be internal DB user id (1), not telegram id (42)
    expect(mockExpenseRecorderRecordReceipt.mock.calls[0]?.[1]).toBe(MOCK_USER.id);
    expect(mockExpenseRecorderRecordReceipt.mock.calls[0]?.[1]).not.toBe(42);
  });

  test('passes fileId to recordReceipt as receiptFileId', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    mockExpenseRecorderRecordReceipt.mockImplementation(() =>
      Promise.resolve({
        expenses: [{ expense: stubExpense({ id: 77 }), eurAmount: 5 }],
        categoriesAffected: ['Food'],
      }),
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

    // recordReceipt was called once with receiptFileId in the payload
    const call = mockExpenseRecorderRecordReceipt.mock.calls[0];
    if (!call) throw new Error('recordReceipt not called');
    expect(call[2].receiptFileId).toBe('tg_file_abc');
  });

  test('70 items in one category → ONE recordReceipt call, ONE created (regression)', async () => {
    mockFindByTelegramId.mockImplementation(() => MOCK_USER);
    mockGroupsFindByTelegramGroupId.mockReturnValue(stubGroup({ id: 7 }));
    mockGroupMembersIsMember.mockReturnValue(true);
    mockExpenseRecorderRecordReceipt.mockImplementation(() =>
      Promise.resolve({
        expenses: [{ expense: stubExpense({ id: 100 }), eurAmount: 60 }],
        categoriesAffected: ['Продукты'],
      }),
    );

    const items = Array.from({ length: 70 }, (_, i) => ({
      name: `Item ${i}`,
      qty: 1,
      price: 100,
      total: 100,
      category: 'Продукты',
      currency: 'RSD',
    }));

    const initData = buildInitData(42);
    const req = makePostRequest(CONFIRM_PATH, { groupId: GROUP_ID, expenses: items }, initData);
    const res = await handleMiniAppRequest(req, CORS_ORIGIN);
    if (!res) throw new Error('expected Response');
    expect(res.status).toBe(200);

    // Exactly ONE recordReceipt call with 70 items in its payload
    expect(mockExpenseRecorderRecordReceipt).toHaveBeenCalledTimes(1);
    const call = mockExpenseRecorderRecordReceipt.mock.calls[0];
    if (!call) throw new Error('no call');
    expect(call[2].items).toHaveLength(70);

    // Response body reports 1 created expense (one category)
    const body = (await res.json()) as { created: number };
    expect(body.created).toBe(1);

    // The per-item record() path was NOT used
    expect(mockExpenseRecorderRecord).not.toHaveBeenCalled();
  });
});

// ── GET /api/analytics ────────────────────────────────────────────────────────

afterAll(restoreTestGlobals);
beforeAll(installTestMocks);
