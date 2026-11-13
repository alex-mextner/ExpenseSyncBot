/** Native OMR totals and foreign subtotal conversion must retain one-baisa amounts. */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as converter from './converter';
import { expenseAmountInCurrency, sumExpensesInCurrency } from './totals';

const convertSpy = spyOn(converter, 'convertCurrency');

beforeEach(() => {
  convertSpy.mockImplementation((amount) => amount * 2);
});
afterEach(() => convertSpy.mockClear());
afterAll(() => convertSpy.mockRestore());

describe('original-currency OMR totals', () => {
  test('keeps native milli-rials even when stored EUR rounded to zero', () => {
    const fee = { amount: 0.001, currency: 'OMR' as const, eur_amount: 0 };
    const expenses: Parameters<typeof sumExpensesInCurrency>[0] = [
      fee,
      { amount: 1.234, currency: 'OMR', eur_amount: 2.86 },
    ];
    expect(sumExpensesInCurrency(expenses, 'OMR')).toBe(1.235);
    expect(expenseAmountInCurrency(fee, 'OMR')).toBe(0.001);
    expect(convertSpy).not.toHaveBeenCalled();
  });

  test('converts the foreign EUR subtotal once before adding native OMR', () => {
    const expenses: Parameters<typeof sumExpensesInCurrency>[0] = [
      { amount: 0.001, currency: 'OMR', eur_amount: 0 },
      { amount: 0.01, currency: 'EUR', eur_amount: 0.01 },
      { amount: 0.4, currency: 'THB', eur_amount: 0.01 },
    ];
    expect(sumExpensesInCurrency(expenses, 'OMR')).toBe(0.041);
    expect(convertSpy).toHaveBeenCalledTimes(1);
    expect(convertSpy).toHaveBeenCalledWith(0.02, 'EUR', 'OMR');
  });

  test('retains stored-EUR normalization for other display currencies', () => {
    expect(
      sumExpensesInCurrency([{ amount: 1.234, currency: 'OMR', eur_amount: 2.86 }], 'GEL'),
    ).toBe(5.72);
    expect(convertSpy).toHaveBeenCalledWith(2.86, 'EUR', 'GEL');
  });
});

describe('native travel-currency totals', () => {
  test('keeps KHR units lost by EUR-cent normalization', () => {
    const fee = { amount: 1, currency: 'KHR' as const, eur_amount: 0 };
    const expenses: Parameters<typeof sumExpensesInCurrency>[0] = [
      fee,
      { amount: 1000, currency: 'KHR', eur_amount: 0.22 },
    ];
    expect(sumExpensesInCurrency(expenses, 'KHR')).toBe(1001);
    expect(expenseAmountInCurrency(fee, 'KHR')).toBe(1);
    expect(convertSpy).not.toHaveBeenCalled();
  });

  test.each([
    'GEL',
    'THB',
    'MYR',
    'KHR',
    'TRY',
  ] as const)('keeps %s native fractions and converts only foreign subtotal', (currency) => {
    const expenses: Parameters<typeof sumExpensesInCurrency>[0] = [
      { amount: 1.21, currency, eur_amount: 0 },
      { amount: 2.34, currency, eur_amount: 0.01 },
      { amount: 0.01, currency: 'EUR', eur_amount: 0.01 },
      { amount: 100, currency: 'USD', eur_amount: 0.01 },
    ];
    expect(sumExpensesInCurrency(expenses, currency)).toBe(3.59);
    expect(convertSpy).toHaveBeenCalledTimes(1);
    expect(convertSpy).toHaveBeenCalledWith(0.02, 'EUR', currency);
  });
});
