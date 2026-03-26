/**
 * Currency-aware expression evaluator — used by the AI calculate tool
 */
import Big from 'big.js';
import { CURRENCY_ALIASES, type CurrencyCode } from '../../config/constants';
import { convertCurrency } from './converter';
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
      let rawAmount: string;
      let currencyAlias: string;

      if (currBefore !== undefined) {
        // Pattern: CURR NUM (e.g. $100)
        currencyAlias = currBefore;
        rawAmount = numAfterCurr;
      } else {
        // Pattern: NUM CURR (e.g. 100$ or 100 EUR)
        rawAmount = numBeforeCurr;
        currencyAlias = currAfter;
      }

      const fromCurrency = CURRENCY_ALIASES[currencyAlias.toLowerCase()] as
        | CurrencyCode
        | undefined;
      if (!fromCurrency) return match;

      const amount = parseFloat(rawAmount.replace(',', '.'));
      if (Number.isNaN(amount)) return match;

      anyCurrencyReplaced = true;
      return String(convertCurrency(amount, fromCurrency, targetCurrency));
    },
  );

  // Handle percentage: "EXPR [+-] N%" → evaluate EXPR, then apply percentage
  const pctMatch = converted.match(/^(.+?)\s*([+-])\s*(\d+(?:[.,]\d+)?)%\s*$/);
  if (pctMatch) {
    const baseExpr = pctMatch[1]?.trim() ?? '';
    const op = pctMatch[2];
    const pctStr = (pctMatch[3] ?? '0').replace(',', '.');
    if (Number.isNaN(parseFloat(pctStr))) return null;

    // Evaluate base — could be a single converted amount or a full expression
    let baseValue: Big | null;
    if (/^\d+(?:\.\d+)?$/.test(baseExpr)) {
      baseValue = new Big(baseExpr);
    } else {
      baseValue = evaluateMathExpressionBig(baseExpr);
    }
    if (baseValue === null) return null;

    const pct = new Big(pctStr);
    const delta = baseValue.times(pct).div(100);
    const result = op === '+' ? baseValue.plus(delta) : baseValue.minus(delta);
    return { value: result, hasCurrency: anyCurrencyReplaced };
  }

  const trimmed = converted.trim();

  // Single currency amount (e.g. "100$", "70 EUR") → plain conversion, no operator needed
  if (anyCurrencyReplaced && /^\d+(?:\.\d+)?$/.test(trimmed)) {
    return { value: new Big(trimmed), hasCurrency: true };
  }

  const mathResult = evaluateMathExpressionBig(trimmed);
  return mathResult === null ? null : { value: mathResult, hasCurrency: anyCurrencyReplaced };
}
