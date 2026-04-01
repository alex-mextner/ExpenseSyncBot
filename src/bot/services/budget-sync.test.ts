// Tests for budget-sync — silentSyncBudgets, ensureFreshBudgets, syncBudgetsDiff, cache

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';

// ── Mock database ──

const mockGroups = {
  findById: mock(
    (): {
      id: number;
      google_refresh_token: string | null;
      spreadsheet_id: string;
      default_currency: CurrencyCode;
      enabled_currencies: CurrencyCode[];
      active_topic_id: number | null;
    } | null => ({
      id: 1,
      google_refresh_token: 'encrypted-token',
      spreadsheet_id: 'sheet-123',
      default_currency: 'EUR',
      enabled_currencies: ['EUR', 'RSD'],
      active_topic_id: null,
    }),
  ),
};

const mockGroupSpreadsheets = {
  getByYear: mock((_groupId: number, _year: number): string | null => 'sheet-123'),
};

const mockCategories = {
  exists: mock((_groupId: number, _name: string): boolean => true),
  create: mock((_data: { group_id: number; name: string }) => {}),
};

const mockBudgets = {
  findByGroupCategoryMonth: mock(
    (
      _groupId: number,
      _category: string,
      _month: string,
    ): {
      id: number;
      limit_amount: number;
      currency: string;
      category: string;
      month: string;
    } | null => null,
  ),
  setBudget: mock((_data: unknown) => {}),
  getAllBudgetsForMonth: mock(
    (
      _groupId: number,
      _month: string,
    ): Array<{
      id: number;
      category: string;
      limit_amount: number;
      currency: string;
      month: string;
    }> => [],
  ),
  delete: mock((_id: number) => {}),
};

const mockTransaction = mock(<T>(fn: () => T): T => fn());

mock.module('../../database', () => ({
  database: {
    groups: mockGroups,
    groupSpreadsheets: mockGroupSpreadsheets,
    categories: mockCategories,
    budgets: mockBudgets,
    transaction: mockTransaction,
  },
}));

// ── Mock sheets ──

const mockGoogleConn = mock(() => ({ auth: 'fake-auth' }));
const mockMonthTabExists = mock(async () => true);
const mockReadMonthBudget = mock(
  async (): Promise<Array<{ category: string; limit: number; currency: CurrencyCode }>> => [],
);

mock.module('../../services/google/sheets', () => ({
  googleConn: mockGoogleConn,
  monthTabExists: mockMonthTabExists,
  readMonthBudget: mockReadMonthBudget,
}));

// ── Mock telegram-sender ──

const mockSendMessage = mock(async () => ({ message_id: 1 }));
const mockWithChatContext = mock(
  async <T>(_chatId: number, _threadId: number | null, fn: () => T): Promise<T> => fn(),
);

mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: mockSendMessage,
  withChatContext: mockWithChatContext,
}));

// ── Import after mocks ──

import {
  ensureFreshBudgets,
  getBudgetSyncCachedResult,
  silentSyncBudgets,
  syncBudgetsDiff,
} from './budget-sync';

// ── Helpers ──

const TEST_GROUP_ID = 1;
const fakeConn = { auth: 'fake' } as never;

function resetAllMocks() {
  mockGroups.findById.mockClear();
  mockGroupSpreadsheets.getByYear.mockClear();
  mockCategories.exists.mockClear();
  mockCategories.create.mockClear();
  mockBudgets.findByGroupCategoryMonth.mockClear();
  mockBudgets.setBudget.mockClear();
  mockBudgets.getAllBudgetsForMonth.mockClear();
  mockBudgets.delete.mockClear();
  mockTransaction.mockClear();
  mockMonthTabExists.mockClear();
  mockReadMonthBudget.mockClear();
  mockGoogleConn.mockClear();
  mockSendMessage.mockClear();
  mockWithChatContext.mockClear();

  // Restore defaults
  mockGroups.findById.mockReturnValue({
    id: 1,
    google_refresh_token: 'encrypted-token',
    spreadsheet_id: 'sheet-123',
    default_currency: 'EUR' as CurrencyCode,
    enabled_currencies: ['EUR', 'RSD'] as CurrencyCode[],
    active_topic_id: null,
  });
  mockGroupSpreadsheets.getByYear.mockReturnValue('sheet-123');
  mockCategories.exists.mockReturnValue(true);
  mockMonthTabExists.mockResolvedValue(true);
  mockReadMonthBudget.mockResolvedValue([]);
  mockBudgets.findByGroupCategoryMonth.mockReturnValue(null);
  mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);
}

// ── Tests ──

