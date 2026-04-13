// Tests for receipt-display helpers — N+2 truncation rule and comment parsing

import { describe, expect, test } from 'bun:test';
import { formatReceiptCommentForTelegram, truncateItemsForDisplay } from './receipt-display';

describe('truncateItemsForDisplay', () => {
  test('returns empty string for empty input', () => {
    expect(truncateItemsForDisplay([])).toBe('');
  });

  test('shows all items when count ≤ maxVisible + 2', () => {
    expect(truncateItemsForDisplay(['a'])).toBe('a');
    expect(truncateItemsForDisplay(['a', 'b', 'c'])).toBe('a, b, c');
    // 4 items: 4 ≤ 3 + 2 → show all
    expect(truncateItemsForDisplay(['a', 'b', 'c', 'd'])).toBe('a, b, c, d');
    // 5 items: 5 ≤ 3 + 2 → show all
    expect(truncateItemsForDisplay(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, d, e');
  });

  test('truncates with "и ещё N позиция" when hidden count is exactly 3', () => {
    expect(truncateItemsForDisplay(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a, b, c и ещё 3 позиции');
  });

  test('truncates with "и ещё N позиций" for larger counts', () => {
    expect(truncateItemsForDisplay(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe(
      'a, b, c и ещё 4 позиции',
    );
    const many = Array.from({ length: 70 }, (_, i) => `item${i}`);
    expect(truncateItemsForDisplay(many)).toBe('item0, item1, item2 и ещё 67 позиций');
  });

  test('uses "позиция" for N=1, "позиции" for 2-4, "позиций" for 5+', () => {
    // These can't trigger via maxVisible=3 (hidden < 3 shows all), but the
    // pluralize call is reachable via bigger maxVisible
    expect(truncateItemsForDisplay(['a', 'b', 'c', 'd', 'e', 'f'], 3)).toContain('3 позиции');
    // 20 items, maxVisible=3 → 17 hidden → "17 позиций"
    const twenty = Array.from({ length: 20 }, (_, i) => `${i}`);
    expect(truncateItemsForDisplay(twenty, 3)).toContain('17 позиций');
    // 24 items, maxVisible=3 → 21 hidden → "21 позиция" (mod10=1, not 11-19)
    const twentyFour = Array.from({ length: 24 }, (_, i) => `${i}`);
    expect(truncateItemsForDisplay(twentyFour, 3)).toContain('21 позиция');
  });

  test('respects custom maxVisible', () => {
    // 10 items, maxVisible=5 → 5 hidden → truncate
    const ten = Array.from({ length: 10 }, (_, i) => `${i}`);
    expect(truncateItemsForDisplay(ten, 5)).toBe('0, 1, 2, 3, 4 и ещё 5 позиций');
    // 6 items, maxVisible=5 → 1 hidden → show all (hidden < 3)
    expect(truncateItemsForDisplay(['a', 'b', 'c', 'd', 'e', 'f'], 5)).toBe('a, b, c, d, e, f');
  });
});

describe('formatReceiptCommentForTelegram', () => {
  test('parses a real receipt comment with commas in names and truncates correctly', () => {
    const full =
      'Чек: Бананы (1x167.12), Салат Айсберг (1x159.99), Помидоры черри, 500г (1x339.99), Огурец (1x139.98), Куриное бедро (1x279.99), Желейные конфеты (1x185.49)';
    // 6 real items, comma inside "Помидоры черри, 500г" must NOT split.
    // Expected: first 3 names shown, remaining 3 counted as "и ещё 3 позиции".
    const out = formatReceiptCommentForTelegram(full);
    expect(out).toBe('Чек: Бананы, Салат Айсберг, Помидоры черри, 500г и ещё 3 позиции');
  });

  test('handles decimal quantity (weighed goods)', () => {
    const full = 'Чек: Помидоры черри, 500г (0.5x679.98), Сыр, 200г (0.2x2624.95)';
    // 2 items with commas in names and decimal quantities
    expect(formatReceiptCommentForTelegram(full)).toBe('Чек: Помидоры черри, 500г, Сыр, 200г');
  });

  test('parses a well-formed receipt comment (no commas in names)', () => {
    const full =
      'Чек: Бананы (1x167), Молоко (2x100), Хлеб (1x80), Огурец (1x140), Мясо (1x280), Сыр (1x525), Яйца (1x150)';
    const out = formatReceiptCommentForTelegram(full);
    expect(out).toBe('Чек: Бананы, Молоко, Хлеб и ещё 4 позиции');
  });

  test('returns comment unchanged if it has no receipt prefix', () => {
    expect(formatReceiptCommentForTelegram('Такси до дома')).toBe('Такси до дома');
    expect(formatReceiptCommentForTelegram('')).toBe('');
  });

  test('handles comment with exactly 3 items (no truncation)', () => {
    const full = 'Чек: A (1x10), B (1x20), C (1x30)';
    expect(formatReceiptCommentForTelegram(full)).toBe('Чек: A, B, C');
  });

  test('handles comment with 5 items (N+2 rule: show all)', () => {
    const full = 'Чек: A (1x10), B (1x20), C (1x30), D (1x40), E (1x50)';
    expect(formatReceiptCommentForTelegram(full)).toBe('Чек: A, B, C, D, E');
  });
});
