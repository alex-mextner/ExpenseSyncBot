/** Currency support contract across text expenses, budget input, arithmetic, and formatting. */
import { describe, expect, test } from 'bun:test';
import { type CurrencyCode, getCurrencySymbol, isSupportedCurrency } from '../../config/constants';
import { parseBudgetInputAmount } from './budget-amount-parser';
import { evaluateCurrencyExpression } from './calculator';
import { convertCurrency, formatAmount, getAllExchangeRates } from './converter';
import { parseExpenseMessage } from './parser';

const variants: [string, CurrencyCode][] = [
  ['GEL', 'GEL'],
  ['gel', 'GEL'],
  ['GeL', 'GEL'],
  ['₾', 'GEL'],
  ['лари', 'GEL'],
  ['грузинских лари', 'GEL'],
  ['georgian lari', 'GEL'],
  ['lari', 'GEL'],
  ['laris', 'GEL'],
  ['ლარი', 'GEL'],
  ['ქართული ლარი', 'GEL'],
  ['OMR', 'OMR'],
  ['omr', 'OMR'],
  ['OmR', 'OMR'],
  ['RO', 'OMR'],
  ['R.O.', 'OMR'],
  ['р.о.', 'OMR'],
  ['оманский риал', 'OMR'],
  ['оманских риалов', 'OMR'],
  ['риала омана', 'OMR'],
  ['omani rial', 'OMR'],
  ['omani rials', 'OMR'],
  ['rial omani', 'OMR'],
  ['omani riyals', 'OMR'],
  ['ر.ع.', 'OMR'],
  ['ر.ع.\u200f', 'OMR'],
  ['ريال عماني', 'OMR'],
  ['الريال العماني', 'OMR'],
  ['ريالات عمانية', 'OMR'],
  ['\u20c4', 'OMR'],
  ['THB', 'THB'],
  ['thb', 'THB'],
  ['ThB', 'THB'],
  ['฿', 'THB'],
  ['бат', 'THB'],
  ['бата', 'THB'],
  ['батов', 'THB'],
  ['батами', 'THB'],
  ['тайских батов', 'THB'],
  ['таиландский бат', 'THB'],
  ['тайландских батов', 'THB'],
  ['baht', 'THB'],
  ['bahts', 'THB'],
  ['thai baht', 'THB'],
  ['บาท', 'THB'],
  ['บาทไทย', 'THB'],
  ['MYR', 'MYR'],
  ['myr', 'MYR'],
  ['MyR', 'MYR'],
  ['RM', 'MYR'],
  ['ринггит', 'MYR'],
  ['ринггитов', 'MYR'],
  ['рингит', 'MYR'],
  ['малайзийских ринггитов', 'MYR'],
  ['ringgit', 'MYR'],
  ['ringgits', 'MYR'],
  ['malaysian ringgit', 'MYR'],
  ['ringgit malaysia', 'MYR'],
  ['KHR', 'KHR'],
  ['khr', 'KHR'],
  ['KhR', 'KHR'],
  ['៛', 'KHR'],
  ['риель', 'KHR'],
  ['риелей', 'KHR'],
  ['камбоджийских риелей', 'KHR'],
  ['riel', 'KHR'],
  ['riels', 'KHR'],
  ['cambodian riel', 'KHR'],
  ['រៀល', 'KHR'],
  ['TRY', 'TRY'],
  ['try', 'TRY'],
  ['TrY', 'TRY'],
  ['₺', 'TRY'],
  ['TL', 'TRY'],
  ['лира', 'TRY'],
  ['лир', 'TRY'],
  ['турецких лир', 'TRY'],
  ['turkish lira', 'TRY'],
  ['türk lirası', 'TRY'],
  ['Türk Lirası', 'TRY'],
  ['TÜRK LİRASI', 'TRY'],
  ['turk lirasi', 'TRY'],
];

