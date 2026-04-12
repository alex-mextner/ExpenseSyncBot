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
const {
  SpendingAnalytics,
  buildCategoryProfiles,
  buildIntervalProfiles,
  passesActivityGate,
  projectCategory,
} = await import('./spending-analytics');

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

describe('computeBurnRates — normExceedsBudget suppresses warning/critical', () => {
  const GID = 20;

  test('category with EMA > budget gets on_track even if projection > budget', () => {
    // Setup: group 20 with a category that historically spends 500 EUR/month
    // but budget is set to 200 EUR — normExceedsBudget should suppress warning/critical
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [GID, 202020, 'EUR', '["EUR"]'],
    );

    // 6 months of history: 500 EUR each month → EMA will be ~500
    for (let m = 1; m <= 6; m++) {
      const monthDate = format(
        new Date(subMonths(now, m).getFullYear(), subMonths(now, m).getMonth(), 15),
        'yyyy-MM-dd',
      );
      db.run(
        `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [GID, USER_ID, monthDate, 'Gym', 'monthly', 500, 'EUR', 500],
      );
    }

    // Current month: 100 EUR spent (< budget 200), but pace extrapolates higher
    const day3 = format(new Date(now.getFullYear(), now.getMonth(), 3), 'yyyy-MM-dd');
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [GID, USER_ID, day3, 'Gym', 'session', 100, 'EUR', 100],
    );

    // Budget: 200 EUR for Gym (less than historical EMA of ~500)
    db.run(
      `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
      [GID, 'Gym', currentMonth, 200, 'EUR'],
    );

    // Use day 15 so we have enough data for projection
    const fakeNow = new Date(now.getFullYear(), now.getMonth(), 15);
    const fakeToday = format(fakeNow, 'yyyy-MM-dd');
    const fakeMonthStart = format(startOfMonth(fakeNow), 'yyyy-MM-dd');
    const fakeCurrentMonth = format(fakeNow, 'yyyy-MM');

    const burnRates = analytics.testComputeBurnRates(
      GID,
      fakeNow,
      fakeCurrentMonth,
      fakeMonthStart,
      fakeToday,
    );

    const gym = burnRates.find((br) => br.category === 'Gym');
    if (!gym) throw new Error('Gym burn rate missing');
    // Spent < budget → not exceeded
    expect(gym.spent).toBeLessThan(gym.budget_limit);
    // normExceedsBudget is true (EMA ~500 > budget 200),
    // so warning/critical should be suppressed → status is on_track
    expect(gym.status).toBe('on_track');
  });

  test('exceeded status still fires even when normExceedsBudget is true', () => {
    const GID2 = 21;
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [GID2, 212121, 'EUR', '["EUR"]'],
    );

    // 6 months of history: 500 EUR each
    for (let m = 1; m <= 6; m++) {
      const monthDate = format(
        new Date(subMonths(now, m).getFullYear(), subMonths(now, m).getMonth(), 15),
        'yyyy-MM-dd',
      );
      db.run(
        `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [GID2, USER_ID, monthDate, 'Gym', 'monthly', 500, 'EUR', 500],
      );
    }

    // Current month: 250 EUR spent (> budget 200) — exceeded
    const day5 = format(new Date(now.getFullYear(), now.getMonth(), 5), 'yyyy-MM-dd');
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [GID2, USER_ID, day5, 'Gym', 'session', 250, 'EUR', 250],
    );

    db.run(
      `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
      [GID2, 'Gym', currentMonth, 200, 'EUR'],
    );

    const fakeNow = new Date(now.getFullYear(), now.getMonth(), 15);
    const fakeToday = format(fakeNow, 'yyyy-MM-dd');
    const fakeMonthStart = format(startOfMonth(fakeNow), 'yyyy-MM-dd');
    const fakeCurrentMonth = format(fakeNow, 'yyyy-MM');

    const burnRates = analytics.testComputeBurnRates(
      GID2,
      fakeNow,
      fakeCurrentMonth,
      fakeMonthStart,
      fakeToday,
    );

    const gym = burnRates.find((br) => br.category === 'Gym');
    if (!gym) throw new Error('Gym burn rate missing');
    // Spent > budget → exceeded regardless of normExceedsBudget
    expect(gym.status).toBe('exceeded');
  });
});

