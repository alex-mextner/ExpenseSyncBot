/** Currency converter — converts amounts between currencies using hardcoded EUR-based exchange rates */
import Big from 'big.js';
import {
  BASE_CURRENCY,
  type CurrencyCode,
  getCurrencySymbol,
  SUPPORTED_CURRENCIES,
} from '../../config/constants';
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
  EGP: '0.018', // 1 EGP = 0.018 EUR (approx 55.5 EGP = 1 EUR)
};

const FALLBACK_RATES: Record<CurrencyCode, number> = Object.fromEntries(
  Object.entries(FALLBACK_RATES_STR).map(([k, v]) => [k, parseFloat(v)]),
) as Record<CurrencyCode, number>;

/**
 * Fallback rates for currencies used by bank plugins but not in SUPPORTED_CURRENCIES.
 * These are approximate values for when the API is unavailable.
 */
const BANK_FALLBACK_RATES: Record<string, number> = {
  GEL: 1 / 2.94, // Georgian Lari (~2.94 GEL = 1 EUR)
  KZT: 1 / 514, // Kazakh Tenge
  AMD: 1 / 408, // Armenian Dram
  UAH: 1 / 44, // Ukrainian Hryvnia
  UZS: 1 / 13500, // Uzbek Som
  AZN: 1 / 1.84, // Azerbaijani Manat
  TRY: 1 / 35, // Turkish Lira
  ILS: 1 / 3.96, // Israeli Shekel
  PLN: 1 / 4.28, // Polish Zloty
  CZK: 1 / 25.2, // Czech Koruna
  HUF: 1 / 400, // Hungarian Forint
  RON: 1 / 4.97, // Romanian Leu
  BGN: 1 / 1.96, // Bulgarian Lev
  HRK: 1 / 7.53, // Croatian Kuna
  MKD: 1 / 61.5, // Macedonian Denar
  BAM: 1 / 1.96, // Bosnian Mark
  RSD: 1 / 117, // Serbian Dinar (duplicate of SUPPORTED, kept for lookup convenience)
};

/**
 * Currencies to cache from the API. Starts with SUPPORTED_CURRENCIES.
 * Grows lazily — when convertAnyToEUR encounters a new code it registers it here
 * so the next scheduled fetch will include it.
 */
const knownCurrencies: Set<string> = new Set(SUPPORTED_CURRENCIES);

/**
 * Cache for API exchange rates
 */
let cachedRates: Record<CurrencyCode, number> | null = null;
// Rates for knownCurrencies fetched from API — used by convertAnyToEUR
let cachedAllRates: Record<string, number> | null = null;
// String-precision rates derived from API response via Big.js division (used by convertCurrencyBig)
let cachedRatesStr: Record<CurrencyCode, string> | null = null;
let cacheTimestamp: number = 0;
let providerUnavailable = false;
let refreshInFlight: Promise<void> | null = null;
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
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      logger.error({ status: response.status }, '[CURRENCY] API returned error status');
      return null;
    }

    const data = (await response.json()) as ExchangeRateAPIResponse;

    if (data.result !== 'success' || !data.rates) {
      logger.error('[CURRENCY] Invalid API response format');
      return null;
    }

    // Convert from "1 EUR = X OTHER" to "1 OTHER = X EUR"
    const rateFor = (currency: CurrencyCode): number => {
      const value = data.rates[currency];
      return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? 1 / value
        : (cachedRates?.[currency] ?? FALLBACK_RATES[currency]);
    };
    const rates: Record<CurrencyCode, number> = {
      EUR: 1.0,
      USD: rateFor('USD'),
      RUB: rateFor('RUB'),
      RSD: rateFor('RSD'),
      GBP: rateFor('GBP'),
      BYN: rateFor('BYN'),
      CHF: rateFor('CHF'),
      JPY: rateFor('JPY'),
      CNY: rateFor('CNY'),
      INR: rateFor('INR'),
      LKR: rateFor('LKR'),
      AED: rateFor('AED'),
      EGP: rateFor('EGP'),
    };

    // Build string-precision rates for Big.js arithmetic.
    // API gives "1 EUR = X currency" → we compute "1 currency = 1/X EUR" via Big.js division
    // to avoid float imprecision in convertCurrencyBig.
    const toRateStr = (apiKey: CurrencyCode): string => {
      const value = data.rates[apiKey];
      return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? new Big(1).div(new Big(String(value))).toFixed(15)
        : (cachedRatesStr?.[apiKey] ?? FALLBACK_RATES_STR[apiKey]);
    };
    cachedRatesStr = {
      EUR: '1',
      USD: toRateStr('USD'),
      RUB: toRateStr('RUB'),
      RSD: toRateStr('RSD'),
      GBP: toRateStr('GBP'),
      BYN: toRateStr('BYN'),
      CHF: toRateStr('CHF'),
      JPY: toRateStr('JPY'),
      CNY: toRateStr('CNY'),
      INR: toRateStr('INR'),
      LKR: toRateStr('LKR'),
      AED: toRateStr('AED'),
      EGP: toRateStr('EGP'),
    };

    // Store rates for known currencies only — populated lazily as new currencies are encountered.
    const allRates: Record<string, number> = { EUR: 1.0 };
    for (const currency of knownCurrencies) {
      const apiRate = data.rates[currency];
      if (typeof apiRate === 'number' && Number.isFinite(apiRate) && apiRate > 0) {
        allRates[currency] = 1 / apiRate;
      }
    }
    cachedAllRates = allRates;

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
    logger.info(`  /1 EGP = €${(1 / rates.EGP).toFixed(6)}`);

    return rates;
  } catch (error) {
    logger.error({ err: error }, '[CURRENCY] Failed to fetch exchange rates');
    return null;
  }
}

