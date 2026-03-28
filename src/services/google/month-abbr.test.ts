// Tests for MonthAbbr helpers

import { describe, expect, test } from 'bun:test';
import { MONTH_ABBREVS, monthAbbrFromDate, monthAbbrFromYYYYMM, prevMonthAbbr } from './month-abbr';

describe('monthAbbrFromDate', () => {
  test('returns correct abbreviation for all 12 months', () => {
    MONTH_ABBREVS.forEach((expected, i) => {
      expect(monthAbbrFromDate(new Date(2026, i, 15))).toBe(expected);
    });
  });
});

describe('monthAbbrFromYYYYMM', () => {
  test('converts YYYY-MM string to abbreviation', () => {
    expect(monthAbbrFromYYYYMM('2026-01')).toBe('Jan');
    expect(monthAbbrFromYYYYMM('2026-03')).toBe('Mar');
    expect(monthAbbrFromYYYYMM('2026-12')).toBe('Dec');
  });

  test('throws for out-of-range month', () => {
    expect(() => monthAbbrFromYYYYMM('2026-13')).toThrow();
    expect(() => monthAbbrFromYYYYMM('2026-00')).toThrow();
  });
});

describe('prevMonthAbbr', () => {
  test('returns previous month, same year', () => {
    expect(prevMonthAbbr(2026, 'Mar')).toEqual({ year: 2026, month: 'Feb' });
    expect(prevMonthAbbr(2026, 'Dec')).toEqual({ year: 2026, month: 'Nov' });
    expect(prevMonthAbbr(2026, 'Feb')).toEqual({ year: 2026, month: 'Jan' });
  });

  test('wraps January to previous year December', () => {
    expect(prevMonthAbbr(2026, 'Jan')).toEqual({ year: 2025, month: 'Dec' });
  });
});

describe('MONTH_ABBREVS', () => {
  test('has 12 entries', () => {
    expect(MONTH_ABBREVS).toHaveLength(12);
  });
});
