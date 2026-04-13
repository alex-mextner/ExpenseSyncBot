/** Tests for computeExpenseStats, formatStats, formatStatsDiff, formatStatsTrend */
import { describe, expect, mock, test } from 'bun:test';

// Mock convertCurrency — use simple 1:100 EUR→RSD rate for predictable tests
mock.module('../currency/converter', () => ({
  convertCurrency: (amount: number, _from: string, to: string) => {
    if (to === 'RSD') return amount * 100; // 1 EUR = 100 RSD (test rate)
    if (to === 'EUR') return amount / 100;
    return amount;
  },
  formatAmount: (amount: number, currency: string) => `${Math.round(amount)} ${currency}`,
}));

import type { ExpenseStats } from './stats';
import { computeExpenseStats, formatStats, formatStatsDiff, formatStatsTrend } from './stats';

describe('computeExpenseStats', () => {
  test('returns zeroed stats for empty array', () => {
    const stats = computeExpenseStats([], 'RSD');
    expect(stats.count).toBe(0);
    expect(stats.total).toBe(0);
    expect(stats.avg).toBe(0);
    expect(stats.median).toBe(0);
    expect(stats.min).toBeNull();
    expect(stats.max).toBeNull();
  });

  test('computes correct stats for single expense', () => {
    const expenses = [
      {
        amount_cents: 100000,
        currency: 'RSD' as const,
        eur_amount_cents: 850,
        category: 'Еда',
        comment: 'Хлеб',
        date: '2026-01-15',
      },
    ];
    const stats = computeExpenseStats(expenses, 'RSD');
    expect(stats.count).toBe(1);
    // 850 EUR-cents * 100 = 85000 RSD-cents (via mock rate)
    expect(stats.total).toBeCloseTo(85000, 0);
    expect(stats.avg).toBeCloseTo(85000, 0);
    expect(stats.median).toBeCloseTo(85000, 0);
    expect(stats.min?.comment).toBe('Хлеб');
    expect(stats.max?.comment).toBe('Хлеб');
  });

  test('computes median for even number of items', () => {
    const expenses = [
      {
        amount_cents: 10000,
        currency: 'RSD' as const,
        eur_amount_cents: 100,
        category: 'A',
        comment: 'a',
        date: '2026-01-01',
      },
      {
        amount_cents: 20000,
        currency: 'RSD' as const,
        eur_amount_cents: 200,
        category: 'B',
        comment: 'b',
        date: '2026-01-02',
      },
      {
        amount_cents: 30000,
        currency: 'RSD' as const,
        eur_amount_cents: 300,
        category: 'C',
        comment: 'c',
        date: '2026-01-03',
      },
      {
        amount_cents: 40000,
        currency: 'RSD' as const,
        eur_amount_cents: 400,
        category: 'D',
        comment: 'd',
        date: '2026-01-04',
      },
    ];
    const stats = computeExpenseStats(expenses, 'RSD');
    expect(stats.count).toBe(4);
    // converted amounts: 10000, 20000, 30000, 40000 (EUR-cents * 100)
    // median of [10000, 20000, 30000, 40000] = (20000+30000)/2 = 25000
    expect(stats.median).toBeCloseTo(25000, 0);
    expect(stats.min?.amount).toBeCloseTo(10000, 0);
    expect(stats.max?.amount).toBeCloseTo(40000, 0);
  });

  test('computes median for odd number of items', () => {
    const expenses = [
      {
        amount_cents: 10000,
        currency: 'RSD' as const,
        eur_amount_cents: 100,
        category: 'A',
        comment: 'a',
        date: '2026-01-01',
      },
      {
        amount_cents: 30000,
        currency: 'RSD' as const,
        eur_amount_cents: 300,
        category: 'B',
        comment: 'b',
        date: '2026-01-02',
      },
      {
        amount_cents: 50000,
        currency: 'RSD' as const,
        eur_amount_cents: 500,
        category: 'C',
        comment: 'c',
        date: '2026-01-03',
      },
    ];
    const stats = computeExpenseStats(expenses, 'RSD');
    // converted: 10000, 30000, 50000 → median = 30000
    expect(stats.median).toBeCloseTo(30000, 0);
  });

  test('min/max reference correct expense', () => {
    const expenses = [
      {
        amount_cents: 500000,
        currency: 'RSD' as const,
        eur_amount_cents: 4250,
        category: 'Развлечения',
        comment: 'Кино',
        date: '2026-01-10',
      },
      {
        amount_cents: 12000,
        currency: 'RSD' as const,
        eur_amount_cents: 102,
        category: 'Еда',
        comment: 'Хлеб',
        date: '2026-01-05',
      },
      {
        amount_cents: 4500000,
        currency: 'RSD' as const,
        eur_amount_cents: 38250,
        category: 'Ресторан',
        comment: 'НГ ужин',
        date: '2025-12-31',
      },
    ];
    const stats = computeExpenseStats(expenses, 'RSD');
    expect(stats.min?.comment).toBe('Хлеб');
    expect(stats.min?.category).toBe('Еда');
    expect(stats.min?.date).toBe('2026-01-05');
    expect(stats.max?.comment).toBe('НГ ужин');
    expect(stats.max?.category).toBe('Ресторан');
  });

  test('handles multi-currency by converting via eur_amount_cents', () => {
    // Mock rate: 1 EUR = 100 RSD (in cents: 1 EUR-cent → 100 RSD-cents)
    // 100 EUR → eur_amount_cents=10000 → 10000*100 = 1000000 RSD-cents
    // 1000 RSD → eur_amount_cents=850 → 850*100 = 85000 RSD-cents
    const expenses = [
      {
        amount_cents: 10000,
        currency: 'EUR' as const,
        eur_amount_cents: 10000,
        category: 'A',
        comment: 'euros',
        date: '2026-01-01',
      },
      {
        amount_cents: 100000,
        currency: 'RSD' as const,
        eur_amount_cents: 850,
        category: 'B',
        comment: 'dinars',
        date: '2026-01-02',
      },
    ];
    const stats = computeExpenseStats(expenses, 'RSD');
    expect(stats.count).toBe(2);
    // max should be the EUR expense (1000000 RSD-cents via mock)
    expect(stats.max?.comment).toBe('euros');
    expect(stats.max?.amount).toBeCloseTo(1000000, 0);
    // min should be the RSD expense (85000 RSD-cents via mock)
    expect(stats.min?.comment).toBe('dinars');
    expect(stats.min?.amount).toBeCloseTo(85000, 0);
  });
});

