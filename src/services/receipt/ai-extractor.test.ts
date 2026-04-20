// Tests for ai-extractor.ts — receipt item types and repairTruncatedJson salvage helper.
//
// Note: the two-step text→JSON extractor was removed; only types + the legacy
// `repairTruncatedJson` helper remain. That helper is still used as a fallback
// when a model ignores tool-calling and dumps raw JSON, so we cover it thoroughly.

import { describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

import { repairTruncatedJson } from './ai-extractor';

describe('repairTruncatedJson — happy path', () => {
  it('salvages complete items from JSON truncated mid-item', () => {
    const truncated = `{
      "items": [
        {"name_ru": "Молоко", "quantity": 1, "price": 150, "total": 150, "category": "Еда"},
        {"name_ru": "Хлеб", "quantity": 2, "price": 60, "total": 120, "category": "Еда"},
        {"name_ru": "Обрезанный", "quantity": 1, "price": 200, "tot`;

    const result = repairTruncatedJson(truncated, 'length');

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.name_ru).toBe('Молоко');
    expect(result.items[0]?.total).toBe(150);
    expect(result.items[1]?.name_ru).toBe('Хлеб');
    expect(result.items[1]?.total).toBe(120);
  });

  it('salvages items wrapped in a markdown code fence', () => {
    const truncated = `\`\`\`json
{
  "items": [
    {"name_ru": "Сок", "quantity": 1, "price": 100, "total": 100, "category": "Еда"}
  ]
}
\`\`\``;

    const result = repairTruncatedJson(truncated, 'stop');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name_ru).toBe('Сок');
  });

  it('extracts currency when present in the response', () => {
    const truncated = `{"items": [{"name_ru": "Сок", "quantity": 1, "price": 100, "total": 100, "category": "Еда"}], "currency": "RSD", "extra": "trun`;

    const result = repairTruncatedJson(truncated, 'length');

    expect(result.items).toHaveLength(1);
    expect(result.currency).toBe('RSD');
  });

  it('supports USD and EUR currency codes', () => {
    const usd = repairTruncatedJson(
      `{"items": [{"name_ru": "x", "quantity": 1, "price": 1, "total": 1, "category": "c"}], "currency": "USD"`,
      'length',
    );
    expect(usd.currency).toBe('USD');

    const eur = repairTruncatedJson(
      `{"items": [{"name_ru": "x", "quantity": 1, "price": 1, "total": 1, "category": "c"}], "currency": "EUR"`,
      'length',
    );
    expect(eur.currency).toBe('EUR');
  });

  it('omits currency when not present in response', () => {
    const truncated = `{"items": [{"name_ru": "Сок", "quantity": 1, "price": 100, "total": 100, "category": "Еда"}]}`;

    const result = repairTruncatedJson(truncated, 'stop');

    expect(result.items).toHaveLength(1);
    expect(result.currency).toBeUndefined();
  });

  it('ignores lowercase currency match (requires 3 uppercase letters)', () => {
    const truncated = `{"items": [{"name_ru": "x", "quantity": 1, "price": 1, "total": 1, "category": "c"}], "currency": "rsd"`;

    const result = repairTruncatedJson(truncated, 'length');
    expect(result.currency).toBeUndefined();
  });

  it('fixes European decimal separator (comma → dot) before parsing items', () => {
    const truncated = `{"items": [
      {"name_ru": "Товар", "quantity": 1, "price": 12,50, "total": 12,50, "category": "Еда"}
    ]`;

    const result = repairTruncatedJson(truncated, 'length');

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.total).toBe(12.5);
    expect(result.items[0]?.price).toBe(12.5);
  });
});

