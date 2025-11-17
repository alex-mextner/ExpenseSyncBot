import type { CurrencyCode } from '../../config/constants';

/**
 * Exchange rates (to USD)
 * TODO: Replace with real-time API (exchangerate-api.com, fixer.io, etc.)
 */
const EXCHANGE_RATES: Record<CurrencyCode, number> = {
  USD: 1.0,
  EUR: 1.08, // 1 EUR = 1.08 USD
  RUB: 0.010, // 1 RUB = 0.01 USD (approx 100 RUB = 1 USD)
  RSD: 0.0093, // 1 RSD = 0.0093 USD (approx 107 RSD = 1 USD)
  GBP: 1.27, // 1 GBP = 1.27 USD
  CHF: 1.13, // 1 CHF = 1.13 USD
  JPY: 0.0067, // 1 JPY = 0.0067 USD (approx 150 JPY = 1 USD)
  CNY: 0.14, // 1 CNY = 0.14 USD (approx 7 CNY = 1 USD)
  INR: 0.012, // 1 INR = 0.012 USD (approx 83 INR = 1 USD)
};

/**
 * Convert amount to USD
 */
export function convertToUSD(amount: number, fromCurrency: CurrencyCode): number {
  if (fromCurrency === 'USD') {
    return amount;
  }

  const rate = EXCHANGE_RATES[fromCurrency];

  if (!rate) {
    throw new Error(`Exchange rate not found for ${fromCurrency}`);
  }

  return Math.round(amount * rate * 100) / 100; // Round to 2 decimal places
}

/**
 * Get exchange rate for currency
 */
export function getExchangeRate(currency: CurrencyCode): number {
  return EXCHANGE_RATES[currency] || 1.0;
}

/**
 * Format amount with currency symbol
 */
export function formatAmount(amount: number, currency: CurrencyCode): string {
  return `${amount.toFixed(2)} ${currency}`;
}

/**
 * Update exchange rates (for future API integration)
 */
export async function updateExchangeRates(): Promise<void> {
  // TODO: Fetch real-time rates from API
  // For now, using hardcoded rates
  console.log('Using hardcoded exchange rates');
}

/**
 * Get all exchange rates
 */
export function getAllExchangeRates(): Record<CurrencyCode, number> {
  return { ...EXCHANGE_RATES };
}
