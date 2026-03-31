// Tests for registerExchangeRateCron — startup fetch + periodic refresh

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import cron from 'node-cron';
import * as converterModule from '../services/currency/converter';
import { registerExchangeRateCron } from './cron';

let cronSpy: ReturnType<typeof spyOn>;
let updateSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  const fakeTask = { stop: mock(() => {}) };
  cronSpy = spyOn(cron, 'schedule').mockReturnValue(
    fakeTask as unknown as ReturnType<typeof cron.schedule>,
  );
  updateSpy = spyOn(converterModule, 'updateExchangeRates').mockResolvedValue(undefined);
});

afterEach(() => {
  mock.restore();
});

describe('registerExchangeRateCron', () => {
  it('calls updateExchangeRates on startup', () => {
    registerExchangeRateCron();
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('registers cron job at "0 */6 * * *"', () => {
    registerExchangeRateCron();
    expect(cronSpy).toHaveBeenCalledTimes(1);
    expect(cronSpy.mock.calls[0]?.[0]).toBe('0 */6 * * *');
  });

  it('cron callback calls updateExchangeRates', () => {
    registerExchangeRateCron();

    // Extract and invoke the cron callback
    const cronCallback = cronSpy.mock.calls[0]?.[1] as () => void;
    expect(cronCallback).toBeDefined();

    cronCallback();

    // 1 from startup + 1 from cron callback
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it('catches startup fetch errors without throwing', async () => {
    updateSpy.mockRejectedValue(new Error('network down'));

    // Should not throw — error is caught internally
    expect(() => registerExchangeRateCron()).not.toThrow();

    // Wait for the rejected promise to be handled
    await new Promise((r) => setTimeout(r, 10));
  });

  it('catches cron callback errors without throwing', async () => {
    updateSpy
      .mockResolvedValueOnce(undefined) // startup succeeds
      .mockRejectedValueOnce(new Error('API down')); // cron fails

    registerExchangeRateCron();

    const cronCallback = cronSpy.mock.calls[0]?.[1] as () => void;
    cronCallback();

    // Wait for the rejected promise to be handled
    await new Promise((r) => setTimeout(r, 10));
  });
});
