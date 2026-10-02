// Tests for the strict plain-amount parser used by the budget prompt text/reply flow

import { describe, expect, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import { parseBudgetInputAmount } from './budget-amount-parser';

describe('parseBudgetInputAmount', () => {
  test.each<[string, number, CurrencyCode | null]>([
    ['150', 150, null],
    ['150 eur', 150, 'EUR'],
    ['150 EUR', 150, 'EUR'],
    ['1 500 RSD', 1500, 'RSD'],
    ['1500.50', 1500.5, null],
    ['1500,5', 1500.5, null],
    ['$150', 150, 'USD'],
    ['150$', 150, 'USD'],
    ['€ 99', 99, 'EUR'],
    ['2000 руб', 2000, 'RUB'],
    ['  150  ', 150, null],
  ])('accepts %p', (input, amount, currency) => {
    expect(parseBudgetInputAmount(input)).toEqual({ amount, currency });
  });

  test.each([
    '',
    'hello',
    '150 food',
    '150 еда продукты',
    'budget 150',
    '0',
    '-5',
    '150 eur usd',
    '$150 eur',
    '12abc',
    '1.2.3',
    '99999999999999',
    '150\n200',
  ])('rejects %p', (input) => {
    expect(parseBudgetInputAmount(input)).toBeNull();
  });
});
