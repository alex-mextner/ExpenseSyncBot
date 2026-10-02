// Bank FX safety: unavailable rates stay unknown and become usable after refresh.
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({ createLogger: () => logMock, logger: logMock }));
const { convertAnyToEUR, updateExchangeRates, getExchangeRateFailure, formatMissingExchangeRate } =
  await import('./converter');
afterEach(() => {
  logMock.warn.mockClear();
  logMock.error.mockClear();
});
describe('bank currency conversion safety', () => {
  test('unknown currency never assumes EUR parity', () => {
    expect(convertAnyToEUR(100, 'XYZ')).toBeNull();
    expect(logMock.warn).toHaveBeenCalled();
  });
  test('EUR remains exact and supported fallback still works', () => {
    expect(convertAnyToEUR(100, 'EUR')).toBe(100);
    expect(convertAnyToEUR(100, 'USD')).toBe(93);
    expect(logMock.warn).not.toHaveBeenCalled();
  });
  test('original amount can be retried after rate becomes available', async () => {
    expect(convertAnyToEUR(100, 'XYZ')).toBeNull();
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          result: 'success',
          rates: { EUR: 1, USD: 2, XYZ: 4 },
        }),
      ),
    );
    try {
      await updateExchangeRates();
      expect(convertAnyToEUR(100, 'XYZ')).toBe(25);
      expect(logMock.error).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

test('provider failure rejects refresh and retains the last usable rate', async () => {
  convertAnyToEUR(100, 'QAA');
  const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ result: 'success', rates: { EUR: 1, QAA: 5 } })),
  );
  try {
    await updateExchangeRates();
    expect(convertAnyToEUR(100, 'QAA')).toBe(20);
    expect(getExchangeRateFailure()).toBe('missing_rate');
    fetchSpy.mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(updateExchangeRates()).rejects.toThrow('provider');
    expect(getExchangeRateFailure()).toBe('provider_unavailable');
    expect(formatMissingExchangeRate()).toBe('Сервис курсов недоступен');
    expect(convertAnyToEUR(100, 'QAA')).toBe(20);
    expect(convertAnyToEUR(100, 'QAB')).toBeNull();
  } finally {
    fetchSpy.mockRestore();
  }
});

test('refresh recovery distinguishes missing currency from a network outage', async () => {
  const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unavailable'));
  try {
    await expect(updateExchangeRates()).rejects.toThrow('provider');
    expect(getExchangeRateFailure()).toBe('provider_unavailable');
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ result: 'success', rates: { EUR: 1 } })),
    );
    await updateExchangeRates();
    expect(convertAnyToEUR(100, 'QAZ')).toBeNull();
    expect(getExchangeRateFailure()).toBe('missing_rate');
    expect(formatMissingExchangeRate()).toBe('Нет курса валюты');
    expect(convertAnyToEUR(100, 'RUB')).not.toBe(100);
  } finally {
    fetchSpy.mockRestore();
  }
});

test('concurrent manual refreshes share one provider request', async () => {
  const response = Promise.withResolvers<void>();
  const fetchSpy = spyOn(globalThis, 'fetch').mockReturnValue(
    response.promise.then(
      () => new Response(JSON.stringify({ result: 'success', rates: { EUR: 1 } })),
    ),
  );
  const refreshes = Array.from({ length: 10 }, () => updateExchangeRates());
  try {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    response.resolve();
    await Promise.all(refreshes);
    fetchSpy.mockRestore();
  }
});
