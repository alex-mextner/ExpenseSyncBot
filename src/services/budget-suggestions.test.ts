// Tests for budget amount suggestions — previous plan, spending history, group distribution, no data

import { mock } from 'bun:test';
import { createMockLogger } from '../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../utils/logger', () => ({ createLogger: () => logMock, logger: logMock }));

import { describe, expect, test } from 'bun:test';
import { buildBudgetSuggestions, roundToNiceAmount } from './budget-suggestions';

const base = {
  currency: 'EUR' as const,
  previousBudget: null,
  currentBudget: null,
  monthlySpendEur: [] as number[],
  otherBudgets: [] as Array<{ amount: number; currency: 'EUR' | 'USD' | 'RSD' }>,
};

describe('roundToNiceAmount', () => {
  test.each([
    [237, 240],
    [1234, 1200],
    [99, 99],
    [8.4, 8],
    [0.2, 1],
    [45678, 46000],
  ])('%p -> %p', (input, expected) => {
    expect(roundToNiceAmount(input)).toBe(expected);
  });
});

describe('buildBudgetSuggestions', () => {
  test('no history at all: no options and no data-driven claim', () => {
    const result = buildBudgetSuggestions(base);
    expect(result.options).toEqual([]);
  });

  test('previous month budget is offered first with its reason', () => {
    const result = buildBudgetSuggestions({
      ...base,
      previousBudget: { amount: 300, currency: 'EUR' },
    });
    expect(result.options[0]).toMatchObject({ amount: 300, kind: 'previous_budget' });
    expect(result.options[0]?.reason).toContain('прошлого месяца');
  });

  test('spending history gives last-month and average options', () => {
    const result = buildBudgetSuggestions({ ...base, monthlySpendEur: [100, 200, 300] });
    const kinds = result.options.map((o) => o.kind);
    expect(kinds).toContain('last_month_spend');
    expect(kinds).toContain('average_spend');
    expect(result.options.find((o) => o.kind === 'last_month_spend')?.amount).toBe(300);
    expect(result.options.find((o) => o.kind === 'average_spend')?.amount).toBe(200);
    expect(result.options.find((o) => o.kind === 'average_spend')?.reason).toContain('3');
  });

  test('single month of spending does not produce an average', () => {
    const result = buildBudgetSuggestions({ ...base, monthlySpendEur: [120] });
    expect(result.options.map((o) => o.kind)).toEqual(['last_month_spend']);
  });

  test('current plan is offered when the budget already exists this month', () => {
    const result = buildBudgetSuggestions({
      ...base,
      currentBudget: { amount: 250, currency: 'EUR' },
    });
    expect(result.options[0]).toMatchObject({ amount: 250, kind: 'current_plan' });
  });

  test('group distribution is the fallback when the category has no history', () => {
    const result = buildBudgetSuggestions({
      ...base,
      otherBudgets: [
        { amount: 100, currency: 'EUR' },
        { amount: 300, currency: 'EUR' },
        { amount: 500, currency: 'EUR' },
      ],
    });
    expect(result.options.map((o) => o.kind)).toContain('group_median');
    expect(result.options.find((o) => o.kind === 'group_median')?.amount).toBe(300);
    expect(result.options.find((o) => o.kind === 'group_median')?.reason).toContain(
      'других категорий',
    );
  });

  test('group distribution is NOT used when the category has its own history', () => {
    const result = buildBudgetSuggestions({
      ...base,
      monthlySpendEur: [100, 120],
      otherBudgets: [{ amount: 999, currency: 'EUR' }],
    });
    expect(result.options.map((o) => o.kind)).not.toContain('group_median');
  });

  test('duplicate amounts are collapsed and options are capped at three', () => {
    const result = buildBudgetSuggestions({
      ...base,
      previousBudget: { amount: 200, currency: 'EUR' },
      currentBudget: { amount: 200, currency: 'EUR' },
      monthlySpendEur: [150, 200, 260, 310],
    });
    const amounts = result.options.map((o) => o.amount);
    expect(new Set(amounts).size).toBe(amounts.length);
    expect(amounts.length).toBeLessThanOrEqual(3);
  });

  test('converts EUR spending and foreign budgets into the prompt currency', () => {
    const result = buildBudgetSuggestions({
      ...base,
      currency: 'RSD',
      monthlySpendEur: [10, 10],
      previousBudget: { amount: 50, currency: 'EUR' },
    });
    // 1 EUR is worth ~117 RSD, so amounts must be far above the raw EUR numbers
    expect(result.options.every((o) => o.amount > 500)).toBe(true);
  });

  test('every option has an integer amount of at least 1', () => {
    const result = buildBudgetSuggestions({ ...base, monthlySpendEur: [0.3, 0.4] });
    for (const option of result.options) {
      expect(Number.isInteger(option.amount)).toBe(true);
      expect(option.amount).toBeGreaterThanOrEqual(1);
    }
  });
});

// Input history omits months without spending, so explanations must not imply consecutive months.
test('spending explanations identify observed months rather than the previous calendar month', () => {
  const result = buildBudgetSuggestions({ ...base, monthlySpendEur: [100, 300] });
  expect(result.options.find((option) => option.kind === 'last_month_spend')?.reason).toBe(
    'последний месяц с расходами',
  );
  expect(result.options.find((option) => option.kind === 'average_spend')?.reason).toBe(
    'средние траты за 2 мес. с расходами',
  );
});
