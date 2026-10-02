// Formula compatibility and prototype-access regressions for dashboard analytics.
import { describe, expect, test } from 'bun:test';
import type { AnalyticsData } from '../src/api/analytics';
import {
  buildScope,
  evaluateFormula,
  validateFormula,
} from '../src/datasources/formula';

const data: AnalyticsData = {
  period: '2026-10',
  defaultCurrency: 'EUR',
  income: 2000,
  expenses: 500,
  balance: 1500,
  savings: 300,
  byCategory: { Food: 200, Еда: 100, constructor: 7, prototype: 8 },
};

describe('dashboard formulas', () => {
  test.each([
    ['savings / income * 100', 15],
    ['expenses.Food', 200],
    ['expenses_constructor', 7],
    ['expenses_prototype', 8],
    ['42', 42],
    ['(income - expenses) / 2', 750],
    ['expenses_Food + expenses_Еда', 300],
    ['max(expenses, savings) + min(2, 3)', 502],
    ['round(1.6) + abs(-3) + sqrt(16)', 9],
    ['2^3 + 10 % 3', 9],
    ['income > 0 ? savings / income * 100 : 0', 15],
    ['expenses_constructor + expenses_prototype', 15],
  ])('preserves %s', (formula, expected) => {
    expect(evaluateFormula(formula, data)).toBeCloseTo(expected);
    expect(validateFormula(formula, data)).toBeNull();
  });

  test('keeps analytics unchanged across evaluation', () => {
    const before = structuredClone(data);
    expect(evaluateFormula('income + savings', data)).toBe(2300);
    expect(data).toEqual(before);
    expect(buildScope(data).income).toBe(2000);
  });

  test.each([
    '1 / 0',
    'sqrt(-1)',
    'missing + 1',
    '"text"',
  ])('rejects %s', (formula) => {
    expect(() => evaluateFormula(formula, data)).toThrow();
  });

  test('reports syntax errors without requiring data', () => {
    expect(validateFormula('unknown + 1')).toBeNull();
    expect(validateFormula('income +')).not.toBeNull();
  });

  test.each([
    'constructor == constructor ? 1 : 0',
    '__proto__ == __proto__ ? 1 : 0',
    'prototype',
    'income.constructor',
    'income["constructor"]',
    'constructor(1)',
    'expenses_constructor()',
    'income = 1; income',
    'expenses_constructor = 1; expenses_constructor',
    'f(x)=x*2;f(savings)',
  ])('rejects inherited scope access: %s', (formula) => {
    expect(() => evaluateFormula(formula, data)).toThrow();
  });

  test('preserves identifiers without alias or prefix collisions', () => {
    const values = {
      ...data,
      byCategory: {
        prototype: 3,
        prototype2: 5,
        constructor: 7,
        constructor_1: 11,
        _fin0: 13,
      },
    };
    expect(
      evaluateFormula(
        'expenses_prototype + expenses_prototype2 + expenses_constructor + expenses_constructor_1 + expenses__fin0',
        values,
      ),
    ).toBe(39);
    expect(() =>
      evaluateFormula('expenses_prototype.constructor', values),
    ).toThrow();
    expect(() => evaluateFormula('_fin0', values)).toThrow();
  });

  test('does not accept objects or functions from analytics', () => {
    for (const value of [{ valueOf: () => 7 }, () => 7]) {
      const invalid = { ...data };
      Object.defineProperty(invalid, 'income', { value });
      expect(() => evaluateFormula('income', invalid)).toThrow();
    }
  });

  test.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects non-finite numeric input', (value) => {
    expect(() =>
      evaluateFormula('income > 0 ? 1 : 0', { ...data, income: value }),
    ).toThrow();
  });
});
