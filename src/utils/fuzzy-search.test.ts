// Tests for category fuzzy matching and normalization

import { describe, expect, it } from 'bun:test';
import {
  calculateSimilarity,
  findBestCategoryMatch,
  levenshteinDistance,
  normalizeCategoryName,
  normalizePhonetic,
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

describe('normalizePhonetic', () => {
  it('lowercases and trims', () => expect(normalizePhonetic('  Кафе  ')).toBe('кафе'));
  it('replaces ё with е', () => expect(normalizePhonetic('ёжик')).toBe('ешик'));
  it('replaces й with и', () => expect(normalizePhonetic('чай')).toBe('чаи'));
  it('replaces о with а', () => expect(normalizePhonetic('кофе')).toBe('кафе'));
  it('replaces voiced consonants: б→п', () => expect(normalizePhonetic('баня')).toBe('паня'));
  it('replaces voiced consonants: в→ф', () => expect(normalizePhonetic('вода')).toBe('фата'));
  it('replaces voiced consonants: г→к', () => expect(normalizePhonetic('город')).toBe('карат'));
  it('replaces voiced consonants: д→т', () => expect(normalizePhonetic('дом')).toBe('там'));
  it('replaces voiced consonants: ж→ш', () => expect(normalizePhonetic('жара')).toBe('шара'));
  it('replaces voiced consonants: з→с', () => expect(normalizePhonetic('зима')).toBe('сима'));
  it('кофе and кафе normalize to same string', () =>
    expect(normalizePhonetic('кофе')).toBe(normalizePhonetic('кафе')));
  it('leaves latin and digits unchanged', () =>
    expect(normalizePhonetic(' ABC 123 ')).toBe('abc 123'));
});

describe('levenshteinDistance', () => {
  it('identical strings → 0', () => expect(levenshteinDistance('кот', 'кот')).toBe(0));
  it('empty strings → 0', () => expect(levenshteinDistance('', '')).toBe(0));
  it('one empty → length of other', () => expect(levenshteinDistance('кот', '')).toBe(3));
  it('one insertion', () => expect(levenshteinDistance('кот', 'кота')).toBe(1));
  it('one deletion', () => expect(levenshteinDistance('кота', 'кот')).toBe(1));
  it('one substitution', () => expect(levenshteinDistance('кот', 'кит')).toBe(1));
  it('2 substitutions (shared middle char)', () =>
    expect(levenshteinDistance('кот', 'дом')).toBe(2));
  it('Развлечения with 1-char typo', () =>
    expect(levenshteinDistance('развлечениа', 'развлечения')).toBe(1));
});

describe('calculateSimilarity', () => {
  it('identical → 1', () => expect(calculateSimilarity('кот', 'кот')).toBe(1));
  it('both empty → 1', () => expect(calculateSimilarity('', '')).toBe(1));
  it('1 char typo in 11-char word → ~0.909', () => {
    // levenshtein=1, maxLen=11 → 1 - 1/11 ≈ 0.909
    const s = calculateSimilarity('развлечениа', 'развлечения');
    expect(s).toBeCloseTo(0.909, 2);
  });
  it('1 char typo in 8-char word → 0.875 (below 0.9)', () => {
    const s = calculateSimilarity('продукта', 'продукты');
    expect(s).toBeCloseTo(0.875, 2);
  });
});

describe('findBestCategoryMatch', () => {
  const cats = ['Продукты', 'Развлечения', 'Транспорт', 'Здоровье', 'Кафе'];

  it('returns null for empty input', () => expect(findBestCategoryMatch('', cats)).toBeNull());
  it('returns null for empty categories', () =>
    expect(findBestCategoryMatch('продукты', [])).toBeNull());

  // Exact match
  it('exact match case-insensitive', () =>
    expect(findBestCategoryMatch('продукты', cats)).toBe('Продукты'));
  it('exact match uppercase input', () =>
    expect(findBestCategoryMatch('ПРОДУКТЫ', cats)).toBe('Продукты'));

  // Starts-with / contained-in
  it('starts-with match: category starts with input', () =>
    expect(findBestCategoryMatch('разв', cats)).toBe('Развлечения'));
  it('starts-with does not match substring in the middle', () =>
    expect(findBestCategoryMatch('влечени', cats)).toBe(null));
  it('contained-in match: category inside input', () =>
    expect(findBestCategoryMatch('мой транспорт сегодня', cats)).toBe('Транспорт'));

  // Phonetic exact: кофе → кафе via о→а
  it('phonetic exact: кофе → Кафе', () => expect(findBestCategoryMatch('кофе', cats)).toBe('Кафе'));

  // Levenshtein fuzzy (1 typo in long word)
  it('fuzzy: 1-char typo in Развлечения → still matches', () =>
    expect(findBestCategoryMatch('Развлечениа', cats)).toBe('Развлечения'));

  // No match
  it('returns null when no match', () => expect(findBestCategoryMatch('xyz', cats)).toBeNull());

  // Voiced/unvoiced: should match via phonetic normalization
  it('phonetic: voiced/unvoiced consonant confusion', () => {
    const c = ['Здоровье'];
    // с→с already, т→т already; з→с makes "Сдоровье" normalize same as "Здоровье"
    expect(findBestCategoryMatch('Сдоровье', c)).toBe('Здоровье');
  });

  // Short categories require near-exact
  it('phonetic: д→т maps "ета" to same form as "Еда" → phonetic exact match', () => {
    const c = ['Еда'];
    // Levenshtein alone: sim("ета","еда")=0.667 < 0.9 → miss
    // Phonetic: "Еда"→"ета" (д→т), "ета"→"ета" → exact match on normalized form → hit
    expect(findBestCategoryMatch('ета', c)).toBe('Еда');
  });

  it('prefers exact over phonetic', () => {
    const c = ['Кафе', 'Кофе'];
    expect(findBestCategoryMatch('кафе', c)).toBe('Кафе');
  });

  it('prefers exact over fuzzy', () => {
    const c = ['Food', 'Fast Food', 'Seafood'];
    expect(findBestCategoryMatch('food', c)).toBe('Food');
  });
});
