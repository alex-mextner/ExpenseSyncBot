/** Tests for StreamJsonParser — incremental JSON item extraction from AI streaming responses */
import { describe, expect, it } from 'bun:test';
import { StreamJsonParser } from './stream-json-parser';

describe('StreamJsonParser', () => {
  it('extracts complete items from a full JSON response', () => {
    const parser = new StreamJsonParser();
    const items = parser.push(`{"items": [
      {"name_ru": "Молоко", "quantity": 1, "price": 89.99, "total": 89.99, "category": "Еда"},
      {"name_ru": "Хлеб", "quantity": 2, "price": 45, "total": 90, "category": "Еда"}
    ], "currency": "RSD"}`);
    expect(items).toHaveLength(2);
    expect(items[0]?.name_ru).toBe('Молоко');
    expect(items[1]?.name_ru).toBe('Хлеб');
  });

  it('emits items incrementally as they complete', () => {
    const parser = new StreamJsonParser();
    const batch1 = parser.push(
      '{"items": [{"name_ru": "Молоко", "quantity": 1, "price": 89.99, "total": 89.99, "category": "Еда"}',
    );
    expect(batch1).toHaveLength(1);
    expect(batch1[0]?.name_ru).toBe('Молоко');

    const batch2 = parser.push(
      ', {"name_ru": "Хлеб", "quantity": 2, "price": 45, "total": 90, "category": "Еда"}',
    );
    expect(batch2).toHaveLength(1);
    expect(batch2[0]?.name_ru).toBe('Хлеб');

    expect(parser.getAllItems()).toHaveLength(2);
  });

  it('handles <think> blocks by stripping them', () => {
    const parser = new StreamJsonParser();
    const items = parser.push(
      '<think>Let me analyze this receipt...</think>{"items": [{"name_ru": "Сок", "quantity": 1, "price": 150, "total": 150, "category": "Еда"}]}',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.name_ru).toBe('Сок');
  });

  it('handles partial <think> block across chunks', () => {
    const parser = new StreamJsonParser();
    const batch1 = parser.push('<think>Analyzing the receipt');
    expect(batch1).toHaveLength(0);

    const batch2 = parser.push(
      '</think>{"items": [{"name_ru": "Вода", "quantity": 1, "price": 50, "total": 50, "category": "Еда"}]}',
    );
    expect(batch2).toHaveLength(1);
    expect(batch2[0]?.name_ru).toBe('Вода');
  });

  it('strips markdown code fences', () => {
    const parser = new StreamJsonParser();
    const items = parser.push(
      '```json\n{"items": [{"name_ru": "Масло", "quantity": 1, "price": 200, "total": 200, "category": "Еда"}]}\n```',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.name_ru).toBe('Масло');
  });

  it('fixes decimal comma separators (399,99 → 399.99)', () => {
    const parser = new StreamJsonParser();
    const items = parser.push(
      '{"items": [{"name_ru": "Сыр", "quantity": 1, "price": 399,99, "total": 399,99, "category": "Еда"}]}',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.price).toBe(399.99);
    expect(items[0]?.total).toBe(399.99);
  });

  it('handles escaped quotes inside strings', () => {
    const parser = new StreamJsonParser();
    const items = parser.push(
      '{"items": [{"name_ru": "Торт \\"Наполеон\\"", "quantity": 1, "price": 500, "total": 500, "category": "Еда"}]}',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.name_ru).toBe('Торт "Наполеон"');
  });

  it('handles braces inside string values', () => {
    const parser = new StreamJsonParser();
    const items = parser.push(
      '{"items": [{"name_ru": "Набор {маленький}", "quantity": 1, "price": 100, "total": 100, "category": "Разное"}]}',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.name_ru).toBe('Набор {маленький}');
  });

  it('skips items missing required fields (name_ru, total)', () => {
    const parser = new StreamJsonParser();
    const items = parser.push(
      '{"items": [{"quantity": 1, "price": 100}, {"name_ru": "Хлеб", "quantity": 1, "price": 45, "total": 45, "category": "Еда"}]}',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.name_ru).toBe('Хлеб');
  });

  it('handles truncated response (no closing bracket)', () => {
    const parser = new StreamJsonParser();
    const batch1 = parser.push(
      '{"items": [{"name_ru": "Яблоко", "quantity": 1, "price": 60, "total": 60, "category": "Еда"}, {"name_ru": "Груша',
    );
    expect(batch1).toHaveLength(1);
    expect(batch1[0]?.name_ru).toBe('Яблоко');
    expect(parser.getAllItems()).toHaveLength(1);
  });

  it('returns empty array when no items found', () => {
    const parser = new StreamJsonParser();
    const items = parser.push('Some random text without JSON');
    expect(items).toHaveLength(0);
  });

  it('handles multiple <think> blocks', () => {
    const parser = new StreamJsonParser();
    const items = parser.push(
      '<think>First thought</think><think>Second thought</think>{"items": [{"name_ru": "Чай", "quantity": 1, "price": 80, "total": 80, "category": "Еда"}]}',
    );
    expect(items).toHaveLength(1);
  });

  it('extracts currency from response', () => {
    const parser = new StreamJsonParser();
    parser.push(
      '{"items": [{"name_ru": "Вода", "quantity": 1, "price": 50, "total": 50, "category": "Еда"}], "currency": "RSD"}',
    );
    expect(parser.getCurrency()).toBe('RSD');
  });

  it('returns undefined currency when not present', () => {
    const parser = new StreamJsonParser();
    parser.push(
      '{"items": [{"name_ru": "Вода", "quantity": 1, "price": 50, "total": 50, "category": "Еда"}]}',
    );
    expect(parser.getCurrency()).toBeUndefined();
  });

  it('extracts currency that appears in later chunk', () => {
    const parser = new StreamJsonParser();
    parser.push(
      '{"items": [{"name_ru": "Вода", "quantity": 1, "price": 50, "total": 50, "category": "Еда"}]',
    );
    expect(parser.getCurrency()).toBeUndefined();
    parser.push(', "currency": "EUR"}');
    expect(parser.getCurrency()).toBe('EUR');
  });
});
