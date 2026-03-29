// Tests for recurring-detector.ts — detects monthly recurring expense patterns
// Mocks database.expenses.findByDateRange and database.recurringPatterns.findByGroupCategoryCurrency

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Expense } from '../../database/types';

const mockFindByDateRange = mock<(groupId: number, start: string, end: string) => Expense[]>(
  () => [],
);
const mockFindByGroupCategoryCurrency = mock<
  (groupId: number, category: string, currency: string) => unknown
>(() => null);

mock.module('../../database', () => ({
  database: {
    expenses: {
      findByDateRange: mockFindByDateRange,
    },
    recurringPatterns: {
      findByGroupCategoryCurrency: mockFindByGroupCategoryCurrency,
    },
  },
}));

// Import after mock is set up
const { detectRecurringPatterns, computeNextExpectedDate } = await import('./recurring-detector');

const GROUP_ID = 1;

/** Build a fake Expense row with sensible defaults */
function makeExpense(overrides: Partial<Expense> & { date: string; amount: number }): Expense {
  return {
    id: 1,
    group_id: GROUP_ID,
    user_id: 1,
    category: 'Подписки',
    comment: 'test',
    currency: 'EUR',
    eur_amount: overrides.amount,
    created_at: overrides.date,
    ...overrides,
  } as Expense;
}

/**
 * Generate N expenses at ~30-day intervals starting from a base date,
 * going backwards in time (most recent first in the returned array,
 * but date-ascending order works too since the detector sorts internally).
 */
function makeMonthlyExpenses(
  count: number,
  opts: { category?: string; amount?: number; currency?: CurrencyCode; baseDate?: string } = {},
): Expense[] {
  const category = opts.category ?? 'Подписки';
  const amount = opts.amount ?? 9.99;
  const currency = opts.currency ?? 'EUR';
  const base = opts.baseDate ? new Date(opts.baseDate) : new Date();

  const expenses: Expense[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i * 30);
    expenses.push(
      makeExpense({
        id: i + 1,
        date: d.toISOString().slice(0, 10),
        amount,
        category,
        currency,
      }),
    );
  }
  return expenses;
}

