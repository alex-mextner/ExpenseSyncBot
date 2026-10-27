/**
 * Budget tools: get_budgets, set_budget and delete_budget (single and batch).
 * Shared mocks live in tool-executor.test-support.ts.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { makeExpense } from '../../test-utils/fixtures';
import {
  ctx,
  executeTool,
  mockBudgetManagerDelete,
  mockBudgetManagerSet,
  mockBudgets,
  mockExpenses,
  mockGetFinancialSnapshot,
  resetAllMocks,
} from './tool-executor.test-support';

describe('executeGetBudgets', () => {
  beforeEach(resetAllMocks);

  test('returns budget list for current month', async () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        category: 'Food',
        month: '2026-03',
        limit_amount: 500,
        currency: 'EUR',
        created_at: '',
        updated_at: '',
      },
    ]);
    // Expenses for spending calculation
    mockExpenses.findByDateRange.mockReturnValue([
      makeExpense({
        id: 1,
        user_id: 123,
        date: '2026-03-05',
        comment: '',
        amount: 100,
        eur_amount: 100,
      }),
    ]);

    const result = await executeTool('get_budgets', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Food');
    expect(result.output).toContain('500.00');
    expect(result.output).toContain('EUR');
  });

  test('returns message when no budgets', async () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);

    const result = await executeTool('get_budgets', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('No budgets set');
  });
});

describe('get_budgets batch', () => {
  beforeEach(() => {
    resetAllMocks();
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_groupId: number, month: string) => [
      {
        id: 1,
        group_id: 1,
        category: 'Еда',
        month,
        limit_amount: 50000,
        currency: 'RSD',
        created_at: '',
        updated_at: '',
      },
      {
        id: 2,
        group_id: 1,
        category: 'Развлечения',
        month,
        limit_amount: 30000,
        currency: 'RSD',
        created_at: '',
        updated_at: '',
      },
    ]);
  });

  test('single month works as before', async () => {
    const result = await executeTool('get_budgets', { month: '2026-01' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Budgets for 2026-01');
  });

  test('multiple months shows per-month breakdown', async () => {
    const result = await executeTool(
      'get_budgets',
      { month: ['2026-01', '2026-02', '2026-03'] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== 2026-01 ===');
    expect(result.output).toContain('=== 2026-02 ===');
    expect(result.output).toContain('=== 2026-03 ===');
  });

  test('category array filters multiple categories', async () => {
    const result = await executeTool(
      'get_budgets',
      { month: '2026-01', category: ['Еда', 'Развлечения'] },
      ctx,
    );
    expect(result.success).toBe(true);
  });
});

describe('get_budgets enriched output', () => {
  beforeEach(resetAllMocks);

  test('current month shows EMA-based burn rate and projected total from spendingAnalytics', async () => {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        category: 'Food',
        month: currentMonth,
        limit_amount: 500,
        currency: 'EUR',
        created_at: '',
        updated_at: '',
      },
    ]);
    mockExpenses.findByDateRange.mockReturnValue([
      makeExpense({
        id: 1,
        user_id: 123,
        date: `${currentMonth}-05`,
        comment: '',
        amount: 200,
        eur_amount: 200,
      }),
    ]);
    // EMA-based burn rate from spendingAnalytics
    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: null,
      burnRates: [
        {
          category: 'Food',
          budget_limit: 500,
          spent: 200,
          currency: 'EUR',
          days_elapsed: now.getDate(),
          days_remaining: 30 - now.getDate(),
          daily_burn_rate: 15.5,
          projected_total: 465,
          projected_overshoot: -35,
          runway_days: 19.4,
          status: 'warning',
        },
      ],
    });

    const result = await executeTool('get_budgets', { month: currentMonth }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('burn:');
    expect(result.output).toContain('15.50');
    expect(result.output).toContain('projected:');
    expect(result.output).toContain('465.00');
    expect(result.output).toContain('runway:');
    expect(result.output).toContain('19d');
    expect(result.output).toContain('Grand Total:');
  });

  test('past month does not show burn rate details', async () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        category: 'Food',
        month: '2025-01',
        limit_amount: 500,
        currency: 'EUR',
        created_at: '',
        updated_at: '',
      },
    ]);
    mockExpenses.findByDateRange.mockReturnValue([]);

    const result = await executeTool('get_budgets', { month: '2025-01' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('burn:');
    expect(result.output).not.toContain('projected:');
    expect(result.output).not.toContain('runway:');
  });

  test('grand total shows inline percentage without synthetic budget object', async () => {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        category: 'Food',
        month: currentMonth,
        limit_amount: 300,
        currency: 'EUR',
        created_at: '',
        updated_at: '',
      },
      {
        id: 2,
        group_id: 1,
        category: 'Transport',
        month: currentMonth,
        limit_amount: 200,
        currency: 'EUR',
        created_at: '',
        updated_at: '',
      },
    ]);
    mockExpenses.findByDateRange.mockReturnValue([
      makeExpense({
        id: 1,
        user_id: 123,
        date: `${currentMonth}-05`,
        comment: '',
        amount: 150,
        eur_amount: 150,
      }),
    ]);
    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: null,
      burnRates: [],
    });

    const result = await executeTool('get_budgets', { month: currentMonth }, ctx);
    expect(result.success).toBe(true);
    // Grand Total: 150 / 500 = 30%
    expect(result.output).toContain('Grand Total:');
    expect(result.output).toContain('30%');
  });
});

describe('executeSetBudget', () => {
  beforeEach(resetAllMocks);

  test('creates budget with correct limit and currency', async () => {
    const result = await executeTool(
      'set_budget',
      { category: 'Food', amount: 500, currency: 'USD', month: '2026-03' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Food');
    expect(result.output).toContain('500.00 USD');
    expect(result.output).toContain('2026-03');
    expect(mockBudgetManagerSet).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 1,
        category: 'Food',
        month: '2026-03',
        amount: 500,
        currency: 'USD',
      }),
    );
  });

  test('rejects invalid amount', async () => {
    const result = await executeTool('set_budget', { category: 'Food', amount: -10 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid');
  });
});

describe('set_budget batch', () => {
  beforeEach(resetAllMocks);

  test('batch set_budget with items array calls set for each item', async () => {
    const result = await executeTool(
      'set_budget',
      {
        items: [
          { category: 'Food', amount: 50000 },
          { category: 'Transport', amount: 10000 },
          { category: 'Fun', amount: 20000 },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockBudgetManagerSet).toHaveBeenCalledTimes(3);
  });

  test('batch set_budget reports partial failure', async () => {
    mockBudgetManagerSet
      .mockResolvedValueOnce({ sheetsSynced: false })
      .mockRejectedValueOnce(new Error('Sheet error'))
      .mockResolvedValueOnce({ sheetsSynced: false });

    const result = await executeTool(
      'set_budget',
      {
        items: [
          { category: 'Food', amount: 100 },
          { category: 'Bad', amount: 200 },
          { category: 'OK', amount: 300 },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('2/3 succeeded');
    expect(result.output).toContain('✗');
  });

  test('batch over 20 items is rejected', async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      category: `Cat${i}`,
      amount: 100,
    }));

    const result = await executeTool('set_budget', { items }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('20');
  });

  test('single set_budget still works (backward compat)', async () => {
    const result = await executeTool('set_budget', { category: 'Food', amount: 500 }, ctx);
    expect(result.success).toBe(true);
    expect(mockBudgetManagerSet).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('Budget set: Food');
  });

  test('items array takes priority over top-level fields', async () => {
    const result = await executeTool(
      'set_budget',
      {
        category: 'IGNORED',
        amount: 999,
        items: [{ category: 'Real', amount: 100 }],
      },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('1/1 succeeded');
    expect(mockBudgetManagerSet).toHaveBeenCalledTimes(1);
    const calls = mockBudgetManagerSet.mock.calls as unknown as Array<
      [{ category: string; amount: number }]
    >;
    expect(calls[0]?.[0].category).toBe('Real');
    expect(calls[0]?.[0].amount).toBe(100);
  });

  test('empty items array returns error', async () => {
    const result = await executeTool('set_budget', { items: [] }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });
});

describe('executeDeleteBudget', () => {
  beforeEach(resetAllMocks);

  test('deletes budget for category/month', async () => {
    const result = await executeTool('delete_budget', { category: 'Food', month: '2026-03' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Budget deleted');
    expect(result.output).toContain('Food');
    expect(mockBudgetManagerDelete).toHaveBeenCalledWith({
      groupId: 1,
      category: 'Food',
      month: '2026-03',
    });
  });

  test('rejects missing category', async () => {
    const result = await executeTool('delete_budget', {}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('category is required');
  });
});

describe('delete_budget batch', () => {
  beforeEach(resetAllMocks);

  test('batch delete with category array', async () => {
    const result = await executeTool(
      'delete_budget',
      { category: ['Food', 'Transport', 'Fun'] },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockBudgetManagerDelete).toHaveBeenCalledTimes(3);
  });

  test('single delete still works (backward compat)', async () => {
    const result = await executeTool('delete_budget', { category: 'Food' }, ctx);
    expect(result.success).toBe(true);
    expect(mockBudgetManagerDelete).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('Budget deleted for Food');
  });

  test('empty category array returns error', async () => {
    const result = await executeTool('delete_budget', { category: [] }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });
});
