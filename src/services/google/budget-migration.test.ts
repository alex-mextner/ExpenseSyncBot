// Tests for the pure inheritance-expansion logic used in Budget sheet migration

import { describe, expect, test } from 'bun:test';
import type { FlatBudgetRow } from './budget-migration';
import { applyInheritance } from './budget-migration';

describe('applyInheritance', () => {
  test('returns empty map for empty input', () => {
    expect(applyInheritance([])).toEqual(new Map());
  });

  test('keeps explicit entries unchanged', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Food', limit: 500, currency: 'EUR' },
      { month: '2026-02', category: 'Food', limit: 600, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    expect(result.get('2026-01')).toEqual([{ category: 'Food', limit: 500, currency: 'EUR' }]);
    expect(result.get('2026-02')).toEqual([{ category: 'Food', limit: 600, currency: 'EUR' }]);
  });

  test('inherits from latest prior month when no explicit entry', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Food', limit: 500, currency: 'EUR' },
      { month: '2026-03', category: 'Food', limit: 700, currency: 'EUR' },
      // March also has a new category
      { month: '2026-03', category: 'Rent', limit: 1000, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    // January: only Food (Rent has no prior entry, skip)
    const jan = result.get('2026-01');
    expect(jan).toHaveLength(1);
    expect(jan?.[0]).toEqual({ category: 'Food', limit: 500, currency: 'EUR' });
    // March: Food explicit + Rent explicit
    const march = result.get('2026-03');
    expect(march).toHaveLength(2);
    expect(march).toContainEqual({ category: 'Food', limit: 700, currency: 'EUR' });
    expect(march).toContainEqual({ category: 'Rent', limit: 1000, currency: 'EUR' });
  });

  test('inherits from the LATEST prior month, not earliest', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Food', limit: 100, currency: 'EUR' },
      { month: '2026-02', category: 'Food', limit: 200, currency: 'EUR' },
      // March: Food missing → should inherit from Feb (200), not Jan (100)
      { month: '2026-03', category: 'Transport', limit: 150, currency: 'USD' },
    ];
    const result = applyInheritance(rows);
    const march = result.get('2026-03');
    const food = march?.find((r) => r.category === 'Food');
    expect(food?.limit).toBe(200);
  });

  test('skips category in a month when no prior entry exists', () => {
    const rows: FlatBudgetRow[] = [
      // Rent only appears in Feb for the first time
      { month: '2026-01', category: 'Food', limit: 500, currency: 'EUR' },
      { month: '2026-02', category: 'Rent', limit: 1000, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    // Jan: Food only (Rent has no prior, skip)
    expect(result.get('2026-01')).toHaveLength(1);
    // Feb: both (Food inherited from Jan, Rent explicit)
    const feb = result.get('2026-02');
    expect(feb).toHaveLength(2);
    expect(feb).toContainEqual({ category: 'Food', limit: 500, currency: 'EUR' });
    expect(feb).toContainEqual({ category: 'Rent', limit: 1000, currency: 'EUR' });
  });
});