describe('formatStats', () => {
  test('formats stats with all fields', () => {
    const stats: ExpenseStats = {
      count: 87,
      total: 275304,
      avg: 3164.41,
      median: 1850,
      min: { amount: 120, comment: 'Хлеб', category: 'Еда', date: '2026-01-15' },
      max: { amount: 45000, comment: 'Ресторан НГ', category: 'Развлечения', date: '2025-12-31' },
    };
    const result = formatStats(stats, 'RSD');
    expect(result).toContain('count: 87');
    expect(result).toContain('median:');
    expect(result).toContain('Хлеб');
    expect(result).toContain('Ресторан НГ');
    expect(result).toContain('Еда');
    expect(result).toContain('Развлечения');
  });

  test('returns "No expenses" for empty stats', () => {
    const stats = computeExpenseStats([], 'RSD');
    expect(formatStats(stats, 'RSD')).toBe('No expenses');
  });
});

describe('formatStatsDiff', () => {
  test('shows delta and percentage between two stats', () => {
    const a: ExpenseStats = {
      count: 50,
      total: 300000,
      avg: 6000,
      median: 4000,
      min: { amount: 100, comment: 'a', category: 'A', date: '2026-01-01' },
      max: { amount: 50000, comment: 'b', category: 'B', date: '2026-01-15' },
    };
    const b: ExpenseStats = {
      count: 62,
      total: 438000,
      avg: 7065,
      median: 4800,
      min: { amount: 80, comment: 'c', category: 'C', date: '2026-02-01' },
      max: { amount: 60000, comment: 'd', category: 'D', date: '2026-02-20' },
    };
    const expA = [
      {
        amount_cents: 20000000,
        currency: 'RSD' as const,
        eur_amount_cents: 200000,
        category: 'Еда',
        comment: '',
        date: '2026-01-01',
      },
      {
        amount_cents: 10000000,
        currency: 'RSD' as const,
        eur_amount_cents: 100000,
        category: 'Жилье',
        comment: '',
        date: '2026-01-01',
      },
    ];
    const expB = [
      {
        amount_cents: 24500000,
        currency: 'RSD' as const,
        eur_amount_cents: 245000,
        category: 'Еда',
        comment: '',
        date: '2026-02-01',
      },
      {
        amount_cents: 1800000,
        currency: 'RSD' as const,
        eur_amount_cents: 18000,
        category: 'Жилье',
        comment: '',
        date: '2026-02-01',
      },
    ];
    const result = formatStatsDiff(a, b, '2026-01', '2026-02', 'RSD', expA, expB);
    expect(result).toContain('+46.0%'); // (438000-300000)/300000 = 46%
    expect(result).toContain('2026-01');
    expect(result).toContain('2026-02');
    // Per-category biggest growth/drop (from spec)
    expect(result).toContain('Biggest growth');
    expect(result).toContain('Еда');
    expect(result).toContain('Biggest drop');
    expect(result).toContain('Жилье');
  });

  test('handles zero-base stats gracefully', () => {
    const a: ExpenseStats = {
      count: 0,
      total: 0,
      avg: 0,
      median: 0,
      min: null,
      max: null,
    };
    const b: ExpenseStats = {
      count: 5,
      total: 10000,
      avg: 2000,
      median: 1500,
      min: { amount: 500, comment: 'x', category: 'X', date: '2026-02-01' },
      max: { amount: 5000, comment: 'y', category: 'Y', date: '2026-02-15' },
    };
    const result = formatStatsDiff(a, b, '2026-01', '2026-02', 'RSD');
    // Should not crash or show NaN/Infinity
    expect(result).not.toContain('NaN');
    expect(result).not.toContain('Infinity');
  });

  test('omits per-category diff when no expenses provided', () => {
    const a: ExpenseStats = { count: 10, total: 5000, avg: 500, median: 400, min: null, max: null };
    const b: ExpenseStats = { count: 15, total: 8000, avg: 533, median: 450, min: null, max: null };
    const result = formatStatsDiff(a, b, '2026-01', '2026-02', 'RSD');
    expect(result).not.toContain('Biggest');
  });
});

