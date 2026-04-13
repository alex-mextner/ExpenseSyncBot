import { describe, expect, mock, test } from 'bun:test';
import type { BankAccount, BankTransaction } from '../../database/types';
import { makeBankTransaction } from '../../test-utils/fixtures';
import { mockDatabase } from '../../test-utils/mocks/database';

const bankAccountsFindByGroupId = mock(() => [] as BankAccount[]);
const bankTransactionsFindByGroupId = mock(() => [] as BankTransaction[]);

mock.module('../../database', () => ({
  database: mockDatabase({
    bankAccounts: { findByGroupId: bankAccountsFindByGroupId },
    bankTransactions: { findByGroupId: bankTransactionsFindByGroupId },
  }),
}));

import { computeOverallSeverity, formatSnapshotForPrompt } from './formatters';

import type {
  BudgetBurnRate,
  CategoryAnomaly,
  FinancialSnapshot,
  MonthlyProjection,
  SpendingStreak,
  SpendingTrend,
  SpendingVelocity,
} from './types';

// === Helpers to build test data ===

function makeTrend(overrides: Partial<SpendingTrend> = {}): SpendingTrend {
  return {
    period: 'week',
    current_total: 10000,
    previous_total: 10000,
    change_percent: 0,
    direction: 'stable',
    category_changes: [],
    ...overrides,
  };
}

function makeVelocity(overrides: Partial<SpendingVelocity> = {}): SpendingVelocity {
  return {
    period_1_daily_avg: 1000,
    period_2_daily_avg: 1000,
    acceleration: 0,
    trend: 'stable',
    ...overrides,
  };
}

function makeStreak(overrides: Partial<SpendingStreak> = {}): SpendingStreak {
  return {
    current_streak_days: 0,
    streak_type: 'below_average',
    avg_daily_during_streak: 500,
    overall_daily_average: 1000,
    ...overrides,
  };
}

function makeBurnRate(overrides: Partial<BudgetBurnRate> = {}): BudgetBurnRate {
  return {
    category: 'food',
    budget_limit: 50000,
    spent: 25000,
    currency: 'EUR',
    days_elapsed: 15,
    days_remaining: 15,
    daily_burn_rate: 1667,
    projected_total: 50000,
    projected_overshoot: 0,
    runway_days: 15,
    status: 'on_track',
    ...overrides,
  };
}

function makeAnomaly(overrides: Partial<CategoryAnomaly> = {}): CategoryAnomaly {
  return {
    category: 'entertainment',
    current_month_total: 20000,
    avg_3_month: 8000,
    deviation_ratio: 2.5,
    severity: 'significant',
    ...overrides,
  };
}

function makeProjection(overrides: Partial<MonthlyProjection> = {}): MonthlyProjection {
  return {
    days_elapsed: 15,
    days_in_month: 30,
    current_total: 75000,
    projected_total: 150000,
    projected_vs_last_month: 10,
    confidence: 'medium',
    category_projections: [],
    ...overrides,
  };
}

