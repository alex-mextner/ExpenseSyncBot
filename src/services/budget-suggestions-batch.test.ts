// Shared budget snapshots must preserve repository matching and chronological spending semantics.
import { expect, mock, test } from 'bun:test';
import { BudgetRepository } from '../database/repositories/budget.repository';
import { GroupRepository } from '../database/repositories/group.repository';
import { createTestDb } from '../test-utils/db';

const db = createTestDb();
const budgets = new BudgetRepository(db);
const history = mock(
  () => [] as { category: string; month: string; monthly_total: number; tx_count: number }[],
);
mock.module('../database', () => ({
  database: { budgets, expenses: { getMonthlyHistoryByCategory: history } },
}));
const { suggestBudgetAmountsBatch } = await import('./budget-suggestions');

test('batch suggestions preserve ambiguous prefix choice from the repository', () => {
  const group = new GroupRepository(db).create({ telegram_group_id: -746123 });
  budgets.setBudget({
    group_id: group.id,
    category: 'Food',
    month: '2026-09',
    limit_amount: 120,
    currency: 'EUR',
  });
  budgets.setBudget({
    group_id: group.id,
    category: 'Foo',
    month: '2026-09',
    limit_amount: 240,
    currency: 'EUR',
  });
  const original = budgets.getBudgetForMonth(group.id, 'Fo', '2026-09');
  expect(original?.category).toBe('Food');
  const suggestion = suggestBudgetAmountsBatch(group.id, ['Fo'], 'EUR', new Date(2026, 9, 2)).get(
    'Fo',
  );
  expect(suggestion?.options[0]?.amount).toBe(original?.limit_amount);
});

test('case-folded history remains chronological without sorting unrelated categories', () => {
  history.mockReturnValue([
    { category: 'FOOD', month: '2026-09', monthly_total: 300, tx_count: 1 },
    { category: 'Food', month: '2026-08', monthly_total: 100, tx_count: 1 },
    { category: 'Unrelated', month: '2026-09', monthly_total: 999, tx_count: 1 },
  ]);
  const result = suggestBudgetAmountsBatch(-1, ['Food'], 'EUR', new Date(2026, 9, 2)).get('Food');
  expect(result?.options.find((option) => option.kind === 'last_month_spend')?.amount).toBe(300);
  expect(result?.options.some((option) => option.amount === 200)).toBe(true);
});
