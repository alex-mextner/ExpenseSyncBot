// Spending analytics: anomalies, budget utilization, financial snapshot and category/interval profiles.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { format, startOfMonth, subMonths } from 'date-fns';
import {
  buildCategoryProfiles,
  currentMonth,
  GROUP_ID,
  installAnalyticsFixture,
  now,
  projectCategory,
  seedAnalyticsFixture,
  TestableSpendingAnalytics,
  today,
  USER_ID,
} from './spending-analytics-test-harness';

const { db, expenseRepo, budgetRepo } = installAnalyticsFixture();

let analytics: TestableSpendingAnalytics;

beforeAll(() => {
  seedAnalyticsFixture(db);
  analytics = new TestableSpendingAnalytics();
});

afterAll(() => {
  db.close();
});

describe('computeAnomalies', () => {
  test('category spending significantly above 3-month average is flagged', () => {
    // Insert a spike: add a huge Food expense this month to trigger anomaly
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [3, 33333, 'EUR', '["EUR"]'],
    );
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [3, USER_ID, today, 'Food', 'spike', 500, 'EUR', 500],
    );
    // History: 3 months of ~100 EUR Food each
    // Spread across different days within each month
    const m1mid = format(
      new Date(subMonths(now, 1).getFullYear(), subMonths(now, 1).getMonth(), 10),
      'yyyy-MM-dd',
    );
    const m2mid = format(
      new Date(subMonths(now, 2).getFullYear(), subMonths(now, 2).getMonth(), 10),
      'yyyy-MM-dd',
    );
    const m3mid = format(
      new Date(subMonths(now, 3).getFullYear(), subMonths(now, 3).getMonth(), 10),
      'yyyy-MM-dd',
    );

    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [3, USER_ID, m1mid, 'Food', 'h', 100, 'EUR', 100],
    );
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [3, USER_ID, m2mid, 'Food', 'h', 100, 'EUR', 100],
    );
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [3, USER_ID, m3mid, 'Food', 'h', 100, 'EUR', 100],
    );

    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const anomalies = analytics.testComputeAnomalies(3, now, monthStart, today);

    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    const foodAnomaly = anomalies.find((a) => a.category === 'Food');
    expect(foodAnomaly).toBeDefined();
    if (!foodAnomaly) return;
    expect(foodAnomaly.deviation_ratio).toBeGreaterThanOrEqual(1.5);
    expect(['mild', 'significant', 'extreme']).toContain(foodAnomaly.severity);
  });

  test('normal spending does not produce anomalies', () => {
    // Group 4: current month spending equals the historical average
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [4, 44444, 'EUR', '["EUR"]'],
    );

    const m1mid = format(
      new Date(subMonths(now, 1).getFullYear(), subMonths(now, 1).getMonth(), 10),
      'yyyy-MM-dd',
    );
    const m2mid = format(
      new Date(subMonths(now, 2).getFullYear(), subMonths(now, 2).getMonth(), 10),
      'yyyy-MM-dd',
    );
    const m3mid = format(
      new Date(subMonths(now, 3).getFullYear(), subMonths(now, 3).getMonth(), 10),
      'yyyy-MM-dd',
    );

    // History: 100 EUR each month
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [4, USER_ID, m1mid, 'Food', 'h', 100, 'EUR', 100],
    );
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [4, USER_ID, m2mid, 'Food', 'h', 100, 'EUR', 100],
    );
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [4, USER_ID, m3mid, 'Food', 'h', 100, 'EUR', 100],
    );

    // Current month: same as average
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [4, USER_ID, today, 'Food', 'normal', 100, 'EUR', 100],
    );

    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const anomalies = analytics.testComputeAnomalies(4, now, monthStart, today);

    // deviation_ratio = 100/100 = 1.0, which is below 1.3 threshold
    expect(anomalies.length).toBe(0);
  });

  test('severity escalates with deviation ratio', () => {
    // Group 5: extreme spike (10x average)
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [5, 55555, 'EUR', '["EUR"]'],
    );

    const m1mid = format(
      new Date(subMonths(now, 1).getFullYear(), subMonths(now, 1).getMonth(), 10),
      'yyyy-MM-dd',
    );
    const m2mid = format(
      new Date(subMonths(now, 2).getFullYear(), subMonths(now, 2).getMonth(), 10),
      'yyyy-MM-dd',
    );
    const m3mid = format(
      new Date(subMonths(now, 3).getFullYear(), subMonths(now, 3).getMonth(), 10),
      'yyyy-MM-dd',
    );

    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [5, USER_ID, m1mid, 'Food', 'h', 50, 'EUR', 50],
    );
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [5, USER_ID, m2mid, 'Food', 'h', 50, 'EUR', 50],
    );
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [5, USER_ID, m3mid, 'Food', 'h', 50, 'EUR', 50],
    );

    // Current month: 500 EUR = 10x the average of 50 → extreme
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [5, USER_ID, today, 'Food', 'spike', 500, 'EUR', 500],
    );

    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const anomalies = analytics.testComputeAnomalies(5, now, monthStart, today);

    expect(anomalies.length).toBe(1);
    const anomaly = anomalies.at(0);
    expect(anomaly?.severity).toBe('extreme');
    expect(anomaly?.deviation_ratio).toBeGreaterThanOrEqual(2.5);
  });
});

