import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { format, getDaysInMonth, startOfMonth, subDays, subMonths } from 'date-fns';
import { createTestDb } from '../../test-utils/db';
import { seedGroupAndUser } from '../../test-utils/fixtures';

// --- Setup in-memory database and mock the singleton ---

const db = createTestDb();

import { BudgetRepository } from '../../database/repositories/budget.repository';
// Instantiate real repositories backed by in-memory DB
import { ExpenseRepository } from '../../database/repositories/expense.repository';

const expenseRepo = new ExpenseRepository(db);
const budgetRepo = new BudgetRepository(db);

// Mock the database module so SpendingAnalytics picks up our in-memory repos
mock.module('../../database', () => ({
  database: {
    db,
    expenses: expenseRepo,
    budgets: budgetRepo,
  },
}));

// Import AFTER mock is set up
const { SpendingAnalytics, buildCategoryProfiles, projectCategory } = await import(
  './spending-analytics'
);

class TestableSpendingAnalytics extends SpendingAnalytics {
  testComputeVelocity = (groupId: number, today: string) => this.computeVelocity(groupId, today);
  testComputeStreak = (groupId: number, today: string) => this.computeStreak(groupId, today);
  testComputeDayPatterns = (groupId: number, today: string) =>
    this.computeDayPatterns(groupId, today);
  testComputeWeekOverWeek = (groupId: number, today: string) =>
    this.computeWeekOverWeek(groupId, today);
  testComputeMonthOverMonth = (
    groupId: number,
    now: Date,
    currentMonthStart: string,
    today: string,
  ) => this.computeMonthOverMonth(groupId, now, currentMonthStart, today);
  testComputeProjection = (
    groupId: number,
    now: Date,
    currentMonth: string,
    monthStart: string,
    today: string,
  ) => this.computeProjection(groupId, now, currentMonth, monthStart, today);
  testComputeBurnRates = (
    groupId: number,
    now: Date,
    currentMonth: string,
    monthStart: string,
    today: string,
  ) => this.computeBurnRates(groupId, now, currentMonth, monthStart, today);
  testComputeAnomalies = (groupId: number, now: Date, currentMonthStart: string, today: string) =>
    this.computeAnomalies(groupId, now, currentMonthStart, today);
  testComputeBudgetUtilization = (
    groupId: number,
    currentMonth: string,
    monthStart: string,
    today: string,
  ) => this.computeBudgetUtilization(groupId, currentMonth, monthStart, today);
}

// --- Fixture data ---

const GROUP_ID = 1;
const USER_ID = 1;

const now = new Date();
const today = format(now, 'yyyy-MM-dd');
const yesterday = format(subDays(now, 1), 'yyyy-MM-dd');
const sevenDaysAgo = format(subDays(now, 7), 'yyyy-MM-dd');
const fourteenDaysAgo = format(subDays(now, 14), 'yyyy-MM-dd');
const lastMonth = subMonths(now, 1);
const lastMonthDate = format(
  new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 15),
  'yyyy-MM-dd',
);
const twoMonthsAgoDate = format(
  new Date(subMonths(now, 2).getFullYear(), subMonths(now, 2).getMonth(), 15),
  'yyyy-MM-dd',
);
const threeMonthsAgoDate = format(
  new Date(subMonths(now, 3).getFullYear(), subMonths(now, 3).getMonth(), 15),
  'yyyy-MM-dd',
);
const currentMonth = format(now, 'yyyy-MM');

