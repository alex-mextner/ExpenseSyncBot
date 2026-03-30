/** Tests for currency info, validation, and hint builders */
import { describe, expect, test } from 'bun:test';
import {
  buildCurrencyHints,
  CURRENCY_INFO,
  getCurrencyLabel,
  getCurrencySymbol,
  isValidCurrencyCode,
} from './constants';

describe('CURRENCY_INFO', () => {
  test('contains all SUPPORTED_CURRENCIES', () => {
    const supported = [
      'USD',
      'EUR',
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
    for (const code of supported) {
      expect(CURRENCY_INFO[code]).toBeDefined();
      expect(CURRENCY_INFO[code]?.code).toBe(code);
      expect(CURRENCY_INFO[code]?.nameRu).toBeTruthy();
      expect(CURRENCY_INFO[code]?.nameEn).toBeTruthy();
    }
  });

  test('contains common CIS currencies', () => {
    for (const code of ['GEL', 'KZT', 'AMD', 'UAH', 'UZS', 'AZN']) {
      expect(CURRENCY_INFO[code]).toBeDefined();
      expect(CURRENCY_INFO[code]?.nameRu).toBeTruthy();
    }
  });

  test('each entry has matching code field', () => {
    for (const [key, info] of Object.entries(CURRENCY_INFO)) {
      expect(info.code).toBe(key);
    }
  });
});

describe('isValidCurrencyCode', () => {
  test('accepts known currencies', () => {
    expect(isValidCurrencyCode('USD')).toBe(true);
    expect(isValidCurrencyCode('EUR')).toBe(true);
    expect(isValidCurrencyCode('TRY')).toBe(true);
    expect(isValidCurrencyCode('GEL')).toBe(true);
  });

  test('accepts lowercase input', () => {
    expect(isValidCurrencyCode('usd')).toBe(true);
    expect(isValidCurrencyCode('try')).toBe(true);
  });

  test('accepts unknown 3-letter codes as potentially valid ISO 4217', () => {
    expect(isValidCurrencyCode('XYZ')).toBe(true);
    expect(isValidCurrencyCode('abc')).toBe(true);
  });

  test('rejects non-3-letter strings', () => {
    expect(isValidCurrencyCode('US')).toBe(false);
    expect(isValidCurrencyCode('USDX')).toBe(false);
    expect(isValidCurrencyCode('')).toBe(false);
    expect(isValidCurrencyCode('12')).toBe(false);
    expect(isValidCurrencyCode('123')).toBe(false);
    expect(isValidCurrencyCode('U1D')).toBe(false);
  });
});

describe('getCurrencyLabel', () => {
  test('returns label with symbol for known currency', () => {
    const label = getCurrencyLabel('USD');
    expect(label).toContain('USD');
    expect(label).toContain('$');
    expect(label).toContain('Доллар');
  });

  test('returns label without duplicate symbol when symbol equals code', () => {
    const label = getCurrencyLabel('RSD');
    expect(label).toContain('RSD');
    expect(label).toContain('Сербский динар');
    // Should not have "RSD (RSD)"
    expect(label).not.toContain('(RSD)');
  });

  test('returns just the code for unknown currency', () => {
    expect(getCurrencyLabel('XYZ')).toBe('XYZ');
  });

  test('handles lowercase input', () => {
    const label = getCurrencyLabel('eur');
    expect(label).toContain('EUR');
    expect(label).toContain('Евро');
  });
});

describe('buildCurrencyHints', () => {
  test('shows default currency hint', () => {
    const hints = buildCurrencyHints(['EUR', 'USD', 'RUB'], 'EUR');
    expect(hints).toContain('EUR');
    expect(hints).toContain('100 еда обед');
  });

  test('shows shortcuts for non-default currencies', () => {
    const hints = buildCurrencyHints(['EUR', 'USD', 'RUB'], 'EUR');
    expect(hints).toContain('USD');
    expect(hints).toContain('$');
    expect(hints).toContain('RUB');
    expect(hints).toContain('₽');
  });

  test('does not show shortcuts for default currency in the list', () => {
    const hints = buildCurrencyHints(['EUR', 'USD'], 'EUR');
    // EUR should only appear as "default currency", not in the shortcuts list
    const lines = hints.split('\n').filter((l) => l.startsWith('  EUR:'));
    expect(lines.length).toBe(0);
  });

  test('handles unknown custom currency gracefully', () => {
    const hints = buildCurrencyHints(['EUR', 'XYZ'], 'EUR');
    expect(hints).toContain('XYZ');
    expect(hints).toContain('100 xyz');
  });
});

describe('getCurrencySymbol', () => {
  test('returns symbol for known currencies', () => {
    expect(getCurrencySymbol('USD')).toBe('$');
    expect(getCurrencySymbol('EUR')).toBe('€');
    expect(getCurrencySymbol('RUB')).toBe('₽');
    expect(getCurrencySymbol('GBP')).toBe('£');
    expect(getCurrencySymbol('JPY')).toBe('¥');
    expect(getCurrencySymbol('INR')).toBe('₹');
    expect(getCurrencySymbol('BYN')).toBe('Br');
  });

  test('returns symbol for currencies beyond the old CURRENCY_SYMBOLS set', () => {
    expect(getCurrencySymbol('TRY')).toBe('₺');
    expect(getCurrencySymbol('UAH')).toBe('₴');
    expect(getCurrencySymbol('GEL')).toBe('₾');
    expect(getCurrencySymbol('KZT')).toBe('₸');
    expect(getCurrencySymbol('PLN')).toBe('zł');
  });

  test('returns code itself for currencies where symbol equals code', () => {
    expect(getCurrencySymbol('RSD')).toBe('RSD');
    expect(getCurrencySymbol('CHF')).toBe('CHF');
    expect(getCurrencySymbol('LKR')).toBe('LKR');
    expect(getCurrencySymbol('AED')).toBe('AED');
  });

  test('falls back to code for completely unknown currencies', () => {
    expect(getCurrencySymbol('XYZ')).toBe('XYZ');
    expect(getCurrencySymbol('ABC')).toBe('ABC');
  });

  test('handles lowercase input', () => {
    expect(getCurrencySymbol('usd')).toBe('$');
    expect(getCurrencySymbol('eur')).toBe('€');
  });
});