describe('detectRecurringPatterns', () => {
  beforeEach(() => {
    mockFindByDateRange.mockReset();
    mockFindByGroupCategoryCurrency.mockReset();
    mockFindByDateRange.mockReturnValue([]);
    mockFindByGroupCategoryCurrency.mockReturnValue(null);
  });

  it('returns empty array when no expenses', () => {
    const result = detectRecurringPatterns(GROUP_ID);
    expect(result).toEqual([]);
  });

  it('returns empty array when fewer than 3 similar expenses in a category', () => {
    mockFindByDateRange.mockReturnValue(
      makeMonthlyExpenses(2, { category: 'Подписки', amount: 10 }),
    );

    const result = detectRecurringPatterns(GROUP_ID);
    expect(result).toEqual([]);
  });

  it('detects a monthly pattern with 3+ expenses at ~30-day intervals', () => {
    const expenses = makeMonthlyExpenses(4, {
      category: 'Подписки',
      amount: 9.99,
      currency: 'EUR',
      baseDate: '2025-12-15',
    });
    mockFindByDateRange.mockReturnValue(expenses);

    const result = detectRecurringPatterns(GROUP_ID);
    expect(result.length).toBe(1);
    expect(result[0]?.category).toBe('Подписки');
    expect(result[0]?.currency).toBe('EUR');
    expect(result[0]?.occurrences).toBe(4);
    expect(result[0]?.expectedAmount).toBe(9.99);
  });

  it('detects pattern when amounts vary within ±20% tolerance', () => {
    // 10, 11.5, 10.5 — all within 20% of each other
    const expenses = [
      makeExpense({ id: 1, date: '2025-12-15', amount: 10, category: 'Netflix', currency: 'EUR' }),
      makeExpense({
        id: 2,
        date: '2025-11-15',
        amount: 11.5,
        category: 'Netflix',
        currency: 'EUR',
      }),
      makeExpense({
        id: 3,
        date: '2025-10-16',
        amount: 10.5,
        category: 'Netflix',
        currency: 'EUR',
      }),
    ];
    mockFindByDateRange.mockReturnValue(expenses);

    const result = detectRecurringPatterns(GROUP_ID);
    expect(result.length).toBe(1);
    expect(result[0]?.category).toBe('Netflix');
    expect(result[0]?.occurrences).toBe(3);
  });

  it('does NOT detect pattern when amounts differ by >20%', () => {
    const expenses = [
      makeExpense({ id: 1, date: '2025-12-15', amount: 10, category: 'Кафе', currency: 'EUR' }),
      makeExpense({ id: 2, date: '2025-11-15', amount: 15, category: 'Кафе', currency: 'EUR' }),
      makeExpense({ id: 3, date: '2025-10-16', amount: 10, category: 'Кафе', currency: 'EUR' }),
    ];
    mockFindByDateRange.mockReturnValue(expenses);

    const result = detectRecurringPatterns(GROUP_ID);
    // 10 vs 15 = 33% diff — exceeds 20%, so 15 is not in the cluster.
    // Only 2 expenses match (10, 10), which is < MIN_OCCURRENCES (3)
    expect(result).toEqual([]);
  });

  it('does NOT detect pattern when intervals are irregular (not monthly)', () => {
    // Intervals: 5 days, 60 days — neither is monthly (25-35 days)
    const expenses = [
      makeExpense({ id: 1, date: '2025-12-15', amount: 10, category: 'Такси', currency: 'EUR' }),
      makeExpense({ id: 2, date: '2025-12-10', amount: 10, category: 'Такси', currency: 'EUR' }),
      makeExpense({ id: 3, date: '2025-10-11', amount: 10, category: 'Такси', currency: 'EUR' }),
    ];
    mockFindByDateRange.mockReturnValue(expenses);

    const result = detectRecurringPatterns(GROUP_ID);
    expect(result).toEqual([]);
  });

  it('detects patterns in multiple currencies separately', () => {
    const eurExpenses = makeMonthlyExpenses(3, {
      category: 'Подписки',
      amount: 9.99,
      currency: 'EUR',
      baseDate: '2025-12-15',
    });
    const usdExpenses = makeMonthlyExpenses(3, {
      category: 'Подписки',
      amount: 14.99,
      currency: 'USD',
      baseDate: '2025-12-15',
    });
    // Assign unique IDs
    for (const [i, exp] of usdExpenses.entries()) {
      exp.id = 100 + i;
    }
    mockFindByDateRange.mockReturnValue([...eurExpenses, ...usdExpenses]);

    const result = detectRecurringPatterns(GROUP_ID);
    expect(result.length).toBe(2);

    const currencies = result.map((p) => p.currency).sort();
    expect(currencies).toEqual(['EUR', 'USD']);

    const eurPattern = result.find((p) => p.currency === 'EUR');
    const usdPattern = result.find((p) => p.currency === 'USD');
    expect(eurPattern?.expectedAmount).toBe(9.99);
    expect(usdPattern?.expectedAmount).toBe(14.99);
  });

  it('skips patterns already saved in database', () => {
    const expenses = makeMonthlyExpenses(3, {
      category: 'Подписки',
      amount: 9.99,
      currency: 'EUR',
      baseDate: '2025-12-15',
    });
    mockFindByDateRange.mockReturnValue(expenses);
    // Simulate an existing pattern in DB
    mockFindByGroupCategoryCurrency.mockReturnValue({ id: 42, category: 'Подписки' });

    const result = detectRecurringPatterns(GROUP_ID);
    expect(result).toEqual([]);
  });

  it('correctly computes median amount for even number of expenses', () => {
    // 4 expenses with amounts: 10, 10.5, 11, 11.5 → median = (10.5 + 11) / 2 = 10.75
    const expenses = [
      makeExpense({
        id: 1,
        date: '2025-12-15',
        amount: 11.5,
        category: 'Gym',
        currency: 'EUR',
      }),
      makeExpense({
        id: 2,
        date: '2025-11-15',
        amount: 11,
        category: 'Gym',
        currency: 'EUR',
      }),
      makeExpense({
        id: 3,
        date: '2025-10-16',
        amount: 10.5,
        category: 'Gym',
        currency: 'EUR',
      }),
      makeExpense({
        id: 4,
        date: '2025-09-16',
        amount: 10,
        category: 'Gym',
        currency: 'EUR',
      }),
    ];
    mockFindByDateRange.mockReturnValue(expenses);

    const result = detectRecurringPatterns(GROUP_ID);
    expect(result.length).toBe(1);
    expect(result[0]?.expectedAmount).toBe(10.75);
  });

  it('correctly computes expected day as median of day-of-month values', () => {
    // Days: 14, 15, 16 → median = 15
    const expenses = [
      makeExpense({
        id: 1,
        date: '2025-12-16',
        amount: 10,
        category: 'Rent',
        currency: 'EUR',
      }),
      makeExpense({
        id: 2,
        date: '2025-11-15',
        amount: 10,
        category: 'Rent',
        currency: 'EUR',
      }),
      makeExpense({
        id: 3,
        date: '2025-10-14',
        amount: 10,
        category: 'Rent',
        currency: 'EUR',
      }),
    ];
    mockFindByDateRange.mockReturnValue(expenses);

    const result = detectRecurringPatterns(GROUP_ID);
    expect(result.length).toBe(1);
    expect(result[0]?.expectedDay).toBe(15);
  });

  it('returns lastDate as the most recent expense date in the cluster', () => {
    const expenses = makeMonthlyExpenses(3, {
      category: 'Подписки',
      amount: 9.99,
      currency: 'EUR',
      baseDate: '2025-12-20',
    });
    mockFindByDateRange.mockReturnValue(expenses);

    const result = detectRecurringPatterns(GROUP_ID);
    expect(result.length).toBe(1);
    expect(result[0]?.lastDate).toBe('2025-12-20');
  });
});