describe('silentSyncBudgets', () => {
  beforeEach(resetAllMocks);

  it('returns 0 when no spreadsheet found', async () => {
    mockGroupSpreadsheets.getByYear.mockReturnValue(null);
    const result = await silentSyncBudgets(fakeConn, TEST_GROUP_ID);
    expect(result).toBe(0);
    expect(mockMonthTabExists).not.toHaveBeenCalled();
  });

  it('returns 0 when month tab does not exist', async () => {
    mockMonthTabExists.mockResolvedValue(false);
    const result = await silentSyncBudgets(fakeConn, TEST_GROUP_ID);
    expect(result).toBe(0);
    expect(mockReadMonthBudget).not.toHaveBeenCalled();
  });

  it('returns 0 when sheet has no budgets', async () => {
    mockReadMonthBudget.mockResolvedValue([]);
    const result = await silentSyncBudgets(fakeConn, TEST_GROUP_ID);
    expect(result).toBe(0);
    expect(mockBudgets.setBudget).not.toHaveBeenCalled();
  });

  it('syncs new budgets and creates missing categories', async () => {
    mockReadMonthBudget.mockResolvedValue([
      { category: 'Еда', limit: 500, currency: 'EUR' as CurrencyCode },
      { category: 'Транспорт', limit: 200, currency: 'EUR' as CurrencyCode },
    ]);
    mockCategories.exists.mockReturnValue(false);
    mockBudgets.findByGroupCategoryMonth.mockReturnValue(null);

    const result = await silentSyncBudgets(fakeConn, TEST_GROUP_ID);

    expect(result).toBe(2);
    expect(mockCategories.create).toHaveBeenCalledTimes(2);
    expect(mockBudgets.setBudget).toHaveBeenCalledTimes(2);
  });

  it('skips unchanged budgets', async () => {
    mockReadMonthBudget.mockResolvedValue([
      { category: 'Еда', limit: 500, currency: 'EUR' as CurrencyCode },
    ]);
    mockBudgets.findByGroupCategoryMonth.mockReturnValue({
      id: 1,
      limit_amount: 500,
      currency: 'EUR',
      category: 'Еда',
      month: '2026-03',
    });

    const result = await silentSyncBudgets(fakeConn, TEST_GROUP_ID);
    expect(result).toBe(0);
    expect(mockBudgets.setBudget).not.toHaveBeenCalled();
  });

  it('syncs changed budgets (limit changed)', async () => {
    mockReadMonthBudget.mockResolvedValue([
      { category: 'Еда', limit: 700, currency: 'EUR' as CurrencyCode },
    ]);
    mockBudgets.findByGroupCategoryMonth.mockReturnValue({
      id: 1,
      limit_amount: 500,
      currency: 'EUR',
      category: 'Еда',
      month: '2026-03',
    });

    const result = await silentSyncBudgets(fakeConn, TEST_GROUP_ID);
    expect(result).toBe(1);
    expect(mockBudgets.setBudget).toHaveBeenCalledTimes(1);
  });

  it('wraps writes in a transaction', async () => {
    mockReadMonthBudget.mockResolvedValue([
      { category: 'Еда', limit: 500, currency: 'EUR' as CurrencyCode },
    ]);

    await silentSyncBudgets(fakeConn, TEST_GROUP_ID);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns 0 and logs on error', async () => {
    mockGroupSpreadsheets.getByYear.mockImplementation(() => {
      throw new Error('DB error');
    });
    const result = await silentSyncBudgets(fakeConn, TEST_GROUP_ID);
    expect(result).toBe(0);
  });
});

