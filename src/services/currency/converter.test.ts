// Tests for currency conversion logic

import { describe, expect, it } from 'bun:test';
import Big from 'big.js';
import {
  convertCurrency,
  convertCurrencyBig,
  convertToEUR,
  formatAmount,
  formatExchangeRatesForAI,
  getAllExchangeRates,
  getExchangeRate,
} from './converter';

describe('convertToEUR', () => {
  it('returns same amount for EUR', () => {
    expect(convertToEUR(100, 'EUR')).toBe(100);
  });

  it('converts USD to EUR using fallback rate', () => {
    // 1 USD = 0.93 EUR
    expect(convertToEUR(100, 'USD')).toBe(93);
  });

  it('converts GBP to EUR', () => {
    // 1 GBP = 1.18 EUR
    expect(convertToEUR(10, 'GBP')).toBe(11.8);
  });

  it('converts RSD to EUR (small rate)', () => {
    // 1 RSD = 0.0086 EUR → 1000 RSD = 8.6 EUR
    expect(convertToEUR(1000, 'RSD')).toBe(8.6);
  });

  it('converts JPY to EUR (very small rate)', () => {
    // 1 JPY = 0.0062 EUR → 10000 JPY = 62 EUR
    expect(convertToEUR(10000, 'JPY')).toBe(62);
  });

  it('rounds to 2 decimal places', () => {
    const result = convertToEUR(7, 'RUB');
    expect(Number(result.toFixed(2))).toBe(result);
  });

  it('handles zero amount', () => {
    expect(convertToEUR(0, 'USD')).toBe(0);
  });

  it('handles large amounts', () => {
    expect(convertToEUR(1_000_000, 'EUR')).toBe(1_000_000);
  });

  it('handles negative amounts', () => {
    expect(convertToEUR(-100, 'USD')).toBe(-93);
  });

  it('converts CHF to EUR', () => {
    // 1 CHF = 1.05 EUR
    expect(convertToEUR(100, 'CHF')).toBe(105);
  });

  it('converts BYN to EUR', () => {
    // 1 BYN = 0.28 EUR
    expect(convertToEUR(100, 'BYN')).toBe(28);
  });

  it('converts CNY to EUR', () => {
    // 1 CNY = 0.13 EUR
    expect(convertToEUR(100, 'CNY')).toBe(13);
  });

  it('converts INR to EUR', () => {
    // 1 INR = 0.011 EUR
    expect(convertToEUR(100, 'INR')).toBe(1.1);
  });

  it('converts LKR to EUR', () => {
    // 1 LKR = 0.0028 EUR
    expect(convertToEUR(1000, 'LKR')).toBe(2.8);
  });

  it('converts AED to EUR', () => {
    // 1 AED = 0.25 EUR
    expect(convertToEUR(100, 'AED')).toBe(25);
  });

  it('converts RUB to EUR', () => {
    // 1 RUB = 0.0093 EUR
    expect(convertToEUR(1000, 'RUB')).toBe(9.3);
  });

  // All 11 non-EUR currencies return positive for positive input
  const currencies = [
    'USD',
    'RUB',
    'RSD',
    'GBP',
    'BYN',
    'CHF',
    'JPY',
    'CNY',
    'INR',
    'LKR',
    'AED',
  ] as const;
  for (const currency of currencies) {
    it(`converts ${currency} to EUR (result is positive for positive input)`, () => {
      expect(convertToEUR(100, currency)).toBeGreaterThan(0);
    });
  }

  it('EUR 0 stays 0', () => {
    expect(convertToEUR(0, 'EUR')).toBe(0);
  });

  it('EUR 1 stays 1', () => {
    expect(convertToEUR(1, 'EUR')).toBe(1);
  });

  it('fractional amounts round correctly', () => {
    const result = convertToEUR(0.01, 'USD');
    expect(Number(result.toFixed(2))).toBe(result);
  });
});

