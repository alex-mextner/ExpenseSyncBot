// Tests for Russian month formatting

import { describe, expect, test } from 'bun:test';
import { formatMonthYearRu } from './ru-date';

describe('formatMonthYearRu', () => {
  test('formats every month in nominative case', () => {
    const names = Array.from({ length: 12 }, (_, month) =>
      formatMonthYearRu(new Date(2026, month, 15)),
    );
    expect(names[0]).toBe('январь 2026');
    expect(names[8]).toBe('сентябрь 2026');
    expect(names[11]).toBe('декабрь 2026');
    expect(new Set(names).size).toBe(12);
  });
});
