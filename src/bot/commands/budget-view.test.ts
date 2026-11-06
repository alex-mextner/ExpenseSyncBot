// Tests for the rich-text /budget view: Russian month, aligned <pre> table, totals, markers, 4096 split

import { mock } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import { createMockLogger } from '../../test-utils/mocks/logger';

interface BudgetStub {
  category: string;
  limit_amount: number;
  currency: CurrencyCode;
}

const mockExpenses = {
  getCategoryTotals: mock(
    (
      _groupId: number,
      _from: string,
      _to: string,
    ): Array<{ category: string; total: number }> => [],
  ),
};
const mockBudgets = {
  getAllBudgetsForMonth: mock((_groupId: number, _month: string): BudgetStub[] => []),
};
const mockGroups = {
  findById: mock((_id: number) => ({ id: 1, default_currency: 'EUR' as CurrencyCode })),
};

mock.module('../../database', () => ({
  database: { expenses: mockExpenses, budgets: mockBudgets, groups: mockGroups },
}));

const logMock = createMockLogger();
mock.module('../../utils/logger', () => ({ createLogger: () => logMock, logger: logMock }));

const snapshotMock = mock((_groupId: number): { technicalAnalysis: unknown } => ({
  technicalAnalysis: null,
}));
mock.module('../../services/analytics/spending-analytics', () => ({
  spendingAnalytics: { getFinancialSnapshot: snapshotMock },
}));

import { beforeEach, describe, expect, it } from 'bun:test';
import { formatBudgetProgress } from './budget-view';

const OCTOBER = new Date('2026-10-15T12:00:00Z');

function budget(category: string, limit: number, currency: CurrencyCode = 'EUR'): BudgetStub {
  return { category, limit_amount: limit, currency };
}

function render(now: Date = OCTOBER): { messages: string[]; hasBudgets: boolean } {
  return formatBudgetProgress(1, now);
}

function allText(): string {
  return render().messages.join('\n');
}

function tableRows(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/<\/?pre>/g, ''))
    .filter((line) => line.includes(' / ') && /[🟢🟡🔴]/u.test(line));
}

beforeEach(() => {
  mockExpenses.getCategoryTotals.mockReset();
  mockExpenses.getCategoryTotals.mockReturnValue([]);
  mockBudgets.getAllBudgetsForMonth.mockReset();
  mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);
  snapshotMock.mockReset();
  snapshotMock.mockReturnValue({ technicalAnalysis: null });
  logMock.error.mockClear();
  logMock.warn.mockClear();
});

describe('formatBudgetProgress', () => {
  it('reports no budgets with the localized month', () => {
    const result = render();
    expect(result.hasBudgets).toBe(false);
    expect(result.messages.join('\n')).toContain('Бюджеты не установлены');
    expect(result.messages.join('\n')).toContain('октябрь 2026');
  });

  it('uses Russian month names, not English ones', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([budget('Food', 500)]);
    const september = formatBudgetProgress(1, new Date('2026-09-02T12:00:00Z')).messages.join('\n');
    expect(september).toContain('сентябрь 2026');
    expect(september).not.toContain('September');
    expect(allText()).toContain('<b>');
  });

  it('renders categories inside an HTML <pre> table with matching tags', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([budget('Food', 500), budget('Rent', 900)]);
    const text = allText();
    expect(text.match(/<pre>/g)?.length).toBe(text.match(/<\/pre>/g)?.length);
    expect(text).toContain('<pre>');
    expect(tableRows(text)).toHaveLength(2);
  });

  it('aligns the amount separator across rows', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      budget('Food', 500),
      budget('Transportation costs', 1200),
      budget('Hi', 50),
    ]);
    mockExpenses.getCategoryTotals.mockReturnValue([{ category: 'Food', total: 77 }]);
    const rows = tableRows(allText());
    const positions = rows.map((row) => row.indexOf(' / '));
    expect(rows).toHaveLength(3);
    expect(new Set(positions).size).toBe(1);
  });

  it('escapes HTML in category names', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([budget('R&D <b>', 100)]);
    const text = allText();
    expect(text).toContain('R&amp;D &lt;b&gt;');
    expect(text).not.toContain('R&D <b>');
  });

  it('shows per-currency totals plus a combined line for mixed currencies', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      budget('Food', 500, 'EUR'),
      budget('Taxi', 20000, 'RSD'),
    ]);
    const text = allText();
    expect(text).toContain('Итого EUR');
    expect(text).toContain('Итого RSD');
    expect(text).toContain('Всего');
  });

  it('does not add a combined line for a single currency', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([budget('Food', 500), budget('Rent', 900)]);
    const text = allText();
    expect(text).toContain('Итого EUR');
    expect(text).not.toContain('Всего');
  });

  it('orders rows by usage percentage, highest first', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([budget('Low', 1000), budget('High', 100)]);
    mockExpenses.getCategoryTotals.mockReturnValue([
      { category: 'Low', total: 100 },
      { category: 'High', total: 90 },
    ]);
    const text = allText();
    expect(text.indexOf('High')).toBeLessThan(text.indexOf('Low'));
  });

  it('marks under-limit, warning and exceeded budgets differently', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      budget('Calm', 100),
      budget('Warn', 100),
      budget('Over', 100),
    ]);
    mockExpenses.getCategoryTotals.mockReturnValue([
      { category: 'Calm', total: 10 },
      { category: 'Warn', total: 95 },
      { category: 'Over', total: 150 },
    ]);
    const rows = tableRows(allText());
    expect(rows.find((r) => r.includes('Calm'))).toContain('🟢');
    expect(rows.find((r) => r.includes('Warn'))).toContain('🟡');
    expect(rows.find((r) => r.includes('Over'))).toContain('🔴');
  });

  it('shows 0% when nothing was spent', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([budget('Food', 1000)]);
    expect(allText()).toContain('0%');
  });

  it('adds forecast insights for categories heading over budget', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([budget('Food', 100)]);
    snapshotMock.mockReturnValue({
      technicalAnalysis: {
        categories: [
          {
            category: 'Food',
            forecasts: { ensemble: 150 },
            trend: { direction: 'rising', confidence: 0.9 },
            anomaly: { isAnomaly: false },
          },
        ],
      },
    });
    expect(allText()).toContain('Прогноз');
  });

  it('splits long output into valid messages under 4096 characters', () => {
    const many = Array.from({ length: 220 }, (_, i) =>
      budget(`Category <${i}> with a very long name & more`, 100 + i),
    );
    mockBudgets.getAllBudgetsForMonth.mockReturnValue(many);
    const result = render();
    expect(result.messages.length).toBeGreaterThan(1);
    for (const message of result.messages) {
      expect(message.length).toBeLessThanOrEqual(4096);
      expect(message.match(/<pre>/g)?.length ?? 0).toBe(message.match(/<\/pre>/g)?.length ?? 0);
    }
    expect(result.messages.join('\n')).toContain('Category &lt;219&gt;');
  });

  it('does not log errors on the happy path', () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([budget('Food', 500)]);
    render();
    expect(logMock.error).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});
