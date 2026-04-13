// Tests for budget progress calculation in /sum command

import { describe, expect, it } from 'bun:test';
import { buildBudgetProgressEntry, buildBudgetTotals } from './sum';

describe('buildBudgetProgressEntry — budget currency conversion', () => {
  // RSD fallback rate: 1 RSD = 0.0086 EUR → 1 EUR ≈ 116 RSD

  it('converts EUR spending to budget currency for percentage', () => {
    // 50 EUR (5000c) ≈ 580 000c RSD; limit 1 000 000c RSD → ~58%
    const entry = buildBudgetProgressEntry(5000, {
      category: 'Еда',
      limit_amount_cents: 1_000_000,
      currency: 'RSD',
    });
    expect(entry.percentage).toBeGreaterThan(40);
    expect(entry.percentage).toBeLessThan(80);
  });

  it('is_exceeded false when EUR spending converts below limit', () => {
    // 50 EUR (5000c) ≈ 580 000c RSD < 1 000 000c RSD
    const entry = buildBudgetProgressEntry(5000, {
      category: 'Еда',
      limit_amount_cents: 1_000_000,
      currency: 'RSD',
    });
    expect(entry.is_exceeded).toBe(false);
  });

  it('is_exceeded true when EUR spending converts above limit', () => {
    // 150 EUR (15000c) ≈ 1 740 000c RSD > 1 000 000c RSD
    const entry = buildBudgetProgressEntry(15000, {
      category: 'Еда',
      limit_amount_cents: 1_000_000,
      currency: 'RSD',
    });
    expect(entry.is_exceeded).toBe(true);
  });

  it('is_warning triggers at 90–99% of limit in budget currency', () => {
    // 85 EUR (8500c) ≈ 986 000c RSD, limit 1 000 000c → ~99% → warning
    const entry = buildBudgetProgressEntry(8500, {
      category: 'Еда',
      limit_amount_cents: 1_000_000,
      currency: 'RSD',
    });
    expect(entry.is_warning).toBe(true);
    expect(entry.is_exceeded).toBe(false);
  });

  it('EUR budget: no conversion, direct comparison', () => {
    const entry = buildBudgetProgressEntry(7500, {
      category: 'Transport',
      limit_amount_cents: 10000,
      currency: 'EUR',
    });
    expect(entry.percentage).toBe(75);
    expect(entry.is_exceeded).toBe(false);
    expect(entry.spentInCurrency).toBeCloseTo(7500);
  });

  it('returns correct currency code', () => {
    const entry = buildBudgetProgressEntry(1000, {
      category: 'Еда',
      limit_amount_cents: 500_000,
      currency: 'RSD',
    });
    expect(entry.currency).toBe('RSD');
  });
});

describe('buildBudgetTotals — cross-currency totals in display currency', () => {
  it('converts all limits to EUR and then to display currency', () => {
    // Budget: 1 000 000c RSD ≈ 8600c EUR; spent: 5000c EUR → 5000/8600 ≈ 58%
    const totals = buildBudgetTotals(
      { Еда: 5000 },
      [{ category: 'Еда', limit_amount_cents: 1_000_000, currency: 'RSD' }],
      'EUR',
    );
    expect(totals.percentage).toBeGreaterThan(40);
    expect(totals.percentage).toBeLessThan(80);
  });

  it('mixed currencies sum correctly in display currency', () => {
    // Budget A: 10000c EUR; Budget B: 1 000 000c RSD ≈ 8600c EUR → total ≈ 18600c EUR
    // Spent: 5000c EUR (A) + 4300c EUR (B) = 9300c EUR → ~50%
    const totals = buildBudgetTotals(
      { A: 5000, B: 4300 },
      [
        { category: 'A', limit_amount_cents: 10000, currency: 'EUR' },
        { category: 'B', limit_amount_cents: 1_000_000, currency: 'RSD' },
      ],
      'EUR',
    );
    expect(totals.percentage).toBeGreaterThan(35);
    expect(totals.percentage).toBeLessThan(65);
  });

  it('display currency affects output amounts but not percentage', () => {
    const eurTotals = buildBudgetTotals(
      { Еда: 5000 },
      [{ category: 'Еда', limit_amount_cents: 10000, currency: 'EUR' }],
      'EUR',
    );
    const rsdTotals = buildBudgetTotals(
      { Еда: 5000 },
      [{ category: 'Еда', limit_amount_cents: 10000, currency: 'EUR' }],
      'RSD',
    );
    expect(eurTotals.percentage).toBe(rsdTotals.percentage);
    // RSD amounts should be much larger than EUR amounts
    expect(rsdTotals.totalBudgetDisplay).toBeGreaterThan(eurTotals.totalBudgetDisplay * 50);
  });

  it('missing category spending treated as 0', () => {
    const totals = buildBudgetTotals(
      {},
      [{ category: 'Еда', limit_amount_cents: 10000, currency: 'EUR' }],
      'EUR',
    );
    expect(totals.totalSpentDisplay).toBe(0);
    expect(totals.percentage).toBe(0);
  });

  it('zero limit_amount_cents returns 0% without division by zero', () => {
    const totals = buildBudgetTotals(
      { Еда: 5000 },
      [{ category: 'Еда', limit_amount_cents: 0, currency: 'EUR' }],
      'EUR',
    );
    expect(totals.percentage).toBe(0);
    expect(totals.totalBudgetDisplay).toBe(0);
  });
});
