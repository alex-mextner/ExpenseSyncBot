import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import type { BankConnection, BankTransaction } from '../../database/types';
import { buildNeutralSnapshot } from '../../test-utils/fixtures';
import { mockDatabase } from '../../test-utils/mocks/database';
import type { AdviceLog, BudgetBurnRate, CategoryAnomaly, FinancialSnapshot } from './types';

// ── Mock database ──────────────────────────────────────────────────────

const mockAdviceLogs = {
  countToday: mock(() => 0),
  hasTopicThisMonth: mock(() => false),
  getRecent: mock(() => [] as AdviceLog[]),
};

const mockExpenses = {
  getCountForRange: mock(() => 0),
};

const mockBankConnections = {
  findActiveByGroupId: mock(() => [] as BankConnection[]),
};

const mockBankTransactions = {
  findPendingByConnectionId: mock(() => [] as BankTransaction[]),
  findByGroupId: mock(() => [] as BankTransaction[]),
};

const mockBankAccounts = {
  findByGroupId: mock(() => []),
};

const mockRecurringPatterns = {
  findOverdue: mock(() => []),
};

mock.module('../../database', () => ({
  database: mockDatabase({
    adviceLogs: mockAdviceLogs,
    expenses: mockExpenses,
    bankConnections: mockBankConnections,
    bankTransactions: mockBankTransactions,
    bankAccounts: mockBankAccounts,
    recurringPatterns: mockRecurringPatterns,
  }),
}));

// Load real SpendingAnalytics with the mocked database so other test files
// that run after this one can still get the real class from the module cache.
const { SpendingAnalytics } = await import('./spending-analytics');

mock.module('./spending-analytics', () => ({
  SpendingAnalytics,
  spendingAnalytics: {
    getFinancialSnapshot: mock(() => buildTriggerSnapshot()),
  },
}));

// Import AFTER mocks are set up
const { checkSmartTriggers, recordAdviceSent } = await import('./advice-triggers');

// ── Helpers ────────────────────────────────────────────────────────────

// Default to a non-low-confidence projection so warning/critical burn-rate
// tests (which exist independent of the confidence gate) are not suppressed
// by it. Tests that specifically exercise the gate override this explicitly.
const DEFAULT_PROJECTION: FinancialSnapshot['projection'] = {
  days_elapsed: 15,
  days_in_month: 30,
  current_total: 500,
  projected_total: 1000,
  projected_vs_last_month: 100,
  confidence: 'medium',
  category_projections: [],
};

function buildTriggerSnapshot(overrides: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return buildNeutralSnapshot({ projection: DEFAULT_PROJECTION, ...overrides });
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
  // 2026-03-23 is a Monday — fixes day-of-week-dependent tests
  setSystemTime(new Date('2026-03-23T10:00:00Z'));

  mockAdviceLogs.countToday.mockImplementation(() => 0);
  mockAdviceLogs.hasTopicThisMonth.mockImplementation(() => false);
  mockAdviceLogs.getRecent.mockImplementation(() => []);
  mockExpenses.getCountForRange.mockImplementation(() => 0);
  mockBankConnections.findActiveByGroupId.mockImplementation(() => []);
  mockBankTransactions.findPendingByConnectionId.mockImplementation(() => []);

  // Clear cooldowns by recording a zeroed-out state:
  // Since cooldowns is a private Map, we can't clear it directly.
  // recordAdviceSent with a 'deep' tier doesn't set any cooldown,
  // so we just rely on the fact that each test group below handles
  // cooldowns explicitly where needed.
});

afterEach(() => {
  setSystemTime(); // reset to real time
});

// ═══════════════════════════════════════════════════════════════════════
// Tests for checkSmartTriggers
// ═══════════════════════════════════════════════════════════════════════

