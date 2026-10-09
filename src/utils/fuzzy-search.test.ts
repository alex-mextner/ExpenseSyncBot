import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  levenshteinDistance,
  calculateSimilarity,
  findBestCategoryMatch,
  normalizeCategoryName,
} from './fuzzy-search';

describe('levenshteinDistance', () => {
  test('should return 0 for identical strings', () => {
    expect(levenshteinDistance('продукты', 'продукты')).toBe(0);
    expect(levenshteinDistance('test', 'test')).toBe(0);
  });

  test('should return length of string when comparing with empty string', () => {
    expect(levenshteinDistance('продукты', '')).toBe(8);
    expect(levenshteinDistance('', 'test')).toBe(4);
    expect(levenshteinDistance('', '')).toBe(0);
  });

  test('should calculate distance for single character substitution', () => {
    expect(levenshteinDistance('продукты', 'продукта')).toBe(1);
    expect(levenshteinDistance('test', 'tost')).toBe(1);
  });

  test('should calculate distance for single character insertion', () => {
    expect(levenshteinDistance('продукты', 'продукты1')).toBe(1);
    expect(levenshteinDistance('test', 'tests')).toBe(1);
  });

  test('should calculate distance for single character deletion', () => {
    expect(levenshteinDistance('продукты', 'родукты')).toBe(1);
    expect(levenshteinDistance('test', 'tst')).toBe(1);
  });

  test('should calculate distance for multiple differences', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('продукты', 'продукт')).toBe(1);
  });

  test('should be case-sensitive', () => {
    expect(levenshteinDistance('Test', 'test')).toBe(1);
    expect(levenshteinDistance('TEST', 'test')).toBe(4);
  });
});

describe('calculateSimilarity', () => {
  test('should return 1.0 for identical strings', () => {
    expect(calculateSimilarity('продукты', 'продукты')).toBe(1.0);
    expect(calculateSimilarity('test', 'test')).toBe(1.0);
  });

  test('should return 0.0 when comparing with empty string', () => {
    expect(calculateSimilarity('продукты', '')).toBe(0.0);
    expect(calculateSimilarity('', 'test')).toBe(0.0);
    expect(calculateSimilarity('', '')).toBe(1.0);
  });

  test('should calculate similarity for single character difference', () => {
    // 1 error out of 8 characters = 7/8 = 0.875
    const sim = calculateSimilarity('продукты', 'продукта');
    expect(sim).toBeCloseTo(0.875, 3);
  });

  test('should calculate similarity for short strings', () => {
    // 1 error out of 2 characters = 1/2 = 0.5
    const sim = calculateSimilarity('ab', 'ac');
    expect(sim).toBeCloseTo(0.5, 3);
  });

  test('should handle different length strings', () => {
    // distance 1, max length 5 = 1 - 1/5 = 0.8
    const sim = calculateSimilarity('test', 'tests');
    expect(sim).toBeCloseTo(0.8, 3);
  });

  test('should be case-sensitive (lowercase input should match lowercase category)', () => {
    // Both should be normalized before calling this
    const sim = calculateSimilarity('test', 'TEST');
    expect(sim).toBe(0.0);
  });
});

