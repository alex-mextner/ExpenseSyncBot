// src/services/ai/bank-tools.test.ts

import { describe, expect, mock, test } from 'bun:test';
import { mockDatabase } from '../../test-utils/mocks/database';

type FindByGroupIdFn = (groupId: number, includeExcluded?: boolean) => unknown[];

const mockFindByGroupId: { impl: FindByGroupIdFn } = { impl: () => [] };
const mockFindById: { impl: (id: number) => unknown } = { impl: () => null };

mock.module('../../database', () => ({
  database: mockDatabase({
    bankAccounts: {
      findByGroupId: mock((groupId: number, includeExcluded?: boolean) =>
        mockFindByGroupId.impl(groupId, includeExcluded),
      ),
    },
    bankTransactions: {
      findByGroupId: mock(() => []),
      findUnmatched: mock(() => []),
    },
    bankConnections: {
      findById: mock((id: number) => mockFindById.impl(id)),
      findActiveByGroupId: mock(() => []),
    },
    expenses: { findByDateRange: mock(() => []) },
  }),
}));

import { executeTool } from './tool-executor';
import type { AgentContext } from './types';

const TEST_GROUP_ID = 1;

const ctx: AgentContext = {
  groupId: TEST_GROUP_ID,
  userId: 1,
  chatId: TEST_GROUP_ID,
  userName: 'test',
  userFullName: 'Test User',
  customPrompt: null,
  telegramGroupId: TEST_GROUP_ID,
};

describe('bank AI tools', () => {
  test('get_bank_balances returns empty list when no connections', async () => {
    mockFindByGroupId.impl = () => [];
    const result = await executeTool('get_bank_balances', { bank_name: 'all' }, ctx);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toEqual([]);
  });

  test('get_bank_balances always returns all accounts including hidden ones', async () => {
    const accounts = [
      {
        id: 1,
        connection_id: 1,
        title: 'Card USD',
        balance: 100,
        currency: 'USD',
        type: null,
        is_excluded: 0,
      },
      {
        id: 2,
        connection_id: 1,
        title: 'Lena',
        balance: 1639,
        currency: 'USD',
        type: null,
        is_excluded: 1,
      },
    ];
    mockFindByGroupId.impl = () => accounts;
    mockFindById.impl = () => ({ bank_name: 'tbc-ge', display_name: 'TBC Georgia' });

    const result = await executeTool('get_bank_balances', { bank_name: 'all' }, ctx);
    expect(result.success).toBe(true);
    const data = result.data as Array<{ hidden: boolean; account_title: string }>;
    expect(data.length).toBe(2);
    expect(data.find((a) => a.account_title === 'Card USD')?.hidden).toBe(false);
    expect(data.find((a) => a.account_title === 'Lena')?.hidden).toBe(true);
  });

  test('get_bank_balances with bank_name filter does case-insensitive substring match', async () => {
    const account = {
      id: 1,
      connection_id: 1,
      title: 'Card USD',
      balance: 100,
      currency: 'USD',
      type: null,
      is_excluded: 0,
    };
    mockFindByGroupId.impl = () => [account];
    mockFindById.impl = () => ({ bank_name: 'tbc-ge', display_name: 'TBC Georgia' });

    const result = await executeTool('get_bank_balances', { bank_name: 'TBC' }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as unknown[]).length).toBe(1);
  });

  test('get_bank_balances with non-matching bank_name returns helpful error with available banks', async () => {
    const account = {
      id: 1,
      connection_id: 1,
      title: 'Card USD',
      balance: 100,
      currency: 'USD',
      type: null,
      is_excluded: 0,
    };
    mockFindByGroupId.impl = () => [account];
    mockFindById.impl = () => ({ bank_name: 'tbc-ge', display_name: 'TBC Georgia' });

    const result = await executeTool('get_bank_balances', { bank_name: 'kaspi' }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.summary).toContain('tbc-ge');
    expect(result.summary).toContain('kaspi');
  });

  test('get_bank_transactions returns empty list when no transactions', async () => {
    const result = await executeTool(
      'get_bank_transactions',
      { period: 'current_month', bank_name: 'all' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toEqual([]);
  });

  test('find_missing_expenses returns no missing when no transactions', async () => {
    const result = await executeTool('find_missing_expenses', { period: 'current_month' }, ctx);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toEqual([]);
  });
});
