/**
 * Characterization tests for forecast-core: pin the routing and rounding of
 * projectCategory and the interval statistics of buildIntervalProfiles.
 * Expected values were captured from the implementation before it was decomposed.
 */
import { describe, expect, test } from 'bun:test';
import { buildIntervalProfiles, projectCategory } from './forecast-core';
import type { CategoryProfile, IntervalProfile } from './types';

function profile(overrides: Partial<CategoryProfile> = {}): CategoryProfile {
  return {
    ema: 100,
    cv: 0.2,
    monthsOfData: 6,
    avgTxPerMonth: 10,
    zeroMonthRatio: 0,
    monthlyTotals: [90, 100, 110, 100, 95, 105],
    ...overrides,
  };
}

function stableInterval(avgInterval: number): IntervalProfile {
  return { avgInterval, intervalCv: 0.1, avgAmount: 40, isStable: true };
}

describe('projectCategory', () => {
  test('returns spent amount when no day has elapsed', () => {
    expect(projectCategory(50, 0, 30, profile())).toBe(50);
  });

  describe('stable interval profile', () => {
    test('adds expected remaining fills (mid-cycle)', () => {
      expect(projectCategory(100, 10, 30, null, 3, stableInterval(7))).toBe(220);
    });

    test('treats unknown days-since-last-tx as 0', () => {
      expect(projectCategory(100, 10, 30, null, undefined, stableInterval(7))).toBe(180);
    });

    test('next fill beyond month end adds nothing', () => {
      expect(projectCategory(100, 10, 30, null, 0, stableInterval(25))).toBe(100);
    });

    test('runs before stall detection (long gap is normal for a long cycle)', () => {
      expect(projectCategory(100, 28, 30, null, 0, stableInterval(25))).toBe(100);
      expect(projectCategory(100, 20, 30, null, 6, stableInterval(7))).toBe(
        100 + (1 + Math.floor((10 - 1) / 7)) * 40,
      );
    });
  });

  describe('stall and history gates', () => {
    test('stalled category after a third of the month returns spent amount', () => {
      expect(projectCategory(100, 20, 30, profile(), 6)).toBe(100);
    });

    test('same gap early in the month is not a stall', () => {
      expect(projectCategory(100, 5, 30, profile(), 6)).toBe(116.67);
    });

    test('no profile returns spent amount', () => {
      expect(projectCategory(100, 15, 30, null)).toBe(100);
    });

    test('fewer than 3 months of data returns spent amount', () => {
      expect(projectCategory(100, 15, 30, profile({ monthsOfData: 2 }))).toBe(100);
    });
  });

  describe('demand pattern routing', () => {
    test('lumpy returns spent amount', () => {
      expect(projectCategory(100, 15, 30, profile({ zeroMonthRatio: 0.5, cv: 0.9 }))).toBe(100);
    });

    test('intermittent uses TSB forecast over monthly totals', () => {
      const p = profile({ zeroMonthRatio: 0.5, cv: 0.3, monthlyTotals: [0, 200, 0, 150, 0, 180] });
      expect(projectCategory(100, 15, 30, p)).toBe(128.04);
    });

    test('intermittent without monthly totals falls back to EMA x activity probability', () => {
      // Property omitted entirely (not `undefined`): profile() would otherwise supply default totals.
      const withoutTotals: CategoryProfile = {
        ema: 100,
        cv: 0.3,
        monthsOfData: 6,
        avgTxPerMonth: 10,
        zeroMonthRatio: 0.5,
      };
      expect(projectCategory(100, 15, 30, withoutTotals)).toBe(125);
      expect(
        projectCategory(100, 15, 30, profile({ zeroMonthRatio: 0.5, cv: 0.3, monthlyTotals: [] })),
      ).toBe(125);
    });

    test('erratic is pace-only', () => {
      expect(projectCategory(100, 15, 30, profile({ cv: 0.9 }))).toBe(200);
    });

    test('smooth blends EMA and pace', () => {
      expect(projectCategory(100, 15, 30, profile())).toBe(130);
    });

    test('smooth pace trust is capped at 1 and result is rounded to cents', () => {
      expect(projectCategory(100, 29, 30, profile({ cv: 0.6, ema: 50 }))).toBe(103.45);
    });
  });
});

describe('buildIntervalProfiles', () => {
  const tx = (date: string, amount = 10, category = 'fuel') => ({ date, category, amount });

  test('computes stable low-frequency cycle statistics', () => {
    const result = buildIntervalProfiles([
      tx('2026-01-01', 50),
      tx('2026-01-22', 60),
      tx('2026-02-12', 55),
      tx('2026-03-05', 45),
      tx('2026-01-01', 1, 'other'),
    ]);
    expect([...result.keys()]).toEqual(['fuel']);
    expect(result.get('fuel')).toEqual({
      avgInterval: 21,
      intervalCv: 0,
      avgAmount: 52.5,
      isStable: true,
    });
  });

  test('sorts by date before measuring gaps', () => {
    const result = buildIntervalProfiles([
      tx('2026-03-05', 45),
      tx('2026-01-01', 50),
      tx('2026-02-12', 55),
      tx('2026-01-22', 60),
    ]);
    expect(result.get('fuel')?.avgInterval).toBe(21);
  });

  test('ignores same-day and over-90-day gaps; high frequency is never stable', () => {
    const result = buildIntervalProfiles([
      tx('2026-01-01'),
      tx('2026-01-01'),
      tx('2026-01-02'),
      tx('2026-01-03'),
      tx('2026-01-05'),
      tx('2026-06-01'),
      tx('2026-06-03'),
    ]);
    expect(result.get('fuel')).toEqual({
      avgInterval: 1.5,
      intervalCv: 0.333,
      avgAmount: 10,
      isStable: false,
    });
  });

  test('omits categories with fewer than 3 valid intervals', () => {
    const result = buildIntervalProfiles([tx('2026-01-01'), tx('2026-01-10'), tx('2026-01-20')]);
    expect(result.size).toBe(0);
  });
});
