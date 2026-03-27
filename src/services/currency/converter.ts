import Big from 'big.js';
import type { CurrencyCode } from '../../config/constants';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('converter');

/**
 * Fallback exchange rates (to EUR), stored as strings for exact decimal representation.
 * Used when API is unavailable. Numbers derived from this via parseFloat.
 */
const FALLBACK_RATES_STR: Record<CurrencyCode, string> = {
  EUR: '1',
  USD: '0.93', // 1 USD = 0.93 EUR
  RUB: '0.0093', // 1 RUB = 0.0093 EUR (approx 108 RUB = 1 EUR)
  RSD: '0.0086', // 1 RSD = 0.0086 EUR (approx 117 RSD = 1 EUR)
  GBP: '1.18', // 1 GBP = 1.18 EUR
  BYN: '0.28', // 1 BYN = 0.28 EUR (approx 3.5 BYN = 1 EUR)
  CHF: '1.05', // 1 CHF = 1.05 EUR
  JPY: '0.0062', // 1 JPY = 0.0062 EUR (approx 161 JPY = 1 EUR)
  CNY: '0.13', // 1 CNY = 0.13 EUR (approx 7.7 CNY = 1 EUR)
  INR: '0.011', // 1 INR = 0.011 EUR (approx 90 INR = 1 EUR)
  LKR: '0.0028', // 1 LKR = 0.0028 EUR (approx 360 LKR = 1 EUR)
  AED: '0.25', // 1 AED = 0.25 EUR (approx 4 AED = 1 EUR)
};

const FALLBACK_RATES: Record<CurrencyCode, number> = Object.fromEntries(
  Object.entries(FALLBACK_RATES_STR).map(([k, v]) => [k, parseFloat(v)]),
) as Record<CurrencyCode, number>;

/**
 * Cache for API exchange rates
 */
let cachedRates: Record<CurrencyCode, number> | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

/**
 * API response type
 */
interface ExchangeRateAPIResponse {
  result: string;
  base_code: string;
  rates: Record<string, number>;
}

/**
 * Fetch exchange rates from API
 * Using exchangerate-api.com (free, no API key required)
 */
