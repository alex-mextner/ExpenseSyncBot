/**
 * Currency-aware expression evaluator — used by the AI calculate tool
 */
import Big from 'big.js';
import { CURRENCY_ALIASES, type CurrencyCode } from '../../config/constants';
import { convertCurrencyBig } from './converter';
import { evaluateMathExpressionBig } from './parser';

// All currency aliases, sorted longest-first (prevents partial matches on shorter entries)
const SORTED_ALIASES: Array<[string, CurrencyCode]> = (
  Object.entries(CURRENCY_ALIASES) as Array<[string, string]>
)
  .filter(([alias]) => !/\s/.test(alias)) // skip multi-word aliases (e.g. "белорусский рубль")
  .sort(([a], [b]) => b.length - a.length)
  .map(([alias, code]) => [alias, code as CurrencyCode]);

// Number pattern: digits with optional decimal (dot or comma)
const NUM = '\\d+(?:[.,]\\d+)?';

// Currency identifier pattern (longest aliases first, all special chars escaped)
const CURR = SORTED_ALIASES.map(([alias]) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(
  '|',
);

// Matches: (currency)(number)  e.g. $100, €50
//      or: (number)(optional space)(currency)  e.g. 100$, 50 EUR, 100eur
const AMOUNT_RE = new RegExp(`(${CURR})(${NUM})|(${NUM})\\s*(${CURR})`, 'gi');

/**
 * Result of evaluating a currency-aware expression.
 * hasCurrency=true when the expression contained currency amounts (output should show currency).
 */
export interface CurrencyExpressionResult {
  value: Big;
  hasCurrency: boolean;
}

const PLAIN_NUMBER_RE = /^\d+(?:\.\d+)?$/;

/**
 * Convert one regex match of AMOUNT_RE to targetCurrency (as a plain decimal string).
 * Returns null when the alias/amount is not convertible so the caller keeps the original text.
 */
function convertAmountMatch(
  currBefore: string | undefined,
  numAfterCurr: string,
  numBeforeCurr: string,
  currAfter: string,
  targetCurrency: CurrencyCode,
): string | null {
  // Pattern: CURR NUM (e.g. $100) or NUM CURR (e.g. 100$ or 100 EUR)
  const currencyAlias = currBefore !== undefined ? currBefore : currAfter;
  const rawAmount = currBefore !== undefined ? numAfterCurr : numBeforeCurr;

  const fromCurrency = CURRENCY_ALIASES[currencyAlias.toLowerCase()] as CurrencyCode | undefined;
  if (!fromCurrency) return null;

  const amountStr = rawAmount.replace(',', '.');
  if (Number.isNaN(parseFloat(amountStr))) return null;

  // Use Big for exact decimal arithmetic — no intermediate 2-decimal rounding
  return convertCurrencyBig(new Big(amountStr), fromCurrency, targetCurrency).toString();
}

/**
 * Handle percentage: "EXPR [+-] N%" → evaluate EXPR, then apply percentage.
 * `pctMatch` is the match of the percentage pattern against the converted expression.
 */
function applyPercentage(
  pctMatch: RegExpMatchArray,
  hasCurrency: boolean,
): CurrencyExpressionResult | null {
  const baseExpr = pctMatch[1]?.trim() ?? '';
  const op = pctMatch[2];
  const pctStr = (pctMatch[3] ?? '0').replace(',', '.');
  if (Number.isNaN(parseFloat(pctStr))) return null;

  // Evaluate base — could be a single converted amount or a full expression
  const baseValue = PLAIN_NUMBER_RE.test(baseExpr)
    ? new Big(baseExpr)
    : evaluateMathExpressionBig(baseExpr);
  if (baseValue === null) return null;

  const delta = baseValue.times(new Big(pctStr)).div(100);
  const result = op === '+' ? baseValue.plus(delta) : baseValue.minus(delta);
  return { value: result, hasCurrency };
}

/**
 * Evaluate a math expression containing optional currency amounts.
 * All currency amounts are converted to targetCurrency before evaluation.
 *
 * Examples:
 *   "100$ - 70EUR"       in USD → converts 70 EUR→USD, evaluates 100 − result
 *   "100$-70eur"         in USD → same, compact form
 *   "1500 RSD + 10€"     in EUR → converts 1500 RSD→EUR, evaluates result + 10
 *   "100 - 70"           in USD → pure math, hasCurrency=false
 *   "63000000 / 0.5"     in EUR → pure math, hasCurrency=false
 *
 * Returns null for invalid or unevaluable expressions.
 */
export function evaluateCurrencyExpression(
  expr: string,
  targetCurrency: CurrencyCode,
): CurrencyExpressionResult | null {
  if (!expr || expr.trim().length === 0) return null;

  let anyCurrencyReplaced = false;

  // Replace each currency amount with its value in targetCurrency
  const converted = expr.replace(
    AMOUNT_RE,
    (match, currBefore, numAfterCurr, numBeforeCurr, currAfter) => {
      const replacement = convertAmountMatch(
        currBefore,
        numAfterCurr,
        numBeforeCurr,
        currAfter,
        targetCurrency,
      );
      if (replacement === null) return match;
      anyCurrencyReplaced = true;
      return replacement;
    },
  );

  const pctMatch = converted.match(/^(.+?)\s*([+-])\s*(\d+(?:[.,]\d+)?)%\s*$/);
  if (pctMatch) return applyPercentage(pctMatch, anyCurrencyReplaced);

  const trimmed = converted.trim();

  // Single currency amount (e.g. "100$", "70 EUR") → plain conversion, no operator needed
  if (anyCurrencyReplaced && PLAIN_NUMBER_RE.test(trimmed)) {
    return { value: new Big(trimmed), hasCurrency: true };
  }

  const mathResult = evaluateMathExpressionBig(trimmed);
  return mathResult === null ? null : { value: mathResult, hasCurrency: anyCurrencyReplaced };
}