describe('formatStatsTrend', () => {
  test('ranks periods by total descending', () => {
    const entries = [
      {
        label: '2025-11',
        stats: { count: 45, total: 698578, avg: 0, median: 0, min: null, max: null },
      },
      {
        label: '2025-12',
        stats: { count: 30, total: 317719, avg: 0, median: 0, min: null, max: null },
      },
      {
        label: '2026-01',
        stats: { count: 35, total: 331128, avg: 0, median: 0, min: null, max: null },
      },
    ];
    const result = formatStatsTrend(entries, 'RSD');
    expect(result).toContain('2025-11'); // highest total, should be first
    // Ranking should show max and min markers
    expect(result).toContain('max');
    expect(result).toContain('min');
  });

  test('handles single entry without max/min markers', () => {
    const entries = [
      {
        label: '2026-01',
        stats: { count: 10, total: 50000, avg: 5000, median: 4000, min: null, max: null },
      },
    ];
    const result = formatStatsTrend(entries, 'RSD');
    expect(result).toContain('2026-01');
    expect(result).not.toContain('max');
    expect(result).not.toContain('min');
  });

  test('handles entries with equal totals', () => {
    const entries = [
      {
        label: '2026-01',
        stats: { count: 10, total: 50000, avg: 5000, median: 4000, min: null, max: null },
      },
      {
        label: '2026-02',
        stats: { count: 12, total: 50000, avg: 4167, median: 3800, min: null, max: null },
      },
    ];
    const result = formatStatsTrend(entries, 'RSD');
    // Equal totals → no max/min distinction
    expect(result).not.toContain('max');
    expect(result).not.toContain('min');
  });

  test('handles entries with zero totals', () => {
    const entries = [
      { label: '2026-01', stats: { count: 0, total: 0, avg: 0, median: 0, min: null, max: null } },
      { label: '2026-02', stats: { count: 0, total: 0, avg: 0, median: 0, min: null, max: null } },
      { label: '2026-03', stats: { count: 0, total: 0, avg: 0, median: 0, min: null, max: null } },
    ];
    const result = formatStatsTrend(entries, 'RSD');
    expect(result).not.toContain('NaN');
    expect(result).not.toContain('Infinity');
  });
});
