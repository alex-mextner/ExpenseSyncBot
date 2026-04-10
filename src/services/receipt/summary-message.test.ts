// Tests for buildReceiptSummaryMessage — the shared summary builder used by
// both the bot photo handler flow and the Mini App confirm endpoint.
import { describe, expect, it, mock } from 'bun:test';
import { getCategoryEmoji } from '../../config/category-emojis';
import type { CurrencyCode } from '../../config/constants';

// Stub the async resolver so tests don't touch the DB cache or HF. The exact
// emoji-lookup behavior (exact match + default fallback) is preserved via
// the sync getCategoryEmoji helper.
mock.module('./category-emoji-resolver', () => ({
  resolveCategoryEmoji: async (category: string) => getCategoryEmoji(category),
  resolveCategoryEmojis: async (categories: readonly string[]) => {
    const map = new Map<string, string>();
    for (const c of categories) {
      map.set(c, getCategoryEmoji(c));
    }
    return map;
  },
  getCategoryEmoji,
}));

import { buildReceiptSummaryMessage, type ReceiptSummaryItem } from './summary-message';

function item(overrides: Partial<ReceiptSummaryItem> = {}): ReceiptSummaryItem {
  return {
    name: overrides.name ?? 'Товар',
    qty: overrides.qty ?? 1,
    price: overrides.price ?? 100,
    total: overrides.total ?? 100,
    category: overrides.category ?? 'Продукты',
    currency: overrides.currency ?? ('RSD' as CurrencyCode),
  };
}

describe('buildReceiptSummaryMessage', () => {
  it('returns empty string for no items', async () => {
    expect(await buildReceiptSummaryMessage([])).toBe('');
  });

  it('uses singular "позиция" for count=1', async () => {
    const msg = await buildReceiptSummaryMessage([item()]);
    expect(msg).toContain('1 позиция');
  });

  it('uses few form "позиции" for count=2-4', async () => {
    const msg = await buildReceiptSummaryMessage([item(), item(), item()]);
    expect(msg).toContain('3 позиции');
  });

  it('uses many form "позиций" for count=5+', async () => {
    const items = Array.from({ length: 7 }, () => item());
    const msg = await buildReceiptSummaryMessage(items);
    expect(msg).toContain('7 позиций');
  });

  it('uses many form "позиций" for count=11 (teen special case)', async () => {
    const items = Array.from({ length: 11 }, () => item());
    const msg = await buildReceiptSummaryMessage(items);
    expect(msg).toContain('11 позиций');
  });

  it('aggregates totals by category', async () => {
    const items = [
      item({ category: 'Продукты', total: 100 }),
      item({ category: 'Продукты', total: 250 }),
      item({ category: 'Здоровье', total: 400 }),
    ];
    const msg = await buildReceiptSummaryMessage(items);

    // Продукты: 100 + 250 = 350
    expect(msg).toMatch(/Продукты.*350/);
    // Здоровье: 400
    expect(msg).toMatch(/Здоровье.*400/);
  });

  it('shows grand total', async () => {
    const items = [item({ total: 100 }), item({ total: 200 }), item({ total: 300 })];
    const msg = await buildReceiptSummaryMessage(items);
    expect(msg).toMatch(/Итого.*600/);
  });

  it('wraps full item list in expandable blockquote', async () => {
    const msg = await buildReceiptSummaryMessage([
      item({ name: 'Молоко' }),
      item({ name: 'Хлеб' }),
    ]);
    expect(msg).toContain('<blockquote expandable>');
    expect(msg).toContain('</blockquote>');
    expect(msg).toContain('Молоко');
    expect(msg).toContain('Хлеб');
  });

  it('includes qty × price = total format for each item', async () => {
    const msg = await buildReceiptSummaryMessage([
      item({ name: 'Молоко', qty: 2, price: 150, total: 300 }),
    ]);
    // Should contain "2×150 RSD = 300 RSD" (approximately)
    expect(msg).toMatch(/Молоко.*2×.*150.*300/);
  });

  it('omits qty × price prefix when qty/price are missing (AI-correction flow)', async () => {
    // ReceiptSummary after AI correction loses qty/price — only name+total survive
    const msg = await buildReceiptSummaryMessage([
      {
        name: 'Молоко',
        total: 300,
        category: 'Продукты',
        currency: 'RSD' as CurrencyCode,
      },
    ]);
    // Line should be "• Молоко = 300..." — no "2×150 =" prefix
    expect(msg).toMatch(/• Молоко = .*300/);
    expect(msg).not.toMatch(/Молоко.*×/);
  });

  it('emits per-category emoji in the header', async () => {
    const msg = await buildReceiptSummaryMessage([item({ category: 'Продукты' })]);
    // Продукты → 🛒
    expect(msg).toContain('🛒');
  });

  it('falls back to default emoji for unknown category', async () => {
    const msg = await buildReceiptSummaryMessage([item({ category: 'ВымышленнаяКатегория' })]);
    // Default emoji for unknown category is 💰 (from getCategoryEmoji)
    expect(msg).toContain('💰');
  });

  it('escapes HTML in category and item names', async () => {
    const msg = await buildReceiptSummaryMessage([
      item({ name: '<script>alert(1)</script>', category: 'A & B' }),
    ]);
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('&lt;script&gt;');
    expect(msg).toContain('A &amp; B');
  });

  it('preserves the Telegram <blockquote expandable> tag during escaping', async () => {
    const msg = await buildReceiptSummaryMessage([item()]);
    // The blockquote tag itself must NOT be escaped
    expect(msg).toContain('<blockquote expandable>');
    expect(msg).not.toContain('&lt;blockquote');
  });

  it('truncates message that exceeds Telegram 4096 char limit', async () => {
    // 200 items × ~50 chars each ≈ 10 000 chars — definitely exceeds 4096
    const items = Array.from({ length: 200 }, (_, i) =>
      item({ name: `Товар с длинным именем номер ${i}`, total: 1000 + i }),
    );
    const msg = await buildReceiptSummaryMessage(items);

    // Must be under Telegram hard limit
    expect(msg.length).toBeLessThanOrEqual(4096);
    // Truncation keeps the blockquote tag closed
    expect(msg).toMatch(/<\/blockquote>$/);
    // Ellipsis marker indicates truncation occurred
    expect(msg).toContain('…');
  });

  it('uses the currency from the first item for aggregates', async () => {
    const msg = await buildReceiptSummaryMessage([
      item({ currency: 'EUR' as CurrencyCode, total: 10 }),
      item({ currency: 'EUR' as CurrencyCode, total: 20 }),
    ]);
    // formatAmount uses the € symbol for EUR
    expect(msg).toContain('€');
    expect(msg).not.toContain('RSD');
  });

  it('preserves category insertion order in the summary header', async () => {
    const items = [
      item({ category: 'Здоровье', total: 100 }),
      item({ category: 'Продукты', total: 200 }),
      item({ category: 'Транспорт', total: 50 }),
    ];
    const msg = await buildReceiptSummaryMessage(items);

    const healthIdx = msg.indexOf('Здоровье');
    const groceriesIdx = msg.indexOf('Продукты');
    const transportIdx = msg.indexOf('Транспорт');

    expect(healthIdx).toBeGreaterThan(-1);
    expect(groceriesIdx).toBeGreaterThan(healthIdx);
    expect(transportIdx).toBeGreaterThan(groceriesIdx);
  });
});