describe('convertCurrency', () => {
  it('returns same amount when currencies are equal', () => {
    expect(convertCurrency(100, 'USD', 'USD')).toBe(100);
  });

  it('returns same amount when both EUR', () => {
    expect(convertCurrency(100, 'EUR', 'EUR')).toBe(100);
  });

  it('converts USD to GBP via EUR', () => {
    // USD→EUR: 100 * 0.93 = 93 EUR
    // EUR→GBP: 93 / 1.18 ≈ 78.81 GBP
    const result = convertCurrency(100, 'USD', 'GBP');
    expect(result).toBeCloseTo(78.81, 1);
  });

  it('converts EUR to USD', () => {
    // rate[USD]=0.93 → 1 EUR = 1/0.93 USD > 1
    const result = convertCurrency(100, 'EUR', 'USD');
    expect(result).toBeGreaterThan(100); // USD is weaker than EUR
  });

  it('handles zero', () => {
    expect(convertCurrency(0, 'USD', 'GBP')).toBe(0);
  });

  it('round-trip EUR→USD→EUR is approximately equal', () => {
    const eur = 100;
    const usd = convertCurrency(eur, 'EUR', 'USD');
    const backToEur = convertCurrency(usd, 'USD', 'EUR');
    expect(backToEur).toBeCloseTo(eur, 0);
  });

  it('is symmetric: A→B then B→A ≈ original', () => {
    const original = 500;
    const toGBP = convertCurrency(original, 'RSD', 'GBP');
    const back = convertCurrency(toGBP, 'GBP', 'RSD');
    expect(back).toBeCloseTo(original, -1);
  });

  it('converts RUB to RSD (both small currencies)', () => {
    const result = convertCurrency(1000, 'RUB', 'RSD');
    expect(result).toBeGreaterThan(0);
  });

  it('rounds result to 2 decimal places', () => {
    const result = convertCurrency(1, 'JPY', 'INR');
    expect(Number(result.toFixed(2))).toBe(result);
  });

  it('converts GBP to EUR (GBP is stronger)', () => {
    // 1 GBP = 1.18 EUR → 100 GBP > 100 EUR
    const result = convertCurrency(100, 'GBP', 'EUR');
    expect(result).toBeGreaterThan(100);
  });

  it('converts EUR to RUB (RUB is weak)', () => {
    // 1 EUR ≈ 108 RUB
    const result = convertCurrency(1, 'EUR', 'RUB');
    expect(result).toBeGreaterThan(50);
  });

  it('converts between two small currencies correctly', () => {
    const result = convertCurrency(100, 'JPY', 'INR');
    expect(result).toBeGreaterThan(0);
  });

  it('large amount converts proportionally', () => {
    const small = convertCurrency(100, 'USD', 'EUR');
    const large = convertCurrency(1000, 'USD', 'EUR');
    expect(large).toBeCloseTo(small * 10, 1);
  });
});

describe('getExchangeRate', () => {
  it('returns 1.0 for EUR', () => {
    expect(getExchangeRate('EUR')).toBe(1.0);
  });

  it('returns 0.93 for USD (fallback rate)', () => {
    expect(getExchangeRate('USD')).toBe(0.93);
  });

  it('returns 1.18 for GBP', () => {
    expect(getExchangeRate('GBP')).toBe(1.18);
  });

  it('returns 0.0086 for RSD', () => {
    expect(getExchangeRate('RSD')).toBe(0.0086);
  });

  it('returns 0.0093 for RUB', () => {
    expect(getExchangeRate('RUB')).toBe(0.0093);
  });

  it('returns rate for all supported currencies', () => {
    const currencies = [
      'USD',
      'RUB',
      'RSD',
      'GBP',
      'BYN',
      'CHF',
      'JPY',
      'CNY',
      'INR',
      'LKR',
      'AED',
      'EUR',
    ] as const;
    for (const c of currencies) {
      expect(getExchangeRate(c)).toBeGreaterThan(0);
    }
  });

  it('returns a number', () => {
    expect(typeof getExchangeRate('CHF')).toBe('number');
  });
});

