/** Currency invention guard recognizes travel aliases without matching words or unbounded digits. */
import { describe, expect, test } from 'bun:test';
import { amountCurrencies } from './agent-helpers';

describe('amountCurrencies travel aliases', () => {
  test.each([
    ['MYR', 'MYR'],
    ['myr', 'MYR'],
    ['RM', 'MYR'],
    ['rm', 'MYR'],
    ['ringgit malaysia', 'MYR'],
    ['ринггитов', 'MYR'],
    ['KHR', 'KHR'],
    ['៛', 'KHR'],
    ['риелей', 'KHR'],
    ['រៀល', 'KHR'],
    ['TRY', 'TRY'],
    ['try', 'TRY'],
    ['TL', 'TRY'],
    ['₺', 'TRY'],
    ['турецких лир', 'TRY'],
    ['TÜRK LİRASI', 'TRY'],
    ['GEL', 'GEL'],
    ['₾', 'GEL'],
    ['ქართული ლარი', 'GEL'],
    ['OMR', 'OMR'],
    ['RO', 'OMR'],
    ['R.O.', 'OMR'],
    ['ر.ع.\u200f', 'OMR'],
    ['THB', 'THB'],
    ['฿', 'THB'],
    ['บาท', 'THB'],
    ['USD', 'USD'],
    ['$', 'USD'],
    ['EUR', 'EUR'],
    ['€', 'EUR'],
    ['RSD', 'RSD'],
    ['£', 'GBP'],
  ])('spots %s next to an amount on either side', (alias, code) => {
    expect(amountCurrencies(`${alias}12.34; 12.34 ${alias}; ${alias} −12`)).toEqual([code]);
  });

  test.each([
    'farm',
    'tryhard',
    'RMX',
    'KHRx',
    'риелтор',
    'рингитон',
    'TLD',
    'TRL',
    'YTL',
    '₤',
  ])('does not invent a currency from %s', (word) => {
    expect(amountCurrencies(`12 ${word}; ${word}12`)).toEqual([]);
  });

  test('does not count currency names without adjacent amounts', () => {
    expect(amountCurrencies('MYR and KHR; TL, RM, ៛ and ₺; 12 ordinary words')).toEqual([]);
  });

  test('keeps USD, KHR, MYR, TRY and GBP distinct in one response', () => {
    expect(amountCurrencies('$12, 10៛, RM4, ₺50, £3, 2omr')).toEqual([
      'USD',
      'KHR',
      'MYR',
      'TRY',
      'GBP',
      'OMR',
    ]);
  });

  test('scans a long digit run without consuming the whole number at every position', () => {
    expect(amountCurrencies(`${'1'.repeat(100_000)} RM`)).toEqual(['MYR']);
  });
});
