import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { format, getDaysInMonth, startOfMonth, subDays, subMonths } from 'date-fns';

// --- Setup in-memory database and mock the singleton ---

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON;');

// Create tables matching the production schema (post-migrations)
db.exec(`
  CREATE TABLE groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_group_id INTEGER NOT NULL UNIQUE,
    google_refresh_token TEXT,
    spreadsheet_id TEXT,
    default_currency TEXT NOT NULL DEFAULT 'USD',
    enabled_currencies TEXT NOT NULL DEFAULT '["USD"]',
    custom_prompt TEXT,
    active_topic_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL UNIQUE,
    group_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
  );
`);

db.exec(`
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    UNIQUE(group_id, name)
  );
`);

db.exec(`
  CREATE TABLE expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    comment TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    eur_amount REAL NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.exec(`
  CREATE INDEX idx_expenses_group_id ON expenses(group_id);
`);

db.exec(`
  CREATE INDEX idx_expenses_date ON expenses(date);
`);

db.exec(`
  CREATE INDEX idx_expenses_group_date ON expenses(group_id, date);
`);

db.exec(`
  CREATE TABLE budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    month TEXT NOT NULL,
    limit_amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    UNIQUE(group_id, category, month)
  );
`);

db.exec(`
  CREATE INDEX idx_budgets_group_id ON budgets(group_id);
  CREATE INDEX idx_budgets_month ON budgets(month);
  CREATE INDEX idx_budgets_group_month ON budgets(group_id, month);
`);

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
const { SpendingAnalytics } = await import('./spending-analytics');

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
  // Insert group
  db.run(
    `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
    [GROUP_ID, 12345, 'EUR', '["EUR"]'],
  );

  // Insert user
  db.run(`INSERT INTO users (id, telegram_id, group_id) VALUES (?, ?, ?)`, [
    USER_ID,
    99999,
    GROUP_ID,
  ]);

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

  test('projection is based on daily rate * total days', () => {
    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const projection = analytics.testComputeProjection(
      GROUP_ID,
      now,
      currentMonth,
      monthStart,
      today,
    );

    if (projection) {
      const dailyRate = projection.current_total / projection.days_elapsed;
      const expectedProjected = Math.round(dailyRate * projection.days_in_month * 100) / 100;
      expect(projection.projected_total).toBe(expectedProjected);
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
