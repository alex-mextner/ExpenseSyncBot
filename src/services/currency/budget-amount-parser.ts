// Strict parser for a lone budget amount ("150", "150 eur", "1 500 RSD", "$150") typed by the user

import { CURRENCY_ALIASES, type CurrencyCode } from '../../config/constants';

export interface ParsedBudgetAmount {
  amount: number;
  /** null when the user did not name a currency — caller falls back to the prompt currency. */
  currency: CurrencyCode | null;
}

const MAX_AMOUNT = 1_000_000_000_000;
const NUMBER = String.raw`(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const PREFIX_FORM = new RegExp(String.raw`^([$€£₽¥])\s*${NUMBER}$`);
const SUFFIX_FORM = new RegExp(String.raw`^${NUMBER}\s*([$€£₽¥]|[\p{L}]+)?$`, 'u');

function toCurrency(token: string | undefined): CurrencyCode | null | undefined {
  if (!token) return null;
  const code = CURRENCY_ALIASES[token.toLowerCase()];
  // undefined = unknown word, so the whole input is prose, not an amount
  return code ? (code as CurrencyCode) : undefined;
}

function toAmount(raw: string): number | null {
  const normalized = raw.replace(/[  ]/g, '').replace(',', '.');
  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount) || amount <= 0 || amount >= MAX_AMOUNT) return null;
  return amount;
}

/**
 * Parse text that consists ONLY of an amount with an optional currency.
 * Anything else (extra words, unknown currency words, several numbers) returns null so that
 * ordinary expense lines and prose are never swallowed by a budget prompt.
 */
export function parseBudgetInputAmount(text: string): ParsedBudgetAmount | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('\n')) return null;

  const prefix = PREFIX_FORM.exec(trimmed);
  if (prefix) {
    const amount = toAmount(prefix[2] ?? '');
    const currency = toCurrency(prefix[1]);
    return amount !== null && currency ? { amount, currency } : null;
  }

  const suffix = SUFFIX_FORM.exec(trimmed);
  if (!suffix) return null;
  const amount = toAmount(suffix[1] ?? '');
  const currency = toCurrency(suffix[2]);
  if (amount === null || currency === undefined) return null;
  return { amount, currency };
}
