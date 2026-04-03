import { describe, expect, test } from 'bun:test';
import { normalizeArrayParam, resolvePeriodDates } from './period';

describe('resolvePeriodDates', () => {
  test('resolves specific month YYYY-MM', () => {
    const { startDate, endDate } = resolvePeriodDates('2026-02');
    expect(startDate).toBe('2026-02-01');
    expect(endDate).toBe('2026-02-28');
  });

  test('resolves leap year February', () => {
    const { startDate, endDate } = resolvePeriodDates('2024-02');
    expect(startDate).toBe('2024-02-01');
    expect(endDate).toBe('2024-02-29');
  });

  test('resolves current_month', () => {
    const { startDate, endDate } = resolvePeriodDates('current_month');
    expect(startDate).toMatch(/^\d{4}-\d{2}-01$/);
    expect(endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('resolves last_month', () => {
    const { startDate } = resolvePeriodDates('last_month');
    expect(startDate).toMatch(/^\d{4}-\d{2}-01$/);
  });

  test('resolves last_3_months', () => {
    const { startDate } = resolvePeriodDates('last_3_months');
    const now = new Date();
    const startMonth = new Date(startDate);
    expect(now.getTime() - startMonth.getTime()).toBeGreaterThan(50 * 86400 * 1000);
  });

  test('resolves last_6_months', () => {
    const { startDate } = resolvePeriodDates('last_6_months');
    const now = new Date();
    const startMonth = new Date(startDate);
    expect(now.getTime() - startMonth.getTime()).toBeGreaterThan(140 * 86400 * 1000);
  });

  test('resolves "all" to wide range', () => {
    const { startDate } = resolvePeriodDates('all');
    expect(startDate).toBe('2000-01-01');
  });

  test('falls back to current_month for invalid input', () => {
    const { startDate } = resolvePeriodDates('garbage');
    const { startDate: currentStart } = resolvePeriodDates('current_month');
    expect(startDate).toBe(currentStart);
  });
});

describe('normalizeArrayParam', () => {
  test('wraps string in array', () => {
    expect(normalizeArrayParam('hello')).toEqual(['hello']);
  });

  test('passes array through', () => {
    expect(normalizeArrayParam(['a', 'b'])).toEqual(['a', 'b']);
  });

  test('returns default for undefined', () => {
    expect(normalizeArrayParam(undefined, 'default')).toEqual(['default']);
  });

  test('returns empty array for undefined with no default', () => {
    expect(normalizeArrayParam(undefined)).toEqual([]);
  });

  test('converts non-string array elements to strings', () => {
    expect(normalizeArrayParam([1, 2, 3])).toEqual(['1', '2', '3']);
  });

  test('falls back to default for empty array', () => {
    expect(normalizeArrayParam([], 'default')).toEqual(['default']);
  });

  test('returns empty array for empty array with no default', () => {
    expect(normalizeArrayParam([])).toEqual([]);
  });
});
