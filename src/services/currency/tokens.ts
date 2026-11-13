/** Shared currency spellings for expense, budget, and calculator input. */
import { CURRENCY_ALIASES, type CurrencyCode } from '../../config/constants';

/** Ignore direction marks commonly copied with Arabic currency abbreviations. */
export function normalizeCurrencyText(text: string): string {
  return text.normalize('NFC').replace(/[\u061c\u200e\u200f]/g, '');
}

export function normalizeCurrencyAlias(token: string): CurrencyCode | null {
  // Turkish uppercase İ lowercases to i + combining dot; keep its currency alias stable.
  const key = normalizeCurrencyText(token)
    .toLowerCase()
    .replace(/i\u0307/g, 'i')
    .trim()
    .replace(/\s+/g, ' ');
  return (CURRENCY_ALIASES[key] as CurrencyCode | undefined) ?? null;
}

/** Longest aliases win, so qualified names are consumed before their short forms. */
export const CURRENCY_TOKEN_PATTERN = Object.keys(CURRENCY_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((alias) => {
    const pattern = alias
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    return CURRENCY_ALIASES[alias] === 'TRY' ? pattern.replace(/[iı]/g, '[iıİ]') : pattern;
  })
  .join('|');