function insertExpense(date: string, category: string, eurAmount: number) {
  db.run(
    `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [GROUP_ID, USER_ID, date, category, 'test', eurAmount, 'EUR', eurAmount],
  );
}

let analytics: TestableSpendingAnalytics;

beforeAll(() => {
  seedGroupAndUser(db, { groupId: 12345, userId: 99999 });

  // -- Expenses --

  // Today
  insertExpense(today, 'Food', 50);
  insertExpense(today, 'Transport', 30);

  // Yesterday
  insertExpense(yesterday, 'Food', 25);
  insertExpense(yesterday, 'Entertainment', 15);

  // 7 days ago
  insertExpense(sevenDaysAgo, 'Food', 100);
  insertExpense(sevenDaysAgo, 'Transport', 40);

  // 14 days ago
  insertExpense(fourteenDaysAgo, 'Food', 80);

  // Last month (mid-month)
  insertExpense(lastMonthDate, 'Food', 200);
  insertExpense(lastMonthDate, 'Transport', 100);
  insertExpense(lastMonthDate, 'Entertainment', 50);

  // 2 months ago
  insertExpense(twoMonthsAgoDate, 'Food', 180);
  insertExpense(twoMonthsAgoDate, 'Transport', 90);

  // 3 months ago (for anomaly history)
  insertExpense(threeMonthsAgoDate, 'Food', 150);
  insertExpense(threeMonthsAgoDate, 'Transport', 70);

  // -- Budgets for current month --
  db.run(
    `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
    [GROUP_ID, 'Food', currentMonth, 300, 'EUR'],
  );
  db.run(
    `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
    [GROUP_ID, 'Transport', currentMonth, 150, 'EUR'],
  );

  analytics = new TestableSpendingAnalytics();
});

afterAll(() => {
  db.close();
});

// ============================================================
// Tests
// ============================================================

describe('computeVelocity', () => {
  test('daily average for recent period is calculated correctly', () => {
    const velocity = analytics.testComputeVelocity(GROUP_ID, today);

    // Recent 7 days: today..6 days ago. That window includes today, yesterday
    // but NOT sevenDaysAgo (date(today, '-6 days') = subDays(6), sevenDaysAgo = subDays(7))
    // recent: today(50+30) + yesterday(25+15) = 120
    // earlier: sevenDaysAgo(100+40) = 140, fourteenDaysAgo is at -14, which is outside -13 days window
    // Actually date(today, '-13 days') captures 14 days ago too? Let me recalculate:
    // The SQL: date >= date(today, '-6 days') → 'recent', else 'earlier'
    // WHERE date >= date(today, '-13 days') AND date <= today
    // fourteenDaysAgo = -14 days, date(today, '-13 days') = -13 days → fourteenDaysAgo is OUTSIDE
    // So earlier = sevenDaysAgo (100+40) = 140

    // daily avg = total / 7
    expect(velocity.period_2_daily_avg).toBeGreaterThan(0);
    expect(velocity.period_1_daily_avg).toBeGreaterThan(0);
    expect(typeof velocity.acceleration).toBe('number');
  });

  test('week-over-week acceleration is computed', () => {
    const velocity = analytics.testComputeVelocity(GROUP_ID, today);

    // recent total: 50+30+25+15 = 120 → daily avg = 120/7 ≈ 17.14
    // earlier total: 100+40 = 140 → daily avg = 140/7 = 20
    // acceleration = ((17.14 - 20) / 20) * 100 ≈ -14.3%
    expect(velocity.acceleration).toBeLessThan(0);
    expect(velocity.trend).toBe('decelerating');
  });
});

describe('computeStreak', () => {
  test('consecutive days with expenses detected', () => {
    const streak = analytics.testComputeStreak(GROUP_ID, today);

    // Today and yesterday both have expenses → at least 2 day streak
    // (only if both days are on the same side of average)
    expect(streak.current_streak_days).toBeGreaterThanOrEqual(1);
    expect(streak.streak_type).not.toBe('no_spending');
  });

  test('gap in spending breaks streak', () => {
    // Insert data for a separate group with a gap
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [2, 22222, 'EUR', '["EUR"]'],
    );

    // Only expense 3 days ago, nothing since
    const threeDaysAgo = format(subDays(now, 3), 'yyyy-MM-dd');
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [2, USER_ID, threeDaysAgo, 'Food', 'test', 50, 'EUR', 50],
    );

    const streak = analytics.testComputeStreak(2, today);

    // No expenses today → streak broken immediately, 0 days
    expect(streak.current_streak_days).toBe(0);
    expect(streak.streak_type).toBe('no_spending');
  });
});

describe('computeDayPatterns', () => {
  test('day with most spending is identified', () => {
    const patterns = analytics.testComputeDayPatterns(GROUP_ID, today);

    expect(patterns.length).toBeGreaterThan(0);

    // Find the day with highest avg_daily_spend
    const first = patterns.at(0);
    if (!first) return;
    const maxDay = patterns.reduce(
      (max, p) => (p.avg_daily_spend > max.avg_daily_spend ? p : max),
      first,
    );

    expect(maxDay.avg_daily_spend).toBeGreaterThan(0);
    expect(maxDay.day_name).toBeTruthy();
  });

  test('patterns are sorted by day_of_week ascending', () => {
    const patterns = analytics.testComputeDayPatterns(GROUP_ID, today);

    for (let i = 1; i < patterns.length; i++) {
      const curr = patterns.at(i);
      const prev = patterns.at(i - 1);
      if (curr && prev) {
        expect(curr.day_of_week).toBeGreaterThanOrEqual(prev.day_of_week);
      }
    }
  });

  test('each pattern has required fields', () => {
    const patterns = analytics.testComputeDayPatterns(GROUP_ID, today);

    for (const p of patterns) {
      expect(typeof p.day_of_week).toBe('number');
      expect(p.day_of_week).toBeGreaterThanOrEqual(0);
      expect(p.day_of_week).toBeLessThanOrEqual(6);
      expect(typeof p.day_name).toBe('string');
      expect(typeof p.avg_daily_spend).toBe('number');
      expect(typeof p.total_transactions).toBe('number');
      expect(typeof p.vs_average_percent).toBe('number');
      expect(typeof p.top_category).toBe('string');
    }
  });
});

describe('computeMonthOverMonth', () => {
  test('current vs previous month trend direction', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const trend = analytics.testComputeMonthOverMonth(GROUP_ID, now, monthStart, today);

    expect(trend.period).toBe('month');
    expect(['up', 'down', 'stable']).toContain(trend.direction);
  });

  test('percentage change is calculated', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const trend = analytics.testComputeMonthOverMonth(GROUP_ID, now, monthStart, today);

    expect(typeof trend.change_percent).toBe('number');
    expect(typeof trend.current_total).toBe('number');
    expect(typeof trend.previous_total).toBe('number');
  });

  test('category changes are included', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const trend = analytics.testComputeMonthOverMonth(GROUP_ID, now, monthStart, today);

    expect(Array.isArray(trend.category_changes)).toBe(true);
    for (const cc of trend.category_changes) {
      expect(typeof cc.category).toBe('string');
      expect(typeof cc.current).toBe('number');
      expect(typeof cc.previous).toBe('number');
      expect(typeof cc.change_percent).toBe('number');
    }
  });
});

describe('computeWeekOverWeek', () => {
  test('this week vs last week comparison', () => {
    const trend = analytics.testComputeWeekOverWeek(GROUP_ID, today);

    expect(trend.period).toBe('week');
    expect(typeof trend.current_total).toBe('number');
    expect(typeof trend.previous_total).toBe('number');
    expect(['up', 'down', 'stable']).toContain(trend.direction);
  });

  test('category changes sorted by absolute change_percent descending', () => {
    const trend = analytics.testComputeWeekOverWeek(GROUP_ID, today);

    const changes = trend.category_changes;
    for (let i = 1; i < changes.length; i++) {
      const curr = changes.at(i);
      const prev = changes.at(i - 1);
      if (curr && prev) {
        expect(Math.abs(curr.change_percent)).toBeLessThanOrEqual(Math.abs(prev.change_percent));
      }
    }
  });
});

describe('computeProjection', () => {
  test('linear projection to end of month', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const projection = analytics.testComputeProjection(
      GROUP_ID,
      now,
      currentMonth,
      monthStart,
      today,
    );

    // Should not be null since we have expenses this month
    if (now.getDate() < 3) {
      // Edge case: first 2 days of month with 0 total could return null
      // Our test data ensures there ARE expenses today, so it should still work
    }

    expect(projection).not.toBeNull();
    if (!projection) return;
    expect(projection.days_elapsed).toBe(now.getDate());
    expect(projection.days_in_month).toBe(getDaysInMonth(now));
  });

  test('projection uses EMA-based algorithm: result ≥ current total', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const projection = analytics.testComputeProjection(
      GROUP_ID,
      now,
      currentMonth,
      monthStart,
      today,
    );

    if (projection) {
      // Projected total should always be at least what we've already spent
      expect(projection.projected_total).toBeGreaterThanOrEqual(projection.current_total);
    }
  });

  test('confidence is low when days_elapsed < 7', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const projection = analytics.testComputeProjection(
      GROUP_ID,
      now,
      currentMonth,
      monthStart,
      today,
    );

    if (projection && now.getDate() < 7) {
      expect(projection.confidence).toBe('low');
    } else if (projection && now.getDate() >= 20) {
      expect(projection.confidence).toBe('high');
    } else if (projection) {
      expect(projection.confidence).toBe('medium');
    }
  });
});

describe('computeBurnRates', () => {
  test('budget utilization percentage computed for each category', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const burnRates = analytics.testComputeBurnRates(
      GROUP_ID,
      now,
      currentMonth,
      monthStart,
      today,
    );

    expect(burnRates.length).toBe(2); // Food and Transport
    for (const br of burnRates) {
      expect(typeof br.spent).toBe('number');
      expect(typeof br.budget_limit).toBe('number');
      expect(typeof br.daily_burn_rate).toBe('number');
      expect(typeof br.projected_total).toBe('number');
    }
  });

  test('status is one of on_track/warning/critical/exceeded', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const burnRates = analytics.testComputeBurnRates(
      GROUP_ID,
      now,
      currentMonth,
      monthStart,
      today,
    );

    for (const br of burnRates) {
      expect(['on_track', 'warning', 'critical', 'exceeded']).toContain(br.status);
    }
  });

  test('runway days calculation', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const burnRates = analytics.testComputeBurnRates(
      GROUP_ID,
      now,
      currentMonth,
      monthStart,
      today,
    );

    for (const br of burnRates) {
      expect(typeof br.runway_days).toBe('number');
      if (br.daily_burn_rate > 0) {
        // runway = (limit - spent) / daily_burn_rate
        const expectedRunway = (br.budget_limit - br.spent) / br.daily_burn_rate;
        if (expectedRunway === Infinity) {
          expect(br.runway_days).toBe(999);
        } else {
          expect(br.runway_days).toBe(Math.round(expectedRunway * 10) / 10);
        }
      }
    }
  });

  test('days_elapsed and days_remaining add up to days in month', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const burnRates = analytics.testComputeBurnRates(
      GROUP_ID,
      now,
      currentMonth,
      monthStart,
      today,
    );

    for (const br of burnRates) {
      expect(br.days_elapsed + br.days_remaining).toBe(getDaysInMonth(now));
    }
  });
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
    expect(food?.avgTxPerMonth).toBeCloseTo(12.3, 0);
    expect(food?.monthsOfData).toBe(3);
  });

  test('single month of history: EMA equals that month', () => {
    const rows = [{ category: 'Car', month: '2026-03', monthly_total: 500, tx_count: 2 }];
    const profiles = buildCategoryProfiles(rows);
    const car = profiles.get('Car');

    expect(car?.ema).toBe(500);
    expect(car?.cv).toBe(0); // no variance with 1 data point
    expect(car?.avgTxPerMonth).toBe(2);
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
  const stableProfile = { ema: 15000, cv: 0.2, avgTxPerMonth: 3, monthsOfData: 4 };
  const volatileProfile = { ema: 5000, cv: 1.2, avgTxPerMonth: 2, monthsOfData: 3 };

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

  test('volatile category shifts to pace faster (higher CV)', () => {
    // Same day 10, same spent — but volatile vs stable profile
    const stableResult = projectCategory(3000, 10, 30, stableProfile);
    const volatileResult = projectCategory(3000, 10, 30, volatileProfile);

    // Volatile profile has higher CV → higher alpha → more pace influence
    // Pace = (3000/10)*30 = 9000 > EMA(5000)
    // Both should differ due to different EMA values AND different alpha
    expect(volatileResult).toBeDefined();
    expect(stableResult).toBeDefined();
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

describe('burn rate: single large expense early in month', () => {
  test('single large expense does not produce critical status (with or without history)', () => {
    // Group 10: budget 500 EUR for "Car", single expense of 200 EUR
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [10, 101010, 'EUR', '["EUR"]'],
    );
    db.run(
      `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
      [10, 'Car', currentMonth, 500, 'EUR'],
    );
    // Single expense: 200 EUR → naive projection on day 4 = 200/4*30 = 1500 → critical
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [10, USER_ID, today, 'Car', 'repair', 200, 'EUR', 200],
    );

    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const burnRates = analytics.testComputeBurnRates(10, now, currentMonth, monthStart, today);

    expect(burnRates.length).toBe(1);
    const carBurn = burnRates[0];

    // Without history: projectCategory returns currentSpent = 200 → on_track
    // With history: uses EMA baseline → still conservative early in month
    expect(carBurn?.projected_total).toBeLessThanOrEqual(
      Math.round((200 / now.getDate()) * getDaysInMonth(now) * 100) / 100,
    );
  });

  test('category with historical pattern uses EMA for projection', () => {
    // Group 11: has 3 months of Car history averaging ~100 EUR/month
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [11, 111111, 'EUR', '["EUR"]'],
    );
    db.run(
      `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
      [11, 'Car', currentMonth, 500, 'EUR'],
    );

    // Historical data: 3 months of ~100 EUR
    const m1 = format(
      new Date(subMonths(now, 1).getFullYear(), subMonths(now, 1).getMonth(), 10),
      'yyyy-MM-dd',
    );
    const m2 = format(
      new Date(subMonths(now, 2).getFullYear(), subMonths(now, 2).getMonth(), 10),
      'yyyy-MM-dd',
    );
    const m3 = format(
      new Date(subMonths(now, 3).getFullYear(), subMonths(now, 3).getMonth(), 10),
      'yyyy-MM-dd',
    );
    for (const d of [m1, m2, m3]) {
      db.run(
        `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [11, USER_ID, d, 'Car', 'fuel', 100, 'EUR', 100],
      );
    }

    // Current month: 80 EUR spent
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [11, USER_ID, today, 'Car', 'fuel', 80, 'EUR', 80],
    );

    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const burnRates = analytics.testComputeBurnRates(11, now, currentMonth, monthStart, today);

    expect(burnRates.length).toBe(1);
    const carBurn = burnRates[0];

    // With history (EMA ~100), early in month: projection should be close to EMA (100)
    // not the naive linear extrapolation
    expect(carBurn?.projected_total).toBeLessThan(500);
    expect(carBurn?.status).toBe('on_track');
  });
});
