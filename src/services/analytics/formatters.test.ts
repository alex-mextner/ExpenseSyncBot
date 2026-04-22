import { describe, expect, mock, test } from 'bun:test';
import type { BankAccount, BankTransaction } from '../../database/types';
import { makeBankTransaction } from '../../test-utils/fixtures';
import { mockDatabase } from '../../test-utils/mocks/database';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
// converter.ts imports './logger.ts' — suffix must match
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const bankAccountsFindByGroupId = mock(() => [] as BankAccount[]);
const bankTransactionsFindByGroupId = mock(() => [] as BankTransaction[]);

mock.module('../../database', () => ({
  database: mockDatabase({
    bankAccounts: { findByGroupId: bankAccountsFindByGroupId },
    bankTransactions: { findByGroupId: bankTransactionsFindByGroupId },
  }),
}));

import { computeOverallSeverity, formatSnapshotForPrompt } from './formatters';

import type { CategoryTaAnalysis } from './ta/analyzer';
import type {
  BudgetBurnRate,
  CategoryAnomaly,
  FinancialSnapshot,
  MonthlyProjection,
  SpendingStreak,
  SpendingTrend,
  SpendingVelocity,
  TechnicalAnalysis,
} from './types';

// === Helpers to build test data ===

function makeTrend(overrides: Partial<SpendingTrend> = {}): SpendingTrend {
  return {
    period: 'week',
    current_total: 100,
    previous_total: 100,
    change_percent: 0,
    direction: 'stable',
    category_changes: [],
    ...overrides,
  };
}

function makeVelocity(overrides: Partial<SpendingVelocity> = {}): SpendingVelocity {
  return {
    period_1_daily_avg: 10,
    period_2_daily_avg: 10,
    acceleration: 0,
    trend: 'stable',
    ...overrides,
  };
}

function makeStreak(overrides: Partial<SpendingStreak> = {}): SpendingStreak {
  return {
    current_streak_days: 0,
    streak_type: 'below_average',
    avg_daily_during_streak: 5,
    overall_daily_average: 10,
    ...overrides,
  };
}

function makeBurnRate(overrides: Partial<BudgetBurnRate> = {}): BudgetBurnRate {
  return {
    category: 'food',
    budget_limit: 500,
    spent: 250,
    currency: 'EUR',
    days_elapsed: 15,
    days_remaining: 15,
    daily_burn_rate: 16.67,
    projected_total: 500,
    projected_overshoot: 0,
    runway_days: 15,
    status: 'on_track',
    ...overrides,
  };
}

function makeAnomaly(overrides: Partial<CategoryAnomaly> = {}): CategoryAnomaly {
  return {
    category: 'entertainment',
    current_month_total: 200,
    avg_3_month: 80,
    deviation_ratio: 2.5,
    severity: 'significant',
    ...overrides,
  };
}

