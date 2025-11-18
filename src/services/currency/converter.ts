import type { CurrencyCode } from "../../config/constants";

/**
 * Fallback exchange rates (to EUR)
 * Used when API is unavailable
 */
const FALLBACK_RATES: Record<CurrencyCode, number> = {
  EUR: 1.0,
  USD: 0.93, // 1 USD = 0.93 EUR
  RUB: 0.0093, // 1 RUB = 0.0093 EUR (approx 108 RUB = 1 EUR)
  RSD: 0.0086, // 1 RSD = 0.0086 EUR (approx 117 RSD = 1 EUR)
  GBP: 1.18, // 1 GBP = 1.18 EUR
  CHF: 1.05, // 1 CHF = 1.05 EUR
  JPY: 0.0062, // 1 JPY = 0.0062 EUR (approx 161 JPY = 1 EUR)
  CNY: 0.13, // 1 CNY = 0.13 EUR (approx 7.7 CNY = 1 EUR)
  INR: 0.011, // 1 INR = 0.011 EUR (approx 90 INR = 1 EUR)
};

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
async function fetchExchangeRates(): Promise<Record<
  CurrencyCode,
  number
> | null> {
  try {
    console.log("[CURRENCY] Fetching exchange rates from API...");

    const response = await fetch("https://open.er-api.com/v6/latest/EUR", {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      console.error(`[CURRENCY] API returned status ${response.status}`);
      return null;
    }

    const data = (await response.json()) as ExchangeRateAPIResponse;

    if (data.result !== "success" || !data.rates) {
      console.error("[CURRENCY] Invalid API response format");
      return null;
    }

    // Convert from "1 EUR = X OTHER" to "1 OTHER = X EUR"
    const rates: Record<CurrencyCode, number> = {
      EUR: 1.0,
      USD: 1 / (data.rates.USD || 1),
      RUB: 1 / (data.rates.RUB || 1),
      RSD: 1 / (data.rates.RSD || 1),
      GBP: 1 / (data.rates.GBP || 1),
      CHF: 1 / (data.rates.CHF || 1),
      JPY: 1 / (data.rates.JPY || 1),
      CNY: 1 / (data.rates.CNY || 1),
      INR: 1 / (data.rates.INR || 1),
    };

    console.log("[CURRENCY] ✅ Successfully fetched exchange rates from API");
    console.log("[CURRENCY] Exchange rates (to EUR):");
    console.log(`  /1 USD = €${(1 / rates.USD).toFixed(4)}`);
    console.log(`  /1 RSD = €${(1 / rates.RSD).toFixed(6)}`);
    console.log(`  /1 RUB = €${(1 / rates.RUB).toFixed(6)}`);
    console.log(`  /1 GBP = €${(1 / rates.GBP).toFixed(4)}`);
    console.log(`  /1 CHF = €${(1 / rates.CHF).toFixed(4)}`);
    console.log(`  /1 JPY = €${(1 / rates.JPY).toFixed(6)}`);
    console.log(`  /1 CNY = €${(1 / rates.CNY).toFixed(4)}`);
    console.log(`  /1 INR = €${(1 / rates.INR).toFixed(6)}`);

    return rates;
  } catch (error) {
    console.error("[CURRENCY] Failed to fetch exchange rates:", error);
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
    console.log("[CURRENCY] Using cached exchange rates");
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
  console.log("[CURRENCY] Using fallback exchange rates");
  return FALLBACK_RATES;
}

/**
 * Convert amount to EUR
 */
export function convertToEUR(
  amount: number,
  fromCurrency: CurrencyCode
): number {
  if (fromCurrency === "EUR") {
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
