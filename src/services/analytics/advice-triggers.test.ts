import { test, expect, describe, beforeEach, mock } from 'bun:test';
import type { FinancialSnapshot, BudgetBurnRate, CategoryAnomaly, SpendingVelocity, AdviceLog } from './types';

// ── Mock database ──────────────────────────────────────────────────────

const mockAdviceLogs = {
  countToday: mock(() => 0),
  hasTopicThisMonth: mock(() => false),
  getRecent: mock(() => [] as AdviceLog[]),
};

const mockExpenses = {
  getCountForRange: mock(() => 0),
};

mock.module('../../database', () => ({
  database: {
    adviceLogs: mockAdviceLogs,
    expenses: mockExpenses,
  },
}));

mock.module('./spending-analytics', () => ({
  spendingAnalytics: {
    getFinancialSnapshot: mock(() => buildNeutralSnapshot()),
  },
}));

// Import AFTER mocks are set up
const { checkSmartTriggers, recordAdviceSent } = await import('./advice-triggers');

// ── Helpers ────────────────────────────────────────────────────────────

function buildNeutralSnapshot(overrides: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return {
    burnRates: [],
    weekTrend: {
      period: 'week',
      current_total: 100,
      previous_total: 100,
      change_percent: 0,
      direction: 'stable',
      category_changes: [],
    },
    monthTrend: {
      period: 'month',
      current_total: 500,
      previous_total: 500,
      change_percent: 0,
      direction: 'stable',
      category_changes: [],
    },
    anomalies: [],
    dayOfWeekPatterns: [],
    velocity: {
      period_1_daily_avg: 50,
      period_2_daily_avg: 50,
      acceleration: 0,
      trend: 'stable',
    },
    budgetUtilization: null,
    streak: {
      current_streak_days: 0,
      streak_type: 'no_spending',
      avg_daily_during_streak: 0,
      overall_daily_average: 50,
    },
    projection: null,
    ...overrides,
  };
}

function buildBurnRate(overrides: Partial<BudgetBurnRate> = {}): BudgetBurnRate {
  return {
    category: 'Food',
    budget_limit: 500,
    spent: 100,
    currency: 'EUR',
    days_elapsed: 10,
    days_remaining: 20,
    daily_burn_rate: 10,
    projected_total: 300,
    projected_overshoot: 0,
    runway_days: 40,
    status: 'on_track',
    ...overrides,
  };
}

function buildAnomaly(overrides: Partial<CategoryAnomaly> = {}): CategoryAnomaly {
  return {
    category: 'Entertainment',
    current_month_total: 300,
    avg_3_month: 100,
    deviation_ratio: 3.0,
    severity: 'significant',
    ...overrides,
  };
}

// ── Reset mocks between tests ──────────────────────────────────────────

beforeEach(() => {
  mockAdviceLogs.countToday.mockImplementation(() => 0);
  mockAdviceLogs.hasTopicThisMonth.mockImplementation(() => false);
  mockAdviceLogs.getRecent.mockImplementation(() => []);
  mockExpenses.getCountForRange.mockImplementation(() => 0);

  // Clear cooldowns by recording a zeroed-out state:
  // Since cooldowns is a private Map, we can't clear it directly.
  // recordAdviceSent with a 'deep' tier doesn't set any cooldown,
  // so we just rely on the fact that each test group below handles
  // cooldowns explicitly where needed.
});

// ═══════════════════════════════════════════════════════════════════════
// Tests for checkSmartTriggers
// ═══════════════════════════════════════════════════════════════════════