/**
 * Get current exchange rates (from cache or API)
 */
async function getExchangeRates(force = false): Promise<Record<CurrencyCode, number>> {
  const now = Date.now();

  // Check if cache is still valid
  if (!force && cachedRates && now - cacheTimestamp < CACHE_DURATION) {
    logger.info('[CURRENCY] Using cached exchange rates');
    return cachedRates;
  }

  // Try to fetch from API
  const apiRates = await fetchExchangeRates();

  if (apiRates) {
    providerUnavailable = false;
    cachedRates = apiRates;
    cacheTimestamp = now;
    return apiRates;
  }

  // A failed refresh must reach the cron retry loop without discarding usable cached rates.
  providerUnavailable = true;
  throw new Error('Exchange-rate provider unavailable');
}

/**
 * Convert amount to EUR
 */
export function convertToEUR(amount: number, fromCurrency: CurrencyCode): number {
  if (fromCurrency === BASE_CURRENCY) {
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
 * Convert amount to EUR for any ISO 4217 currency code, including those outside SUPPORTED_CURRENCIES.
 * Uses live API rates (all currencies), then SUPPORTED_CURRENCIES fallback, then BANK_FALLBACK_RATES.
 * If the rate is unavailable or invalid, returns null so callers cannot fabricate EUR.
 * Intended for bank transaction processing where the currency comes from the bank plugin.
 */
export function convertAnyToEUR(amount: number, currency: string): number | null {
  if (currency === 'EUR') return amount;
  // Register so the next scheduled API fetch caches this currency's live rate.
  knownCurrencies.add(currency);
  const rate =
    cachedAllRates?.[currency] ??
    cachedRates?.[currency as CurrencyCode] ??
    FALLBACK_RATES[currency as CurrencyCode] ??
    BANK_FALLBACK_RATES[currency];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    logger.warn({ currency }, 'convertAnyToEUR: exchange rate unavailable');
    return null;
  }
  return Math.round(amount * rate * 100) / 100;
}

/** Why a bank conversion has no rate; provider failure is distinct from an absent currency. */
export function getExchangeRateFailure(): 'provider_unavailable' | 'missing_rate' {
  return providerUnavailable ? 'provider_unavailable' : 'missing_rate';
}

/** User-facing failure label shared by confirmation and pending transaction cards. */
export function formatMissingExchangeRate(): string {
  return providerUnavailable ? 'Сервис курсов недоступен' : 'Нет курса валюты';
}

/**
 * Get exchange rate for currency
 */
export function getExchangeRate(currency: CurrencyCode): number {
  const rates = cachedRates || FALLBACK_RATES;
  return rates[currency] || 1.0;
}

/**
 * Format amount with currency symbol (falls back to code for unknown currencies).
 *
 * User-facing (default): amounts >= 1M shown as "1.5 млн RSD", "1.5 млн $".
 * AI context (aiContext=true): always uses the raw code (not symbol) for unambiguous parsing,
 * e.g. "1500000.00 (1.5 млн) USD".
 */
export function formatAmount(amount: number, currency: string, aiContext = false): string {
  const abs = Math.abs(amount);

  if (aiContext) {
    const exact = amount.toFixed(2);
    if (abs >= 1_000_000_000) {
      return `${exact} (${+(amount / 1_000_000_000).toFixed(2)} млрд) ${currency}`;
    }
    if (abs >= 1_000_000) {
      return `${exact} (${+(amount / 1_000_000).toFixed(2)} млн) ${currency}`;
    }
    return `${exact} ${currency}`;
  }

  const symbol = getCurrencySymbol(currency);
  let num: string;
  if (abs >= 1_000_000_000) {
    num = `${+(amount / 1_000_000_000).toFixed(2)} млрд`;
  } else if (abs >= 1_000_000) {
    num = `${+(amount / 1_000_000).toFixed(2)} млн`;
  } else {
    num = amount.toFixed(2);
  }
  return `${num} ${symbol}`;
}

/**
 * Force-fetch exchange rates; preserve usable caches and reject on provider failure.
 * Called from cron and on bot startup.
 */
export function updateExchangeRates(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = getExchangeRates(true)
      .then(() => {})
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
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
 * Uses live API rates (as precise strings via Big.js division) when available,
 * falls back to FALLBACK_RATES_STR otherwise.
 * Intended for the AI calculator where intermediate rounding causes visible errors.
 */
export function convertCurrencyBig(amount: Big, from: CurrencyCode, to: CurrencyCode): Big {
  if (from === to) return amount;

  const rateTable = cachedRatesStr ?? FALLBACK_RATES_STR;
  const fromRateStr = rateTable[from];
  const toRateStr = rateTable[to];

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
    if (currency !== BASE_CURRENCY) {
      lines.push(formatRate(currency));
    }
  }

  lines.push('');
  lines.push('Используй эти курсы для конвертации. НЕ пиши что курс "ориентировочный".');

  return lines.join('\n');
}
