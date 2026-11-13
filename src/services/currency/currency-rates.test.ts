/** Live/cache/offline exchange-rate behavior for newly supported currencies; no network calls. */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import Big from 'big.js';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({ createLogger: () => logMock, logger: logMock }));
const {
  convertAnyToEUR,
  convertCurrency,
  convertCurrencyBig,
  getAllExchangeRates,
  updateExchangeRates,
} = await import('./converter');
const fallback = getAllExchangeRates();
const fetchSpy = spyOn(globalThis, 'fetch');

beforeEach(() => {
  fetchSpy.mockReset();
  logMock.warn.mockClear();
  logMock.error.mockClear();
});
afterAll(() => fetchSpy.mockRestore());

describe('new currency exchange rates', () => {
  test('uses API quotes consistently for manual, bank, and exact calculator conversions', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          result: 'success',
          base_code: 'EUR',
          rates: { EUR: 1, GEL: 3, OMR: 0.4, THB: 40, MYR: 5, KHR: 4500, TRY: 50 },
        }),
      ),
    );
    await updateExchangeRates();
    expect(convertCurrency(3, 'GEL', 'EUR')).toBe(1);
    expect(convertCurrency(1, 'EUR', 'OMR')).toBe(0.4);
    expect(convertCurrency(40, 'THB', 'EUR')).toBe(1);
    expect(convertCurrency(5, 'MYR', 'EUR')).toBe(1);
    expect(convertCurrency(4500, 'KHR', 'EUR')).toBe(1);
    expect(convertCurrency(50, 'TRY', 'EUR')).toBe(1);
    expect(convertCurrency(1, 'EUR', 'MYR')).toBe(5);
    expect(convertCurrencyBig(new Big('5'), 'MYR', 'OMR').toString()).toBe('0.4');
    expect(convertAnyToEUR(0.4, 'OMR')).toBe(1);
    expect(convertCurrencyBig(new Big('0.001'), 'OMR', 'EUR').toString()).toBe('0.0025');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('uses per-code offline rates for missing or invalid API quotes instead of EUR parity', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          result: 'success',
          base_code: 'EUR',
          rates: { EUR: 1, GEL: -1, OMR: 0 },
        }),
      ),
    );
    await updateExchangeRates();
    for (const code of ['GEL', 'OMR', 'THB', 'MYR', 'KHR', 'TRY'] as const) {
      expect(getAllExchangeRates()[code]).toBe(fallback[code]);
      expect(getAllExchangeRates()[code]).not.toBe(1);
      expect(convertAnyToEUR(100, code)).toBe(Math.round(10000 * fallback[code]) / 100);
      expect(convertCurrencyBig(new Big('1'), code, 'EUR').toNumber()).toBeCloseTo(
        fallback[code],
        12,
      );
    }
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('clears live caches and retains non-parity fallbacks during an API outage', async () => {
    fetchSpy.mockRejectedValue(new Error('synthetic offline test'));
    await updateExchangeRates();
    for (const code of ['GEL', 'OMR', 'THB', 'MYR', 'KHR', 'TRY'] as const) {
      expect(getAllExchangeRates()[code]).toBe(fallback[code]);
      expect(convertAnyToEUR(100, code)).toBe(Math.round(10000 * fallback[code]) / 100);
    }
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalledTimes(1);
  });
});
