// Tests for formatBudgetProgressText — budget progress formatting for /budget and cron

import { mock } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import { createMockLogger } from '../../test-utils/mocks/logger';

// ── Mock database ──

const mockExpenses = {
  findByDateRange: mock(
    (
      _groupId: number,
      _from: string,
      _to: string,
    ): Array<{ category: string; eur_amount: number }> => [],
  ),
};

const mockBudgets = {
  getAllBudgetsForMonth: mock(
    (
      _groupId: number,
      _month: string,
    ): Array<{
      category: string;
      limit_amount: number;
      currency: CurrencyCode;
    }> => [],
  ),
};

mock.module('../../database', () => ({
  database: {
    expenses: mockExpenses,
    budgets: mockBudgets,
  },
}));

mock.module('../../services/currency/converter', () => ({
  convertCurrency: mock((amount: number) => amount),
  formatAmount: mock((amount: number, currency: string) => `${amount} ${currency}`),
}));

const logMock = createMockLogger();
mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

mock.module('../../services/analytics/spending-analytics', () => ({
  spendingAnalytics: {
    getFinancialSnapshot: () => ({ technicalAnalysis: null }),
  },
}));

// ── Import after mocks ──

import { beforeEach, describe, expect, it } from 'bun:test';
import { formatBudgetProgressText } from './budget';

beforeEach(() => {
  mockExpenses.findByDateRange.mockReset();
  mockExpenses.findByDateRange.mockReturnValue([]);
  mockBudgets.getAllBudgetsForMonth.mockReset();
  mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);
});

describe('formatBudgetProgressText', () => {
  it('returns hasBudgets=false when no budgets exist', () => {
    const result = formatBudgetProgressText(1);

    expect(result.hasBudgets).toBe(false);
    expect(result.text).toContain('Бюджеты не установлены');
  });

  it('includes month name in header', () => {
    const result = formatBudgetProgressText(1);

    // Should contain "Бюджет на <month name>"
    expect(result.text).toMatch(/Бюджет на /);
  });

  it('returns hasBudgets=true when budgets exist', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 500, currency: 'EUR' as CurrencyCode },
    ]);

    const result = formatBudgetProgressText(1);

    expect(result.hasBudgets).toBe(true);
    expect(result.text).toContain('Food');
    expect(result.text).toContain('500');
  });

  it('shows 0% when no expenses match budget category', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 1000, currency: 'EUR' as CurrencyCode },
    ]);

    const result = formatBudgetProgressText(1);

    expect(result.text).toContain('(0%)');
  });

  it('calculates correct percentage from expenses', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 1000, currency: 'EUR' as CurrencyCode },
    ]);
    mockExpenses.findByDateRange.mockReturnValue([{ category: 'Food', eur_amount: 500 }]);

    const result = formatBudgetProgressText(1);

    expect(result.text).toContain('(50%)');
  });

  it('shows (!) for exceeded budgets', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 100, currency: 'EUR' as CurrencyCode },
    ]);
    mockExpenses.findByDateRange.mockReturnValue([{ category: 'Food', eur_amount: 150 }]);

    const result = formatBudgetProgressText(1);

    expect(result.text).toContain('(!)');
  });

  it('shows (~) for warning budgets (>=90%)', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 100, currency: 'EUR' as CurrencyCode },
    ]);
    mockExpenses.findByDateRange.mockReturnValue([{ category: 'Food', eur_amount: 95 }]);

    const result = formatBudgetProgressText(1);

    expect(result.text).toContain('(~)');
  });

  it('shows total per currency', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 500, currency: 'EUR' as CurrencyCode },
      { category: 'Transport', limit_amount: 200, currency: 'EUR' as CurrencyCode },
    ]);

    const result = formatBudgetProgressText(1);

    expect(result.text).toContain('Всего (EUR)');
  });

  it('sorts budgets by percentage descending', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Low', limit_amount: 1000, currency: 'EUR' as CurrencyCode },
      { category: 'High', limit_amount: 100, currency: 'EUR' as CurrencyCode },
    ]);
    mockExpenses.findByDateRange.mockReturnValue([
      { category: 'Low', eur_amount: 100 },
      { category: 'High', eur_amount: 90 },
    ]);

    const result = formatBudgetProgressText(1);

    const highIdx = result.text.indexOf('High');
    const lowIdx = result.text.indexOf('Low');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('does not log errors on happy path', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 500, currency: 'EUR' as CurrencyCode },
    ]);

    formatBudgetProgressText(1);

    expect(logMock.error).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});
