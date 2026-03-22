// Tests for category fuzzy matching and normalization

import { describe, expect, it } from 'bun:test';
import {
  findBestCategoryMatch,
  findSimilarCategories,
  normalizeCategoryName,
} from './fuzzy-search';

describe('normalizeCategoryName', () => {
  it('capitalizes first letter', () => expect(normalizeCategoryName('food')).toBe('Food'));
  it('preserves already-capitalized', () => expect(normalizeCategoryName('Food')).toBe('Food'));
  it('trims leading whitespace', () => expect(normalizeCategoryName('  food  ')).toBe('Food'));
  it('handles empty string', () => expect(normalizeCategoryName('')).toBe(''));
  it('handles whitespace only', () => expect(normalizeCategoryName('   ')).toBe(''));
  it('handles single character', () => expect(normalizeCategoryName('f')).toBe('F'));
  it('handles unicode first char', () => expect(normalizeCategoryName('еда')).toBe('Еда'));
  it('does not alter rest of string casing', () =>
    expect(normalizeCategoryName('fOOD')).toBe('FOOD'));
  it('handles already trimmed string', () =>
    expect(normalizeCategoryName('Transport')).toBe('Transport'));
  it('handles multi-word input', () =>
    expect(normalizeCategoryName('food and drink')).toBe('Food and drink'));
});

describe('findBestCategoryMatch', () => {
  const cats = ['Food', 'Transport', 'Entertainment', 'Health'];

  it('returns null for empty input', () => expect(findBestCategoryMatch('', cats)).toBeNull());
  it('returns null for empty categories', () =>
    expect(findBestCategoryMatch('food', [])).toBeNull());
  it('finds exact match case-insensitive', () =>
    expect(findBestCategoryMatch('food', cats)).toBe('Food'));
  it('finds exact match uppercase input', () =>
    expect(findBestCategoryMatch('FOOD', cats)).toBe('Food'));
  it('finds exact match mixed case', () =>
    expect(findBestCategoryMatch('fOoD', cats)).toBe('Food'));
  it('finds match when category contains input', () =>
    expect(findBestCategoryMatch('tain', cats)).toBe('Entertainment'));
  it('finds match when input contains category', () =>
    expect(findBestCategoryMatch('My Food purchase', cats)).toBe('Food'));
  it('returns null when no match', () => expect(findBestCategoryMatch('xyz', cats)).toBeNull());
  it('prefers exact over contains', () => {
    const c = ['food & drink', 'Food'];
    expect(findBestCategoryMatch('food', c)).toBe('Food');
  });
  it('handles single character input matching start', () => {
    expect(findBestCategoryMatch('h', ['Health', 'Home'])).toBe('Health');
  });
  it('handles single-item categories list', () => {
    expect(findBestCategoryMatch('transport', ['Transport'])).toBe('Transport');
  });
  it('returns a match when input is whitespace only (trimmed to empty, matches all via contains)', () => {
    // trimmed empty string matches all via String.includes('') === true
    const result = findBestCategoryMatch('   ', cats);
    expect(result).not.toBeNull();
    expect(cats).toContain(result as string);
  });
});

describe('findSimilarCategories', () => {
  const cats = ['Food', 'Transport', 'Entertainment', 'Health', 'Healthcare'];

  it('returns empty array for empty input', () =>
    expect(findSimilarCategories('', cats)).toEqual([]));
  it('returns empty array for empty categories', () =>
    expect(findSimilarCategories('food', [])).toEqual([]));
  it('returns at most limit results', () =>
    expect(findSimilarCategories('health', cats, 1)).toHaveLength(1));
  it('default limit is 3', () =>
    expect(findSimilarCategories('health', cats).length).toBeLessThanOrEqual(3));
  it('exact match scores highest (appears first)', () => {
    const results = findSimilarCategories('health', cats);
    expect(results[0]).toBe('Health');
  });
  it('returns multiple partial matches', () => {
    const results = findSimilarCategories('health', cats, 5);
    expect(results).toContain('Health');
    expect(results).toContain('Healthcare');
  });
  it('word-based matching works', () => {
    const results = findSimilarCategories('food delivery', cats);
    expect(results).toContain('Food');
  });
  it('returns sorted by score descending', () => {
    const results = findSimilarCategories('health', cats, 5);
    expect(results[0]).toBe('Health');
  });
  it('returns empty array when nothing matches', () => {
    const results = findSimilarCategories('zzzxxx', cats);
    expect(results).toEqual([]);
  });
  it('limit 0 returns empty array', () => {
    const results = findSimilarCategories('food', cats, 0);
    expect(results).toHaveLength(0);
  });
  it('exact match score is highest (100)', () => {
    const results = findSimilarCategories('food', ['Food', 'Fast Food', 'Seafood']);
    expect(results[0]).toBe('Food');
  });
  it('category-contains-input score beats input-contains-category', () => {
    // "Seafood" contains "food" (score 80), "Food" is exact (score 100)
    const results = findSimilarCategories('food', ['Seafood', 'Food'], 2);
    expect(results[0]).toBe('Food');
  });
  it('handles case-insensitive matching for similar categories', () => {
    const results = findSimilarCategories('HEALTH', cats, 5);
    expect(results).toContain('Health');
  });
});
