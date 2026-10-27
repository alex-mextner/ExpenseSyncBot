/**
 * get_budgets report text, pinned line by line.
 *
 * The report is the only place the model reads budget progress, burn rate, projection and the
 * grand total from, so its exact wording and the arithmetic behind it are pinned here
 * (EMA vs linear projection, status labels, per-currency conversion, batch grand total).
 * The clock is fixed to 2026-03-10 (day 10 of 31) so "current month" figures are deterministic.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Budget, Expense } from '../../database/types';
import { makeExpense } from '../../test-utils/fixtures';
import { convertCurrency, formatAmount } from '../currency/converter';
import {
  ctx,
  executeTool,
  mockBudgets,
  mockExpenses,
  mockGetFinancialSnapshot,
  mockGroups,
  resetAllMocks,
} from './tool-executor.test-support';

function budget(category: string, limit: number, currency: CurrencyCode, month: string): Budget {
  return {
    id: 1,
    group_id: 1,
    category,
    month,
    limit_amount: limit,
    currency,
    created_at: '',
    updated_at: '',
  };
}

function spend(id: number, category: string, date: string, eur: number): Expense {
  return makeExpense({ id, category, date, amount: eur, eur_amount: eur });
}

describe('get_budgets report', () => {
  beforeEach(() => {
    resetAllMocks();
    setSystemTime(new Date(2026, 2, 10, 12, 0, 0));
    mockGetFinancialSnapshot.mockReset();
    mockGetFinancialSnapshot.mockReturnValue({ technicalAnalysis: null, burnRates: [] });
  });
  afterEach(() => {
    setSystemTime();
  });

  test('current month: every status label, EMA burn rate, linear fallback, grand total with days left', async () => {
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_g: number, m: string) => [
      budget('Food', 300, 'EUR', m),
      budget('Transport', 200, 'EUR', m),
      budget('Fun', 100, 'EUR', m),
      budget('Rent', 50, 'EUR', m),
      budget('Bills', 100, 'EUR', m),
      budget('Gifts', 1000, 'RSD', m),
    ]);
    mockExpenses.findByDateRange.mockReturnValue([
      spend(1, 'Food', '2026-03-05', 150),
      spend(2, 'Transport', '2026-03-05', 90),
      spend(3, 'Fun', '2026-03-05', 120),
      spend(4, 'Bills', '2026-03-06', 95),
      spend(5, 'Gifts', '2026-03-07', 5),
      spend(6, 'Other', '2026-03-08', 10),
    ]);
    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: null,
      burnRates: [
        { category: 'Food', daily_burn_rate: 15.5, projected_total: 465, runway_days: 9.6 },
        { category: 'Fun', daily_burn_rate: 12, projected_total: 372, runway_days: 999 },
      ],
    });

    const result = await executeTool('get_budgets', {}, ctx);

    // Gifts is budgeted in RSD: the EUR spend is converted into the budget's own currency.
    const giftsSpent = convertCurrency(5, 'EUR', 'RSD');
    const giftsDaily = giftsSpent / 10;
    expect(giftsSpent).toBeCloseTo(581.4, 5);
    expect(result).toEqual({
      success: true,
      output: [
        'Budgets for 2026-03 (day 10/31):',
        '',
        // EMA path: figures come from the analytics snapshot; runway 9.6 rounds to 10d.
        'Food: 150.00 EUR/300.00 EUR (50%) [OK] | burn: 15.50 EUR/day, projected: 465.00 EUR, runway: 10d',
        // Linear fallback: 90/10 days = 9/day, *31 = 279, remaining 110 / 9 = 12.2 -> 12d.
        'Transport: 90.00 EUR/200.00 EUR (45%) [OK] | burn: 9.00 EUR/day, projected: 279.00 EUR, runway: 12d',
        // EMA runway >= 999 is shown as infinity; EXCEEDED beats WARNING.
        'Fun: 120.00 EUR/100.00 EUR (120%) [EXCEEDED] | burn: 12.00 EUR/day, projected: 372.00 EUR, runway: ∞',
        // No spending: zero burn means unlimited runway.
        'Rent: 0.00 EUR/50.00 EUR (0%) [OK] | burn: 0.00 EUR/day, projected: 0.00 EUR, runway: ∞',
        // 95% of the limit, not over it: WARNING.
        'Bills: 95.00 EUR/100.00 EUR (95%) [WARNING] | burn: 9.50 EUR/day, projected: 294.50 EUR, runway: 1d',
        `Gifts: ${formatAmount(giftsSpent, 'RSD', true)}/1000.00 RSD (58%) [OK] | burn: ${formatAmount(giftsDaily, 'RSD', true)}/day, projected: ${formatAmount(giftsDaily * 31, 'RSD', true)}, runway: 7d`,
        '',
        // Grand total sums only budgeted categories (Other is left out); EUR limit total is
        // 750 EUR + 1000 RSD converted back.
        `Grand Total: 460.00 EUR/${formatAmount(750 + convertCurrency(1000, 'RSD', 'EUR'), 'EUR', true)} (${Math.round((460 / (750 + convertCurrency(1000, 'RSD', 'EUR'))) * 100)}%) | burn: 46.00 EUR/day, projected: 1426.00 EUR, 21d left`,
        '',
      ].join('\n'),
    });
  });

  test('category filter is case-insensitive and shrinks the grand total to the filtered budgets', async () => {
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_g: number, m: string) => [
      budget('Food', 300, 'EUR', m),
      budget('Transport', 200, 'EUR', m),
      budget('Rent', 50, 'EUR', m),
    ]);
    mockExpenses.findByDateRange.mockReturnValue([
      spend(1, 'Food', '2026-03-05', 150),
      spend(2, 'Transport', '2026-03-05', 90),
    ]);

    const result = await executeTool(
      'get_budgets',
      { month: '2026-03', category: ['food', 'RENT'] },
      ctx,
    );

    expect(result.output).toBe(
      [
        'Budgets for 2026-03 (day 10/31):',
        '',
        'Food: 150.00 EUR/300.00 EUR (50%) [OK] | burn: 15.00 EUR/day, projected: 465.00 EUR, runway: 10d',
        'Rent: 0.00 EUR/50.00 EUR (0%) [OK] | burn: 0.00 EUR/day, projected: 0.00 EUR, runway: ∞',
        '',
        'Grand Total: 150.00 EUR/350.00 EUR (43%) | burn: 15.00 EUR/day, projected: 465.00 EUR, 21d left',
        '',
      ].join('\n'),
    );
  });

  test('past month: no burn details, grand total without projection, spending after the month is ignored', async () => {
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_g: number, m: string) => [
      budget('Food', 200, 'EUR', m),
    ]);
    mockExpenses.findByDateRange.mockReturnValue([spend(1, 'Food', '2026-01-20', 50)]);

    const result = await executeTool('get_budgets', { month: '2026-01' }, ctx);

    expect(mockExpenses.findByDateRange).toHaveBeenCalledWith(1, '2026-01-01', '2026-01-31');
    expect(mockGetFinancialSnapshot).not.toHaveBeenCalled();
    expect(result.output).toBe(
      [
        'Budgets for 2026-01 (day 31/31):',
        '',
        'Food: 50.00 EUR/200.00 EUR (25%) [OK]',
        '',
        'Grand Total: 50.00 EUR/200.00 EUR (25%)',
        '',
      ].join('\n'),
    );
  });

  test('zero limits (disabled budgets) give a 0% grand total instead of dividing by zero', async () => {
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_g: number, m: string) => [
      budget('Food', 0, 'EUR', m),
    ]);
    mockExpenses.findByDateRange.mockReturnValue([spend(1, 'Food', '2026-01-20', 50)]);

    const result = await executeTool('get_budgets', { month: '2026-01' }, ctx);

    expect(result.output).toContain('Food: 50.00 EUR/0.00 EUR (0%) [EXCEEDED]');
    expect(result.output).toContain('Grand Total: 50.00 EUR/0.00 EUR (0%)');
  });

  test('grand total is shown in the group default currency', async () => {
    const group = mockGroups.findById();
    if (!group) throw new Error('fixture group missing');
    mockGroups.findById.mockReturnValue({ ...group, default_currency: 'USD' });
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_g: number, m: string) => [
      budget('Food', 200, 'EUR', m),
    ]);
    mockExpenses.findByDateRange.mockReturnValue([spend(1, 'Food', '2026-01-20', 50)]);

    const result = await executeTool('get_budgets', { month: '2026-01' }, ctx);

    const spentUsd = convertCurrency(50, 'EUR', 'USD');
    const limitUsd = convertCurrency(200, 'EUR', 'USD');
    expect(result.output).toContain(
      `Grand Total: ${formatAmount(spentUsd, 'USD', true)}/${formatAmount(limitUsd, 'USD', true)} (25%)`,
    );
  });

  test('single month without budgets', async () => {
    const result = await executeTool('get_budgets', { month: '2026-01' }, ctx);

    expect(result).toEqual({ success: true, output: 'No budgets set for 2026-01.' });
    expect(mockExpenses.findByDateRange).not.toHaveBeenCalled();
  });

  test('category filter that matches nothing reports no budgets', async () => {
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_g: number, m: string) => [
      budget('Food', 200, 'EUR', m),
    ]);

    const result = await executeTool('get_budgets', { month: '2026-01', category: 'Pets' }, ctx);

    expect(result).toEqual({ success: true, output: 'No budgets set for 2026-01.' });
  });

  test('burn rates are only requested when the current month is in the list', async () => {
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_g: number, m: string) => [
      budget('Food', 200, 'EUR', m),
    ]);

    await executeTool('get_budgets', { month: ['2026-01', '2026-02'] }, ctx);
    expect(mockGetFinancialSnapshot).not.toHaveBeenCalled();

    await executeTool('get_budgets', { month: ['2026-02', '2026-03'] }, ctx);
    expect(mockGetFinancialSnapshot).toHaveBeenCalledWith(1);
  });

  test('batch: per-month sections, empty month note, current month details, grand total over all expenses', async () => {
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_g: number, m: string) =>
      m === '2026-02' ? [] : [budget('Food', 200, 'EUR', m)],
    );
    mockExpenses.findByDateRange.mockImplementation((_g: number, start: string): Expense[] => {
      if (start === '2026-01-01') {
        return [spend(1, 'Food', '2026-01-05', 50), spend(2, 'Other', '2026-01-06', 25)];
      }
      return [spend(3, 'Food', '2026-03-02', 100)];
    });

    const result = await executeTool(
      'get_budgets',
      { month: ['2026-01', '2026-02', '2026-03'] },
      ctx,
    );

    expect(result.output).toBe(
      [
        '=== 2026-01 ===',
        'Food: 50.00 EUR/200.00 EUR (25%) [OK]',
        '',
        '=== 2026-02 ===',
        'No budgets set.',
        '',
        '=== 2026-03 ===',
        'Food: 100.00 EUR/200.00 EUR (50%) [OK] | burn: 10.00 EUR/day, projected: 310.00 EUR, runway: 10d',
        '',
        // 50 + 25 (unbudgeted "Other" included) + 100.
        '=== Grand Total (3 months) ===',
        '175.00 EUR',
      ].join('\n'),
    );
  });

  test('batch without any spending has no grand total section', async () => {
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_g: number, m: string) => [
      budget('Food', 200, 'EUR', m),
    ]);

    const result = await executeTool('get_budgets', { month: ['2026-01', '2026-02'] }, ctx);

    expect(result.output).toBe(
      [
        '=== 2026-01 ===',
        'Food: 0.00 EUR/200.00 EUR (0%) [OK]',
        '',
        '=== 2026-02 ===',
        'Food: 0.00 EUR/200.00 EUR (0%) [OK]',
        '',
      ].join('\n'),
    );
  });

  test('batch grand total is converted into the group default currency', async () => {
    const group = mockGroups.findById();
    if (!group) throw new Error('fixture group missing');
    mockGroups.findById.mockReturnValue({ ...group, default_currency: 'RSD' });
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_g: number, m: string) => [
      budget('Food', 200, 'EUR', m),
    ]);
    mockExpenses.findByDateRange.mockReturnValue([spend(1, 'Food', '2026-01-20', 50)]);

    const result = await executeTool('get_budgets', { month: ['2026-01', '2026-02'] }, ctx);

    // Each month's query returns the same 50 EUR, so two months add up to 100 EUR.
    expect(
      result.output?.endsWith(
        `=== Grand Total (2 months) ===\n${formatAmount(convertCurrency(100, 'EUR', 'RSD'), 'RSD', true)}`,
      ),
    ).toBe(true);
  });
});