describe('formatAmount', () => {
  it('returns a non-empty string', () => {
    expect(formatAmount(100, 'USD').length).toBeGreaterThan(0);
  });

  it('includes the currency code for USD', () => {
    expect(formatAmount(100, 'USD')).toContain('USD');
  });

  it('includes the currency code for EUR', () => {
    expect(formatAmount(50, 'EUR')).toContain('EUR');
  });

  it('includes the numeric value', () => {
    expect(formatAmount(100, 'USD')).toContain('100');
  });

  it('includes fractional value', () => {
    expect(formatAmount(0.05, 'EUR')).toContain('0.05');
  });

  it('handles zero', () => {
    expect(formatAmount(0, 'USD')).toContain('0');
  });

  it('handles negative amounts', () => {
    const result = formatAmount(-50.5, 'GBP');
    expect(result).toContain('50');
    expect(result).toContain('GBP');
  });

  it('formats as "amount.xx CURRENCY"', () => {
    expect(formatAmount(100, 'USD')).toBe('100.00 USD');
  });

  it('formats decimal correctly', () => {
    expect(formatAmount(50.5, 'EUR')).toBe('50.50 EUR');
  });

  it('formats small decimal', () => {
    expect(formatAmount(0.01, 'RUB')).toBe('0.01 RUB');
  });

  it('formats 1M with млн suffix', () => {
    expect(formatAmount(1_000_000, 'RSD')).toBe('1 млн RSD');
  });

  it('formats 1.5M with млн suffix', () => {
    expect(formatAmount(1_500_000, 'RSD')).toBe('1.5 млн RSD');
  });

  it('formats 1.23M with млн suffix (2 decimal places)', () => {
    expect(formatAmount(1_234_567, 'EUR')).toBe('1.23 млн EUR');
  });

  it('formats 2M exactly as "2 млн" (no trailing zeros)', () => {
    expect(formatAmount(2_000_000, 'USD')).toBe('2 млн USD');
  });

  it('formats 1B with млрд suffix', () => {
    expect(formatAmount(1_000_000_000, 'RUB')).toBe('1 млрд RUB');
  });

  it('formats 2.5B with млрд suffix', () => {
    expect(formatAmount(2_500_000_000, 'EUR')).toBe('2.5 млрд EUR');
  });
});

describe('formatAmount (aiContext=true)', () => {
  it('small amount: exact decimal with currency', () => {
    expect(formatAmount(1234.56, 'RSD', true)).toBe('1234.56 RSD');
  });

  it('just below 1M: no suffix', () => {
    expect(formatAmount(999_999.99, 'RSD', true)).toBe('999999.99 RSD');
  });

  it('exactly 1M: adds млн suffix', () => {
    expect(formatAmount(1_000_000, 'RSD', true)).toBe('1000000.00 (1 млн) RSD');
  });

  it('1.5M: exact + suffix', () => {
    expect(formatAmount(1_500_000, 'RSD', true)).toBe('1500000.00 (1.5 млн) RSD');
  });

  it('1.234M: suffix rounded to 2 decimal places', () => {
    expect(formatAmount(1_234_567.89, 'EUR', true)).toBe('1234567.89 (1.23 млн) EUR');
  });

  it('2M: no trailing zeros in suffix', () => {
    expect(formatAmount(2_000_000, 'USD', true)).toBe('2000000.00 (2 млн) USD');
  });

  it('exactly 1B: млрд suffix', () => {
    expect(formatAmount(1_000_000_000, 'RUB', true)).toBe('1000000000.00 (1 млрд) RUB');
  });

  it('2.5B: exact + млрд suffix', () => {
    expect(formatAmount(2_500_000_000, 'EUR', true)).toBe('2500000000.00 (2.5 млрд) EUR');
  });
});

describe('getAllExchangeRates', () => {
  it('returns object with all 12 currencies', () => {
    const rates = getAllExchangeRates();
    expect(Object.keys(rates)).toHaveLength(12);
  });

  it('EUR rate is 1.0', () => {
    expect(getAllExchangeRates().EUR).toBe(1.0);
  });

  it('USD rate is 0.93', () => {
    expect(getAllExchangeRates().USD).toBe(0.93);
  });

  it('returns a copy — mutation does not affect module state', () => {
    const rates = getAllExchangeRates();
    rates.EUR = 999;
    expect(getAllExchangeRates().EUR).toBe(1.0);
  });

  it('all rates are positive numbers', () => {
    const rates = getAllExchangeRates();
    for (const rate of Object.values(rates)) {
      expect(rate).toBeGreaterThan(0);
    }
  });

  it('contains all expected currency keys', () => {
    const rates = getAllExchangeRates();
    const keys = Object.keys(rates);
    expect(keys).toContain('USD');
    expect(keys).toContain('EUR');
    expect(keys).toContain('RUB');
    expect(keys).toContain('RSD');
    expect(keys).toContain('GBP');
    expect(keys).toContain('BYN');
    expect(keys).toContain('CHF');
    expect(keys).toContain('JPY');
    expect(keys).toContain('CNY');
    expect(keys).toContain('INR');
    expect(keys).toContain('LKR');
    expect(keys).toContain('AED');
  });
});