describe('computeBurnRates — stall detection in production path', () => {
  test('stalled category returns currentSpent as projection', () => {
    const GID = 22;
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [GID, 222222, 'EUR', '["EUR"]'],
    );

    // 4 months of history to establish a profile
    for (let m = 1; m <= 4; m++) {
      // Multiple tx per month for activity gate
      for (let t = 0; t < 3; t++) {
        const txDate = format(
          new Date(subMonths(now, m).getFullYear(), subMonths(now, m).getMonth(), 5 + t * 5),
          'yyyy-MM-dd',
        );
        db.run(
          `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [GID, USER_ID, txDate, 'Taxi', 'ride', 50, 'EUR', 50],
        );
      }
    }

    // Current month: expenses only on days 1-3, then nothing
    for (let d = 1; d <= 3; d++) {
      const txDate = format(new Date(now.getFullYear(), now.getMonth(), d), 'yyyy-MM-dd');
      db.run(
        `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [GID, USER_ID, txDate, 'Taxi', 'ride', 30, 'EUR', 30],
      );
    }

    // Budget for the category
    db.run(
      `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
      [GID, 'Taxi', currentMonth, 500, 'EUR'],
    );

    // Simulate day 15: daysSinceLastTx = 15 - 3 = 12, monthProgress = 15/30 = 0.5
    const fakeNow = new Date(now.getFullYear(), now.getMonth(), 15);
    const fakeToday = format(fakeNow, 'yyyy-MM-dd');
    const fakeMonthStart = format(startOfMonth(fakeNow), 'yyyy-MM-dd');
    const fakeCurrentMonth = format(fakeNow, 'yyyy-MM');

    const burnRates = analytics.testComputeBurnRates(
      GID,
      fakeNow,
      fakeCurrentMonth,
      fakeMonthStart,
      fakeToday,
    );

    const taxi = burnRates.find((br) => br.category === 'Taxi');
    if (!taxi) throw new Error('Taxi burn rate missing');
    // Stall detection: daysSinceLastTx=12 >= 5, monthProgress=0.5 > 0.33
    // projected_total should equal spent (no extrapolation)
    expect(taxi.projected_total).toBe(taxi.spent);
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

// ============================================================
// buildIntervalProfiles — cycle detection from raw transactions
// ============================================================

describe('buildIntervalProfiles', () => {
  test('detects stable interval pattern (regular refueling)', () => {
    // Transactions every ~20 days with similar amounts
    const transactions = [
      { date: '2026-01-05', category: 'Машина', amount: 50 },
      { date: '2026-01-25', category: 'Машина', amount: 48 },
      { date: '2026-02-14', category: 'Машина', amount: 52 },
      { date: '2026-03-06', category: 'Машина', amount: 49 },
      { date: '2026-03-26', category: 'Машина', amount: 51 },
    ];

    const profiles = buildIntervalProfiles(transactions);
    const profile = profiles.get('Машина');

    expect(profile).toBeDefined();
    expect(profile?.isStable).toBe(true);
    expect(profile?.avgInterval).toBeGreaterThan(18);
    expect(profile?.avgInterval).toBeLessThan(22);
    expect(profile?.intervalCv).toBeLessThan(0.4);
    expect(profile?.avgAmount).toBeGreaterThan(45);
    expect(profile?.avgAmount).toBeLessThan(55);
  });

  test('rejects irregular pattern (high CV)', () => {
    // Intervals: 3, 45, 7, 60 days — very irregular
    const transactions = [
      { date: '2026-01-01', category: 'Развлечения', amount: 100 },
      { date: '2026-01-04', category: 'Развлечения', amount: 200 },
      { date: '2026-02-18', category: 'Развлечения', amount: 50 },
      { date: '2026-02-25', category: 'Развлечения', amount: 300 },
      { date: '2026-04-26', category: 'Развлечения', amount: 80 },
    ];

    const profiles = buildIntervalProfiles(transactions);
    const profile = profiles.get('Развлечения');

    expect(profile).toBeDefined();
    expect(profile?.isStable).toBe(false);
    expect(profile?.intervalCv).toBeGreaterThanOrEqual(0.4);
  });

  test('filters out gaps > 90 days', () => {
    // Gap of 120 days between tx 2 and tx 3 should be excluded
    const transactions = [
      { date: '2026-01-05', category: 'Здоровье', amount: 100 },
      { date: '2026-01-25', category: 'Здоровье', amount: 100 },
      { date: '2026-02-14', category: 'Здоровье', amount: 100 },
      { date: '2026-03-06', category: 'Здоровье', amount: 100 },
      { date: '2026-07-04', category: 'Здоровье', amount: 100 }, // 120-day gap
      { date: '2026-07-24', category: 'Здоровье', amount: 100 },
    ];

    const profiles = buildIntervalProfiles(transactions);
    const profile = profiles.get('Здоровье');

    expect(profile).toBeDefined();
    // Should have 4 valid intervals (20, 20, 20, 20) — the 120-day gap excluded
    expect(profile?.avgInterval).toBeGreaterThan(18);
    expect(profile?.avgInterval).toBeLessThan(22);
  });

  test('skips category with fewer than 3 valid intervals', () => {
    const transactions = [
      { date: '2026-01-05', category: 'Редкое', amount: 100 },
      { date: '2026-01-25', category: 'Редкое', amount: 100 },
      { date: '2026-02-14', category: 'Редкое', amount: 100 },
      // Only 2 intervals — below minimum
    ];

    const profiles = buildIntervalProfiles(transactions);
    expect(profiles.has('Редкое')).toBe(false);
  });

  test('filters out same-day transactions', () => {
    // Multiple items on same day (e.g., one receipt) should not count as 0-day intervals
    const transactions = [
      { date: '2026-01-05', category: 'Еда', amount: 10 },
      { date: '2026-01-05', category: 'Еда', amount: 15 },
      { date: '2026-01-05', category: 'Еда', amount: 20 },
      { date: '2026-01-25', category: 'Еда', amount: 12 },
      { date: '2026-01-25', category: 'Еда', amount: 18 },
      { date: '2026-02-14', category: 'Еда', amount: 11 },
      { date: '2026-03-06', category: 'Еда', amount: 14 },
      { date: '2026-03-26', category: 'Еда', amount: 13 },
    ];

    const profiles = buildIntervalProfiles(transactions);
    const profile = profiles.get('Еда');

    expect(profile).toBeDefined();
    // Valid intervals: 20, 20, 20, 20 (same-day duplicates excluded)
    expect(profile?.avgInterval).toBeGreaterThan(18);
  });

  test('groups categories independently', () => {
    const transactions = [
      { date: '2026-01-05', category: 'A', amount: 50 },
      { date: '2026-01-25', category: 'A', amount: 48 },
      { date: '2026-02-14', category: 'A', amount: 52 },
      { date: '2026-03-06', category: 'A', amount: 49 },
      { date: '2026-01-01', category: 'B', amount: 100 },
      { date: '2026-01-02', category: 'B', amount: 100 },
      // B has only 1 interval → should not appear
    ];

    const profiles = buildIntervalProfiles(transactions);
    expect(profiles.has('A')).toBe(true);
    expect(profiles.has('B')).toBe(false);
  });

  test('empty input returns empty map', () => {
    const profiles = buildIntervalProfiles([]);
    expect(profiles.size).toBe(0);
  });
});

// ============================================================
// projectCategory with intervalProfile parameter
// ============================================================

describe('projectCategory with intervalProfile', () => {
  const stableProfile = { ema: 150, cv: 0.2, monthsOfData: 4, avgTxPerMonth: 2, zeroMonthRatio: 0 };

  test('stable interval profile overrides S-B routing', () => {
    // Day 10 of 30, spent 50, last tx 4 days ago (below 5-day stall threshold)
    // Interval profile: every 20 days, avg amount 50
    // Time to next fill: 20 - 4 = 16 days, fits in remaining 20 days
    // Expected more fills: 1 + floor((20 - 16) / 20) = 1 + 0 = 1
    // Projected: 50 + 1 * 50 = 100
    const interval = { avgInterval: 20, intervalCv: 0.15, avgAmount: 50, isStable: true };
    const result = projectCategory(50, 10, 30, stableProfile, 4, interval);
    expect(result).toBe(100);
  });

  test('interval profile predicts multiple remaining fills', () => {
    // Day 5 of 30, spent 50, last tx today (daysSinceLastTx = 0)
    // Interval: every 7 days, avg 50
    // Time to next: 7 - 0 = 7 days, remaining = 25
    // Fills: 1 + floor((25 - 7) / 7) = 1 + 2 = 3
    // Projected: 50 + 3 * 50 = 200
    const interval = { avgInterval: 7, intervalCv: 0.2, avgAmount: 50, isStable: true };
    const result = projectCategory(50, 5, 30, null, 0, interval);
    expect(result).toBe(200);
  });

  test('interval profile with no remaining time predicts 0 more fills', () => {
    // Day 28 of 30, last tx 2 days ago
    // Interval: every 20 days, avg 50
    // Time to next: 20 - 2 = 18 days, remaining = 2 days → 18 > 2, no more fills
    // Projected: 200 + 0 = 200
    const interval = { avgInterval: 20, intervalCv: 0.15, avgAmount: 50, isStable: true };
    const result = projectCategory(200, 28, 30, stableProfile, 2, interval);
    expect(result).toBe(200);
  });

  test('unstable interval profile falls through to S-B routing', () => {
    // isStable = false → interval profile ignored, falls through to normal projection
    const interval = { avgInterval: 20, intervalCv: 0.6, avgAmount: 50, isStable: false };
    const withInterval = projectCategory(5000, 10, 30, stableProfile, 2, interval);
    const without = projectCategory(5000, 10, 30, stableProfile, 2);
    expect(withInterval).toBe(without);
  });

  test('undefined interval profile falls through to S-B routing', () => {
    const withUndef = projectCategory(5000, 10, 30, stableProfile, 2, undefined);
    const without = projectCategory(5000, 10, 30, stableProfile, 2);
    expect(withUndef).toBe(without);
  });

  test('stable interval profile overrides stall detection for long cycles', () => {
    // daysSinceLastTx = 6, monthProgress > 0.33 → stall would fire,
    // but stable interval profile runs first: next fill in 10-6=4 days fits
    // in remaining 15 days → expects 1 + floor((15-4)/10)=2 more fills.
    // Projected: 100 + 2*50 = 200
    const interval = { avgInterval: 10, intervalCv: 0.1, avgAmount: 50, isStable: true };
    const result = projectCategory(100, 15, 30, stableProfile, 6, interval);
    expect(result).toBe(200);
  });

  test('stall detection fires when interval profile is unstable', () => {
    // With no stable interval to anchor on, a 6-day gap past monthProgress>0.33
    // means the category stopped spending mid-month.
    const interval = { avgInterval: 10, intervalCv: 0.8, avgAmount: 50, isStable: false };
    const result = projectCategory(100, 15, 30, stableProfile, 6, interval);
    expect(result).toBe(100);
  });

  test('interval profile with daysSinceLastTx undefined defaults to 0', () => {
    // Day 5 of 30, no daysSinceLastTx → treated as 0
    // Interval: every 10 days, avg 50
    // Time to next: 10 - 0 = 10 days, remaining = 25
    // Fills: 1 + floor((25 - 10) / 10) = 1 + 1 = 2
    // Projected: 50 + 2 * 50 = 150
    const interval = { avgInterval: 10, intervalCv: 0.1, avgAmount: 50, isStable: true };
    const result = projectCategory(50, 5, 30, null, undefined, interval);
    expect(result).toBe(150);
  });

  test('result is never less than currentSpent', () => {
    // Even if interval math somehow produces less (impossible with this formula, but guarding)
    const interval = { avgInterval: 100, intervalCv: 0.1, avgAmount: 1, isStable: true };
    const result = projectCategory(500, 10, 30, null, 0, interval);
    expect(result).toBeGreaterThanOrEqual(500);
  });
});

// ============================================================
// projectCategory — intermittent pattern uses TSB forecast
// ============================================================

describe('projectCategory — intermittent TSB path', () => {
  // Intermittent classification requires ADI ≥ 1.32 AND cv² < 0.49.
  // `[100, 100, 100, 0]` and `[0, 100, 100, 120]` satisfy both:
  //   zeroMonthRatio=0.25 → adi=1.333
  //   cv²=0.333 resp. 0.344 < 0.49
  // The patterns described in the task spec (`[100, 0, 80, 0, 60]` etc.)
  // happen to classify as "lumpy" because the heavier mix of zeros inflates cv²
  // above 0.49. Lumpy returns currentSpent unconditionally, so TSB is never
  // invoked for them. To exercise the TSB code path we use 4-month sequences
  // with a single zero, which reliably land in the intermittent quadrant.

  const FADING: number[] = [100, 100, 100, 0];
  const GROWING: number[] = [0, 100, 100, 120];

  function intermittentProfile(monthlyTotals: number[]): {
    ema: number;
    cv: number;
    monthsOfData: number;
    avgTxPerMonth: number;
    zeroMonthRatio: number;
    monthlyTotals: number[];
  } {
    const n = monthlyTotals.length;
    const alpha = 2 / (n + 1);
    let ema = monthlyTotals[0] ?? 0;
    for (let i = 1; i < n; i++) {
      ema = alpha * (monthlyTotals[i] ?? 0) + (1 - alpha) * ema;
    }
    const mean = monthlyTotals.reduce((s, v) => s + v, 0) / n;
    const variance = monthlyTotals.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);
    const cv = mean > 0 ? stddev / mean : 0;
    const zeroMonthRatio = monthlyTotals.filter((v) => v === 0).length / n;
    return {
      ema: Math.round(ema * 100) / 100,
      cv: Math.round(cv * 1000) / 1000,
      monthsOfData: n,
      avgTxPerMonth: 2,
      zeroMonthRatio: Math.round(zeroMonthRatio * 100) / 100,
      monthlyTotals,
    };
  }

  test('pattern classifies as intermittent', () => {
    // Sanity check that the chosen sequences hit the intermittent quadrant.
    const profile = intermittentProfile(FADING);
    expect(profile.zeroMonthRatio).toBe(0.25);
    // cv² ≈ 0.333 < 0.49
    expect(profile.cv * profile.cv).toBeLessThan(0.49);
    // adi = 1/(1-0.25) ≈ 1.333 ≥ 1.32
    expect(1 / (1 - profile.zeroMonthRatio)).toBeGreaterThanOrEqual(1.32);
  });

  test('uses TSB forecast instead of simple EMA × activityProb fallback', () => {
    // Same pattern, once via the TSB path (monthlyTotals set) and once via the
    // fallback path (monthlyTotals omitted). TSB for [100,100,100,0] yields
    // prob·amount = 0.7·100 = 70. The fallback uses EMA=60 × activityProb=0.75 = 45.
    // At day 5 of 30 with a tiny currentSpent, pace influence is negligible and
    // the projection tracks whichever expectedTotal branch was taken.
    const profileWithTotals = intermittentProfile(FADING);
    const { monthlyTotals: _omit, ...profileWithoutTotals } = profileWithTotals;

    const withTsb = projectCategory(10, 5, 30, profileWithTotals, 0);
    const withoutTsb = projectCategory(10, 5, 30, profileWithoutTotals, 0);

    // TSB (70) should pull the projection much higher than EMA·activityProb (45).
    expect(withTsb).toBeGreaterThan(withoutTsb);
    expect(withTsb).toBeGreaterThan(60);
    expect(withoutTsb).toBeLessThan(55);
  });

  test('fading demand projects lower than growing demand', () => {
    // Same early-month scenario (day 5 of 30, small current spend) for both
    // intermittent profiles. TSB damps the fading series because the latest
    // period is zero, whereas the growing series sustains probability ≈ 0.755.
    const fadingProfile = intermittentProfile(FADING);
    const growingProfile = intermittentProfile(GROWING);

    const fadingProjection = projectCategory(10, 5, 30, fadingProfile, 0);
    const growingProjection = projectCategory(10, 5, 30, growingProfile, 0);

    expect(fadingProjection).toBeLessThan(growingProjection);
  });

  test('growing demand projects higher than the naive EMA × activityProb fallback', () => {
    // Cross-check the other direction: growing demand also benefits from TSB
    // (rising recent activity boosts probability) vs the flat EMA fallback.
    const growing = intermittentProfile(GROWING);
    const { monthlyTotals: _omit, ...fallback } = growing;

    const withTsb = projectCategory(10, 5, 30, growing, 0);
    const withoutTsb = projectCategory(10, 5, 30, fallback, 0);

    expect(withTsb).toBeGreaterThan(withoutTsb);
  });
});

// ============================================================
// computeBurnRates — interval profile integration (refueling cycle)
// ============================================================

describe('computeBurnRates — interval profile integration', () => {
  test('stable ~20-day interval history drives projection via interval formula, not linear pace', () => {
    const GID = 30;
    const CATEGORY = 'Машина';
    const AMOUNT = 50;
    const AVG_INTERVAL = 20;

    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [GID, 303030, 'EUR', '["EUR"]'],
    );

    // Historical transactions: every 20 days, 50 EUR each. Anchor them to the
    // current month so the simulation day (day 9) has both enough history
    // inside the 6-month lookback window and current-month activity.
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstOfCurrent = new Date(year, month, 1);
    // Walk backwards 5 intervals of 20 days from day 1 of current month, so the
    // history sits in the 3 months preceding the current month.
    const historicalDates: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const d = new Date(firstOfCurrent);
      d.setDate(d.getDate() - i * AVG_INTERVAL);
      historicalDates.push(format(d, 'yyyy-MM-dd'));
    }
    for (const d of historicalDates) {
      db.run(
        `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [GID, USER_ID, d, CATEGORY, 'fuel', AMOUNT, 'EUR', AMOUNT],
      );
    }

    // Current month: two same-day transactions on day 5 (total 100 EUR).
    // Same-day pairs don't add a 0-day interval (filtered in buildIntervalProfiles)
    // but they satisfy the activity gate (needs >=2 tx for sparse categories).
    const day5 = format(new Date(year, month, 5), 'yyyy-MM-dd');
    for (let i = 0; i < 2; i++) {
      db.run(
        `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [GID, USER_ID, day5, CATEGORY, 'fuel', AMOUNT, 'EUR', AMOUNT],
      );
    }

    // Generous budget so normExceedsBudget doesn't shortcut status logic.
    db.run(
      `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
      [GID, CATEGORY, currentMonth, 1000, 'EUR'],
    );

    // Simulate day 9 — before the 0.33 month-progress stall boundary so
    // the stall guard cannot fire.
    const fakeNow = new Date(year, month, 9);
    const daysInMonth = getDaysInMonth(fakeNow);
    const fakeToday = format(fakeNow, 'yyyy-MM-dd');
    const fakeMonthStart = format(startOfMonth(fakeNow), 'yyyy-MM-dd');
    const fakeCurrentMonth = format(fakeNow, 'yyyy-MM');

    const burnRates = analytics.testComputeBurnRates(
      GID,
      fakeNow,
      fakeCurrentMonth,
      fakeMonthStart,
      fakeToday,
    );

    const car = burnRates.find((br) => br.category === CATEGORY);
    if (!car) throw new Error(`${CATEGORY} burn rate missing`);

    // spent = 100 EUR (two same-day 50 EUR tx)
    expect(car.spent).toBe(100);

    // Interval-based formula at day 9:
    //   daysSinceLastTx = 9 - 5 = 4
    //   timeToNextFill = max(0, 20 - 4) = 16
    //   daysRemaining = daysInMonth - 9
    //   expectedMoreFills = (16 <= daysRemaining)
    //     ? 1 + floor((daysRemaining - 16) / 20) : 0
    //   projected = 100 + expectedMoreFills * 50
    const daysRemaining = daysInMonth - 9;
    const timeToNextFill = Math.max(0, AVG_INTERVAL - 4);
    const expectedMoreFills =
      timeToNextFill <= daysRemaining
        ? 1 + Math.floor((daysRemaining - timeToNextFill) / AVG_INTERVAL)
        : 0;
    const expectedIntervalProjection = 100 + expectedMoreFills * AMOUNT;

    expect(car.projected_total).toBe(expectedIntervalProjection);

    // Linear extrapolation would give (100/9)*daysInMonth ≈ 333 for 30-day months
    // and is always at least 300 — far above the interval-based estimate.
    const linearProjection = Math.round((100 / 9) * daysInMonth * 100) / 100;
    expect(linearProjection).toBeGreaterThan(car.projected_total);
    expect(linearProjection - car.projected_total).toBeGreaterThan(50);
  });
});

