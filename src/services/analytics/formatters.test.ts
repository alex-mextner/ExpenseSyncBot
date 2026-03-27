import { describe, expect, test } from 'bun:test';
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