function makeProjection(overrides: Partial<MonthlyProjection> = {}): MonthlyProjection {
  return {
    days_elapsed: 15,
    days_in_month: 30,
    current_total: 750,
    projected_total: 1500,
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
          spent: 350,
          budget_limit: 500,
          currency: 'EUR',
          daily_burn_rate: 23.33,
          projected_total: 700,
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
        current_total: 125,
        previous_total: 100,
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
        current_total: 84.3,
        previous_total: 100,
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
          current_month_total: 300,
          avg_3_month: 100,
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
        projected_total: 1850.5,
        current_total: 920,
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
        total_budget: 2000,
        total_spent: 1500,
        remaining: 500,
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

// === Coverage for trends category-changes branch ===

describe('formatSnapshotForPrompt — significant category changes in week trend', () => {
  test('lists up to three significant category changes', () => {
    const snapshot = makeSnapshot({
      weekTrend: makeTrend({
        period: 'week',
        direction: 'up',
        change_percent: 40,
        current_total: 140,
        previous_total: 100,
        category_changes: [
          { category: 'taxi', current: 60, previous: 20, change_percent: 200 },
          { category: 'food', current: 40, previous: 80, change_percent: -50 },
          { category: 'beer', current: 30, previous: 10, change_percent: 200 },
          // below the 20% threshold — must be skipped
          { category: 'utilities', current: 50, previous: 48, change_percent: 4 },
          // both current and previous are tiny (≤5) — must be skipped even with huge %
          { category: 'dust', current: 2, previous: 1, change_percent: 100 },
          // extra big one — should be cut off by slice(0, 3)
          { category: 'shopping', current: 90, previous: 30, change_percent: 200 },
        ],
      }),
    });

    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('taxi');
    expect(output).toContain('food');
    expect(output).toContain('beer');
    expect(output).not.toContain('utilities'); // under threshold
    expect(output).not.toContain('dust'); // too small in absolute terms
    expect(output).not.toContain('shopping'); // cut by slice(0, 3)
    expect(output).toContain('+200%');
    expect(output).toContain('-50%');
  });
});

// === Coverage for budget utilization status branches ===

describe('formatSnapshotForPrompt — budget utilization status', () => {
  test('utilization > 100 → shows БЮДЖЕТ ПРЕВЫШЕН status', () => {
    const snapshot = makeSnapshot({
      budgetUtilization: {
        total_budget: 1000,
        total_spent: 1200,
        remaining: -200,
        utilization_percent: 120,
        remaining_percent: -20,
      },
    });

    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('ИСПОЛЬЗОВАНИЕ БЮДЖЕТА');
    expect(output).toContain('БЮДЖЕТ ПРЕВЫШЕН');
  });

  test('utilization between 90 and 100 → shows ПОЧТИ ИСЧЕРПАН status', () => {
    const snapshot = makeSnapshot({
      budgetUtilization: {
        total_budget: 1000,
        total_spent: 950,
        remaining: 50,
        utilization_percent: 95,
        remaining_percent: 5,
      },
    });

    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('ПОЧТИ ИСЧЕРПАН');
    expect(output).not.toContain('БЮДЖЕТ ПРЕВЫШЕН');
  });

  test('utilization under 90 → no warning status line', () => {
    const snapshot = makeSnapshot({
      budgetUtilization: {
        total_budget: 1000,
        total_spent: 400,
        remaining: 600,
        utilization_percent: 40,
        remaining_percent: 60,
      },
    });

    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('ИСПОЛЬЗОВАНИЕ БЮДЖЕТА');
    expect(output).not.toContain('БЮДЖЕТ ПРЕВЫШЕН');
    expect(output).not.toContain('ПОЧТИ ИСЧЕРПАН');
  });
});

// === Coverage for projection "will exceed budget" block ===

describe('formatSnapshotForPrompt — projection categories that will exceed budget', () => {
  test('lists exceeding categories with budget limit', () => {
    const snapshot = makeSnapshot({
      projection: makeProjection({
        projected_total: 2000,
        category_projections: [
          {
            category: 'food',
            current: 300,
            projected: 600,
            budget_limit: 500,
            will_exceed: true,
          },
          {
            category: 'taxi',
            current: 80,
            projected: 160,
            budget_limit: null,
            will_exceed: true,
          },
          {
            category: 'utilities',
            current: 50,
            projected: 100,
            budget_limit: 200,
            will_exceed: false,
          },
        ],
      }),
    });

    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('Категории, которые превысят бюджет');
    expect(output).toContain('food');
    expect(output).toContain('600.00');
    expect(output).toContain('500.00');
    // null budget_limit falls back to "—"
    expect(output).toContain('taxi');
    expect(output).toContain('—');
    // non-exceeding should not appear in that block
    expect(output).not.toContain('utilities');
  });

  test('omits "превысят бюджет" block when no categories will exceed', () => {
    const snapshot = makeSnapshot({
      projection: makeProjection({
        category_projections: [
          {
            category: 'food',
            current: 100,
            projected: 200,
            budget_limit: 500,
            will_exceed: false,
          },
        ],
      }),
    });

    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('ПРОГНОЗ');
    expect(output).not.toContain('Категории, которые превысят бюджет');
  });

  test('projected_vs_last_month > 0 shows comparison line', () => {
    const snapshot = makeSnapshot({
      projection: makeProjection({
        projected_vs_last_month: 22.4,
        confidence: 'low',
      }),
    });

    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('vs прошлый месяц');
    expect(output).toContain('22.4%');
    expect(output).toContain('НИЗКАЯ ТОЧНОСТЬ');
  });
});

// === Coverage for velocity / streak / severity edge cases ===

describe('formatSnapshotForPrompt — velocity', () => {
  test('decelerating velocity shows Замедление label', () => {
    const snapshot = makeSnapshot({
      velocity: makeVelocity({
        trend: 'decelerating',
        acceleration: -15,
        period_1_daily_avg: 20,
        period_2_daily_avg: 17,
      }),
    });

    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('СКОРОСТЬ ТРАТ');
    expect(output).toContain('Замедление');
    expect(output).toContain('-15');
  });

  test('stable velocity → section omitted', () => {
    const snapshot = makeSnapshot({ velocity: makeVelocity({ trend: 'stable' }) });
    const output = formatSnapshotForPrompt(snapshot, 0);
    expect(output).not.toContain('СКОРОСТЬ ТРАТ');
  });
});

describe('formatSnapshotForPrompt — streak', () => {
  test('below_average streak is labelled correctly', () => {
    const snapshot = makeSnapshot({
      streak: makeStreak({
        current_streak_days: 4,
        streak_type: 'below_average',
        avg_daily_during_streak: 3,
        overall_daily_average: 10,
      }),
    });
    const output = formatSnapshotForPrompt(snapshot, 0);
    expect(output).toContain('СЕРИЯ ТРАТ');
    expect(output).toContain('4 дней подряд ниже среднего');
  });

  test('streak under 3 days → section omitted', () => {
    const snapshot = makeSnapshot({ streak: makeStreak({ current_streak_days: 2 }) });
    const output = formatSnapshotForPrompt(snapshot, 0);
    expect(output).not.toContain('СЕРИЯ ТРАТ');
  });
});

// === Coverage for empty snapshot ===

describe('formatSnapshotForPrompt — empty states', () => {
  test('neutral snapshot yields only trends section', () => {
    const snapshot = makeSnapshot();
    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('ТРЕНДЫ');
    // All other sections omitted
    expect(output).not.toContain('BURN RATE');
    expect(output).not.toContain('ИСПОЛЬЗОВАНИЕ БЮДЖЕТА');
    expect(output).not.toContain('АНОМАЛИИ');
    expect(output).not.toContain('ПРОГНОЗ');
    expect(output).not.toContain('СКОРОСТЬ ТРАТ');
    expect(output).not.toContain('СЕРИЯ ТРАТ');
    expect(output).not.toContain('ТЕХНИЧЕСКИЙ АНАЛИЗ');
  });
});

describe('computeOverallSeverity — remaining branches', () => {
  test('high budget utilization (>90%) without other signals → concern', () => {
    const snapshot = makeSnapshot({
      budgetUtilization: {
        total_budget: 1000,
        total_spent: 950,
        remaining: 50,
        utilization_percent: 95,
        remaining_percent: 5,
      },
    });
    expect(computeOverallSeverity(snapshot)).toBe('concern');
  });

  test('accelerating velocity > 20% without burn alarms → watch', () => {
    const snapshot = makeSnapshot({
      velocity: makeVelocity({ trend: 'accelerating', acceleration: 25 }),
    });
    expect(computeOverallSeverity(snapshot)).toBe('watch');
  });

  test('mild anomaly alone → watch', () => {
    const snapshot = makeSnapshot({ anomalies: [makeAnomaly({ severity: 'mild' })] });
    expect(computeOverallSeverity(snapshot)).toBe('watch');
  });
});

// === Helpers and coverage for formatTechnicalAnalysis ===

function makeTaCategory(overrides: Partial<CategoryTaAnalysis> = {}): CategoryTaAnalysis {
  const base: CategoryTaAnalysis = {
    category: 'food',
    monthsOfData: 8,
    currentMonthSpent: 450,
    forecasts: {
      sma3: 400,
      wma3: 410,
      kama: 420,
      median: 390,
      holt: { forecast: 405, level: 400, trend: 5 },
      theta: { forecast: 415 },
      quantiles: { p50: 400, p75: 470, p90: 530, p95: 560 },
      croston: null,
      holtWinters: null,
      ensemble: 410,
    },
    volatility: {
      bollingerBands: {
        upper: 520,
        middle: 400,
        lower: 280,
        bandwidth: 0.6,
        percentB: 0.5,
      },
      atr: 50,
      keltner: { upper: 500, middle: 400, lower: 300 },
      donchian: {
        upper: 600,
        middle: 450,
        lower: 300,
        isBreakoutHigh: false,
        isBreakoutLow: false,
      },
      historicalVol: 15,
      maEnvelopes: { upper: 480, middle: 400, lower: 320 },
      percentiles: { p10: 250, p25: 320, p50: 400, p75: 470, p90: 530 },
    },
    anomaly: {
      zScore: { zScore: 1.0, isAnomaly: false, direction: null },
      modifiedZScore: { zScore: 0.9, isAnomaly: false, direction: null },
      iqr: { q1: 320, q3: 470, iqr: 150, lowerBound: 100, upperBound: 700, isOutlier: false },
      isAnomaly: false,
      anomalyCount: 0,
    },
    trend: {
      regression: { slope: 1, intercept: 350, r2: 0.5, forecast: 420, monthlyChange: 1 },
      cusum: { values: [0, 1, 2], shiftDetected: false, shiftIndex: -1 },
      rsi: { value: 55, signal: 'neutral' },
      macd: { macd: 1, signal: 0.5, histogram: 0.5, crossover: 'none' },
      roc1: 2,
      roc3: 5,
      momentum3: 10,
      ewmaControl: { outOfControl: false, value: 410 },
      changePoints: [],
      hurst: { value: 0.5, type: 'random_walk' },
      pivotPoints: { pivot: 400, resistance1: 450, resistance2: 500, support1: 350, support2: 300 },
      direction: 'stable',
      confidence: 0.6,
    },
  };
  return { ...base, ...overrides };
}

describe('formatSnapshotForPrompt — technical analysis section', () => {
  test('stable category with no signals — minimal line', () => {
    const ta: TechnicalAnalysis = {
      categories: [makeTaCategory()],
      correlations: [],
    };

    const snapshot = makeSnapshot({ technicalAnalysis: ta });
    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('ТЕХНИЧЕСКИЙ АНАЛИЗ');
    expect(output).toContain('food');
    expect(output).toContain('(8 мес)');
    expect(output).toContain('Текущий месяц: 450');
    expect(output).toContain('Тренд: стабильно');
    expect(output).toContain('60%');
    expect(output).toContain('Прогноз: 410');
    expect(output).toContain('P50=400');
    expect(output).toContain('P75=470');
    expect(output).toContain('P90=530');
  });

  test('rising trend with extreme Bollinger %B, anomaly, MACD, RSI, change points, Hurst, Croston', () => {
    const ta: TechnicalAnalysis = {
      categories: [
        makeTaCategory({
          category: 'taxi',
          currentMonthSpent: 0, // covers the "hide current month" branch
          monthsOfData: 12,
          volatility: {
            bollingerBands: {
              upper: 520,
              middle: 400,
              lower: 280,
              bandwidth: 0.6,
              percentB: 0.95,
            },
            atr: 40,
            keltner: { upper: 500, middle: 400, lower: 300 },
            donchian: {
              upper: 600,
              middle: 450,
              lower: 300,
              isBreakoutHigh: true,
              isBreakoutLow: false,
            },
            historicalVol: 10,
            maEnvelopes: { upper: 480, middle: 400, lower: 320 },
            percentiles: { p10: 250, p25: 320, p50: 400, p75: 470, p90: 530 },
          },
          anomaly: {
            zScore: { zScore: 3, isAnomaly: true, direction: 'high' },
            modifiedZScore: { zScore: 3.1, isAnomaly: true, direction: 'high' },
            iqr: { q1: 320, q3: 470, iqr: 150, lowerBound: 100, upperBound: 700, isOutlier: true },
            isAnomaly: true,
            anomalyCount: 3,
          },
          trend: {
            regression: { slope: 10, intercept: 300, r2: 0.95, forecast: 500, monthlyChange: 10 },
            cusum: { values: [0, 5, 12], shiftDetected: true, shiftIndex: 2 },
            rsi: { value: 82, signal: 'overbought' },
            macd: { macd: 2, signal: 0.5, histogram: 1.5, crossover: 'bullish' },
            roc1: 15,
            roc3: 40,
            momentum3: 50,
            ewmaControl: { outOfControl: true, value: 500 },
            changePoints: [3, 7],
            hurst: { value: 0.8, type: 'trending' },
            pivotPoints: {
              pivot: 400,
              resistance1: 450,
              resistance2: 500,
              support1: 350,
              support2: 300,
            },
            direction: 'rising',
            confidence: 0.9,
          },
          forecasts: {
            sma3: 400,
            wma3: 410,
            kama: 420,
            median: 390,
            holt: { forecast: 500, level: 480, trend: 20 },
            theta: { forecast: 510 },
            quantiles: { p50: 450, p75: 520, p90: 600, p95: 650 },
            croston: { forecast: 200, expectedAmount: 180, expectedInterval: 1.5 },
            holtWinters: null,
            ensemble: 500,
          },
        }),
      ],
      correlations: [
        {
          category1: 'taxi',
          category2: 'food',
          correlation: 0.75,
          strength: 'strong_positive',
        },
        {
          category1: 'alcohol',
          category2: 'bars',
          correlation: -0.4,
          strength: 'moderate_negative',
        },
      ],
    };

    const snapshot = makeSnapshot({ technicalAnalysis: ta });
    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('taxi');
    expect(output).toContain('Тренд: растёт');
    // currentMonthSpent = 0 — should NOT produce "Текущий месяц: 0"
    expect(output).not.toContain('Текущий месяц: 0');
    expect(output).toContain('выше полосы Боллинджера');
    expect(output).toContain('аномалия (3/3)');
    expect(output).toContain('MACD рост');
    expect(output).toContain('RSI 82');
    expect(output).toContain('2 смен режима');
    expect(output).toContain('Hurst 0.80 трендовая');
    expect(output).toContain('Кростон: ~180 / 1.5 мес');
    expect(output).toContain('Корреляции');
    expect(output).toContain('taxi ↔ food: r=+0.75');
    expect(output).toContain('alcohol ↔ bars: r=-0.40');
  });

  test('falling trend, MACD bearish, low Bollinger %B, mean-reverting Hurst', () => {
    const ta: TechnicalAnalysis = {
      categories: [
        makeTaCategory({
          category: 'shopping',
          volatility: {
            bollingerBands: {
              upper: 520,
              middle: 400,
              lower: 280,
              bandwidth: 0.6,
              percentB: 0.05,
            },
            atr: 30,
            keltner: { upper: 500, middle: 400, lower: 300 },
            donchian: {
              upper: 600,
              middle: 450,
              lower: 300,
              isBreakoutHigh: false,
              isBreakoutLow: true,
            },
            historicalVol: 8,
            maEnvelopes: { upper: 480, middle: 400, lower: 320 },
            percentiles: { p10: 250, p25: 320, p50: 400, p75: 470, p90: 530 },
          },
          trend: {
            regression: { slope: -5, intercept: 500, r2: 0.7, forecast: 300, monthlyChange: -5 },
            cusum: { values: [0, -2, -5], shiftDetected: false, shiftIndex: -1 },
            rsi: { value: 15, signal: 'oversold' },
            macd: { macd: -1, signal: -0.3, histogram: -0.7, crossover: 'bearish' },
            roc1: -8,
            roc3: -20,
            momentum3: -15,
            ewmaControl: { outOfControl: false, value: 350 },
            changePoints: [],
            hurst: { value: 0.25, type: 'mean_reverting' },
            pivotPoints: {
              pivot: 400,
              resistance1: 450,
              resistance2: 500,
              support1: 350,
              support2: 300,
            },
            direction: 'falling',
            confidence: 0.55,
          },
        }),
      ],
      correlations: [],
    };

    const snapshot = makeSnapshot({ technicalAnalysis: ta });
    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('Тренд: падает');
    expect(output).toContain('ниже полосы Боллинджера');
    expect(output).toContain('MACD снижение');
    expect(output).toContain('RSI 15');
    expect(output).toContain('Hurst 0.25 возвратная');
  });

  test('more than five correlations are truncated to first five', () => {
    const makeCorr = (i: number) => ({
      category1: `c${i}`,
      category2: `d${i}`,
      correlation: 0.6,
      strength: 'moderate_positive' as const,
    });
    const ta: TechnicalAnalysis = {
      categories: [makeTaCategory()],
      correlations: Array.from({ length: 7 }, (_, i) => makeCorr(i + 1)),
    };

    const snapshot = makeSnapshot({ technicalAnalysis: ta });
    const output = formatSnapshotForPrompt(snapshot, 0);

    expect(output).toContain('c1 ↔ d1');
    expect(output).toContain('c5 ↔ d5');
    expect(output).not.toContain('c6 ↔ d6');
    expect(output).not.toContain('c7 ↔ d7');
  });
});
