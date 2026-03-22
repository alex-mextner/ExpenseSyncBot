// Tests for receipt-summarizer.ts — pure functions: buildSummaryFromItems,
// formatSummaryMessage, validateSummaryTotals, summaryToCategoryMap
// applyCorrectionWithAI requires HuggingFace; tested separately via fetch mock

import { describe, expect, it } from 'bun:test';
import type { ReceiptItem } from '../../database/types';
import {
  buildSummaryFromItems,
  formatSummaryMessage,
  type ReceiptSummary,
  summaryToCategoryMap,
  validateSummaryTotals,
} from './receipt-summarizer';

// Minimal ReceiptItem factory for tests
function makeItem(
  overrides: Partial<ReceiptItem> & { suggested_category: string; name_ru: string; total: number },
): ReceiptItem {
  return {
    id: 1,
    photo_queue_id: 1,
    name_ru: overrides.name_ru,
    name_original: overrides.name_original ?? null,
    quantity: overrides.quantity ?? 1,
    price: overrides.price ?? overrides.total,
    total: overrides.total,
    suggested_category: overrides.suggested_category,
    possible_categories: overrides.possible_categories ?? [],
    confirmed_category: overrides.confirmed_category ?? null,
    waiting_for_category_input: overrides.waiting_for_category_input ?? 0,
    currency: overrides.currency ?? 'EUR',
    status: overrides.status ?? 'pending',
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('buildSummaryFromItems', () => {
  describe('basic grouping', () => {
    it('groups items by suggested_category', () => {
      const items = [
        makeItem({ name_ru: 'Молоко', suggested_category: 'Еда', total: 100 }),
        makeItem({ name_ru: 'Хлеб', suggested_category: 'Еда', total: 50 }),
        makeItem({ name_ru: 'Шампунь', suggested_category: 'Гигиена', total: 200 }),
      ];
      const summary = buildSummaryFromItems(items);
      expect(summary.categories).toHaveLength(2);
    });

    it('calculates total amount as sum of all item totals', () => {
      const items = [
        makeItem({ name_ru: 'Item 1', suggested_category: 'Food', total: 100 }),
        makeItem({ name_ru: 'Item 2', suggested_category: 'Food', total: 200 }),
        makeItem({ name_ru: 'Item 3', suggested_category: 'Home', total: 300 }),
      ];
      const summary = buildSummaryFromItems(items);
      expect(summary.totalAmount).toBe(600);
    });

    it('preserves item names (name_ru) in summary items', () => {
      const items = [makeItem({ name_ru: 'Яблоко Гала', suggested_category: 'Еда', total: 45 })];
      const summary = buildSummaryFromItems(items);
      expect(summary.categories[0]?.items[0]?.name).toBe('Яблоко Гала');
    });

    it('uses currency from first item', () => {
      const items = [
        makeItem({ name_ru: 'Item 1', suggested_category: 'Food', total: 100, currency: 'RSD' }),
      ];
      const summary = buildSummaryFromItems(items);
      expect(summary.currency).toBe('RSD');
    });

    it('defaults currency to EUR when items array is empty', () => {
      const summary = buildSummaryFromItems([]);
      expect(summary.currency).toBe('EUR');
    });

    it('handles single item', () => {
      const items = [
        makeItem({ name_ru: 'Одна позиция', suggested_category: 'Разное', total: 99 }),
      ];
      const summary = buildSummaryFromItems(items);
      expect(summary.categories).toHaveLength(1);
      expect(summary.totalAmount).toBe(99);
    });

    it('handles many items in same category', () => {
      const items = Array.from({ length: 10 }, (_, i) =>
        makeItem({ name_ru: `Item ${i}`, suggested_category: 'Food', total: 10 }),
      );
      const summary = buildSummaryFromItems(items);
      expect(summary.categories).toHaveLength(1);
      expect(summary.categories[0]?.items).toHaveLength(10);
      expect(summary.totalAmount).toBe(100);
    });

    it('handles multiple categories without mixing items', () => {
      const items = [
        makeItem({ name_ru: 'Apple', suggested_category: 'Fruits', total: 10 }),
        makeItem({ name_ru: 'Bread', suggested_category: 'Bakery', total: 20 }),
        makeItem({ name_ru: 'Milk', suggested_category: 'Dairy', total: 30 }),
      ];
      const summary = buildSummaryFromItems(items);
      expect(summary.categories).toHaveLength(3);
      const categoryNames = summary.categories.map((c) => c.name);
      expect(categoryNames).toContain('Fruits');
      expect(categoryNames).toContain('Bakery');
      expect(categoryNames).toContain('Dairy');
    });

    it('returns zero totalAmount for empty items', () => {
      const summary = buildSummaryFromItems([]);
      expect(summary.totalAmount).toBe(0);
    });

    it('returns empty categories for empty items', () => {
      const summary = buildSummaryFromItems([]);
      expect(summary.categories).toHaveLength(0);
    });
  });

  describe('item totals in summary', () => {
    it('preserves item totals exactly', () => {
      const items = [
        makeItem({ name_ru: 'Expensive item', suggested_category: 'Tech', total: 999.99 }),
      ];
      const summary = buildSummaryFromItems(items);
      expect(summary.categories[0]?.items[0]?.total).toBe(999.99);
    });

    it('sums multiple items in same category correctly', () => {
      const items = [
        makeItem({ name_ru: 'A', suggested_category: 'Cat', total: 33.33 }),
        makeItem({ name_ru: 'B', suggested_category: 'Cat', total: 66.67 }),
      ];
      const summary = buildSummaryFromItems(items);
      expect(summary.totalAmount).toBeCloseTo(100, 2);
    });
  });
});

describe('formatSummaryMessage', () => {
  const simpleSummary: ReceiptSummary = {
    categories: [
      {
        name: 'Еда',
        items: [
          { name: 'Молоко', total: 100 },
          { name: 'Хлеб', total: 50 },
        ],
      },
    ],
    totalAmount: 150,
    currency: 'EUR',
  };

  describe('structure', () => {
    it('starts with receipt header with item count', () => {
      const msg = formatSummaryMessage(simpleSummary, 2);
      expect(msg).toContain('2');
      expect(msg).toContain('🧾');
    });

    it('includes total amount at end', () => {
      const msg = formatSummaryMessage(simpleSummary, 2);
      expect(msg).toContain('150.00');
      expect(msg).toContain('EUR');
    });

    it('includes category names', () => {
      const msg = formatSummaryMessage(simpleSummary, 2);
      expect(msg).toContain('Еда');
    });

    it('uses HTML bold tags for categories', () => {
      const msg = formatSummaryMessage(simpleSummary, 2);
      expect(msg).toContain('<b>');
      expect(msg).toContain('</b>');
    });

    it('includes item names', () => {
      const msg = formatSummaryMessage(simpleSummary, 2);
      expect(msg).toContain('Молоко');
      expect(msg).toContain('Хлеб');
    });

    it('returns a string', () => {
      const msg = formatSummaryMessage(simpleSummary, 0);
      expect(typeof msg).toBe('string');
    });
  });

  describe('item display limits', () => {
    it('shows all items when 3 or fewer', () => {
      const summary: ReceiptSummary = {
        categories: [
          {
            name: 'Cat',
            items: [
              { name: 'A', total: 1 },
              { name: 'B', total: 2 },
              { name: 'C', total: 3 },
            ],
          },
        ],
        totalAmount: 6,
        currency: 'EUR',
      };
      const msg = formatSummaryMessage(summary, 3);
      expect(msg).toContain('A');
      expect(msg).toContain('B');
      expect(msg).toContain('C');
      expect(msg).not.toContain('еще');
    });

    it('truncates to 3 items and shows "и еще N позиций" for more than 3', () => {
      const summary: ReceiptSummary = {
        categories: [
          {
            name: 'Cat',
            items: [
              { name: 'Item1', total: 1 },
              { name: 'Item2', total: 2 },
              { name: 'Item3', total: 3 },
              { name: 'Item4', total: 4 },
              { name: 'Item5', total: 5 },
            ],
          },
        ],
        totalAmount: 15,
        currency: 'EUR',
      };
      const msg = formatSummaryMessage(summary, 5);
      expect(msg).toContain('еще 2');
    });
  });

  describe('HTML escaping', () => {
    it('escapes < and > in category names', () => {
      const summary: ReceiptSummary = {
        categories: [{ name: '<script>', items: [{ name: 'Item', total: 10 }] }],
        totalAmount: 10,
        currency: 'EUR',
      };
      const msg = formatSummaryMessage(summary, 1);
      expect(msg).toContain('&lt;script&gt;');
      expect(msg).not.toContain('<script>');
    });

    it('escapes & in item names', () => {
      const summary: ReceiptSummary = {
        categories: [{ name: 'Cat', items: [{ name: 'Fish & Chips', total: 10 }] }],
        totalAmount: 10,
        currency: 'EUR',
      };
      const msg = formatSummaryMessage(summary, 1);
      expect(msg).toContain('Fish &amp; Chips');
    });
  });

  describe('category emoji', () => {
    it('uses food emoji for Еда category', () => {
      const summary: ReceiptSummary = {
        categories: [{ name: 'Еда', items: [{ name: 'Item', total: 10 }] }],
        totalAmount: 10,
        currency: 'RSD',
      };
      const msg = formatSummaryMessage(summary, 1);
      expect(msg).toContain('🍔');
    });

    it('uses default emoji for unknown category', () => {
      const summary: ReceiptSummary = {
        categories: [{ name: 'Прочее', items: [{ name: 'Item', total: 10 }] }],
        totalAmount: 10,
        currency: 'EUR',
      };
      const msg = formatSummaryMessage(summary, 1);
      expect(msg).toContain('📦');
    });
  });
});

describe('validateSummaryTotals', () => {
  it('returns true when totals match within 1%', () => {
    const summary: ReceiptSummary = {
      categories: [{ name: 'Cat', items: [{ name: 'Item', total: 100 }] }],
      totalAmount: 100,
      currency: 'EUR',
    };
    expect(validateSummaryTotals(summary, 100)).toBe(true);
  });

  it('returns true when difference is exactly 1%', () => {
    const summary: ReceiptSummary = {
      categories: [{ name: 'Cat', items: [{ name: 'Item', total: 99 }] }],
      totalAmount: 99,
      currency: 'EUR',
    };
    // original=100, new=99, diff=0.01 (1%) - should pass
    expect(validateSummaryTotals(summary, 100)).toBe(true);
  });

  it('returns false when difference exceeds 1%', () => {
    const summary: ReceiptSummary = {
      categories: [{ name: 'Cat', items: [{ name: 'Item', total: 90 }] }],
      totalAmount: 90,
      currency: 'EUR',
    };
    // original=100, new=90, diff=0.10 (10%) - should fail
    expect(validateSummaryTotals(summary, 100)).toBe(false);
  });

  it('returns true when both totals are zero', () => {
    const summary: ReceiptSummary = {
      categories: [],
      totalAmount: 0,
      currency: 'EUR',
    };
    expect(validateSummaryTotals(summary, 0)).toBe(true);
  });

  it('returns false when new total is zero but original is non-zero', () => {
    const summary: ReceiptSummary = {
      categories: [],
      totalAmount: 0,
      currency: 'EUR',
    };
    expect(validateSummaryTotals(summary, 100)).toBe(false);
  });

  it('sums nested items in categories for validation', () => {
    const summary: ReceiptSummary = {
      categories: [
        {
          name: 'Cat1',
          items: [
            { name: 'A', total: 50 },
            { name: 'B', total: 50 },
          ],
        },
        { name: 'Cat2', items: [{ name: 'C', total: 100 }] },
      ],
      totalAmount: 200,
      currency: 'EUR',
    };
    // items sum to 200, original is 200 → match
    expect(validateSummaryTotals(summary, 200)).toBe(true);
  });
});

describe('summaryToCategoryMap', () => {
  it('maps item names to their category', () => {
    const summary: ReceiptSummary = {
      categories: [
        { name: 'Еда', items: [{ name: 'Молоко', total: 100 }] },
        { name: 'Гигиена', items: [{ name: 'Шампунь', total: 200 }] },
      ],
      totalAmount: 300,
      currency: 'EUR',
    };
    const map = summaryToCategoryMap(summary);
    expect(map.get('Молоко')).toBe('Еда');
    expect(map.get('Шампунь')).toBe('Гигиена');
  });

  it('returns empty map for empty summary', () => {
    const summary: ReceiptSummary = { categories: [], totalAmount: 0, currency: 'EUR' };
    const map = summaryToCategoryMap(summary);
    expect(map.size).toBe(0);
  });

  it('handles multiple items per category', () => {
    const summary: ReceiptSummary = {
      categories: [
        {
          name: 'Food',
          items: [
            { name: 'Apple', total: 5 },
            { name: 'Banana', total: 3 },
            { name: 'Cherry', total: 8 },
          ],
        },
      ],
      totalAmount: 16,
      currency: 'EUR',
    };
    const map = summaryToCategoryMap(summary);
    expect(map.size).toBe(3);
    expect(map.get('Apple')).toBe('Food');
    expect(map.get('Banana')).toBe('Food');
    expect(map.get('Cherry')).toBe('Food');
  });

  it('last category wins for duplicate item names', () => {
    const summary: ReceiptSummary = {
      categories: [
        { name: 'Cat1', items: [{ name: 'Item', total: 10 }] },
        { name: 'Cat2', items: [{ name: 'Item', total: 20 }] },
      ],
      totalAmount: 30,
      currency: 'EUR',
    };
    const map = summaryToCategoryMap(summary);
    // Map.set overwrites — last write wins
    expect(map.get('Item')).toBe('Cat2');
  });

  it('returns a Map instance', () => {
    const summary: ReceiptSummary = { categories: [], totalAmount: 0, currency: 'EUR' };
    const map = summaryToCategoryMap(summary);
    expect(map instanceof Map).toBe(true);
  });
});
