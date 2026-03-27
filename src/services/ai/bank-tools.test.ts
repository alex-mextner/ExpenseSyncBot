// src/services/ai/bank-tools.test.ts

import { describe, expect, mock, test } from 'bun:test';

// Mock database so tests don't depend on the real singleton or test execution order.
mock.module('../../database', () => ({
  database: {
    bankAccounts: { findByGroupId: () => [] },
    bankTransactions: { findByGroupId: () => [], findUnmatched: () => [] },
    bankConnections: { findById: () => null, findActiveByGroupId: () => [] },
    expenses: { findByDateRange: () => [] },
  },
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
    const result = await executeTool('get_bank_balances', {}, ctx);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toEqual([]);
  });

  test('get_bank_transactions returns empty list when no transactions', async () => {
    const result = await executeTool('get_bank_transactions', { period: 'current_month' }, ctx);
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