describe('computeNextExpectedDate', () => {
  it('returns next month with same day for a normal case', () => {
    // Last seen Jan 15, expected day 15 → Feb 15
    const result = computeNextExpectedDate('2025-01-15', 15);
    expect(result).toBe('2025-02-15');
  });

  it('clamps to last day of month when expected day exceeds month length', () => {
    // Last seen Jan 31, expected day 31 → Feb has 28 days → Feb 28
    const result = computeNextExpectedDate('2025-01-31', 31);
    expect(result).toBe('2025-02-28');
  });

  it('handles leap year February correctly', () => {
    // 2024 is a leap year: Jan 31, expected day 29 → Feb 29
    const result = computeNextExpectedDate('2024-01-31', 29);
    expect(result).toBe('2024-02-29');
  });

  it('handles year boundary: December → January next year', () => {
    const result = computeNextExpectedDate('2025-12-15', 15);
    expect(result).toBe('2026-01-15');
  });

  it('clamps expected day at year boundary', () => {
    // December 31, expected day 31 → January has 31 days → Jan 31
    const result = computeNextExpectedDate('2025-12-31', 31);
    expect(result).toBe('2026-01-31');
  });

  it('uses expected day, not last seen day', () => {
    // Last seen Jan 20 but expected day is 5 → Feb 5
    const result = computeNextExpectedDate('2025-01-20', 5);
    expect(result).toBe('2025-02-05');
  });

  it('clamps day 31 for April (30 days)', () => {
    // March → April, expected day 31 → April has 30 days → April 30
    const result = computeNextExpectedDate('2025-03-31', 31);
    expect(result).toBe('2025-04-30');
  });
});
