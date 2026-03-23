/**
 * Tests for currency-aware expression evaluator
 */
import { describe, expect, test } from 'bun:test';
import { evaluateCurrencyExpression } from './calculator';
import { convertCurrency } from './converter';

describe('evaluateCurrencyExpression', () => {
  // Pure math — no currency tokens
  test('100 - 70 → 30', () => expect(evaluateCurrencyExpression('100 - 70', 'USD')).toBe(30));
  test('100 + 50 → 150', () => expect(evaluateCurrencyExpression('100 + 50', 'USD')).toBe(150));
  test('10 * 3 → 30', () => expect(evaluateCurrencyExpression('10 * 3', 'USD')).toBe(30));
  test('100-70 → 30 (no spaces)', () =>
    expect(evaluateCurrencyExpression('100-70', 'USD')).toBe(30));

  // Same currency as target (identity conversion — result must be exact)
  test('100 USD - 30 USD in USD → 70', () =>
    expect(evaluateCurrencyExpression('100 USD - 30 USD', 'USD')).toBe(70));
  test('100$ - 30$ in USD → 70', () =>
    expect(evaluateCurrencyExpression('100$ - 30$', 'USD')).toBe(70));
  test('100€ + 50€ in EUR → 150', () =>
    expect(evaluateCurrencyExpression('100€ + 50€', 'EUR')).toBe(150));
  test('50 EUR + 30 EUR in EUR → 80', () =>
    expect(evaluateCurrencyExpression('50 EUR + 30 EUR', 'EUR')).toBe(80));

  // Cross-currency — use convertCurrency to derive expected (avoids hardcoding rates)
  test('100 USD - 70 EUR in USD', () => {
    const expected = 100 - convertCurrency(70, 'EUR', 'USD');
    expect(evaluateCurrencyExpression('100 USD - 70 EUR', 'USD')).toBeCloseTo(expected, 1);
  });
  test('$100 - 70EUR in USD (no spaces, mixed formats)', () => {
    const expected = 100 - convertCurrency(70, 'EUR', 'USD');
    expect(evaluateCurrencyExpression('$100-70EUR', 'USD')).toBeCloseTo(expected, 1);
  });
  test('100$-70eur compact (user-typed format)', () => {
    const expected = 100 - convertCurrency(70, 'EUR', 'USD');
    expect(evaluateCurrencyExpression('100$-70eur', 'USD')).toBeCloseTo(expected, 1);
  });
  test('1500 RSD + 10 EUR in EUR', () => {
    const expected = convertCurrency(1500, 'RSD', 'EUR') + 10;
    expect(evaluateCurrencyExpression('1500 RSD + 10 EUR', 'EUR')).toBeCloseTo(expected, 1);
  });

  // Single-char Russian aliases
  test('100е - 30д in EUR (Russian aliases)', () => {
    const expected = 100 - convertCurrency(30, 'USD', 'EUR');
    expect(evaluateCurrencyExpression('100е - 30д', 'EUR')).toBeCloseTo(expected, 1);
  });

  // Single currency amount = conversion (no operator needed)
  test('100$ in USD → 100 (identity)', () =>
    expect(evaluateCurrencyExpression('100$', 'USD')).toBe(100));
  test('70 EUR in USD → converted value', () => {
    const expected = convertCurrency(70, 'EUR', 'USD');
    expect(evaluateCurrencyExpression('70 EUR', 'USD')).toBeCloseTo(expected, 2);
  });
  test('1500 RSD in EUR → converted value', () => {
    const expected = convertCurrency(1500, 'RSD', 'EUR');
    expect(evaluateCurrencyExpression('1500 RSD', 'EUR')).toBeCloseTo(expected, 2);
  });
  test('100е in USD → converted from EUR', () => {
    const expected = convertCurrency(100, 'EUR', 'USD');
    expect(evaluateCurrencyExpression('100е', 'USD')).toBeCloseTo(expected, 2);
  });

  // Overflow guard — same threshold as evaluateMathExpression (>= 10_000_000)
  test('huge single amount → null', () =>
    expect(evaluateCurrencyExpression('99999999 USD', 'USD')).toBeNull());
  test('huge expression result → null', () =>
    expect(evaluateCurrencyExpression('9999999 + 1', 'USD')).toBeNull());

  // Percentage — subtract
  test('100 - 10% → 90', () => expect(evaluateCurrencyExpression('100 - 10%', 'USD')).toBe(90));
  test('200 - 25% → 150', () => expect(evaluateCurrencyExpression('200 - 25%', 'USD')).toBe(150));
  test('100$ - 7.5% in USD → 92.5', () =>
    expect(evaluateCurrencyExpression('100$ - 7.5%', 'USD')).toBeCloseTo(92.5, 2));

  // Percentage — add
  test('100 + 20% → 120', () => expect(evaluateCurrencyExpression('100 + 20%', 'USD')).toBe(120));
  test('500€ + 10% in EUR → 550', () =>
    expect(evaluateCurrencyExpression('500€ + 10%', 'EUR')).toBeCloseTo(550, 2));

  // Percentage — with expression base (split + discount)
  test('100 + 50 - 10% → 135 (percentage of combined total)', () =>
    expect(evaluateCurrencyExpression('100 + 50 - 10%', 'USD')).toBe(135));
  test('300 / 3 - 5% → 95 (split then discount)', () =>
    expect(evaluateCurrencyExpression('300 / 3 - 5%', 'USD')).toBe(95));

  // Percentage — with cross-currency base
  test('100$ + 50€ - 10% in USD', () => {
    const base = 100 + convertCurrency(50, 'EUR', 'USD');
    const expected = base - base * 0.1;
    expect(evaluateCurrencyExpression('100$ + 50€ - 10%', 'USD')).toBeCloseTo(expected, 1);
  });

  // Percentage — comma decimal
  test('100 - 7,5% → 92.5 (comma decimal)', () =>
    expect(evaluateCurrencyExpression('100 - 7,5%', 'USD')).toBeCloseTo(92.5, 2));

  // Percentage — edge cases
  test('100 - 0% → 100', () => expect(evaluateCurrencyExpression('100 - 0%', 'USD')).toBe(100));
  test('100 + 100% → 200', () => expect(evaluateCurrencyExpression('100 + 100%', 'USD')).toBe(200));
  test('100 - 100% → 0', () => expect(evaluateCurrencyExpression('100 - 100%', 'USD')).toBe(0));
  test('bare 50% → null (no base)', () =>
    expect(evaluateCurrencyExpression('50%', 'USD')).toBeNull());

  // Percentage — overflow guard
  test('9999999 + 50% → null (overflow)', () =>
    expect(evaluateCurrencyExpression('9999999 + 50%', 'USD')).toBeNull());

  // Edge cases
  test('empty string → null', () => expect(evaluateCurrencyExpression('', 'USD')).toBeNull());
  test('plain text → null', () =>
    expect(evaluateCurrencyExpression('hello world', 'USD')).toBeNull());
  test('single plain number → null (no currency, no operator)', () =>
    expect(evaluateCurrencyExpression('100', 'USD')).toBeNull());
});