describe('travel currencies in every amount parser', () => {
  test.each(variants)('accepts %s before and after an expense amount', (alias, code) => {
    for (const input of [
      `12.34 ${alias} food lunch`,
      `${alias} 12.34 food lunch`,
      `12.34${alias} food lunch`,
      `${alias}12.34 food lunch`,
    ]) {
      expect(parseExpenseMessage(input, 'EUR')).toMatchObject({
        amount: 12.34,
        currency: code,
        category: 'Food',
        comment: 'Lunch',
      });
    }
  });

  test.each(variants)('accepts %s in a lone budget amount', (alias, code) => {
    expect(parseBudgetInputAmount(`12.34 ${alias}`)).toEqual({ amount: 12.34, currency: code });
    expect(parseBudgetInputAmount(`${alias}12.34`)).toEqual({ amount: 12.34, currency: code });
  });

  test.each(variants)('accepts %s in currency arithmetic', (alias, code) => {
    const result = evaluateCurrencyExpression(`1.25 ${alias} + ${alias} 2.50`, code);
    expect(result?.value.toString()).toBe('3.75');
    expect(result?.hasCurrency).toBe(true);
  });

  test.each([
    'GEL',
    'OMR',
    'THB',
    'MYR',
    'KHR',
    'TRY',
  ] as const)('has metadata and positive fallback rates for %s', (code) => {
    expect(isSupportedCurrency(code)).toBe(true);
    expect(getAllExchangeRates()[code]).toBeGreaterThan(0);
    expect(getCurrencySymbol(code)).toBe(
      { GEL: '₾', OMR: 'OMR', THB: '฿', MYR: 'RM', KHR: '៛', TRY: '₺' }[code],
    );
  });

  test.each([
    'gelatin',
    'ringgitfoo',
    'RMX',
    'риелтор',
    'lirafoo',
    'tldr',
    'батон',
    'bath',
    'bat',
    'rial',
    'riyal',
    'риал',
    'риял',
    'ريال',
    'SAR',
    'QAR',
    'IRR',
  ])('does not mistake %s for a supported new currency', (word) => {
    expect(parseExpenseMessage(`100 ${word} lunch`, 'EUR')?.currency).toBe('EUR');
    expect(parseBudgetInputAmount(`100 ${word}`)).toBeNull();
    expect(evaluateCurrencyExpression(`100 ${word}`, 'EUR')).toBeNull();
  });

  test.each([
    ['1\u00a0234,56 RM', 'MYR'],
    ['RM1 234.56', 'MYR'],
    ['1 234,56៛', 'KHR'],
    ['រៀល1\u00a0234.56', 'KHR'],
    ['₺1 234,56', 'TRY'],
    ['1\u00a0234.56 TL', 'TRY'],
  ] as const)('accepts grouped amounts in %s', (input, currency) => {
    expect(parseExpenseMessage(`${input} food lunch`, 'EUR')).toMatchObject({
      amount: 1234.56,
      currency,
      category: 'Food',
      comment: 'Lunch',
    });
    expect(parseBudgetInputAmount(input)).toEqual({ amount: 1234.56, currency });
  });

  test('keeps lira, pound, riel and Omani rial distinct', () => {
    for (const [alias, currency] of [
      ['₺', 'TRY'],
      ['£', 'GBP'],
      ['риель', 'KHR'],
      ['оманский риал', 'OMR'],
    ] as const) {
      expect(parseExpenseMessage(`10 ${alias} food`, 'EUR')?.currency).toBe(currency);
    }
    expect(parseBudgetInputAmount('10 ₤')).toBeNull();
    expect(parseBudgetInputAmount('10 TRL')).toBeNull();
    expect(parseBudgetInputAmount('10 YTL')).toBeNull();
  });

  test('does not recognize the Bitcoin sign as baht', () => {
    expect(parseExpenseMessage('₿100 food', 'EUR')).toBeNull();
    expect(parseBudgetInputAmount('₿100')).toBeNull();
  });
});

describe('Omani rial minor units', () => {
  test.each([
    '0.001 OMR fee',
    'OMR0.001 fee',
    '0,001 omr fee',
    '0.001+0.001 OMR fee',
    '1\u00a0234,567 OMR fee',
  ])('preserves the third decimal in %s', (input) => {
    const expected = input.includes('+') ? 0.002 : input.includes('234') ? 1234.567 : 0.001;
    expect(parseExpenseMessage(input, 'EUR')).toMatchObject({ amount: expected, currency: 'OMR' });
  });
  test('preserves precision when OMR is the default', () => {
    expect(parseExpenseMessage('0.001 fee', 'OMR')?.amount).toBe(0.001);
  });
  test('preserves budget milli-rials', () => {
    expect(parseBudgetInputAmount('1,234 OMR')).toEqual({ amount: 1.234, currency: 'OMR' });
    expect(parseBudgetInputAmount('OMR0.001')).toEqual({ amount: 0.001, currency: 'OMR' });
  });
  test('formats ordinary amounts and AI context to three places', () => {
    expect(formatAmount(1.234, 'OMR')).toBe('1.234 OMR');
    expect(formatAmount(0.001, 'OMR', true)).toBe('0.001 OMR');
    expect(formatAmount(1.234, 'GEL')).toBe('1.23 ₾');
    expect(formatAmount(1.234, 'THB')).toBe('1.23 ฿');
    expect(formatAmount(1.234, 'MYR')).toBe('1.23 RM');
    expect(formatAmount(1.234, 'KHR')).toBe('1.23 ៛');
    expect(formatAmount(1.234, 'TRY')).toBe('1.23 ₺');
  });
  test('rounds conversions to the target currency precision', () => {
    const rates = getAllExchangeRates();
    expect(convertCurrency(1, 'EUR', 'OMR')).toBe(Math.round(1000 / rates.OMR) / 1000);
  });
});
