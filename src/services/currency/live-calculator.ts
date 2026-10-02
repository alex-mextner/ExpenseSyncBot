import { CURRENCY_ALIASES, type CurrencyCode, SUPPORTED_CURRENCIES } from '../../config/constants';
import { ExactDecimal } from './exact-decimal';
import { type LiveRateSnapshot, liveRateSource } from './live-rate-source';

const supported = new Set<string>(SUPPORTED_CURRENCIES);
const aliases = Object.entries(CURRENCY_ALIASES)
  .filter(([alias, code]) => !/\s/u.test(alias) && supported.has(code))
  .sort(([a], [b]) => b.length - a.length);

interface Value {
  value: () => ExactDecimal;
  money: boolean;
}

export interface FreshCalculationResult {
  value: string;
  hasCurrency: boolean;
  rateAsOf?: string;
  rateSource?: string;
}

function currencyAt(expr: string, pos: number): { code: CurrencyCode; length: number } | null {
  const rest = expr.slice(pos).toLocaleLowerCase();
  for (const [alias, code] of aliases) {
    if (!rest.startsWith(alias.toLocaleLowerCase())) continue;
    const next = expr[pos + alias.length];
    if (/\p{L}/u.test(alias.at(-1) ?? '') && next && /\p{L}/u.test(next)) continue;
    return { code: code as CurrencyCode, length: alias.length };
  }
  return null;
}

/** Exact dimensional evaluator. Conversion values are lazy so syntax/units validate before any rate lookup. */
export function evaluateWithRates(
  expression: string,
  target: CurrencyCode,
  rates: Readonly<Record<string, string>>,
): { value: string; hasCurrency: boolean } {
  if (!expression.trim() || expression.length > 500) throw new Error('INVALID_EXPRESSION');
  const expr = expression.replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/');
  let pos = 0;
  let depth = 0;
  const space = () => {
    while (pos < expr.length && /\s/u.test(expr.charAt(pos))) pos++;
  };
  const readCurrency = () => {
    space();
    const found = currencyAt(expr, pos);
    if (found) pos += found.length;
    return found?.code ?? null;
  };
  const convert = (value: ExactDecimal, from: CurrencyCode) => {
    if (from === target) return value;
    const fromRate = rates[from];
    const targetRate = rates[target];
    if (!fromRate || !targetRate) throw new Error('MISSING_RATE');
    return value.times(targetRate).div(fromRate);
  };

  function factor(): Value {
    space();
    if (++depth > 32) throw new Error('EXPRESSION_TOO_DEEP');
    try {
      if (expr[pos] === '+' || expr[pos] === '-') {
        const minus = expr[pos++] === '-';
        const inner = factor();
        return { ...inner, value: () => (minus ? inner.value().times(-1) : inner.value()) };
      }
      if (expr[pos] === '(') {
        pos++;
        const inner = sum();
        space();
        if (expr[pos++] !== ')') throw new Error('EXPECTED_CLOSE');
        return inner;
      }
      const before = readCurrency();
      space();
      const match = expr.slice(pos).match(/^\d+(?:\.\d+)?/u);
      if (!match || match[0].length > 40 || (match[0].split('.')[1]?.length ?? 0) > 20)
        throw new Error('EXPECTED_NUMBER');
      pos += match[0].length;
      const after = readCurrency();
      if (before && after) throw new Error('DUPLICATE_CURRENCY');
      const currency = before ?? after;
      const exact = new ExactDecimal(match[0]);
      return {
        value: () => (currency ? convert(exact, currency) : exact),
        money: currency !== null,
      };
    } finally {
      depth--;
    }
  }
  function product(): Value {
    let left = factor();
    while (true) {
      space();
      const op = expr[pos];
      if (op !== '*' && op !== '/') return left;
      pos++;
      const right = factor();
      if (op === '*' && left.money && right.money) throw new Error('MONEY_SQUARED');
      if (op === '/' && !left.money && right.money) throw new Error('INVERSE_MONEY');
      const previous = left;
      left = {
        value: () =>
          op === '*' ? previous.value().times(right.value()) : previous.value().div(right.value()),
        money: op === '*' ? left.money || right.money : left.money && !right.money,
      };
    }
  }

  function sum(): Value {
    let left = product();
    while (true) {
      space();
      const op = expr[pos];
      if (op !== '+' && op !== '-') return left;
      pos++;
      const right = product();
      space();
      if (expr[pos] === '%') {
        if (right.money) throw new Error('INVALID_PERCENT');
        pos++;
        const previous = left;
        left = {
          ...left,
          value: () => {
            const base = previous.value();
            const delta = base.times(right.value()).div(100);
            return op === '+' ? base.plus(delta) : base.minus(delta);
          },
        };
        continue;
      }
      if (left.money !== right.money) throw new Error('MIXED_UNLABELLED_UNITS');
      const previous = left;
      left = {
        value: () =>
          op === '+' ? previous.value().plus(right.value()) : previous.value().minus(right.value()),
        money: left.money,
      };
    }
  }
  const result = sum();
  space();
  if (pos !== expr.length) throw new Error('TRAILING_INPUT');
  const value = result.value().toFixed();
  if (value.length > 1000) throw new Error('RESULT_TOO_LARGE');
  return { value, hasCurrency: result.money };
}

export async function evaluateFreshCurrencyExpression(
  expression: string,
  target: CurrencyCode,
  getRates: () => Promise<LiveRateSnapshot> = () => liveRateSource.get(),
): Promise<FreshCalculationResult> {
  try {
    const noRates = evaluateWithRates(expression, target, {});
    return noRates;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'MISSING_RATE') throw error;
  }
  const snapshot = await getRates();
  const result = evaluateWithRates(expression, target, snapshot.rates);
  return { ...result, rateAsOf: snapshot.asOf, rateSource: snapshot.source };
}
