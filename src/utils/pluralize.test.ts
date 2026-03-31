// Tests for Russian numeral declension utility.

import { describe, expect, test } from 'bun:test';
import { pluralize } from './pluralize';

describe('pluralize', () => {
  const forms = ['карточка', 'карточки', 'карточек'] as const;

  test('singular: 1, 21, 31, 101', () => {
    for (const n of [1, 21, 31, 101, 1001]) {
      expect(pluralize(n, ...forms)).toBe('карточка');
    }
  });

  test('few: 2-4, 22-24, 32-34', () => {
    for (const n of [2, 3, 4, 22, 23, 24, 32, 33, 34]) {
      expect(pluralize(n, ...forms)).toBe('карточки');
    }
  });

  test('many: 0, 5-20, 25-30, 100, 111-119', () => {
    for (const n of [0, 5, 6, 10, 11, 12, 13, 14, 15, 19, 20, 25, 100, 111, 112, 119]) {
      expect(pluralize(n, ...forms)).toBe('карточек');
    }
  });

  test('handles negative numbers', () => {
    expect(pluralize(-1, ...forms)).toBe('карточка');
    expect(pluralize(-3, ...forms)).toBe('карточки');
    expect(pluralize(-5, ...forms)).toBe('карточек');
    expect(pluralize(-11, ...forms)).toBe('карточек');
  });

  test('works with different word sets', () => {
    expect(pluralize(1, 'расход', 'расхода', 'расходов')).toBe('расход');
    expect(pluralize(3, 'расход', 'расхода', 'расходов')).toBe('расхода');
    expect(pluralize(7, 'расход', 'расхода', 'расходов')).toBe('расходов');

    expect(pluralize(1, 'транзакция', 'транзакции', 'транзакций')).toBe('транзакция');
    expect(pluralize(2, 'транзакция', 'транзакции', 'транзакций')).toBe('транзакции');
    expect(pluralize(15, 'транзакция', 'транзакции', 'транзакций')).toBe('транзакций');
  });
});