describe('syncBudgetsDiff', () => {
  beforeEach(resetAllMocks);

  it('throws when group has no google_refresh_token', async () => {
    mockGroups.findById.mockReturnValue({
      id: 1,
      google_refresh_token: null,
      spreadsheet_id: 'sheet-123',
      default_currency: 'EUR' as CurrencyCode,
      enabled_currencies: ['EUR'] as CurrencyCode[],
      active_topic_id: null,
    });
    await expect(syncBudgetsDiff(TEST_GROUP_ID)).rejects.toThrow(
      'Group not configured for Google Sheets',
    );
  });

  it('returns empty result when no spreadsheet', async () => {
    mockGroupSpreadsheets.getByYear.mockReturnValue(null);
    const result = await syncBudgetsDiff(TEST_GROUP_ID);
    expect(result.added).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.unchanged).toBe(0);
  });

  it('returns empty result when tab does not exist', async () => {
    mockMonthTabExists.mockResolvedValue(false);
    const result = await syncBudgetsDiff(TEST_GROUP_ID);
    expect(result.added).toHaveLength(0);
  });

  it('detects added budgets', async () => {
    mockReadMonthBudget.mockResolvedValue([
      { category: 'Еда', limit: 500, currency: 'EUR' as CurrencyCode },
    ]);
    mockBudgets.findByGroupCategoryMonth.mockReturnValue(null);

    const result = await syncBudgetsDiff(TEST_GROUP_ID);

    expect(result.added).toHaveLength(1);
    expect(result.added.at(0)?.category).toBe('Еда');
    expect(result.added.at(0)?.limit).toBe(500);
    expect(mockBudgets.setBudget).toHaveBeenCalledTimes(1);
  });

  it('detects updated budgets', async () => {
    mockReadMonthBudget.mockResolvedValue([
      { category: 'Еда', limit: 700, currency: 'EUR' as CurrencyCode },
    ]);
    mockBudgets.findByGroupCategoryMonth.mockReturnValue({
      id: 1,
      limit_amount: 500,
      currency: 'EUR',
      category: 'Еда',
      month: '2026-03',
    });

    const result = await syncBudgetsDiff(TEST_GROUP_ID);

    expect(result.updated).toHaveLength(1);
    expect(result.updated.at(0)?.oldLimit).toBe(500);
    expect(result.updated.at(0)?.limit).toBe(700);
  });

  it('detects deleted budgets (in DB but not in sheet)', async () => {
    mockReadMonthBudget.mockResolvedValue([]);
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { id: 5, category: 'Транспорт', limit_amount: 300, currency: 'EUR', month: '2026-03' },
    ]);

    const result = await syncBudgetsDiff(TEST_GROUP_ID);

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted.at(0)?.category).toBe('Транспорт');
    expect(mockBudgets.delete).toHaveBeenCalledWith(5);
  });

  it('counts unchanged budgets', async () => {
    mockReadMonthBudget.mockResolvedValue([
      { category: 'Еда', limit: 500, currency: 'EUR' as CurrencyCode },
    ]);
    mockBudgets.findByGroupCategoryMonth.mockReturnValue({
      id: 1,
      limit_amount: 500,
      currency: 'EUR',
      category: 'Еда',
      month: '2026-03',
    });
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { id: 1, category: 'Еда', limit_amount: 500, currency: 'EUR', month: '2026-03' },
    ]);

    const result = await syncBudgetsDiff(TEST_GROUP_ID);

    expect(result.unchanged).toBe(1);
    expect(result.added).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it('wraps DB operations in a transaction', async () => {
    mockReadMonthBudget.mockResolvedValue([
      { category: 'Еда', limit: 500, currency: 'EUR' as CurrencyCode },
    ]);

    await syncBudgetsDiff(TEST_GROUP_ID);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('creates missing categories', async () => {
    mockReadMonthBudget.mockResolvedValue([
      { category: 'НоваяКатегория', limit: 100, currency: 'EUR' as CurrencyCode },
    ]);
    mockCategories.exists.mockReturnValue(false);

    const result = await syncBudgetsDiff(TEST_GROUP_ID);

    expect(result.createdCategories).toContain('НоваяКатегория');
    expect(mockCategories.create).toHaveBeenCalledWith({
      group_id: TEST_GROUP_ID,
      name: 'НоваяКатегория',
    });
  });
});

describe('ensureFreshBudgets', () => {
  beforeEach(resetAllMocks);

  it('skips sync when cooldown is active', async () => {
    const groupId = 1001;
    mockGroups.findById.mockReturnValue({
      id: groupId,
      google_refresh_token: 'token',
      spreadsheet_id: 'sheet',
      default_currency: 'EUR' as CurrencyCode,
      enabled_currencies: ['EUR'] as CurrencyCode[],
      active_topic_id: null,
    });
    mockReadMonthBudget.mockResolvedValue([]);

    // First call — should sync
    await ensureFreshBudgets(groupId);
    expect(mockGroupSpreadsheets.getByYear).toHaveBeenCalled();

    // Second call immediately — should skip due to cooldown
    mockGroupSpreadsheets.getByYear.mockClear();
    await ensureFreshBudgets(groupId);
    expect(mockGroupSpreadsheets.getByYear).not.toHaveBeenCalled();
  });

  it('sends notification when changes detected', async () => {
    const groupId = 999;
    mockGroups.findById.mockReturnValue({
      id: groupId,
      google_refresh_token: 'token',
      spreadsheet_id: 'sheet',
      default_currency: 'EUR' as CurrencyCode,
      enabled_currencies: ['EUR'] as CurrencyCode[],
      active_topic_id: null,
    });
    mockReadMonthBudget.mockResolvedValue([
      { category: 'Еда', limit: 500, currency: 'EUR' as CurrencyCode },
    ]);
    mockBudgets.findByGroupCategoryMonth.mockReturnValue(null);
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);

    await ensureFreshBudgets(groupId, -100123);

    expect(mockWithChatContext).toHaveBeenCalledTimes(1);
    expect(mockWithChatContext.mock.calls.at(0)?.at(0)).toBe(-100123);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const text = mockSendMessage.mock.calls.at(0)?.at(0) as unknown as string;
    expect(text).toContain('Авто-синк');
  });

  it('does not send notification when no changes', async () => {
    const groupId = 998;
    mockGroups.findById.mockReturnValue({
      id: groupId,
      google_refresh_token: 'token',
      spreadsheet_id: 'sheet',
      default_currency: 'EUR' as CurrencyCode,
      enabled_currencies: ['EUR'] as CurrencyCode[],
      active_topic_id: null,
    });
    mockReadMonthBudget.mockResolvedValue([]);
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);

    await ensureFreshBudgets(groupId, -100123);

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('does not throw on error', async () => {
    const groupId = 997;
    mockGroups.findById.mockImplementation(() => {
      throw new Error('DB down');
    });

    await expect(ensureFreshBudgets(groupId)).resolves.toBeUndefined();
  });
});

describe('getBudgetSyncCachedResult', () => {
  it('returns null for unknown key', () => {
    expect(getBudgetSyncCachedResult('nonexistent-key')).toBeNull();
  });
});
