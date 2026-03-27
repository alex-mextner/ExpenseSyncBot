// Tests for budget progress calculation in /sum command

import { describe, expect, it } from 'bun:test';
import { buildBudgetProgressEntry, buildBudgetTotals } from './sum';

describe('buildBudgetProgressEntry — budget currency conversion', () => {
  // RSD fallback rate: 1 RSD = 0.0086 EUR → 1 EUR ≈ 116 RSD

  it('converts EUR spending to budget currency for percentage', () => {
    // 50 EUR ≈ 5 800 RSD; limit 10 000 RSD → ~58%
    const entry = buildBudgetProgressEntry(50, {
      category: 'Еда',
      limit_amount: 10_000,
      currency: 'RSD',
    });
    expect(entry.percentage).toBeGreaterThan(40);
    expect(entry.percentage).toBeLessThan(80);
  });

  it('is_exceeded false when EUR spending converts below limit', () => {
    // 50 EUR ≈ 5 800 RSD < 10 000 RSD
    const entry = buildBudgetProgressEntry(50, {
      category: 'Еда',
      limit_amount: 10_000,
      currency: 'RSD',
    });
    expect(entry.is_exceeded).toBe(false);
  });

  it('is_exceeded true when EUR spending converts above limit', () => {
    // 150 EUR ≈ 17 400 RSD > 10 000 RSD
    const entry = buildBudgetProgressEntry(150, {
      category: 'Еда',
      limit_amount: 10_000,
      currency: 'RSD',
    });
    expect(entry.is_exceeded).toBe(true);
  });

  it('is_warning triggers at 90–99% of limit in budget currency', () => {
    // 85 EUR ≈ 9 860 RSD, limit 10 000 → ~99% → warning
    const entry = buildBudgetProgressEntry(85, {
      category: 'Еда',
      limit_amount: 10_000,
      currency: 'RSD',
    });
    expect(entry.is_warning).toBe(true);
    expect(entry.is_exceeded).toBe(false);
  });

  it('EUR budget: no conversion, direct comparison', () => {
    const entry = buildBudgetProgressEntry(75, {
      category: 'Transport',
      limit_amount: 100,
      currency: 'EUR',
    });
    expect(entry.percentage).toBe(75);
    expect(entry.is_exceeded).toBe(false);
    expect(entry.spentInCurrency).toBeCloseTo(75);
  });

  it('returns correct currency code', () => {
    const entry = buildBudgetProgressEntry(10, {
      category: 'Еда',
      limit_amount: 5_000,
      currency: 'RSD',
    });
    expect(entry.currency).toBe('RSD');
  });
});

describe('buildBudgetTotals — cross-currency totals in display currency', () => {
  it('converts all limits to EUR and then to display currency', () => {
    // Budget: 10 000 RSD ≈ 86 EUR; spent: 50 EUR → 50/86 ≈ 58%
    const totals = buildBudgetTotals(
      { Еда: 50 },
      [{ category: 'Еда', limit_amount: 10_000, currency: 'RSD' }],
      'EUR',
    );
    expect(totals.percentage).toBeGreaterThan(40);
    expect(totals.percentage).toBeLessThan(80);
  });

  it('mixed currencies sum correctly in display currency', () => {
    // Budget A: 100 EUR; Budget B: 10 000 RSD ≈ 86 EUR → total ≈ 186 EUR
    // Spent: 50 EUR (A) + 43 EUR (B) = 93 EUR → ~50%
    const totals = buildBudgetTotals(
      { A: 50, B: 43 },
      [
        { category: 'A', limit_amount: 100, currency: 'EUR' },
        { category: 'B', limit_amount: 10_000, currency: 'RSD' },
      ],
      'EUR',
    );
    expect(totals.percentage).toBeGreaterThan(35);
    expect(totals.percentage).toBeLessThan(65);
  });

  it('display currency affects output amounts but not percentage', () => {
    const eurTotals = buildBudgetTotals(
      { Еда: 50 },
      [{ category: 'Еда', limit_amount: 100, currency: 'EUR' }],
      'EUR',
    );
    const rsdTotals = buildBudgetTotals(
      { Еда: 50 },
      [{ category: 'Еда', limit_amount: 100, currency: 'EUR' }],
      'RSD',
    );
    expect(eurTotals.percentage).toBe(rsdTotals.percentage);
    // RSD amounts should be much larger than EUR amounts
    expect(rsdTotals.totalBudgetDisplay).toBeGreaterThan(eurTotals.totalBudgetDisplay * 50);
  });

  it('missing category spending treated as 0', () => {
    const totals = buildBudgetTotals(
      {},
      [{ category: 'Еда', limit_amount: 100, currency: 'EUR' }],
      'EUR',
    );
    expect(totals.totalSpentDisplay).toBe(0);
    expect(totals.percentage).toBe(0);
  });

  it('zero limit_amount returns 0% without division by zero', () => {
    const totals = buildBudgetTotals(
      { Еда: 50 },
      [{ category: 'Еда', limit_amount: 0, currency: 'EUR' }],
      'EUR',
    );
    expect(totals.percentage).toBe(0);
    expect(totals.totalBudgetDisplay).toBe(0);
  });
});
