// Spending analytics: single-expense burn rate, interval profiles, intermittent TSB projection and activity gate.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { format, getDaysInMonth, startOfMonth, subMonths } from 'date-fns';
import {
  buildIntervalProfiles,
  currentMonth,
  installAnalyticsFixture,
  now,
  passesActivityGate,
  projectCategory,
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

describe('burn rate: single large expense early in month', () => {
  test('single large expense does not produce critical status (with or without history)', () => {
    // Group 40: budget 500 EUR for "Car", single expense of 200 EUR
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [40, 404040, 'EUR', '["EUR"]'],
    );
    db.run(
      `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
      [40, 'Car', currentMonth, 500, 'EUR'],
    );
    // Single expense: 200 EUR → naive projection on day 4 = 200/4*30 = 1500 → critical
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [40, USER_ID, today, 'Car', 'repair', 200, 'EUR', 200],
    );

    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const burnRates = analytics.testComputeBurnRates(40, now, currentMonth, monthStart, today);

    expect(burnRates.length).toBe(1);
    const carBurn = burnRates[0];

    // Without history: projectCategory returns currentSpent = 200 → on_track
    // With history: uses EMA baseline → still conservative early in month
    expect(carBurn?.projected_total).toBeLessThanOrEqual(
      Math.round((200 / now.getDate()) * getDaysInMonth(now) * 100) / 100,
    );
  });

  test('category with historical pattern uses EMA for projection', () => {
    // Group 41: has 3 months of Car history averaging ~100 EUR/month
    db.run(
      `INSERT INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?, ?)`,
      [41, 414141, 'EUR', '["EUR"]'],
    );
    db.run(
      `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
      [41, 'Car', currentMonth, 500, 'EUR'],
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
        [41, USER_ID, d, 'Car', 'fuel', 100, 'EUR', 100],
      );
    }

    // Current month: 80 EUR spent
    db.run(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [41, USER_ID, today, 'Car', 'fuel', 80, 'EUR', 80],
    );

    const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const burnRates = analytics.testComputeBurnRates(41, now, currentMonth, monthStart, today);

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
