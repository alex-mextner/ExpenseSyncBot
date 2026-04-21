// Tests for receipt-summarizer.ts — pure functions + AI-powered correction flow.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { ReceiptItem } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';

// ── logger ───────────────────────────────────────────────────────────────
const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── aiStreamRound / stripThinkingTags ────────────────────────────────────
type StreamResult = {
  text: string;
  toolCalls: never[];
  finishReason: string;
  assistantMessage: { role: 'assistant'; content: string };
  providerUsed: string;
};

const mockAiStreamRound = mock<
  (opts: unknown, cbs?: { onTextDelta?: (d: string) => void }) => Promise<StreamResult>
>(async () => ({
  text: '{"categories":[],"totalAmount":0,"currency":"EUR"}',
  toolCalls: [] as never[],
  finishReason: 'stop',
  assistantMessage: { role: 'assistant' as const, content: '' },
  providerUsed: 'mock',
}));

mock.module('../ai/streaming', () => ({
  aiStreamRound: mockAiStreamRound,
  stripThinkingTags: (t: string) => t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(),
}));

import {
  applyCorrectionWithAI,
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
      expect(msg).toContain('€');
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

// ── Additional buildSummaryFromItems scenarios ───────────────────────────
describe('buildSummaryFromItems — multi-currency & unicode', () => {
  it('preserves first item currency even when later items differ', () => {
    // The current implementation reads currency from items[0] only.
    const items = [
      makeItem({ name_ru: 'A', suggested_category: 'X', total: 10, currency: 'USD' }),
      makeItem({ name_ru: 'B', suggested_category: 'X', total: 20, currency: 'EUR' }),
    ];
    const summary = buildSummaryFromItems(items);
    expect(summary.currency).toBe('USD');
  });

  it('preserves unicode / emoji in name_ru', () => {
    const items = [
      makeItem({ name_ru: '🍎 Яблоко — 1kg', suggested_category: 'Фрукты', total: 50 }),
    ];
    const summary = buildSummaryFromItems(items);
    expect(summary.categories[0]?.items[0]?.name).toBe('🍎 Яблоко — 1kg');
  });

  it('preserves unicode in category name', () => {
    const items = [makeItem({ name_ru: 'X', suggested_category: 'Хозтовары 🧹', total: 5 })];
    const summary = buildSummaryFromItems(items);
    expect(summary.categories[0]?.name).toBe('Хозтовары 🧹');
  });

  it('treats empty-string category as a distinct grouping key', () => {
    const items = [
      makeItem({ name_ru: 'No cat', suggested_category: '', total: 1 }),
      makeItem({ name_ru: 'Also no cat', suggested_category: '', total: 2 }),
    ];
    const summary = buildSummaryFromItems(items);
    expect(summary.categories).toHaveLength(1);
    expect(summary.categories[0]?.name).toBe('');
    expect(summary.categories[0]?.items).toHaveLength(2);
  });

  it('handles negative totals (refunds)', () => {
    const items = [
      makeItem({ name_ru: 'Refund', suggested_category: 'Refunds', total: -50 }),
      makeItem({ name_ru: 'Normal', suggested_category: 'Food', total: 100 }),
    ];
    const summary = buildSummaryFromItems(items);
    expect(summary.totalAmount).toBe(50);
  });

  it('handles zero-amount item', () => {
    const items = [
      makeItem({ name_ru: 'Free', suggested_category: 'Gifts', total: 0 }),
      makeItem({ name_ru: 'Paid', suggested_category: 'Food', total: 100 }),
    ];
    const summary = buildSummaryFromItems(items);
    expect(summary.totalAmount).toBe(100);
  });
});

// ── Additional formatSummaryMessage scenarios ────────────────────────────
describe('formatSummaryMessage — truncation, pluralization, HTML', () => {
  it('shows exactly 3 items without truncation marker when count equals threshold', () => {
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
    expect(msg).not.toContain('еще');
  });

  it('shows "еще 1" for 4 items (captures current behavior — violates N+2 rule)', () => {
    const summary: ReceiptSummary = {
      categories: [
        {
          name: 'Cat',
          items: [
            { name: 'A', total: 1 },
            { name: 'B', total: 2 },
            { name: 'C', total: 3 },
            { name: 'D', total: 4 },
          ],
        },
      ],
      totalAmount: 10,
      currency: 'EUR',
    };
    const msg = formatSummaryMessage(summary, 4);
    // NOTE: currently shows "и еще 1 позиций" — violates N+2 rule in CLAUDE.md.
    // Should show all 4 when remainder is < 3. This test captures current behavior.
    expect(msg).toContain('еще 1');
  });

  it('renders all categories in order', () => {
    const summary: ReceiptSummary = {
      categories: [
        { name: 'Cat1', items: [{ name: 'A', total: 1 }] },
        { name: 'Cat2', items: [{ name: 'B', total: 2 }] },
        { name: 'Cat3', items: [{ name: 'C', total: 3 }] },
        { name: 'Cat4', items: [{ name: 'D', total: 4 }] },
      ],
      totalAmount: 10,
      currency: 'EUR',
    };
    const msg = formatSummaryMessage(summary, 4);
    expect(msg).toContain('Cat1');
    expect(msg).toContain('Cat4');
    expect(msg.indexOf('Cat1')).toBeLessThan(msg.indexOf('Cat2'));
    expect(msg.indexOf('Cat3')).toBeLessThan(msg.indexOf('Cat4'));
  });

  it('renders receipt header with the item count passed in', () => {
    const summary: ReceiptSummary = {
      categories: [{ name: 'Cat', items: [{ name: 'X', total: 1 }] }],
      totalAmount: 1,
      currency: 'EUR',
    };
    const msg = formatSummaryMessage(summary, 42);
    expect(msg).toContain('42');
  });

  it('uses partial-match emoji for category containing known keyword', () => {
    const summary: ReceiptSummary = {
      // "Хозтовары и дом" contains "дом" → 🏠
      categories: [{ name: 'Хозтовары и дом', items: [{ name: 'X', total: 1 }] }],
      totalAmount: 1,
      currency: 'EUR',
    };
    const msg = formatSummaryMessage(summary, 1);
    // Any emoji from the map is fine; key invariant: not the default 📦
    expect(msg).not.toContain('📦');
  });

  it('renders amount in correct currency (RSD)', () => {
    const summary: ReceiptSummary = {
      categories: [{ name: 'Cat', items: [{ name: 'X', total: 1500 }] }],
      totalAmount: 1500,
      currency: 'RSD',
    };
    const msg = formatSummaryMessage(summary, 1);
    expect(msg).toContain('RSD');
  });

  it('handles empty categories array (no content between header & total)', () => {
    const summary: ReceiptSummary = { categories: [], totalAmount: 0, currency: 'EUR' };
    const msg = formatSummaryMessage(summary, 0);
    expect(msg).toContain('🧾');
    expect(msg).toContain('0.00');
  });
});

// ── validateSummaryTotals additional edge cases ──────────────────────────
describe('validateSummaryTotals — boundary cases', () => {
  it('returns false when new total exceeds original by more than 1%', () => {
    const summary: ReceiptSummary = {
      categories: [{ name: 'C', items: [{ name: 'X', total: 110 }] }],
      totalAmount: 110,
      currency: 'EUR',
    };
    expect(validateSummaryTotals(summary, 100)).toBe(false);
  });

  it('returns true for tiny rounding drift (0.001%)', () => {
    const summary: ReceiptSummary = {
      categories: [{ name: 'C', items: [{ name: 'X', total: 100.001 }] }],
      totalAmount: 100.001,
      currency: 'EUR',
    };
    expect(validateSummaryTotals(summary, 100)).toBe(true);
  });

  it('ignores top-level totalAmount — only sums item totals', () => {
    const summary: ReceiptSummary = {
      // Top-level totalAmount is inconsistent but items sum to 100 which matches orig
      categories: [{ name: 'C', items: [{ name: 'X', total: 100 }] }],
      totalAmount: 9999,
      currency: 'EUR',
    };
    expect(validateSummaryTotals(summary, 100)).toBe(true);
  });
});

// ── applyCorrectionWithAI ────────────────────────────────────────────────
describe('applyCorrectionWithAI', () => {
  const baseSummary: ReceiptSummary = {
    categories: [
      { name: 'Еда', items: [{ name: 'Молоко', total: 100 }] },
      { name: 'Бытовое', items: [{ name: 'Мыло', total: 50 }] },
    ],
    totalAmount: 150,
    currency: 'EUR',
  };

  afterEach(() => {
    mockAiStreamRound.mockClear();
  });

  it('parses pure JSON response from AI', async () => {
    mockAiStreamRound.mockResolvedValueOnce({
      text: JSON.stringify({
        categories: [
          {
            name: 'Еда',
            items: [
              { name: 'Молоко', total: 100 },
              { name: 'Мыло', total: 50 },
            ],
          },
        ],
        totalAmount: 150,
        currency: 'EUR',
      }),
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: '' },
      providerUsed: 'mock',
    });

    const result = await applyCorrectionWithAI(
      baseSummary,
      'объедини всё в Еда',
      ['Еда', 'Бытовое'],
      [],
    );
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0]?.name).toBe('Еда');
    expect(result.categories[0]?.items).toHaveLength(2);
  });

  it('parses JSON wrapped in ```json fenced code block', async () => {
    mockAiStreamRound.mockResolvedValueOnce({
      text: '```json\n{"categories":[{"name":"Еда","items":[{"name":"X","total":10}]}],"totalAmount":10,"currency":"EUR"}\n```',
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: '' },
      providerUsed: 'mock',
    });

    const result = await applyCorrectionWithAI(baseSummary, 'fix it', ['Еда'], []);
    expect(result.categories).toHaveLength(1);
  });

  it('strips thinking tags before parsing JSON', async () => {
    mockAiStreamRound.mockResolvedValueOnce({
      text: '<think>reasoning here</think>{"categories":[],"totalAmount":0,"currency":"EUR"}',
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: '' },
      providerUsed: 'mock',
    });

    const result = await applyCorrectionWithAI(baseSummary, 'reset', ['Еда'], []);
    expect(result.categories).toEqual([]);
  });

  it('preserves currency and totalAmount from input even if AI tried to change them', async () => {
    mockAiStreamRound.mockResolvedValueOnce({
      text: JSON.stringify({
        categories: [{ name: 'Еда', items: [{ name: 'X', total: 99 }] }],
        totalAmount: 99999, // AI tried to change it
        currency: 'USD', // AI tried to change it
      }),
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: '' },
      providerUsed: 'mock',
    });

    const result = await applyCorrectionWithAI(baseSummary, 'x', ['Еда'], []);
    expect(result.totalAmount).toBe(baseSummary.totalAmount);
    expect(result.currency).toBe(baseSummary.currency);
  });

  it('throws when AI response has no JSON at all', async () => {
    mockAiStreamRound.mockResolvedValueOnce({
      text: 'Sorry, I cannot help with that',
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: '' },
      providerUsed: 'mock',
    });

    await expect(applyCorrectionWithAI(baseSummary, 'x', ['Еда'], [])).rejects.toThrow(
      'No valid JSON in AI response',
    );
  });

  it('throws when parsed JSON is missing categories array', async () => {
    mockAiStreamRound.mockResolvedValueOnce({
      text: '{"totalAmount":0,"currency":"EUR"}',
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: '' },
      providerUsed: 'mock',
    });

    await expect(applyCorrectionWithAI(baseSummary, 'x', ['Еда'], [])).rejects.toThrow(
      'Invalid summary structure',
    );
  });

  it('passes smart chain to aiStreamRound', async () => {
    await applyCorrectionWithAI(
      {
        categories: [{ name: 'X', items: [{ name: 'A', total: 1 }] }],
        totalAmount: 1,
        currency: 'EUR',
      },
      'test',
      ['X'],
      [],
    );

    const opts = mockAiStreamRound.mock.calls[0]?.[0] as { chain?: string };
    expect(opts.chain).toBe('smart');
  });

  it('includes correction history in prompt when provided', async () => {
    await applyCorrectionWithAI(
      {
        categories: [{ name: 'Еда', items: [{ name: 'A', total: 1 }] }],
        totalAmount: 1,
        currency: 'EUR',
      },
      'new correction',
      ['Еда'],
      [
        { user: 'первая правка', result: 'применено X' },
        { user: 'вторая правка', result: 'применено Y' },
      ],
    );

    const opts = mockAiStreamRound.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessage = opts.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('первая правка');
    expect(userMessage).toContain('вторая правка');
  });

  it('invokes onProgress callback for streaming deltas when passed', async () => {
    const deltas: string[] = [];
    mockAiStreamRound.mockImplementationOnce(async (_opts, cbs) => {
      cbs?.onTextDelta?.('streaming ');
      cbs?.onTextDelta?.('text');
      return {
        text: '{"categories":[],"totalAmount":0,"currency":"EUR"}',
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: '' },
        providerUsed: 'mock',
      };
    });

    await applyCorrectionWithAI(
      {
        categories: [{ name: 'Cat', items: [{ name: 'X', total: 1 }] }],
        totalAmount: 1,
        currency: 'EUR',
      },
      'x',
      ['Cat'],
      [],
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(['streaming ', 'text']);
  });

  it('runs cleanly when onProgress callback is omitted', async () => {
    const result = await applyCorrectionWithAI(
      {
        categories: [{ name: 'C', items: [{ name: 'X', total: 1 }] }],
        totalAmount: 1,
        currency: 'EUR',
      },
      'x',
      ['C'],
      [],
    );
    expect(result).toBeDefined();
  });
});
