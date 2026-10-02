import { describe, expect, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import { evaluateFreshCurrencyExpression, evaluateWithRates } from './live-calculator';

const rates = {
  EUR: '1',
  USD: '1.2',
  RUB: '100',
  RSD: '120',
  GBP: '0.8',
  BYN: '3.5',
  CHF: '0.95',
  JPY: '160',
  CNY: '7.8',
  INR: '100',
  LKR: '350',
  AED: '4',
  EGP: '55',
} satisfies Record<CurrencyCode, string>;

describe('fresh exact currency calculator', () => {
  test.each([
    ['1500 RSD + 10 EUR', 'EUR', '22.5'],
    ['100$ - 10%', 'USD', '90'],
    ['100е + 30д', 'EUR', '125'],
    ['1 / 3 * 3', 'EUR', '1'],
  ] as const)('%s', (expression, target, expected) => {
    expect(evaluateWithRates(expression, target, rates).value).toBe(expected);
  });

  test('does not amplify intermediate division rounding', () => {
    const expression =
      '0.000000000000000001 EUR / 6000000000000000000000 * 6000000000000000000000 * 1000000000000000000';
    expect(evaluateWithRates(expression, 'EUR', rates).value).toBe('1');
  });

  test.each([
    '1 USD + 2',
    '1 USD * 1 EUR',
    '1 / 20 EUR',
    '100 USD trailing',
  ])('rejects invalid dimensions/syntax: %s', (expression) => {
    expect(() => evaluateWithRates(expression, 'EUR', rates)).toThrow();
  });
  test('same-currency and pure math need no HTTP rates', async () => {
    let calls = 0;
    const unavailable = async () => {
      calls++;
      throw new Error('offline');
    };
    expect(
      (await evaluateFreshCurrencyExpression('10 EUR + 20 EUR', 'EUR', unavailable)).value,
    ).toBe('30');
    expect((await evaluateFreshCurrencyExpression('10 * 3', 'EUR', unavailable)).value).toBe('30');
    expect(calls).toBe(0);
  });

  test('cross-currency returns explicit source/date metadata', async () => {
    const result = await evaluateFreshCurrencyExpression('120 RSD + 1 EUR', 'EUR', async () => ({
      rates,
      asOf: '2026-09-13T00:00:00.000Z',
      source: 'https://www.exchangerate-api.com',
    }));
    expect(result.value).toBe('2');
    expect(result.rateAsOf).toBe('2026-09-13T00:00:00.000Z');
    expect(result.rateSource).toContain('exchangerate-api.com');
  });

  test('invalid units are rejected before any rate fetch', async () => {
    let calls = 0;
    await expect(
      evaluateFreshCurrencyExpression('1 USD + 2', 'EUR', async () => {
        calls++;
        return { rates, asOf: 'x', source: 'x' };
      }),
    ).rejects.toThrow('MIXED_UNLABELLED_UNITS');
    expect(calls).toBe(0);
  });
});