function makeBankAccount(overrides: Partial<BankAccount> = {}): BankAccount {
  return {
    id: 1,
    connection_id: 1,
    account_id: 'acc1',
    title: 'Main Card',
    balance: 1000,
    currency: 'EUR',
    type: 'card',
    is_excluded: 0,
    updated_at: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return {
    burnRates: [],
    weekTrend: makeTrend({ period: 'week' }),
    monthTrend: makeTrend({ period: 'month' }),
    anomalies: [],
    dayOfWeekPatterns: [],
    velocity: makeVelocity(),
    budgetUtilization: null,
    streak: makeStreak(),
    projection: null,
    technicalAnalysis: null,
    ...overrides,
  };
}

// === Tests ===

describe('computeOverallSeverity', () => {
  test('budget exceeded → critical', () => {
    const snapshot = makeSnapshot({
      burnRates: [makeBurnRate({ status: 'exceeded' })],
    });
    expect(computeOverallSeverity(snapshot)).toBe('critical');
  });

  test('extreme anomaly → critical', () => {
    const snapshot = makeSnapshot({
      anomalies: [makeAnomaly({ severity: 'extreme' })],
    });
    expect(computeOverallSeverity(snapshot)).toBe('critical');
  });

  test('critical burn rate without exceeded budget → concern', () => {
    const snapshot = makeSnapshot({
      burnRates: [makeBurnRate({ status: 'critical' })],
    });
    expect(computeOverallSeverity(snapshot)).toBe('concern');
  });

  test('significant anomaly → concern', () => {
    const snapshot = makeSnapshot({
      anomalies: [makeAnomaly({ severity: 'significant' })],
    });
    expect(computeOverallSeverity(snapshot)).toBe('concern');
  });

  test('warning burn rate → watch', () => {
    const snapshot = makeSnapshot({
      burnRates: [makeBurnRate({ status: 'warning' })],
    });
    expect(computeOverallSeverity(snapshot)).toBe('watch');
  });

  test('everything clean → good', () => {
    const snapshot = makeSnapshot();
    expect(computeOverallSeverity(snapshot)).toBe('good');
  });
});

describe('formatSnapshotForPrompt — burn rates section', () => {
  test('includes category, spent/limit, percentage', () => {
    const snapshot = makeSnapshot({
      burnRates: [
        makeBurnRate({
          category: 'food',
          spent: 35000,
          budget_limit: 50000,
          currency: 'EUR',
          daily_burn_rate: 2333,
          projected_total: 70000,
          runway_days: 6,
          status: 'warning',
        }),
      ],
    });
    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('BURN RATE');
    expect(output).toContain('food');
    expect(output).toContain('350.00 EUR');
    expect(output).toContain('500.00 EUR');
    expect(output).toContain('70%');
    expect(output).toContain('23.33');
    expect(output).toContain('700.00');
    expect(output).toContain('6 дней');
    expect(output).toContain('ВНИМАНИЕ');
  });

  test('empty burn rates — section omitted', () => {
    const snapshot = makeSnapshot({ burnRates: [] });
    const output = formatSnapshotForPrompt(snapshot, 0);
    expect(output).not.toContain('BURN RATE');
  });
});

describe('formatSnapshotForPrompt — trends section', () => {
  test('positive trend shows arrow up', () => {
    const snapshot = makeSnapshot({
      weekTrend: makeTrend({
        period: 'week',
        direction: 'up',
        change_percent: 25.3,
        current_total: 12500,
        previous_total: 10000,
      }),
    });
    const output = formatSnapshotForPrompt(snapshot, 0);
    expect(output).toContain('↑');
    expect(output).toContain('+25.3%');
  });

  test('negative trend shows arrow down', () => {
    const snapshot = makeSnapshot({
      monthTrend: makeTrend({
        period: 'month',
        direction: 'down',
        change_percent: -15.7,
        current_total: 8430,
        previous_total: 10000,
      }),
    });
    const output = formatSnapshotForPrompt(snapshot, 0);
    expect(output).toContain('↓');
    expect(output).toContain('-15.7%');
  });
});

describe('formatSnapshotForPrompt — anomalies section', () => {
  test('anomalies listed with severity', () => {
    const snapshot = makeSnapshot({
      anomalies: [
        makeAnomaly({
          category: 'taxi',
          current_month_total: 30000,
          avg_3_month: 10000,
          deviation_ratio: 3.0,
          severity: 'extreme',
        }),
      ],
    });
    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('АНОМАЛИИ');
    expect(output).toContain('taxi');
    expect(output).toContain('300.00');
    expect(output).toContain('100.00');
    expect(output).toContain('3.00x');
    expect(output).toContain('EXTREME');
  });

  test('empty anomalies — section omitted', () => {
    const snapshot = makeSnapshot({ anomalies: [] });
    const output = formatSnapshotForPrompt(snapshot, 0);
    expect(output).not.toContain('АНОМАЛИИ');
  });
});

describe('formatSnapshotForPrompt — projection section', () => {
  test('contains projected total', () => {
    const snapshot = makeSnapshot({
      projection: makeProjection({
        projected_total: 185050,
        current_total: 92000,
        days_elapsed: 15,
        days_in_month: 31,
        confidence: 'high',
      }),
    });
    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('ПРОГНОЗ');
    expect(output).toContain('1850.50');
    expect(output).toContain('920.00');
    expect(output).toContain('15/31');
    expect(output).toContain('высокая точность');
  });
});

describe('formatSnapshotForPrompt — full snapshot', () => {
  test('combines all sections into one non-empty string', () => {
    const snapshot = makeSnapshot({
      burnRates: [makeBurnRate({ status: 'warning' })],
      weekTrend: makeTrend({ direction: 'up', change_percent: 10 }),
      monthTrend: makeTrend({ direction: 'down', change_percent: -5 }),
      anomalies: [makeAnomaly({ severity: 'mild' })],
      projection: makeProjection(),
      velocity: makeVelocity({ trend: 'accelerating', acceleration: 30 }),
      streak: makeStreak({ current_streak_days: 5, streak_type: 'above_average' }),
      budgetUtilization: {
        total_budget: 200000,
        total_spent: 150000,
        remaining: 50000,
        utilization_percent: 75,
        remaining_percent: 25,
      },
    });
    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('BURN RATE');
    expect(output).toContain('ИСПОЛЬЗОВАНИЕ БЮДЖЕТА');
    expect(output).toContain('ТРЕНДЫ');
    expect(output).toContain('АНОМАЛИИ');
    expect(output).toContain('ПРОГНОЗ');
    expect(output).toContain('СКОРОСТЬ ТРАТ');
    expect(output).toContain('СЕРИЯ ТРАТ');
  });
});

describe('formatSnapshotForPrompt — bank sections', () => {
  test('includes bank balances when accounts exist', () => {
    bankAccountsFindByGroupId.mockReturnValueOnce([
      makeBankAccount({ title: 'Mastercard', balance: 1234.56, currency: 'EUR' }),
      makeBankAccount({ id: 2, title: 'Visa RSD', balance: 55000, currency: 'RSD' }),
    ]);

    const snapshot = makeSnapshot();
    const output = formatSnapshotForPrompt(snapshot, 1);

    expect(output).toContain('## Банковские балансы');
    expect(output).toContain('Mastercard: 1234.56 EUR');
    expect(output).toContain('Visa RSD: 55000.00 RSD');
  });

  test('includes confirmed bank transactions with merchant info', () => {
    bankTransactionsFindByGroupId.mockReturnValueOnce([
      makeBankTransaction({
        date: '2026-04-10',
        amount: -42.5,
        currency: 'EUR',
        merchant: 'LIDL STORE 123',
        merchant_normalized: 'Lidl',
      }),
      makeBankTransaction({
        id: 2,
        date: '2026-04-09',
        amount: -15,
        currency: 'EUR',
        merchant: 'Unknown Merchant',
        merchant_normalized: null,
      }),
      makeBankTransaction({
        id: 3,
        date: '2026-04-08',
        amount: -100,
        currency: 'RSD',
        merchant: null,
        merchant_normalized: null,
      }),
    ]);

    const snapshot = makeSnapshot();
    const output = formatSnapshotForPrompt(snapshot, 1);

    expect(output).toContain('## Подтверждённые банковские транзакции');
    // merchant_normalized takes precedence over merchant
    expect(output).toContain('2026-04-10 -42.5 EUR — Lidl');
    // falls back to merchant when merchant_normalized is null
    expect(output).toContain('2026-04-09 -15 EUR — Unknown Merchant');
    // falls back to dash when both are null
    expect(output).toContain('2026-04-08 -100 RSD — —');
  });

  test('only first 20 transactions are included (slice cap)', () => {
    const transactions = Array.from({ length: 25 }, (_, i) =>
      makeBankTransaction({
        id: i + 1,
        external_id: `tx${i + 1}`,
        date: '2026-04-10',
        amount: -(i + 1),
        currency: 'EUR',
        merchant: `Store ${i + 1}`,
      }),
    );
    bankTransactionsFindByGroupId.mockReturnValueOnce(transactions);

    const snapshot = makeSnapshot();
    const output = formatSnapshotForPrompt(snapshot, 1);

    expect(output).toContain('## Подтверждённые банковские транзакции');
    // First 20 should be present
    expect(output).toContain('Store 20');
    // Items 21-25 should be absent
    expect(output).not.toContain('Store 21');
    expect(output).not.toContain('Store 25');
  });

  test('bank sections omitted when no data exists', () => {
    // Default mocks return empty arrays
    const snapshot = makeSnapshot();
    const output = formatSnapshotForPrompt(snapshot, 1);

    expect(output).not.toContain('Банковские балансы');
    expect(output).not.toContain('Подтверждённые банковские транзакции');
  });
});