describe('formatExchangeRatesForAI', () => {
  it('returns a non-empty string', () => {
    expect(formatExchangeRatesForAI().length).toBeGreaterThan(50);
  });

  it('contains EUR in the text', () => {
    expect(formatExchangeRatesForAI()).toContain('EUR');
  });

  it('does not include EUR as a line item with "1 EUR ="', () => {
    const lines = formatExchangeRatesForAI()
      .split('\n')
      .filter((l) => l.startsWith('- '));
    expect(lines.every((l) => !l.includes('1 EUR ='))).toBe(true);
  });

  it('includes all non-EUR currencies', () => {
    const text = formatExchangeRatesForAI();
    const currencies = [
      'USD',
      'RUB',
      'RSD',
      'GBP',
      'BYN',
      'CHF',
      'JPY',
      'CNY',
      'INR',
      'LKR',
      'AED',
    ];
    for (const c of currencies) {
      expect(text).toContain(c);
    }
  });

  it('starts with exchange rate header', () => {
    const text = formatExchangeRatesForAI();
    expect(text).toContain('КУРСЫ ВАЛЮТ');
  });

  it('uses 6 decimal places for small rate currencies (RSD)', () => {
    const text = formatExchangeRatesForAI();
    // RSD rate is 0.0086, which is < 0.01 so uses 6 decimals
    const rsdLine = text.split('\n').find((l) => l.includes('RSD'));
    expect(rsdLine).toBeDefined();
    expect(rsdLine).toMatch(/€\d+\.\d{6}/);
  });

  it('uses 4 decimal places for larger rate currencies (USD)', () => {
    const text = formatExchangeRatesForAI();
    const usdLine = text.split('\n').find((l) => l.includes('1 USD'));
    expect(usdLine).toBeDefined();
    expect(usdLine).toMatch(/€\d+\.\d{4}/);
  });

  it('contains instruction text', () => {
    expect(formatExchangeRatesForAI()).toContain('НЕ пиши');
  });

  it('returns consistent results on repeated calls', () => {
    const first = formatExchangeRatesForAI();
    const second = formatExchangeRatesForAI();
    expect(first).toBe(second);
  });

  it('has multiple lines', () => {
    const lines = formatExchangeRatesForAI().split('\n');
    expect(lines.length).toBeGreaterThan(5);
  });
});

describe('convertCurrencyBig', () => {
  it('returns a Big instance', () => {
    const r = convertCurrencyBig(new Big('100'), 'USD', 'EUR');
    expect(r).toBeInstanceOf(Big);
  });

  it('identity: same currency returns same amount', () => {
    const r = convertCurrencyBig(new Big('100'), 'USD', 'USD');
    expect(r.toFixed(2)).toBe('100.00');
  });

  it('USD→EUR exact (no intermediate rounding)', () => {
    // 1.005 * 0.93 = 0.93465 — preserves all decimal places
    const r = convertCurrencyBig(new Big('1.005'), 'USD', 'EUR');
    expect(r.toFixed(5)).toBe('0.93465');
  });

  it('EUR→USD exact', () => {
    // 100 * 1 / 0.93 = 107.52688...
    const r = convertCurrencyBig(new Big('100'), 'EUR', 'USD');
    expect(r.gt(new Big('100'))).toBe(true); // USD weaker than EUR
  });

  it('RSD→EUR no premature rounding', () => {
    // 1500 * 0.0086 = 12.9 exactly
    const r = convertCurrencyBig(new Big('1500'), 'RSD', 'EUR');
    expect(r.toFixed(10)).toBe('12.9000000000');
  });

  it('USD→GBP via EUR exact', () => {
    // 1.005 USD → EUR: 1.005*0.93 = 0.93465 → GBP: 0.93465/1.18 = 0.7920762...
    const r = convertCurrencyBig(new Big('1.005'), 'USD', 'GBP');
    // Key: no intermediate Math.round applied
    const expected = new Big('1.005').times('0.93').div('1.18');
    expect(r.toFixed(8)).toBe(expected.toFixed(8));
  });
});