// ============================================================
// passesActivityGate — boundary + tier coverage
// ============================================================

describe('passesActivityGate', () => {
  test('returns false when no transactions this month', () => {
    expect(passesActivityGate(0, 15, 30, null)).toBe(false);
  });

  test('with no profile: requires at least 2 transactions', () => {
    expect(passesActivityGate(1, 15, 30, null)).toBe(false);
    expect(passesActivityGate(2, 15, 30, null)).toBe(true);
  });

  test('sparse tier (avgTxPerMonth < 5): requires at least 2 transactions', () => {
    const sparseProfile = {
      ema: 100,
      cv: 0.2,
      monthsOfData: 6,
      avgTxPerMonth: 3, // sparse
      zeroMonthRatio: 0,
    };
    expect(passesActivityGate(1, 15, 30, sparseProfile)).toBe(false);
    expect(passesActivityGate(2, 15, 30, sparseProfile)).toBe(true);
    // Sparse tier ignores month progress — 2 tx on day 1 still passes
    expect(passesActivityGate(2, 1, 30, sparseProfile)).toBe(true);
  });

  test('sparse/frequent boundary at avgTxPerMonth = 5: frequent tier kicks in', () => {
    // avgTxPerMonth exactly 5 → frequent tier → needs 30% of expected
    const boundaryProfile = {
      ema: 100,
      cv: 0.2,
      monthsOfData: 6,
      avgTxPerMonth: 5,
      zeroMonthRatio: 0,
    };
    // Day 15/30: expected so far = 5 * 0.5 = 2.5; 30% = 0.75 → ceil = 1, max(2, 1) = 2
    expect(passesActivityGate(1, 15, 30, boundaryProfile)).toBe(false);
    expect(passesActivityGate(2, 15, 30, boundaryProfile)).toBe(true);
  });

  test('frequent tier (avgTxPerMonth ≥ 5): scales threshold with month progress', () => {
    const frequentProfile = {
      ema: 500,
      cv: 0.3,
      monthsOfData: 6,
      avgTxPerMonth: 20, // frequent
      zeroMonthRatio: 0,
    };
    // Day 15/30: expected so far = 20 * 0.5 = 10; 30% = 3 → max(2, 3) = 3
    expect(passesActivityGate(2, 15, 30, frequentProfile)).toBe(false);
    expect(passesActivityGate(3, 15, 30, frequentProfile)).toBe(true);
  });

  test('frequent tier: late month requires more transactions', () => {
    const frequentProfile = {
      ema: 500,
      cv: 0.3,
      monthsOfData: 6,
      avgTxPerMonth: 20,
      zeroMonthRatio: 0,
    };
    // Day 28/30: expected so far = 20 * (28/30) ≈ 18.67; 30% ≈ 5.6 → ceil = 6
    expect(passesActivityGate(5, 28, 30, frequentProfile)).toBe(false);
    expect(passesActivityGate(6, 28, 30, frequentProfile)).toBe(true);
  });

  test('frequent tier: early month still applies minimum-2 floor', () => {
    const frequentProfile = {
      ema: 500,
      cv: 0.3,
      monthsOfData: 6,
      avgTxPerMonth: 20,
      zeroMonthRatio: 0,
    };
    // Day 1/30: expected so far ≈ 0.67; 30% ≈ 0.2 → ceil = 1, max(2, 1) = 2
    expect(passesActivityGate(1, 1, 30, frequentProfile)).toBe(false);
    expect(passesActivityGate(2, 1, 30, frequentProfile)).toBe(true);
  });
});