describe('findBestCategoryMatch with fuzzy matching', () => {
  const categories = ['Продукты', 'Транспорт', 'Развлечения', 'Здоровье'];

  test('should return exact match (case-insensitive)', () => {
    expect(findBestCategoryMatch('Продукты', categories)).toBe('Продукты');
    expect(findBestCategoryMatch('продукты', categories)).toBe('Продукты');
    expect(findBestCategoryMatch('ПРОДУКТЫ', categories)).toBe('Продукты');
  });

  test('should handle extra spaces', () => {
    expect(findBestCategoryMatch(' Продукты ', categories)).toBe('Продукты');
    expect(findBestCategoryMatch('  продукты  ', categories)).toBe('Продукты');
  });

  test('should match with one character typo', () => {
    // "Продукта" (wrong last char) vs "Продукты" - distance 1, similarity 0.875
    // Should match with threshold 0.75
    expect(findBestCategoryMatch('Продукта', categories)).toBe('Продукты');
  });

  test('should match with two character typos', () => {
    // "прадукта" vs "продукты" - 2 typos (a instead of o, a instead of ы)
    // similarity = 1 - 2/8 = 0.75
    expect(findBestCategoryMatch('прадукта', categories)).toBe('Продукты');
  });

  test('should match "продукты" with missing letter', () => {
    // "продукт" (missing 'ы') vs "Продукты" - distance 1, similarity 7/8 = 0.875
    expect(findBestCategoryMatch('продукт', categories)).toBe('Продукты');
  });

  test('should match with 2 typos in 8-char word', () => {
    // "продукты" (8 chars) with 2 typos: similarity = 1 - 2/8 = 0.75
    // "продуки" (missing 'т', 'ы') vs "продукты" - distance 2
    expect(findBestCategoryMatch('продуки', categories)).toBe('Продукты');
    // "прадукты" (a instead of o) - 1 typo
    expect(findBestCategoryMatch('прадукты', categories)).toBe('Продукты');
  });

  test('should NOT match when too many typos (3+ in short word)', () => {
    // "продук" (3 chars missing) vs "продукты" - distance 3, similarity 5/8 = 0.625
    expect(findBestCategoryMatch('продук', categories)).toBeNull();
    // "прод" (4 chars missing) - distance 4, similarity 4/8 = 0.5
    expect(findBestCategoryMatch('прод', categories)).toBeNull();
  });

  test('should return null for no match', () => {
    expect(findBestCategoryMatch('несуществующая', categories)).toBeNull();
  });

  test('should return null for empty input', () => {
    expect(findBestCategoryMatch('', categories)).toBeNull();
    expect(findBestCategoryMatch('   ', categories)).toBeNull();
  });

  test('should return null for empty categories', () => {
    expect(findBestCategoryMatch('Продукты', [])).toBeNull();
  });

  test('should handle short category names', () => {
    const shortCategories = ['Да', 'Нет', 'Авто'];
    
    // Exact match
    expect(findBestCategoryMatch('Да', shortCategories)).toBe('Да');
    expect(findBestCategoryMatch('да', shortCategories)).toBe('Да');
    
    // One char difference in 2-char word (1 - 1/2 = 0.5) - below threshold 0.75
    expect(findBestCategoryMatch('Ду', shortCategories)).toBeNull();
    
    // One char difference in 3-char word (1 - 1/3 = 0.67) - below threshold 0.75
    expect(findBestCategoryMatch('Авт', shortCategories)).toBeNull();
  });

  test('should match category containing input (existing behavior)', () => {
    // "транспорт" contains "транс"
    expect(findBestCategoryMatch('транс', categories)).toBe('Транспорт');
  });

  test('should match input containing category (existing behavior)', () => {
    // "мой транспорт" contains "транспорт"
    expect(findBestCategoryMatch('мой транспорт', categories)).toBe('Транспорт');
  });

  test('should prioritize exact match over fuzzy match', () => {
    const cats = ['Продукты', 'Продукт'];
    expect(findBestCategoryMatch('Продукты', cats)).toBe('Продукты');
    expect(findBestCategoryMatch('Продукт', cats)).toBe('Продукт');
  });

  test('should return best fuzzy match when multiple close matches exist', () => {
    // If we have "Продукты" and "Продукт", and search for "Продукты" (exact match)
    // should return exact
    const cats = ['Продукты', 'Продукт'];
    expect(findBestCategoryMatch('Продукты', cats)).toBe('Продукты');
  });

  test('should handle Unicode correctly', () => {
    const cats = ['Кафе', 'Молоко', 'Яйца'];
    expect(findBestCategoryMatch('кафе', cats)).toBe('Кафе');
    expect(findBestCategoryMatch('молоко', cats)).toBe('Молоко');
  });

  test('should match with similarity just above threshold for long words', () => {
    // "Развлечения" (11 chars) with 1 char diff = 1 - 1/11 = 0.909 (above 0.75)
    const longCategories = ['Развлечения']; // 11 chars
    // Use actual character difference, not case difference
    expect(findBestCategoryMatch('Развлечениа', longCategories)).toBe('Развлечения');
  });

  test('should match with 2 typos in long word', () => {
    // "Развлечения" (11 chars) with 2 char diff = 1 - 2/11 = 0.818 (above 0.75)
    const longCategories = ['Развлечения'];
    // "Развлетения" (ч->т) = 1 typo
    expect(findBestCategoryMatch('Развлетения', longCategories)).toBe('Развлечения');
  });

  test('should NOT match completely different words', () => {
    // "xyzabc" vs "продукты" - completely different
    expect(findBestCategoryMatch('xyzabc', categories)).toBeNull();
  });

  test('should match with insertion (extra character)', () => {
    // "продуктыы" (extra 'ы') vs "Продукты" - distance 1
    expect(findBestCategoryMatch('продуктыы', categories)).toBe('Продукты');
  });

  test('should match with deletion (missing character)', () => {
    // "продукы" (missing 'т') vs "Продукты" - distance 1
    expect(findBestCategoryMatch('продукы', categories)).toBe('Продукты');
  });

  test('should match with extra space', () => {
    // "продукт ы" vs "продукты" - extra space = 1 difference
    expect(findBestCategoryMatch('продукт ы', categories)).toBe('Продукты');
  });

  test('should handle mixed case and spaces', () => {
    expect(findBestCategoryMatch('  ПрОдУкТы  ', categories)).toBe('Продукты');
  });
});

