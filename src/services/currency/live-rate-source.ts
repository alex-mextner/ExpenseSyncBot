import { type CurrencyCode, SUPPORTED_CURRENCIES } from '../../config/constants';

export interface LiveRateSnapshot {
  rates: Record<CurrencyCode, string>;
  asOf: string;
  source: string;
}

const URL = 'https://open.er-api.com/v6/latest/EUR';
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 65_536;

function parseFeed(value: unknown, now: number): LiveRateSnapshot {
  if (!value || typeof value !== 'object') throw new Error('INVALID_EXCHANGE_RATES');
  const data = value as Record<string, unknown>;
  if (data['result'] !== 'success' || data['base_code'] !== 'EUR')
    throw new Error('INVALID_EXCHANGE_RATES');
  if (
    !Number.isInteger(data['time_last_update_unix']) ||
    Number(data['time_last_update_unix']) <= 0
  )
    throw new Error('INVALID_EXCHANGE_RATES');
  const rawRates = data['rates'];
  if (!rawRates || typeof rawRates !== 'object' || Array.isArray(rawRates))
    throw new Error('INVALID_EXCHANGE_RATES');
  const timestamp = Number(data['time_last_update_unix']) * 1000;
  if (timestamp > now + 300_000 || now - timestamp > MAX_AGE_MS)
    throw new Error('STALE_EXCHANGE_RATES');

  const rates = {} as Record<CurrencyCode, string>;
  for (const code of SUPPORTED_CURRENCIES) {
    const raw = (rawRates as Record<string, unknown>)[code];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0)
      throw new Error(`MISSING_RATE_${code}`);
    rates[code] = String(raw);
  }
  if (rates.EUR !== '1') throw new Error('INVALID_EXCHANGE_RATES');
  return {
    rates,
    asOf: new Date(timestamp).toISOString(),
    source: 'https://www.exchangerate-api.com',
  };
}
export function createLiveRateSource(
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  now: () => number = Date.now,
) {
  let cache: LiveRateSnapshot | null = null;
  let validUntil = 0;
  let retryAfter = 0;
  let pending: Promise<LiveRateSnapshot> | null = null;

  async function load(): Promise<LiveRateSnapshot> {
    const response = await fetcher(URL, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('EXCHANGE_RATES_UNAVAILABLE');
    }
    if (!response.body) throw new Error('EXCHANGE_RATES_UNAVAILABLE');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > MAX_BYTES) throw new Error('EXCHANGE_RATE_RESPONSE_TOO_LARGE');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const snapshot = parseFeed(JSON.parse(text), now());
    cache = snapshot;
    validUntil = Math.min(now() + CACHE_MS, Date.parse(snapshot.asOf) + MAX_AGE_MS);
    return snapshot;
  }
  return {
    async get(): Promise<LiveRateSnapshot> {
      const current = now();
      if (cache && current < validUntil) return structuredClone(cache);
      if (current < retryAfter) throw new Error('EXCHANGE_RATES_COOLDOWN');
      pending ??= load()
        .catch((error) => {
          retryAfter = now() + 60_000;
          throw error;
        })
        .finally(() => {
          pending = null;
        });
      return structuredClone(await pending);
    },
  };
}

export const liveRateSource = createLiveRateSource();