describe('checkSmartTriggers', () => {
  test('neutral snapshot with no anomalies or budget issues returns null (or weekly_check on Monday)', () => {
    const snapshot = buildNeutralSnapshot();
    const result = checkSmartTriggers(9999, snapshot);
    const isMonday = new Date().getDay() === 1;
    if (isMonday) {
      // On Mondays, the weekly_check trigger may fire for a neutral snapshot
      if (result) {
        expect(result.type).toBe('weekly_check');
        expect(result.tier).toBe('quick');
      }
    } else {
      expect(result).toBeNull();
    }
  });

  test('returns null when daily advice limit is reached', () => {
    mockAdviceLogs.countToday.mockImplementation(() => 3);

    const snapshot = buildNeutralSnapshot({
      burnRates: [buildBurnRate({ status: 'exceeded', spent: 600 })],
    });

    const result = checkSmartTriggers(9998, snapshot);
    expect(result).toBeNull();
  });

  test('budget exceeded triggers alert', () => {
    const snapshot = buildNeutralSnapshot({
      burnRates: [buildBurnRate({ status: 'exceeded', category: 'Food', spent: 600, budget_limit: 500, currency: 'EUR' })],
    });

    const result = checkSmartTriggers(9997, snapshot);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('budget_threshold');
    expect(result!.tier).toBe('alert');
    expect(result!.topic).toContain('Food');
    expect(result!.topic).toContain('exceeded');
    expect(result!.data.category).toBe('Food');
    expect(result!.data.spent).toBe(600);
    expect(result!.data.limit).toBe(500);
  });

  test('budget warning triggers alert with projected data', () => {
    const snapshot = buildNeutralSnapshot({
      burnRates: [buildBurnRate({ status: 'warning', category: 'Transport', projected_total: 700, budget_limit: 500, currency: 'EUR' })],
    });

    const result = checkSmartTriggers(9996, snapshot);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('budget_threshold');
    expect(result!.tier).toBe('alert');
    expect(result!.data.projected).toBe(700);
    expect(result!.data.limit).toBe(500);
  });

  test('budget critical triggers alert', () => {
    const snapshot = buildNeutralSnapshot({
      burnRates: [buildBurnRate({ status: 'critical', category: 'Rent', projected_total: 1200, budget_limit: 1000, currency: 'USD' })],
    });

    const result = checkSmartTriggers(9995, snapshot);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('budget_threshold');
    expect(result!.tier).toBe('alert');
    expect(result!.topic).toContain('Rent');
    expect(result!.topic).toContain('100');
  });

  test('significant category anomaly triggers alert', () => {
    const snapshot = buildNeutralSnapshot({
      anomalies: [buildAnomaly({ category: 'Entertainment', severity: 'significant', current_month_total: 300, avg_3_month: 100, deviation_ratio: 3.0 })],
    });

    const result = checkSmartTriggers(9994, snapshot);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('anomaly');
    expect(result!.tier).toBe('alert');
    expect(result!.topic).toContain('Entertainment');
    expect(result!.data.category).toBe('Entertainment');
    expect(result!.data.current).toBe(300);
    expect(result!.data.average).toBe(100);
    expect(result!.data.ratio).toBe(3.0);
  });

  test('extreme anomaly triggers alert', () => {
    const snapshot = buildNeutralSnapshot({
      anomalies: [buildAnomaly({ severity: 'extreme', deviation_ratio: 5.0 })],
    });

    const result = checkSmartTriggers(9993, snapshot);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('anomaly');
    expect(result!.tier).toBe('alert');
  });

  test('mild anomaly does NOT trigger', () => {
    const snapshot = buildNeutralSnapshot({
      anomalies: [buildAnomaly({ severity: 'mild', deviation_ratio: 1.2 })],
    });

    const result = checkSmartTriggers(9992, snapshot);
    // Mild anomalies are below the threshold — should not fire anomaly trigger.
    // May still return null or a lower-priority trigger depending on date.
    if (result) {
      expect(result.type).not.toBe('anomaly');
    }
  });

  test('velocity spike (accelerating > 50%) triggers quick advice', () => {
    const snapshot = buildNeutralSnapshot({
      velocity: {
        period_1_daily_avg: 30,
        period_2_daily_avg: 60,
        acceleration: 100,
        trend: 'accelerating',
      },
    });

    const result = checkSmartTriggers(9991, snapshot);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('velocity_spike');
    expect(result!.tier).toBe('quick');
    expect(result!.data.acceleration).toBe(100);
  });

  test('budget exceeded takes priority over anomaly (priority order)', () => {
    const snapshot = buildNeutralSnapshot({
      burnRates: [buildBurnRate({ status: 'exceeded', category: 'Food', spent: 600 })],
      anomalies: [buildAnomaly({ severity: 'extreme' })],
    });

    const result = checkSmartTriggers(9990, snapshot);
    expect(result).not.toBeNull();
    // Budget threshold fires first because it's checked before anomalies
    expect(result!.type).toBe('budget_threshold');
  });

  test('already-sent topic this month is skipped', () => {
    mockAdviceLogs.hasTopicThisMonth.mockImplementation(() => true);

    const snapshot = buildNeutralSnapshot({
      burnRates: [buildBurnRate({ status: 'exceeded', category: 'Food', spent: 600 })],
      anomalies: [buildAnomaly({ severity: 'extreme' })],
      velocity: {
        period_1_daily_avg: 30,
        period_2_daily_avg: 60,
        acceleration: 100,
        trend: 'accelerating',
      },
    });

    // All topics already sent this month — nothing should fire.
    // Velocity spike also checks getRecent, not hasTopicThisMonth,
    // so mock getRecent to return a recent velocity_spike entry.
    mockAdviceLogs.getRecent.mockImplementation(() => [
      { topic: 'velocity_spike', created_at: new Date().toISOString() } as AdviceLog,
    ]);

    const result = checkSmartTriggers(9989, snapshot);
    // Should be null because budget+anomaly topics are "already sent this month"
    // and velocity was sent recently (within 7 days)
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests for recordAdviceSent + cooldown behavior
// ═══════════════════════════════════════════════════════════════════════

describe('recordAdviceSent + cooldown', () => {
  test('alert cooldown (1h): blocks second alert trigger immediately after', () => {
    // Use a unique groupId to avoid interference from other tests
    const groupId = 7001;

    // First call: budget exceeded should fire
    const snapshot = buildNeutralSnapshot({
      burnRates: [buildBurnRate({ status: 'exceeded', category: 'A', spent: 600 })],
    });

    const first = checkSmartTriggers(groupId, snapshot);
    expect(first).not.toBeNull();
    expect(first!.tier).toBe('alert');

    // Record that we sent both tiers to fully lock this group
    recordAdviceSent(groupId, 'alert');
    recordAdviceSent(groupId, 'quick');

    // Second call with a different exceeded budget — should be blocked by cooldown
    const snapshot2 = buildNeutralSnapshot({
      burnRates: [buildBurnRate({ status: 'exceeded', category: 'B', spent: 700 })],
    });

    const second = checkSmartTriggers(groupId, snapshot2);
    // Alert cooldown (1h) blocks alert triggers, quick cooldown (4h) blocks quick triggers
    expect(second).toBeNull();
  });

  test('quick cooldown (4h): blocks velocity spike after recording', () => {
    const groupId = 7002;

    const snapshot = buildNeutralSnapshot({
      velocity: {
        period_1_daily_avg: 30,
        period_2_daily_avg: 60,
        acceleration: 100,
        trend: 'accelerating',
      },
    });

    const first = checkSmartTriggers(groupId, snapshot);
    expect(first).not.toBeNull();
    expect(first!.tier).toBe('quick');

    recordAdviceSent(groupId, 'quick');

    const second = checkSmartTriggers(groupId, snapshot);
    // Weekly check is also 'quick' tier, so it's blocked too.
    // The only remaining triggers (budget/anomaly) are 'alert' tier and not present.
    // So result should be null.
    expect(second).toBeNull();
  });

  test('alert cooldown does NOT block quick tier triggers', () => {
    const groupId = 7003;

    // Record an alert-tier advice
    recordAdviceSent(groupId, 'alert');

    // Velocity spike is 'quick' tier — should still fire
    const snapshot = buildNeutralSnapshot({
      velocity: {
        period_1_daily_avg: 30,
        period_2_daily_avg: 60,
        acceleration: 100,
        trend: 'accelerating',
      },
    });

    const result = checkSmartTriggers(groupId, snapshot);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('quick');
  });
});