describe('repairTruncatedJson — handles malformed content', () => {
  it('skips objects with invalid JSON but salvages the rest', () => {
    const truncated = `{"items": [
      {"name_ru": "Молоко", "quantity": 1, "price": 150, "total": 150, "category": "Еда"},
      {"name_ru": "Bad", quantity: this is not valid json at all, "total": 999},
      {"name_ru": "Хлеб", "quantity": 1, "price": 60, "total": 60, "category": "Еда"}
    ]}`;

    const result = repairTruncatedJson(truncated, 'stop');

    // Good items salvaged, malformed one skipped.
    const names = result.items.map((i) => i.name_ru);
    expect(names).toContain('Молоко');
    expect(names).toContain('Хлеб');
    expect(names).not.toContain('Bad');
  });

  it('skips items missing required name_ru or total', () => {
    const truncated = `{"items": [
      {"name_ru": "Good", "quantity": 1, "price": 50, "total": 50, "category": "Еда"},
      {"quantity": 1, "price": 999, "total": 999, "category": "Еда"},
      {"name_ru": "NoTotal", "quantity": 1, "price": 10, "category": "Еда"}
    ]}`;

    const result = repairTruncatedJson(truncated, 'stop');

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name_ru).toBe('Good');
  });

  it('handles nested objects inside items via brace depth counting', () => {
    const truncated = `{"items": [
      {"name_ru": "Compound", "quantity": 1, "price": 50, "total": 50, "category": "Еда", "meta": {"nested": {"deep": true}}},
      {"name_ru": "Plain", "quantity": 1, "price": 10, "total": 10, "category": "Еда"}
    ]}`;

    const result = repairTruncatedJson(truncated, 'stop');

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.name_ru).toBe('Compound');
    expect(result.items[1]?.name_ru).toBe('Plain');
  });
});

describe('repairTruncatedJson — error cases', () => {
  it('throws when no "items" key is present', () => {
    expect(() => repairTruncatedJson('Sorry, I cannot parse this receipt.', 'stop')).toThrow(
      'No valid JSON found',
    );
  });

  it('throws when "items" key has no array bracket after it', () => {
    const bad = '"items" was never opened';
    expect(() => repairTruncatedJson(bad, 'length')).toThrow('No valid JSON found');
  });

  it('throws when items array is empty and nothing salvageable', () => {
    const empty = '{"items": []}';
    expect(() => repairTruncatedJson(empty, 'stop')).toThrow('No valid JSON found');
  });

  it('throws when every item in the array is malformed/incomplete', () => {
    const allBroken = `{"items": [
      {"name_ru": "Truncated here but no close`;

    expect(() => repairTruncatedJson(allBroken, 'length')).toThrow('No valid JSON found');
  });

  it('throws when every item is missing name_ru', () => {
    const allAnonymous = `{"items": [
      {"quantity": 1, "total": 10},
      {"quantity": 2, "total": 20}
    ]}`;

    expect(() => repairTruncatedJson(allAnonymous, 'stop')).toThrow('No valid JSON found');
  });

  it('throws when every item has non-numeric total', () => {
    const allStringTotals = `{"items": [
      {"name_ru": "A", "quantity": 1, "price": 10, "total": "ten", "category": "Еда"}
    ]}`;

    expect(() => repairTruncatedJson(allStringTotals, 'stop')).toThrow('No valid JSON found');
  });

  it('accepts null finishReason', () => {
    const truncated = `{"items": [{"name_ru": "X", "quantity": 1, "price": 1, "total": 1, "category": "c"}]}`;

    const result = repairTruncatedJson(truncated, null);
    expect(result.items).toHaveLength(1);
  });

  it('accepts undefined finishReason', () => {
    const truncated = `{"items": [{"name_ru": "X", "quantity": 1, "price": 1, "total": 1, "category": "c"}]}`;

    const result = repairTruncatedJson(truncated);
    expect(result.items).toHaveLength(1);
  });
});

describe('repairTruncatedJson — preserves item shape', () => {
  it('preserves full AIReceiptItem fields (name_original, possible_categories)', () => {
    const truncated = `{"items": [
      {"name_ru": "Молоко", "name_original": "Milk 1L", "quantity": 2, "price": 150, "total": 300, "category": "Еда", "possible_categories": ["Продукты", "Разное"]}
    ]}`;

    const result = repairTruncatedJson(truncated, 'stop');

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.name_ru).toBe('Молоко');
    expect(item?.name_original).toBe('Milk 1L');
    expect(item?.quantity).toBe(2);
    expect(item?.price).toBe(150);
    expect(item?.total).toBe(300);
    expect(item?.category).toBe('Еда');
    expect(item?.possible_categories).toEqual(['Продукты', 'Разное']);
  });

  it('keeps partial items as long as name_ru + numeric total are present', () => {
    // Minimum viable item — only name_ru + total required.
    const truncated = `{"items": [
      {"name_ru": "Minimal", "total": 42}
    ]}`;

    const result = repairTruncatedJson(truncated, 'stop');

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name_ru).toBe('Minimal');
    expect(result.items[0]?.total).toBe(42);
  });
});
