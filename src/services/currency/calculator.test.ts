/**
 * Tests for currency-aware expression evaluator
 */
import { describe, expect, test } from 'bun:test';
import { evaluateCurrencyExpression } from './calculator';
import { convertCurrency } from './converter';

describe('evaluateCurrencyExpression', () => {
  // Pure math — no currency tokens
  test('100 - 70 → {value: 30, hasCurrency: false}', () => {
    const r = evaluateCurrencyExpression('100 - 70', 'USD');
    expect(r).not.toBeNull();
    expect(r?.value).toBe(30);
    expect(r?.hasCurrency).toBe(false);
  });
  test('100 + 50 → 150', () => {
    const r = evaluateCurrencyExpression('100 + 50', 'USD');
    expect(r?.value).toBe(150);
    expect(r?.hasCurrency).toBe(false);
  });
  test('10 * 3 → 30', () => {
    const r = evaluateCurrencyExpression('10 * 3', 'USD');
    expect(r?.value).toBe(30);
    expect(r?.hasCurrency).toBe(false);
  });
  test('100-70 → 30 (no spaces)', () => {
    const r = evaluateCurrencyExpression('100-70', 'USD');
    expect(r?.value).toBe(30);
    expect(r?.hasCurrency).toBe(false);
  });
  test('pure math division: 300 / 4 → 75', () => {
    const r = evaluateCurrencyExpression('300 / 4', 'EUR');
    expect(r?.value).toBe(75);
    expect(r?.hasCurrency).toBe(false);
  });

  // Same currency as target (identity conversion — result must be exact)
  test('100 USD - 30 USD in USD → 70', () => {
    const r = evaluateCurrencyExpression('100 USD - 30 USD', 'USD');
    expect(r?.value).toBe(70);
    expect(r?.hasCurrency).toBe(true);
  });
  test('100$ - 30$ in USD → 70', () => {
    const r = evaluateCurrencyExpression('100$ - 30$', 'USD');
    expect(r?.value).toBe(70);
    expect(r?.hasCurrency).toBe(true);
  });
  test('100€ + 50€ in EUR → 150', () => {
    const r = evaluateCurrencyExpression('100€ + 50€', 'EUR');
    expect(r?.value).toBe(150);
    expect(r?.hasCurrency).toBe(true);
  });
  test('50 EUR + 30 EUR in EUR → 80', () => {
    const r = evaluateCurrencyExpression('50 EUR + 30 EUR', 'EUR');
    expect(r?.value).toBe(80);
    expect(r?.hasCurrency).toBe(true);
  });

  // Cross-currency — use convertCurrency to derive expected (avoids hardcoding rates)
  test('100 USD - 70 EUR in USD', () => {
    const expected = 100 - convertCurrency(70, 'EUR', 'USD');
    const r = evaluateCurrencyExpression('100 USD - 70 EUR', 'USD');
    expect(r?.value).toBeCloseTo(expected, 1);
    expect(r?.hasCurrency).toBe(true);
  });
  test('$100 - 70EUR in USD (no spaces, mixed formats)', () => {
    const expected = 100 - convertCurrency(70, 'EUR', 'USD');
    const r = evaluateCurrencyExpression('$100-70EUR', 'USD');
    expect(r?.value).toBeCloseTo(expected, 1);
    expect(r?.hasCurrency).toBe(true);
  });
  test('100$-70eur compact (user-typed format)', () => {
    const expected = 100 - convertCurrency(70, 'EUR', 'USD');
    const r = evaluateCurrencyExpression('100$-70eur', 'USD');
    expect(r?.value).toBeCloseTo(expected, 1);
    expect(r?.hasCurrency).toBe(true);
  });
  test('1500 RSD + 10 EUR in EUR', () => {
    const expected = convertCurrency(1500, 'RSD', 'EUR') + 10;
    const r = evaluateCurrencyExpression('1500 RSD + 10 EUR', 'EUR');
    expect(r?.value).toBeCloseTo(expected, 1);
    expect(r?.hasCurrency).toBe(true);
  });

  // Single-char Russian aliases
  test('100е - 30д in EUR (Russian aliases)', () => {
    const expected = 100 - convertCurrency(30, 'USD', 'EUR');
    const r = evaluateCurrencyExpression('100е - 30д', 'EUR');
    expect(r?.value).toBeCloseTo(expected, 1);
    expect(r?.hasCurrency).toBe(true);
  });

  // Single currency amount = conversion (no operator needed)
  test('100$ in USD → 100 (identity)', () => {
    const r = evaluateCurrencyExpression('100$', 'USD');
    expect(r?.value).toBe(100);
    expect(r?.hasCurrency).toBe(true);
  });
  test('70 EUR in USD → converted value', () => {
    const expected = convertCurrency(70, 'EUR', 'USD');
    const r = evaluateCurrencyExpression('70 EUR', 'USD');
    expect(r?.value).toBeCloseTo(expected, 2);
    expect(r?.hasCurrency).toBe(true);
  });
  test('1500 RSD in EUR → converted value', () => {
    const expected = convertCurrency(1500, 'RSD', 'EUR');
    const r = evaluateCurrencyExpression('1500 RSD', 'EUR');
    expect(r?.value).toBeCloseTo(expected, 2);
    expect(r?.hasCurrency).toBe(true);
  });
  test('100е in USD → converted from EUR', () => {
    const expected = convertCurrency(100, 'EUR', 'USD');
    const r = evaluateCurrencyExpression('100е', 'USD');
    expect(r?.value).toBeCloseTo(expected, 2);
    expect(r?.hasCurrency).toBe(true);
  });

  // Large numbers — no upper limit, single-currency conversion still works
  test('large single currency amount → converted, not null', () => {
    const r = evaluateCurrencyExpression('99999999 USD', 'USD');
    expect(r?.value).toBeCloseTo(99999999, 0);
    expect(r?.hasCurrency).toBe(true);
  });
  test('large pure math → number, not null', () => {
    const r = evaluateCurrencyExpression('63000000 / 0.5', 'EUR');
    expect(r?.value).toBeCloseTo(126000000, 0);
    expect(r?.hasCurrency).toBe(false);
  });
  test('large expression result → number, not null', () => {
    const r = evaluateCurrencyExpression('9999999 + 1', 'USD');
    expect(r?.value).toBe(10000000);
    expect(r?.hasCurrency).toBe(false);
  });

  // Percentage — subtract
  test('100 - 10% → 90', () => {
    const r = evaluateCurrencyExpression('100 - 10%', 'USD');
    expect(r?.value).toBe(90);
  });
  test('200 - 25% → 150', () => {
    const r = evaluateCurrencyExpression('200 - 25%', 'USD');
    expect(r?.value).toBe(150);
  });
  test('100$ - 7.5% in USD → 92.5', () => {
    const r = evaluateCurrencyExpression('100$ - 7.5%', 'USD');
    expect(r?.value).toBeCloseTo(92.5, 2);
    expect(r?.hasCurrency).toBe(true);
  });

  // Percentage — add
  test('100 + 20% → 120', () => {
    const r = evaluateCurrencyExpression('100 + 20%', 'USD');
    expect(r?.value).toBe(120);
  });
  test('500€ + 10% in EUR → 550', () => {
    const r = evaluateCurrencyExpression('500€ + 10%', 'EUR');
    expect(r?.value).toBeCloseTo(550, 2);
    expect(r?.hasCurrency).toBe(true);
  });

  // Percentage — with expression base (split + discount)
  test('100 + 50 - 10% → 135 (percentage of combined total)', () => {
    const r = evaluateCurrencyExpression('100 + 50 - 10%', 'USD');
    expect(r?.value).toBe(135);
  });
  test('300 / 3 - 5% → 95 (split then discount)', () => {
    const r = evaluateCurrencyExpression('300 / 3 - 5%', 'USD');
    expect(r?.value).toBe(95);
  });

  // Percentage — with cross-currency base
  test('100$ + 50€ - 10% in USD', () => {
    const base = 100 + convertCurrency(50, 'EUR', 'USD');
    const expected = base - base * 0.1;
    const r = evaluateCurrencyExpression('100$ + 50€ - 10%', 'USD');
    expect(r?.value).toBeCloseTo(expected, 1);
    expect(r?.hasCurrency).toBe(true);
  });

  // Percentage — comma decimal
  test('100 - 7,5% → 92.5 (comma decimal)', () => {
    const r = evaluateCurrencyExpression('100 - 7,5%', 'USD');
    expect(r?.value).toBeCloseTo(92.5, 2);
  });

  // Percentage — edge cases
  test('100 - 0% → 100', () => {
    const r = evaluateCurrencyExpression('100 - 0%', 'USD');
    expect(r?.value).toBe(100);
  });
  test('100 + 100% → 200', () => {
    const r = evaluateCurrencyExpression('100 + 100%', 'USD');
    expect(r?.value).toBe(200);
  });
  test('100 - 100% → 0', () => {
    const r = evaluateCurrencyExpression('100 - 100%', 'USD');
    expect(r?.value).toBe(0);
  });
  test('bare 50% → null (no base)', () =>
    expect(evaluateCurrencyExpression('50%', 'USD')).toBeNull());

  // Percentage — large base is allowed
  test('9999999 + 50% → 14999998.5 (no overflow limit)', () => {
    const r = evaluateCurrencyExpression('9999999 + 50%', 'USD');
    expect(r?.value).toBeCloseTo(14999998.5, 1);
  });

  // Edge cases
  test('empty string → null', () => expect(evaluateCurrencyExpression('', 'USD')).toBeNull());
  test('plain text → null', () =>
    expect(evaluateCurrencyExpression('hello world', 'USD')).toBeNull());
  test('single plain number → null (no currency, no operator)', () =>
    expect(evaluateCurrencyExpression('100', 'USD')).toBeNull());
});