describe('computeBudgetUtilization', () => {
  test('percentage of budget used is calculated', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const util = analytics.testComputeBudgetUtilization(GROUP_ID, currentMonth, monthStart, today);

    expect(util).not.toBeNull();
    if (!util) return;
    expect(typeof util.total_budget).toBe('number');
    expect(typeof util.total_spent).toBe('number');
    expect(typeof util.utilization_percent).toBe('number');
    expect(typeof util.remaining).toBe('number');
    expect(typeof util.remaining_percent).toBe('number');
  });

  test('remaining = total_budget - total_spent', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const util = analytics.testComputeBudgetUtilization(GROUP_ID, currentMonth, monthStart, today);

    if (util) {
      expect(util.remaining).toBe(Math.round((util.total_budget - util.total_spent) * 100) / 100);
    }
  });

  test('returns null when no budgets exist', () => {
    // Group 2 has no budgets
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const util = analytics.testComputeBudgetUtilization(2, currentMonth, monthStart, today);

    expect(util).toBeNull();
  });
});

describe('getFinancialSnapshot', () => {
  test('returns object with all metrics populated', () => {
    const snapshot = analytics.getFinancialSnapshot(GROUP_ID);

    expect(snapshot).toBeDefined();
    expect(snapshot.burnRates).toBeDefined();
    expect(snapshot.weekTrend).toBeDefined();
    expect(snapshot.monthTrend).toBeDefined();
    expect(snapshot.anomalies).toBeDefined();
    expect(snapshot.dayOfWeekPatterns).toBeDefined();
    expect(snapshot.velocity).toBeDefined();
    expect(snapshot.streak).toBeDefined();
    // budgetUtilization and projection may be null by design, but should be defined
    expect('budgetUtilization' in snapshot).toBe(true);
    expect('projection' in snapshot).toBe(true);
  });

  test('all array fields are arrays', () => {
    const snapshot = analytics.getFinancialSnapshot(GROUP_ID);

    expect(Array.isArray(snapshot.burnRates)).toBe(true);
    expect(Array.isArray(snapshot.anomalies)).toBe(true);
    expect(Array.isArray(snapshot.dayOfWeekPatterns)).toBe(true);
    expect(Array.isArray(snapshot.weekTrend.category_changes)).toBe(true);
    expect(Array.isArray(snapshot.monthTrend.category_changes)).toBe(true);
  });

  test('velocity has required fields', () => {
    const snapshot = analytics.getFinancialSnapshot(GROUP_ID);

    expect(typeof snapshot.velocity.period_1_daily_avg).toBe('number');
    expect(typeof snapshot.velocity.period_2_daily_avg).toBe('number');
    expect(typeof snapshot.velocity.acceleration).toBe('number');
    expect(['accelerating', 'decelerating', 'stable']).toContain(snapshot.velocity.trend);
  });

  test('streak has required fields', () => {
    const snapshot = analytics.getFinancialSnapshot(GROUP_ID);

    expect(typeof snapshot.streak.current_streak_days).toBe('number');
    expect(['above_average', 'below_average', 'no_spending']).toContain(
      snapshot.streak.streak_type,
    );
    expect(typeof snapshot.streak.avg_daily_during_streak).toBe('number');
    expect(typeof snapshot.streak.overall_daily_average).toBe('number');
  });

  test('weekTrend period is week', () => {
    const snapshot = analytics.getFinancialSnapshot(GROUP_ID);
    expect(snapshot.weekTrend.period).toBe('week');
  });

  test('monthTrend period is month', () => {
    const snapshot = analytics.getFinancialSnapshot(GROUP_ID);
    expect(snapshot.monthTrend.period).toBe('month');
  });

  test('getAllBudgetsForMonth is called only once per snapshot', () => {
    const spy = spyOn(budgetRepo, 'getAllBudgetsForMonth');
    analytics.getFinancialSnapshot(GROUP_ID);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('getCategoryTotals is called only once per snapshot', () => {
    const spy = spyOn(expenseRepo, 'getCategoryTotals');
    analytics.getFinancialSnapshot(GROUP_ID);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('getAllBudgetsForMonth with multiple categories', () => {
  test('returns all 5 categories in a single call', () => {
    const multiGroupId = 10;
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [multiGroupId, 101010, 'EUR', '["EUR"]'],
    );

    const categories = ['Entertainment', 'Food', 'Health', 'Shopping', 'Transport'];
    for (const cat of categories) {
      db.run(
        `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
        [multiGroupId, cat, currentMonth, 200, 'EUR'],
      );
    }

    const spy = spyOn(budgetRepo, 'getAllBudgetsForMonth');
    const budgets = budgetRepo.getAllBudgetsForMonth(multiGroupId, currentMonth);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(budgets).toHaveLength(5);
    expect(budgets.map((b: { category: string }) => b.category)).toEqual(categories);
    spy.mockRestore();
  });
});

// ============================================================
// buildCategoryProfiles unit tests
// ============================================================

describe('buildCategoryProfiles', () => {
  test('computes EMA weighted toward recent months', () => {
    const rows = [
      { category: 'Food', month: '2026-01', monthly_total: 100, tx_count: 10 },
      { category: 'Food', month: '2026-02', monthly_total: 200, tx_count: 12 },
      { category: 'Food', month: '2026-03', monthly_total: 300, tx_count: 15 },
    ];
    const profiles = buildCategoryProfiles(rows);
    const food = profiles.get('Food');

    expect(food).toBeDefined();
    // EMA with α=2/(3+1)=0.5: start=100, then 0.5*200+0.5*100=150, then 0.5*300+0.5*150=225
    expect(food?.ema).toBe(225);
    // Mean = 200, stddev = √((100²+0²+100²)/3) = √(6666.7) ≈ 81.6
    // CV = 81.6/200 ≈ 0.408
    expect(food?.cv).toBeGreaterThan(0.3);
    expect(food?.cv).toBeLessThan(0.5);
    expect(food?.monthsOfData).toBe(3);
  });

  test('single month of history: EMA equals that month', () => {
    const rows = [{ category: 'Car', month: '2026-03', monthly_total: 500, tx_count: 2 }];
    const profiles = buildCategoryProfiles(rows);
    const car = profiles.get('Car');

    expect(car?.ema).toBe(500);
    expect(car?.cv).toBe(0); // no variance with 1 data point
  });

  test('stable category has low CV', () => {
    // Subscription: exactly 100 every month
    const rows = [
      { category: 'Sub', month: '2026-01', monthly_total: 100, tx_count: 1 },
      { category: 'Sub', month: '2026-02', monthly_total: 100, tx_count: 1 },
      { category: 'Sub', month: '2026-03', monthly_total: 100, tx_count: 1 },
      { category: 'Sub', month: '2026-04', monthly_total: 100, tx_count: 1 },
    ];
    const profiles = buildCategoryProfiles(rows);
    expect(profiles.get('Sub')?.cv).toBe(0);
  });

  test('highly irregular category has high CV', () => {
    const rows = [
      { category: 'Fun', month: '2026-01', monthly_total: 10, tx_count: 1 },
      { category: 'Fun', month: '2026-02', monthly_total: 500, tx_count: 3 },
      { category: 'Fun', month: '2026-03', monthly_total: 50, tx_count: 2 },
    ];
    const profiles = buildCategoryProfiles(rows);
    expect(profiles.get('Fun')?.cv).toBeGreaterThan(1);
  });

  test('multiple categories are profiled independently', () => {
    const rows = [
      { category: 'A', month: '2026-01', monthly_total: 100, tx_count: 5 },
      { category: 'B', month: '2026-01', monthly_total: 50, tx_count: 1 },
      { category: 'A', month: '2026-02', monthly_total: 120, tx_count: 6 },
      { category: 'B', month: '2026-02', monthly_total: 50, tx_count: 1 },
    ];
    const profiles = buildCategoryProfiles(rows);
    expect(profiles.size).toBe(2);
    expect(profiles.get('A')?.ema).toBeGreaterThan(profiles.get('B')?.ema ?? 0);
  });

  test('empty history returns empty map', () => {
    expect(buildCategoryProfiles([]).size).toBe(0);
  });
});

// ============================================================
// projectCategory unit tests
// ============================================================

describe('projectCategory', () => {
  const stableProfile = {
    ema: 15000,
    cv: 0.2,
    monthsOfData: 4,
    avgTxPerMonth: 10,
    zeroMonthRatio: 0,
  };

  test('no history → returns current spent (conservative)', () => {
    expect(projectCategory(10200, 4, 30, null)).toBe(10200);
  });

  test('zero days elapsed → returns current spent', () => {
    expect(projectCategory(500, 0, 30, stableProfile)).toBe(500);
  });

  test('early month + stable history → projection close to EMA', () => {
    // Day 4 of 30, spent 10200, EMA 15000, CV 0.2
    // alpha = (4/30)² × (1+0.2) = 0.0178 × 1.2 = 0.0213
    // historyBased = max(10200, 15000) = 15000
    // paceBased = (10200/4) * 30 = 76500
    // projected = 0.0213 * 76500 + 0.9787 * 15000 ≈ 1630 + 14680 ≈ 16310
    const result = projectCategory(10200, 4, 30, stableProfile);
    expect(result).toBeGreaterThan(14000);
    expect(result).toBeLessThan(20000);
    // Much less than naive linear (76500)
    expect(result).toBeLessThan(76500 * 0.3);
  });

  test('late month → projection approaches linear extrapolation', () => {
    // Day 25 of 30, spent 12000, EMA 15000, CV 0.2
    // alpha = (25/30)² × 1.2 = 0.694 × 1.2 = 0.833
    // paceBased = (12000/25) * 30 = 14400
    // historyBased = max(12000, 15000) = 15000
    // projected = 0.833 * 14400 + 0.167 * 15000 ≈ 11995 + 2505 ≈ 14500
    const result = projectCategory(12000, 25, 30, stableProfile);
    expect(result).toBeGreaterThan(14000);
    expect(result).toBeLessThan(15200);
  });

  test('erratic category (high CV) uses pace-only projection', () => {
    // CV=1.5 → CV²=2.25 > 0.49 → classified as "erratic"
    // Erratic uses pace-only (no history anchor) to avoid false alarms from outlier months
    const erratic = { ema: 10000, cv: 1.5, monthsOfData: 4, avgTxPerMonth: 3, zeroMonthRatio: 0 };

    // Day 10 of 30, spent 5000 → pace = (5000/10)*30 = 15000
    const result = projectCategory(5000, 10, 30, erratic);
    expect(result).toBe(15000);
    // Pace-only: no blending with EMA
    expect(result).toBeGreaterThanOrEqual(5000);
  });

  test('current spend already exceeds EMA → projected ≥ current', () => {
    // Spent 20000 with EMA 15000 → historyBased = 20000 (capped at current)
    const result = projectCategory(20000, 15, 30, stableProfile);
    expect(result).toBeGreaterThanOrEqual(20000);
  });

  test('full month elapsed → alpha capped at 1 → pure pace', () => {
    // Day 30 of 30
    // alpha = min(1, (30/30)² × 1.2) = min(1, 1.2) = 1
    // projected = 1 * paceBased = (6000/30)*30 = 6000
    const result = projectCategory(6000, 30, 30, stableProfile);
    expect(result).toBe(6000);
  });
});

// ============================================================
// Integration: single large expense should not trigger critical burn rate
// ============================================================
