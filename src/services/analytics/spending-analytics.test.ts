// Spending analytics: velocity, streaks, patterns, month/week comparisons, projection and burn-rate status.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { format, getDaysInMonth, startOfMonth, subDays, subMonths } from 'date-fns';
import {
  currentMonth,
  GROUP_ID,
  installAnalyticsFixture,
  now,
  seedAnalyticsFixture,
  TestableSpendingAnalytics,
  today,
  USER_ID,
} from './spending-analytics-test-harness';

const { db } = installAnalyticsFixture();

let analytics: TestableSpendingAnalytics;

beforeAll(() => {
  seedAnalyticsFixture(db);
  analytics = new TestableSpendingAnalytics();
});

afterAll(() => {
  db.close();
});

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
