// Tests for category fuzzy matching and normalization

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { env } from '../config/env';
import {
  calculateSimilarity,
  findBestCategoryMatch,
  findBestCategoryMatchAsync,
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
  it('lowercases rest after capitalizing first', () =>
    expect(normalizeCategoryName('fOOD')).toBe('Food'));
  it('handles already trimmed string', () =>
    expect(normalizeCategoryName('Transport')).toBe('Transport'));
  it('handles multi-word input', () =>
    expect(normalizeCategoryName('food and drink')).toBe('Food and drink'));
  it('lowercases all-caps latin word', () => expect(normalizeCategoryName('BYTES')).toBe('Bytes'));
  it('lowercases all-caps Cyrillic word', () =>
    expect(normalizeCategoryName('РАЗВЛЕЧЕНИЯ')).toBe('Развлечения'));
  it('is idempotent — applying twice yields the same result', () => {
    const inputs = ['food', 'FOOD', 'fOoD', 'РАЗВЛЕЧЕНИЯ', '  Еда.  ', 'Transport'];
    for (const input of inputs) {
      const once = normalizeCategoryName(input);
      const twice = normalizeCategoryName(once);
      expect(twice).toBe(once);
    }
  });
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

  it('strips trailing dot: Расходыквартиры. matches Расходыквартиры', () => {
    const c = ['Расходыквартиры', 'Ремонт', 'Дом'];
    // Trailing dot: Levenshtein distance 1, should match via startsWith or fuzzy
    expect(findBestCategoryMatch('Расходыквартиры.', c)).toBe('Расходыквартиры');
  });
});

describe('findBestCategoryMatchAsync', () => {
  const originalFetch = global.fetch;
  const originalToken = env.HF_TOKEN;

  beforeEach(() => {
    (env as { HF_TOKEN: string }).HF_TOKEN = 'test-token';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    (env as { HF_TOKEN: string }).HF_TOKEN = originalToken;
  });

  it('returns sync match without calling classifier', async () => {
    // Sync path short-circuits — fetch must not be called
    const fetchMock = mock(() => Promise.reject(new Error('should not be called')));
    global.fetch = fetchMock as unknown as typeof fetch;

    const cats = ['Еда', 'Транспорт', 'Развлечения'];
    expect(await findBestCategoryMatchAsync('еда', cats)).toBe('Еда');
    expect(await findBestCategoryMatchAsync('транс', cats)).toBe('Транспорт');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls through to classifier when sync methods fail', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            sequence: 'починка авто',
            labels: ['Транспорт', 'Еда', 'Развлечения'],
            scores: [0.87, 0.08, 0.05],
          }),
        ),
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const cats = ['Еда', 'Транспорт', 'Развлечения'];
    const result = await findBestCategoryMatchAsync('починка авто', cats);
    expect(result).toBe('Транспорт');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when classifier top score below threshold (0.4)', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            sequence: 'абракадабра',
            labels: ['Еда'],
            scores: [0.2],
          }),
        ),
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await findBestCategoryMatchAsync('абракадабра', ['Еда'])).toBeNull();
  });

  it('returns null when HF_TOKEN is missing', async () => {
    (env as { HF_TOKEN: string }).HF_TOKEN = '';
    const fetchMock = mock(() => Promise.reject(new Error('should not be called')));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await findBestCategoryMatchAsync('абракадабра', ['Еда'])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on HTTP error', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('forbidden', { status: 403 })));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await findBestCategoryMatchAsync('абракадабра', ['Еда'])).toBeNull();
  });

  it('retries once on 503 cold start then succeeds', async () => {
    let calls = 0;
    const fetchMock = mock(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(new Response('Model is currently loading', { status: 503 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            sequence: 'починка',
            labels: ['Ремонт'],
            scores: [0.92],
          }),
        ),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await findBestCategoryMatchAsync('починка', ['Ремонт'])).toBe('Ремонт');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null on fetch abort/network error', async () => {
    const fetchMock = mock(() => Promise.reject(new TypeError('network error')));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await findBestCategoryMatchAsync('абракадабра', ['Еда'])).toBeNull();
  });
});

describe('normalizeCategoryName edge cases', () => {
  it('strips trailing dots', () => expect(normalizeCategoryName('Еда.')).toBe('Еда'));
  it('strips trailing multiple dots', () => expect(normalizeCategoryName('Еда...')).toBe('Еда'));
  it('strips trailing dot+space', () => expect(normalizeCategoryName('Еда. ')).toBe('Еда'));
});
