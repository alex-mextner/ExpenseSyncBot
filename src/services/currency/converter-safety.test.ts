// Bank FX safety: unavailable rates stay unknown and become usable after refresh.
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({ createLogger: () => logMock, logger: logMock }));
const { convertAnyToEUR, updateExchangeRates } = await import('./converter');
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