async function fetchExchangeRates(): Promise<Record<CurrencyCode, number> | null> {
  try {
    logger.info('[CURRENCY] Fetching exchange rates from API...');

    const response = await fetch('https://open.er-api.com/v6/latest/EUR', {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      logger.error(`[CURRENCY] API returned status ${response.status}`);
      return null;
    }

    const data = (await response.json()) as ExchangeRateAPIResponse;

    if (data.result !== 'success' || !data.rates) {
      logger.error('[CURRENCY] Invalid API response format');
      return null;
    }

    // Convert from "1 EUR = X OTHER" to "1 OTHER = X EUR"
    const rates: Record<CurrencyCode, number> = {
      EUR: 1.0,
      USD: 1 / (data.rates['USD'] || 1),
      RUB: 1 / (data.rates['RUB'] || 1),
      RSD: 1 / (data.rates['RSD'] || 1),
      GBP: 1 / (data.rates['GBP'] || 1),
      BYN: 1 / (data.rates['BYN'] || 1),
      CHF: 1 / (data.rates['CHF'] || 1),
      JPY: 1 / (data.rates['JPY'] || 1),
      CNY: 1 / (data.rates['CNY'] || 1),
      INR: 1 / (data.rates['INR'] || 1),
      LKR: 1 / (data.rates['LKR'] || 1),
      AED: 1 / (data.rates['AED'] || 1),
    };

    logger.info('[CURRENCY] ✅ Successfully fetched exchange rates from API');
    logger.info('[CURRENCY] Exchange rates (to EUR):');
    logger.info(`  /1 USD = €${(1 / rates.USD).toFixed(4)}`);
    logger.info(`  /1 RSD = €${(1 / rates.RSD).toFixed(6)}`);
    logger.info(`  /1 RUB = €${(1 / rates.RUB).toFixed(6)}`);
    logger.info(`  /1 GBP = €${(1 / rates.GBP).toFixed(4)}`);
    logger.info(`  /1 BYN = €${(1 / rates.BYN).toFixed(4)}`);
    logger.info(`  /1 CHF = €${(1 / rates.CHF).toFixed(4)}`);
    logger.info(`  /1 JPY = €${(1 / rates.JPY).toFixed(6)}`);
    logger.info(`  /1 CNY = €${(1 / rates.CNY).toFixed(4)}`);
    logger.info(`  /1 INR = €${(1 / rates.INR).toFixed(6)}`);
    logger.info(`  /1 LKR = €${(1 / rates.LKR).toFixed(6)}`);
    logger.info(`  /1 AED = €${(1 / rates.AED).toFixed(4)}`);

    return rates;
  } catch (error) {
    logger.error({ err: error }, '[CURRENCY] Failed to fetch exchange rates');
    return null;
  }
}

/**
 * Get current exchange rates (from cache or API)
 */
async function getExchangeRates(): Promise<Record<CurrencyCode, number>> {
  const now = Date.now();

  // Check if cache is still valid
  if (cachedRates && now - cacheTimestamp < CACHE_DURATION) {
    logger.info('[CURRENCY] Using cached exchange rates');
    return cachedRates;
  }

  // Try to fetch from API
  const apiRates = await fetchExchangeRates();

  if (apiRates) {
    cachedRates = apiRates;
    cacheTimestamp = now;
    return apiRates;
  }

  // Fallback to hardcoded rates
  logger.info('[CURRENCY] Using fallback exchange rates');
  return FALLBACK_RATES;
}

/**
 * Convert amount to EUR
 */
export function convertToEUR(amount: number, fromCurrency: CurrencyCode): number {
  if (fromCurrency === 'EUR') {
    return amount;
  }

  // Use cached rates if available, otherwise use fallback
  const rates = cachedRates || FALLBACK_RATES;
  const rate = rates[fromCurrency];

  if (!rate) {
    throw new Error(`Exchange rate not found for ${fromCurrency}`);
  }

  return Math.round(amount * rate * 100) / 100; // Round to 2 decimal places
}

/**
 * Convert amount between any two currencies
 * Uses EUR as intermediate currency
 */
export function convertCurrency(
  amount: number,
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
): number {
  if (fromCurrency === toCurrency) {
    return amount;
  }

  const rates = cachedRates || FALLBACK_RATES;
  const fromRate = rates[fromCurrency];
  const toRate = rates[toCurrency];

  if (!fromRate || !toRate) {
    throw new Error(`Exchange rate not found for ${fromCurrency} or ${toCurrency}`);
  }

  // rates[X] = "1 X = Y EUR"
  // from -> EUR -> to
  const eurAmount = amount * fromRate;
  return Math.round((eurAmount / toRate) * 100) / 100;
}

/**
 * Get exchange rate for currency
 */
export function getExchangeRate(currency: CurrencyCode): number {
  const rates = cachedRates || FALLBACK_RATES;
  return rates[currency] || 1.0;
}

/**
 * Format amount with currency symbol
 */
export function formatAmount(amount: number, currency: CurrencyCode): string {
  return `${amount.toFixed(2)} ${currency}`;
}

/**
 * Update exchange rates from API
 * Call this periodically or on bot startup
 */
export async function updateExchangeRates(): Promise<void> {
  await getExchangeRates();
}

/**
 * Get all exchange rates
 */
export function getAllExchangeRates(): Record<CurrencyCode, number> {
  return { ...(cachedRates || FALLBACK_RATES) };
}

/**
 * Convert amount between currencies using exact Big.js arithmetic.
 * Preserves full decimal precision — no intermediate rounding.
 * Uses string fallback rates so Big.js receives exact decimal representations.
 * Intended for the AI calculator where intermediate rounding causes visible errors.
 */
export function convertCurrencyBig(amount: Big, from: CurrencyCode, to: CurrencyCode): Big {
  if (from === to) return amount;

  const fromRateStr = FALLBACK_RATES_STR[from];
  const toRateStr = FALLBACK_RATES_STR[to];

  if (!fromRateStr || !toRateStr) {
    throw new Error(`Exchange rate not found for ${from} or ${to}`);
  }

  // rates[X] = "1 X = Y EUR" → from→EUR→to
  return amount.times(new Big(fromRateStr)).div(new Big(toRateStr));
}

/**
 * Format exchange rates for AI context
 */
export function formatExchangeRatesForAI(): string {
  const rates = getAllExchangeRates();
  const lines = ['АКТУАЛЬНЫЕ КУРСЫ ВАЛЮТ (к EUR, источник: exchangerate-api.com):'];

  const formatRate = (currency: CurrencyCode): string => {
    const rate = rates[currency];
    // Use more decimals for small rates (RSD, RUB, JPY, INR)
    const decimals = rate < 0.01 ? 6 : 4;
    return `- 1 ${currency} = €${rate.toFixed(decimals)}`;
  };

  for (const currency of Object.keys(rates) as CurrencyCode[]) {
    if (currency !== 'EUR') {
      lines.push(formatRate(currency));
    }
  }

  lines.push('');
  lines.push('Используй эти курсы для конвертации. НЕ пиши что курс "ориентировочный".');

  return lines.join('\n');
}