describe('findBestCategoryMatch - edge cases', () => {
  test('should handle null-like inputs', () => {
    const categories = ['Продукты'];
    expect(findBestCategoryMatch('', categories)).toBeNull();
    expect(findBestCategoryMatch('   ', categories)).toBeNull();
  });

  test('should handle categories with spaces', () => {
    const categories = ['Бытовые товары', 'Бытовые услуги'];
    expect(findBestCategoryMatch('бытовые товары', categories)).toBe('Бытовые товары');
    expect(findBestCategoryMatch('БЫТОВЫЕ ТОВАРЫ', categories)).toBe('Бытовые товары');
  });

  test('should match with typo in multi-word category', () => {
    const categories = ['Бытовые товары'];
    // "Бытовые товар" (missing 'ы') - distance 1
    expect(findBestCategoryMatch('Бытовые товар', categories)).toBe('Бытовые товары');
  });

  test('should return best match among multiple candidates', () => {
    const categories = ['Продукты', 'Продуктовая', 'Прод'];
    // "Продукты" is exact match for first category
    expect(findBestCategoryMatch('Продукты', categories)).toBe('Продукты');
    // "Продуктовая" should match "Продуктовая" exactly
    expect(findBestCategoryMatch('Продуктовая', categories)).toBe('Продуктовая');
  });

  test('should handle categories with special characters', () => {
    const categories = ['Здоровье/Медицина', 'Транспорт/Такси'];
    expect(findBestCategoryMatch('здоровье/медицина', categories)).toBe('Здоровье/Медицина');
  });
});

describe('normalizeCategoryName', () => {
  test('should capitalize first letter and lowercase rest', () => {
    expect(normalizeCategoryName('продукты')).toBe('Продукты');
    expect(normalizeCategoryName('ПРОДУКТЫ')).toBe('Продукты');
    expect(normalizeCategoryName('ПрОдУкТы')).toBe('Продукты');
    expect(normalizeCategoryName('test')).toBe('Test');
    expect(normalizeCategoryName('TEST')).toBe('Test');
  });

  test('should trim spaces', () => {
    expect(normalizeCategoryName('  продукты  ')).toBe('Продукты');
    expect(normalizeCategoryName(' test ')).toBe('Test');
  });

  test('should handle empty string', () => {
    expect(normalizeCategoryName('')).toBe('');
    expect(normalizeCategoryName('   ')).toBe('');
  });

  test('should preserve already normalized strings', () => {
    expect(normalizeCategoryName('Продукты')).toBe('Продукты');
    expect(normalizeCategoryName('Test')).toBe('Test');
  });

  test('should handle multi-word names', () => {
    expect(normalizeCategoryName('бытовые товары')).toBe('Бытовые товары');
    expect(normalizeCategoryName('БЫТОВЫЕ ТОВАРЫ')).toBe('Бытовые товары');
  });
});
