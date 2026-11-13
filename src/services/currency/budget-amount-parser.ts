// Strict parser for a lone budget amount ("150", "150 eur", "1 500 RSD", "$150") typed by the user

import { type CurrencyCode, getCurrencyPrecision } from '../../config/constants';
import { CURRENCY_TOKEN_PATTERN, normalizeCurrencyAlias, normalizeCurrencyText } from './tokens';

export interface ParsedBudgetAmount {
  amount: number;
  /** null when the user did not name a currency — caller falls back to the prompt currency. */
  currency: CurrencyCode | null;
}

/** Upper bound for budget-prompt amounts, typed (parseBudgetInputAmount) and suggestion
 * buttons alike — one constant so both paths reject at the same line (#244). */
export const BUDGET_MAX_AMOUNT = 1_000_000_000_000;

const MAX_AMOUNT = BUDGET_MAX_AMOUNT;
// Space or NBSP separates thousands groups ("1 500", "1\u00A0500"); \d cannot stand in for it.
const NUMBER = String.raw`(\d{1,3}(?:[ ${'\u00A0'}]\d{3})+(?:[.,]\d{1,3})?|\d+(?:[.,]\d{1,3})?)`;
const PREFIX_FORM = new RegExp(`^(${CURRENCY_TOKEN_PATTERN})\\s*${NUMBER}$`, 'iu');
const SUFFIX_FORM = new RegExp(`^${NUMBER}\\s*(${CURRENCY_TOKEN_PATTERN})?$`, 'iu');

function validPrecision(raw: string, currency: CurrencyCode | null): boolean {
  const decimal = raw.match(/[.,](\d+)$/)?.[1];
  // Currency-free amounts are resolved against the active prompt by the caller.
  return !decimal || decimal.length <= (currency ? getCurrencyPrecision(currency) : 3);
}

function toAmount(raw: string): number | null {
  const normalized = raw.replace(/[  ]/g, '').replace(',', '.');
  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount <= 0 || amount >= MAX_AMOUNT) return null;
  return amount;
}

function parseMatchedAmount(
  rawAmount: string,
  rawCurrency: string,
  defaultCurrency: CurrencyCode | null,
): ParsedBudgetAmount | null {
  const amount = toAmount(rawAmount);
  const currency = rawCurrency ? normalizeCurrencyAlias(rawCurrency) : null;
  if (
    amount === null ||
    (rawCurrency && !currency) ||
    !validPrecision(rawAmount, currency ?? defaultCurrency)
  )
    return null;
  return { amount, currency };
}

/**
 * Parse text that consists ONLY of an amount with an optional currency.
 * Anything else (extra words, unknown currency words, several numbers) returns null so that
 * ordinary expense lines and prose are never swallowed by a budget prompt.
 */
export function parseBudgetInputAmount(
  text: string,
  defaultCurrency: CurrencyCode | null = null,
): ParsedBudgetAmount | null {
  const trimmed = normalizeCurrencyText(text).trim();
  if (!trimmed || trimmed.includes('\n')) return null;

  const prefix = PREFIX_FORM.exec(trimmed);
  if (prefix) {
    return parseMatchedAmount(prefix[2] ?? '', prefix[1] ?? '', defaultCurrency);
  }

  const suffix = SUFFIX_FORM.exec(trimmed);
  if (!suffix) return null;
  return parseMatchedAmount(suffix[1] ?? '', suffix[2] ?? '', defaultCurrency);
}
