import { describe, expect, test } from 'bun:test';
import { createLiveRateSource } from './live-rate-source';

const now = Date.parse('2026-09-13T12:00:00Z');
const rates = {
  EUR: 1,
  USD: 1.2,
  RUB: 100,
  RSD: 120,
  GBP: 0.8,
  BYN: 3.5,
  CHF: 0.95,
  JPY: 160,
  CNY: 7.8,
  INR: 100,
  LKR: 350,
  AED: 4,
  EGP: 55,
};
const body = {
  result: 'success',
  base_code: 'EUR',
  time_last_update_unix: Math.floor(now / 1000) - 60,
  rates,
};

describe('live exchange-rate source', () => {
  test('singleflight cache is immutable and carries source/date', async () => {
    let calls = 0;
    const source = createLiveRateSource(
      async () => {
        calls++;
        return Response.json(body);
      },
      () => now,
    );
    const [a, b] = await Promise.all([source.get(), source.get()]);
    expect(calls).toBe(1);
    expect(a.asOf).toContain('2026-09-13');
    expect(a.source).toContain('exchangerate-api.com');
    a.rates.RSD = '0';
    expect((await source.get()).rates.RSD).toBe('120');
    expect(b.rates.USD).toBe('1.2');
  });

  test.each([
    { ...body, base_code: 'USD' },
    { ...body, time_last_update_unix: 1 },
    { ...body, rates: { ...rates, USD: 0 } },
    { ...body, rates: { ...rates, EGP: undefined } },
  ])('rejects invalid/stale feed', async (payload) => {
    const source = createLiveRateSource(
      async () => Response.json(payload),
      () => now,
    );
    await expect(source.get()).rejects.toThrow();
  });
});