describe('checkSmartTriggers', () => {
  test('neutral snapshot with no anomalies or budget issues returns weekly_check on Monday', () => {
    // System time is set to Monday 2026-03-23 in beforeEach
    const snapshot = buildTriggerSnapshot();
    const result = checkSmartTriggers(9999, snapshot);
    // On a Monday with neutral snapshot, weekly_check fires
    expect(result).not.toBeNull();
    expect(result?.type).toBe('weekly_check');
    expect(result?.tier).toBe('quick');
  });

  test('returns null when daily advice limit is reached', () => {
    mockAdviceLogs.countToday.mockImplementation(() => 3);

    const snapshot = buildTriggerSnapshot({
      burnRates: [buildBurnRate({ status: 'exceeded', spent: 600 })],
    });

    const result = checkSmartTriggers(9998, snapshot);
    expect(result).toBeNull();
  });

  test('budget exceeded triggers alert', () => {
    const snapshot = buildTriggerSnapshot({
      burnRates: [
        buildBurnRate({
          status: 'exceeded',
          category: 'Food',
          spent: 600,
          budget_limit: 500,
          currency: 'EUR',
        }),
      ],
    });

    const result = checkSmartTriggers(9997, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('budget_threshold');
    expect(result?.tier).toBe('alert');
    expect(result?.topic).toContain('Food');
    expect(result?.topic).toContain('exceeded');
    expect(result?.data['category']).toBe('Food');
    expect(result?.data['spent']).toBe(600);
    expect(result?.data['limit']).toBe(500);
  });

  test('budget warning triggers alert with projected data', () => {
    const snapshot = buildTriggerSnapshot({
      burnRates: [
        buildBurnRate({
          status: 'warning',
          category: 'Transport',
          projected_total: 700,
          budget_limit: 500,
          currency: 'EUR',
        }),
      ],
    });

    const result = checkSmartTriggers(9996, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('budget_threshold');
    expect(result?.tier).toBe('alert');
    expect(result?.data['projected']).toBe(700);
    expect(result?.data['limit']).toBe(500);
  });

  test('budget critical triggers alert', () => {
    const snapshot = buildTriggerSnapshot({
      burnRates: [
        buildBurnRate({
          status: 'critical',
          category: 'Rent',
          projected_total: 1200,
          budget_limit: 1000,
          currency: 'USD',
        }),
      ],
    });

    const result = checkSmartTriggers(9995, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('budget_threshold');
    expect(result?.tier).toBe('alert');
    expect(result?.topic).toContain('Rent');
    expect(result?.topic).toContain('100');
  });

  // ── Projection confidence gate ──────────────────────────────────────
  // Reproduces the false-alert bug: a lumpy one-off expense early in the
  // month (e.g. a car repair on day 2) produces a huge linear projection
  // and used to fire a `critical` budget-threshold alert. The spec says
  // projection-based triggers must be suppressed at low confidence.

  test('low-confidence projection suppresses critical burn-rate alert (lumpy car expense, day 2)', () => {
    // Tuesday — no weekly_check noise, so null means "all triggers suppressed"
    setSystemTime(new Date('2026-03-24T10:00:00Z'));

    const snapshot = buildTriggerSnapshot({
      // One car expense of 300 on day 2 of a 30-day month → linear extrapolation
      // projects 4500 for the month on a 500 budget. `computeBurnRates` marks
      // this `critical`, but projection.confidence is `low` (days_elapsed < 7)
      // so the alert must NOT fire.
      burnRates: [
        buildBurnRate({
          status: 'critical',
          category: 'Автомобиль',
          spent: 300,
          projected_total: 4500,
          budget_limit: 500,
          currency: 'EUR',
          days_elapsed: 2,
          days_remaining: 28,
        }),
      ],
      projection: {
        days_elapsed: 2,
        days_in_month: 30,
        current_total: 300,
        projected_total: 4500,
        projected_vs_last_month: 900,
        confidence: 'low',
        category_projections: [],
      },
    });

    const result = checkSmartTriggers(8001, snapshot);
    expect(result).toBeNull();
  });

  test('low-confidence projection suppresses warning burn-rate alert', () => {
    setSystemTime(new Date('2026-03-24T10:00:00Z'));

    const snapshot = buildTriggerSnapshot({
      burnRates: [
        buildBurnRate({
          status: 'warning',
          category: 'Продукты',
          projected_total: 450,
          budget_limit: 500,
          currency: 'EUR',
          days_elapsed: 3,
        }),
      ],
      projection: {
        days_elapsed: 3,
        days_in_month: 30,
        current_total: 150,
        projected_total: 1500,
        projected_vs_last_month: 300,
        confidence: 'low',
        category_projections: [],
      },
    });

    const result = checkSmartTriggers(8002, snapshot);
    expect(result).toBeNull();
  });

  test('low-confidence projection still fires EXCEEDED alert (fact, not projection)', () => {
    // `exceeded` means spent >= limit — that is a hard fact, no extrapolation
    // involved. It must still fire even when the month is young, because the
    // user has already blown past the budget regardless of projection math.
    const snapshot = buildTriggerSnapshot({
      burnRates: [
        buildBurnRate({
          status: 'exceeded',
          category: 'Developer',
          spent: 600,
          budget_limit: 500,
          currency: 'EUR',
          days_elapsed: 2,
        }),
      ],
      projection: {
        days_elapsed: 2,
        days_in_month: 30,
        current_total: 600,
        projected_total: 9000,
        projected_vs_last_month: 1500,
        confidence: 'low',
        category_projections: [],
      },
    });

    const result = checkSmartTriggers(8003, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('budget_threshold');
    expect(result?.topic).toContain('exceeded');
    expect(result?.data['spent']).toBe(600);
  });

  test('null projection (too early in month) suppresses warning/critical alerts', () => {
    setSystemTime(new Date('2026-03-24T10:00:00Z'));

    const snapshot = buildTriggerSnapshot({
      burnRates: [
        buildBurnRate({
          status: 'critical',
          category: 'Транспорт',
          projected_total: 3000,
          budget_limit: 500,
          currency: 'EUR',
          days_elapsed: 1,
        }),
      ],
      projection: null,
    });

    const result = checkSmartTriggers(8004, snapshot);
    expect(result).toBeNull();
  });

  test('medium-confidence projection allows critical alert to fire', () => {
    // Past the first week: projection confidence is medium/high, the linear
    // extrapolation is trustworthy, and the alert should fire normally.
    const snapshot = buildTriggerSnapshot({
      burnRates: [
        buildBurnRate({
          status: 'critical',
          category: 'Rent',
          projected_total: 1200,
          budget_limit: 1000,
          currency: 'USD',
          days_elapsed: 15,
        }),
      ],
      projection: {
        days_elapsed: 15,
        days_in_month: 30,
        current_total: 600,
        projected_total: 1200,
        projected_vs_last_month: 120,
        confidence: 'medium',
        category_projections: [],
      },
    });

    const result = checkSmartTriggers(8005, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('budget_threshold');
    expect(result?.topic).toContain('Rent');
    expect(result?.topic).toContain('100');
  });

  test('significant category anomaly triggers alert', () => {
    const snapshot = buildTriggerSnapshot({
      anomalies: [
        buildAnomaly({
          category: 'Entertainment',
          severity: 'significant',
          current_month_total: 300,
          avg_3_month: 100,
          deviation_ratio: 3.0,
        }),
      ],
    });

    const result = checkSmartTriggers(9994, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('anomaly');
    expect(result?.tier).toBe('alert');
    expect(result?.topic).toContain('Entertainment');
    expect(result?.data['category']).toBe('Entertainment');
    expect(result?.data['current']).toBe(300);
    expect(result?.data['average']).toBe(100);
    expect(result?.data['ratio']).toBe(3.0);
  });

  test('extreme anomaly triggers alert', () => {
    const snapshot = buildTriggerSnapshot({
      anomalies: [buildAnomaly({ severity: 'extreme', deviation_ratio: 5.0 })],
    });

    const result = checkSmartTriggers(9993, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('anomaly');
    expect(result?.tier).toBe('alert');
  });

  test('mild anomaly does NOT trigger', () => {
    const snapshot = buildTriggerSnapshot({
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
    const snapshot = buildTriggerSnapshot({
      velocity: {
        period_1_daily_avg: 30,
        period_2_daily_avg: 60,
        acceleration: 100,
        trend: 'accelerating',
      },
    });

    const result = checkSmartTriggers(9991, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('velocity_spike');
    expect(result?.tier).toBe('quick');
    expect(result?.data['acceleration']).toBe(100);
  });

  test('budget exceeded takes priority over anomaly (priority order)', () => {
    const snapshot = buildTriggerSnapshot({
      burnRates: [buildBurnRate({ status: 'exceeded', category: 'Food', spent: 600 })],
      anomalies: [buildAnomaly({ severity: 'extreme' })],
    });

    const result = checkSmartTriggers(9990, snapshot);
    expect(result).not.toBeNull();
    // Budget threshold fires first because it's checked before anomalies
    expect(result?.type).toBe('budget_threshold');
  });

  test('already-sent topic this month is skipped', () => {
    mockAdviceLogs.hasTopicThisMonth.mockImplementation(() => true);

    const snapshot = buildTriggerSnapshot({
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
    const snapshot = buildTriggerSnapshot({
      burnRates: [buildBurnRate({ status: 'exceeded', category: 'A', spent: 600 })],
    });

    const first = checkSmartTriggers(groupId, snapshot);
    expect(first).not.toBeNull();
    expect(first?.tier).toBe('alert');

    // Record that we sent both tiers to fully lock this group
    recordAdviceSent(groupId, 'alert');
    recordAdviceSent(groupId, 'quick');

    // Second call with a different exceeded budget — should be blocked by cooldown
    const snapshot2 = buildTriggerSnapshot({
      burnRates: [buildBurnRate({ status: 'exceeded', category: 'B', spent: 700 })],
    });

    const second = checkSmartTriggers(groupId, snapshot2);
    // Alert cooldown (1h) blocks alert triggers, quick cooldown (4h) blocks quick triggers
    expect(second).toBeNull();
  });

  test('quick cooldown (4h): blocks velocity spike after recording', () => {
    const groupId = 7002;

    const snapshot = buildTriggerSnapshot({
      velocity: {
        period_1_daily_avg: 30,
        period_2_daily_avg: 60,
        acceleration: 100,
        trend: 'accelerating',
      },
    });

    const first = checkSmartTriggers(groupId, snapshot);
    expect(first).not.toBeNull();
    expect(first?.tier).toBe('quick');

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
    const snapshot = buildTriggerSnapshot({
      velocity: {
        period_1_daily_avg: 30,
        period_2_daily_avg: 60,
        acceleration: 100,
        trend: 'accelerating',
      },
    });

    const result = checkSmartTriggers(groupId, snapshot);
    expect(result).not.toBeNull();
    expect(result?.tier).toBe('quick');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Additional edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  test('weekly_check returns correct topic format with week number', () => {
    // Monday 2026-03-23 set in beforeEach
    const snapshot = buildTriggerSnapshot();
    const result = checkSmartTriggers(8001, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('weekly_check');
    // topic format: weekly_check:YYYY-ww
    expect(result?.topic).toMatch(/^weekly_check:\d{4}-\d+$/);
  });

  test('weekly_check does NOT fire on a non-Monday (Tuesday)', () => {
    // Override to Tuesday
    setSystemTime(new Date('2026-03-24T10:00:00Z')); // Tuesday
    const snapshot = buildTriggerSnapshot();
    const result = checkSmartTriggers(8002, snapshot);
    // No budget/anomaly/velocity — should return null on non-Monday
    expect(result).toBeNull();
  });

  test('weekly_check does NOT fire on Sunday', () => {
    setSystemTime(new Date('2026-03-22T10:00:00Z')); // Sunday
    const snapshot = buildTriggerSnapshot();
    const result = checkSmartTriggers(8003, snapshot);
    expect(result).toBeNull();
  });

  test('multiple budgets: only the first exceeded one fires', () => {
    const snapshot = buildTriggerSnapshot({
      burnRates: [
        buildBurnRate({ status: 'on_track', category: 'Food', spent: 100 }),
        buildBurnRate({ status: 'exceeded', category: 'Transport', spent: 600 }),
        buildBurnRate({ status: 'exceeded', category: 'Rent', spent: 1200 }),
      ],
    });
    const result = checkSmartTriggers(8004, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('budget_threshold');
    // First exceeded budget fires (Transport comes before Rent)
    expect(result?.data['category']).toBe('Transport');
  });

  test('budget warning topic includes "80" threshold', () => {
    const snapshot = buildTriggerSnapshot({
      burnRates: [buildBurnRate({ status: 'warning', category: 'Gym' })],
    });
    const result = checkSmartTriggers(8005, snapshot);
    expect(result).not.toBeNull();
    expect(result?.topic).toContain('80');
  });

  test('budget critical topic includes "100" threshold', () => {
    const snapshot = buildTriggerSnapshot({
      burnRates: [buildBurnRate({ status: 'critical', category: 'Rent' })],
    });
    const result = checkSmartTriggers(8006, snapshot);
    expect(result).not.toBeNull();
    expect(result?.topic).toContain('100');
  });

  test('velocity spike at exactly 50% acceleration does NOT trigger (boundary: > 50 required)', () => {
    const snapshot = buildTriggerSnapshot({
      velocity: {
        period_1_daily_avg: 50,
        period_2_daily_avg: 75,
        acceleration: 50, // exactly at boundary — not > 50
        trend: 'accelerating',
      },
    });
    // Use Tuesday to avoid weekly_check interference
    setSystemTime(new Date('2026-03-24T10:00:00Z'));
    const result = checkSmartTriggers(8007, snapshot);
    expect(result).toBeNull();
  });

  test('velocity spike at 51% acceleration DOES trigger', () => {
    const snapshot = buildTriggerSnapshot({
      velocity: {
        period_1_daily_avg: 50,
        period_2_daily_avg: 75.5,
        acceleration: 51,
        trend: 'accelerating',
      },
    });
    const result = checkSmartTriggers(8008, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('velocity_spike');
    expect(result?.data['acceleration']).toBe(51);
  });

  test('velocity trend stable does NOT trigger velocity_spike even with high acceleration number', () => {
    const snapshot = buildTriggerSnapshot({
      velocity: {
        period_1_daily_avg: 50,
        period_2_daily_avg: 100,
        acceleration: 100,
        trend: 'stable', // not 'accelerating'
      },
    });
    // Use Tuesday to avoid weekly_check
    setSystemTime(new Date('2026-03-24T10:00:00Z'));
    const result = checkSmartTriggers(8009, snapshot);
    expect(result).toBeNull();
  });

  test('first_expense_of_month fires when expenseCount === 1 and date <= 3', () => {
    // Use March 1 (day 1 of month, also not Monday to isolate)
    setSystemTime(new Date('2026-03-01T10:00:00Z')); // Sunday
    mockExpenses.getCountForRange.mockImplementation(() => 1);
    const snapshot = buildTriggerSnapshot();
    const result = checkSmartTriggers(8010, snapshot);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('first_expense_of_month');
    expect(result?.tier).toBe('quick');
    expect(result?.data['month']).toMatch(/^\d{4}-\d{2}$/);
  });

  test('first_expense_of_month does NOT fire when count > 1', () => {
    setSystemTime(new Date('2026-03-01T10:00:00Z'));
    mockExpenses.getCountForRange.mockImplementation(() => 5);
    const snapshot = buildTriggerSnapshot();
    const result = checkSmartTriggers(8011, snapshot);
    expect(result).toBeNull();
  });

  test('first_expense_of_month does NOT fire after day 3', () => {
    setSystemTime(new Date('2026-03-05T10:00:00Z')); // day 5
    mockExpenses.getCountForRange.mockImplementation(() => 1);
    const snapshot = buildTriggerSnapshot();
    const result = checkSmartTriggers(8012, snapshot);
    expect(result).toBeNull();
  });

  test('velocity_spike cooldown: second call within 7 days is blocked', () => {
    const groupId = 8013;
    const sevenDaysAgo = new Date('2026-03-23T10:00:00Z').getTime() - 6 * 24 * 60 * 60 * 1000;
    mockAdviceLogs.getRecent.mockImplementation(() => [
      {
        topic: 'velocity_spike',
        created_at: new Date(sevenDaysAgo).toISOString(),
      } as AdviceLog,
    ]);

    // Use Tuesday to avoid weekly_check interference
    setSystemTime(new Date('2026-03-24T10:00:00Z'));
    const snapshot = buildTriggerSnapshot({
      velocity: {
        period_1_daily_avg: 30,
        period_2_daily_avg: 80,
        acceleration: 167,
        trend: 'accelerating',
      },
    });
    const result = checkSmartTriggers(groupId, snapshot);
    // Within 7 days — should be blocked
    expect(result).toBeNull();
  });

  test('velocity_spike fires after 7-day cooldown expires', () => {
    const groupId = 8014;
    const moreThan7DaysAgo = new Date('2026-03-23T10:00:00Z').getTime() - 8 * 24 * 60 * 60 * 1000;
    mockAdviceLogs.getRecent.mockImplementation(() => [
      {
        topic: 'velocity_spike',
        created_at: new Date(moreThan7DaysAgo).toISOString(),
      } as AdviceLog,
    ]);

    const snapshot = buildTriggerSnapshot({
      velocity: {
        period_1_daily_avg: 30,
        period_2_daily_avg: 80,
        acceleration: 167,
        trend: 'accelerating',
      },
    });
    const result = checkSmartTriggers(groupId, snapshot);
    // More than 7 days ago — should fire
    expect(result).not.toBeNull();
    expect(result?.type).toBe('velocity_spike');
  });

  test('budget_limit=0 with status exceeded does NOT trigger (disabled category)', () => {
    setSystemTime(new Date('2026-03-24T10:00:00Z')); // Tuesday — no weekly_check
    const snapshot = buildTriggerSnapshot({
      burnRates: [
        buildBurnRate({ status: 'exceeded', category: 'Путешествия', budget_limit: 0, spent: 0 }),
      ],
    });
    const result = checkSmartTriggers(9001, snapshot);
    expect(result).toBeNull();
  });

  test('budget_limit=0 with status warning does NOT trigger (disabled category)', () => {
    setSystemTime(new Date('2026-03-24T10:00:00Z'));
    const snapshot = buildTriggerSnapshot({
      burnRates: [
        buildBurnRate({
          status: 'warning',
          category: 'Путешествия',
          budget_limit: 0,
          projected_total: 0,
        }),
      ],
    });
    const result = checkSmartTriggers(9002, snapshot);
    expect(result).toBeNull();
  });

  test('budget_limit=0 with status critical does NOT trigger (disabled category)', () => {
    setSystemTime(new Date('2026-03-24T10:00:00Z'));
    const snapshot = buildTriggerSnapshot({
      burnRates: [
        buildBurnRate({
          status: 'critical',
          category: 'Путешествия',
          budget_limit: 0,
          projected_total: 0,
        }),
      ],
    });
    const result = checkSmartTriggers(9003, snapshot);
    expect(result).toBeNull();
  });

  test('all trigger types return correct tier', () => {
    // alert tier
    const alertSnap = buildTriggerSnapshot({
      burnRates: [buildBurnRate({ status: 'exceeded' })],
    });
    const alertResult = checkSmartTriggers(8015, alertSnap);
    expect(alertResult?.tier).toBe('alert');

    // quick tier — velocity (use unique groupId, Tuesday to avoid weekly check overlap)
    setSystemTime(new Date('2026-03-24T10:00:00Z'));
    const quickSnap = buildTriggerSnapshot({
      velocity: {
        period_1_daily_avg: 30,
        period_2_daily_avg: 80,
        acceleration: 167,
        trend: 'accelerating',
      },
    });
    const quickResult = checkSmartTriggers(8016, quickSnap);
    expect(quickResult?.tier).toBe('quick');
  });

  test('pending_bank_transactions trigger fires when there are pending txs', () => {
    // Tuesday — no weekly_check interference
    setSystemTime(new Date('2026-03-24T10:00:00Z'));

    // 1 active connection with 3 pending transactions
    mockBankConnections.findActiveByGroupId.mockImplementation(
      () => [{ id: 42 }] as BankConnection[],
    );
    mockBankTransactions.findPendingByConnectionId.mockImplementation(
      () => [{ id: 1 }, { id: 2 }, { id: 3 }] as BankTransaction[],
    );

    const snapshot = buildTriggerSnapshot();
    const result = checkSmartTriggers(8017, snapshot);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('pending_bank_transactions');
    expect(result?.tier).toBe('quick');
    expect(result?.data['count']).toBe(3);
    expect(result?.topic).toMatch(/^pending_bank_transactions:\d{4}-\d{2}-\d{2}$/);
  });

  test('pending_bank_transactions does NOT fire when no pending txs', () => {
    // Tuesday — no weekly_check interference
    setSystemTime(new Date('2026-03-24T10:00:00Z'));

    // mockBankConnections returns [] by default (reset in beforeEach)
    const snapshot = buildTriggerSnapshot();
    const result = checkSmartTriggers(8018, snapshot);

    expect(result).toBeNull();
  });
});
