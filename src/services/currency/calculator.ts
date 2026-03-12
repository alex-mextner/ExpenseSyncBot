import type { CurrencyCode } from '../../config/constants';
import { SUPPORTED_CURRENCIES } from '../../config/constants';
import { convertCurrency } from './converter';

export interface CalculateResult {
  success: true;
  value: number;
  currency: CurrencyCode;
  formatted: string;
}

export interface CalculateError {
  success: false;
  error: string;
}

export type CalculatorResult = CalculateResult | CalculateError;

type Token =
  | { type: 'number'; value: number }
  | { type: 'currency'; value: number; currency: CurrencyCode }
  | { type: 'operator'; value: '+' | '-' | '*' | '/' }
  | { type: 'lparen' }
  | { type: 'rparen' };

/**
 * Tokenize expression into numbers, currencies, operators, and parentheses
 */
function tokenizeExpression(expr: string): Token[] | string {
  const tokens: Token[] = [];
  let pos = 0;
  const trimmed = expr.replace(/\s+/g, '');

  if (trimmed.length === 0) {
    return 'Empty expression';
  }

  while (pos < trimmed.length) {
    const char = trimmed[pos];

    // Operators
    if (char === '+' || char === '-' || char === '*' || char === '/') {
      tokens.push({ type: 'operator', value: char });
      pos++;
      continue;
    }

    // Parentheses
    if (char === '(') {
      tokens.push({ type: 'lparen' });
      pos++;
      continue;
    }
    if (char === ')') {
      tokens.push({ type: 'rparen' });
      pos++;
      continue;
    }

    // Numbers with optional currency suffix
    if (/\d/.test(char!) || char === '.') {
      let numStr = '';

      // Read number (digits and decimal point)
      while (pos < trimmed.length && (/\d/.test(trimmed[pos]!) || trimmed[pos] === '.')) {
        numStr += trimmed[pos];
        pos++;
      }

      const num = parseFloat(numStr);
      if (isNaN(num)) {
        return `Invalid number: ${numStr}`;
      }

      // Check for currency suffix
      const remaining = trimmed.slice(pos);
      let matchedCurrency: CurrencyCode | null = null;

      for (const curr of SUPPORTED_CURRENCIES) {
        if (remaining.toUpperCase().startsWith(curr)) {
          matchedCurrency = curr;
          pos += curr.length;
          break;
        }
      }

      if (matchedCurrency) {
        tokens.push({ type: 'currency', value: num, currency: matchedCurrency });
      } else {
        tokens.push({ type: 'number', value: num });
      }
      continue;
    }

    return `Unexpected character at position ${pos}: ${char}`;
  }

  return tokens;
}

interface ParsedValue {
  value: number;
  currency: CurrencyCode | null;
  hasMultipleCurrencies: boolean;
}

/**
 * Recursive descent parser for arithmetic expressions
 * Supports: +, -, *, /, parentheses, and currency amounts
 */
class ExpressionParser {
  private tokens: Token[];
  private pos: number = 0;
  private targetCurrency: CurrencyCode | null;

  constructor(tokens: Token[], targetCurrency?: CurrencyCode) {
    this.tokens = tokens;
    this.targetCurrency = targetCurrency || null;
  }

  parse(): ParsedValue | string {
    const result = this.parseExpression();
    if (typeof result === 'string') {
      return result;
    }

    if (this.pos < this.tokens.length) {
      return `Unexpected token at position ${this.pos}`;
    }

    return result;
  }

  private current(): Token | null {
    return this.tokens[this.pos] || null;
  }

  private advance(): void {
    this.pos++;
  }

  private parseExpression(): ParsedValue | string {
    return this.parseAddSub();
  }

  private parseAddSub(): ParsedValue | string {
    let left = this.parseMulDiv();
    if (typeof left === 'string') return left;

    while (this.current()?.type === 'operator' &&
           (this.current()!.value === '+' || this.current()!.value === '-')) {
      const op = this.current()!.value as '+' | '-';
      this.advance();

      const right = this.parseMulDiv();
      if (typeof right === 'string') return right;

      left = this.applyBinaryOp(left, op, right);
      if (typeof left === 'string') return left;
    }

    return left;
  }

  private parseMulDiv(): ParsedValue | string {
    let left = this.parseUnary();
    if (typeof left === 'string') return left;

    while (this.current()?.type === 'operator' &&
           (this.current()!.value === '*' || this.current()!.value === '/')) {
      const op = this.current()!.value as '*' | '/';
      this.advance();

      const right = this.parseUnary();
      if (typeof right === 'string') return right;

      left = this.applyBinaryOp(left, op, right);
      if (typeof left === 'string') return left;
    }

    return left;
  }

  private parseUnary(): ParsedValue | string {
    const token = this.current();

    if (token?.type === 'operator' && token.value === '-') {
      this.advance();
      const operand = this.parsePrimary();
      if (typeof operand === 'string') return operand;
      return { value: -operand.value, currency: operand.currency, hasMultipleCurrencies: operand.hasMultipleCurrencies };
    }

    if (token?.type === 'operator' && token.value === '+') {
      this.advance();
      return this.parsePrimary();
    }

    return this.parsePrimary();
  }

  private parsePrimary(): ParsedValue | string {
    const token = this.current();

    if (!token) {
      return 'Unexpected end of expression';
    }

    // Parenthesized expression
    if (token.type === 'lparen') {
      this.advance();
      const result = this.parseExpression();
      if (typeof result === 'string') return result;

      const next = this.current();
      if (!next || next.type !== 'rparen') {
        return 'Missing closing parenthesis';
      }
      this.advance();
      return result;
    }

    // Number or currency
    if (token.type === 'number') {
      this.advance();
      return { value: token.value, currency: null, hasMultipleCurrencies: false };
    }

    if (token.type === 'currency') {
      this.advance();
      return { value: token.value, currency: token.currency, hasMultipleCurrencies: false };
    }

    return `Unexpected token: ${JSON.stringify(token)}`;
  }

  private applyBinaryOp(left: ParsedValue, op: '+' | '-' | '*' | '/', right: ParsedValue): ParsedValue | string {
    // Check if we have multiple different currencies
    const hasMultipleCurrencies = left.hasMultipleCurrencies || right.hasMultipleCurrencies ||
      (left.currency !== null && right.currency !== null && left.currency !== right.currency);

    // Determine result currency
    let resultCurrency = this.targetCurrency;

    if (!resultCurrency) {
      if (hasMultipleCurrencies) {
        // Mixed currencies without target - use EUR as default
        resultCurrency = 'EUR';
      } else {
        // Same currency or one side has no currency - use the currency that exists
        resultCurrency = left.currency || right.currency;
      }
    }

    // Convert both operands to a common currency (EUR) if needed
    let leftValue = left.value;
    let rightValue = right.value;

    // If currencies are involved, convert to EUR for calculation
    if (left.currency || right.currency) {
      if (left.currency) {
        leftValue = convertCurrency(left.value, left.currency, 'EUR');
      }
      if (right.currency) {
        rightValue = convertCurrency(right.value, right.currency, 'EUR');
      }
    }

    let result: number;
    switch (op) {
      case '+':
        result = leftValue + rightValue;
        break;
      case '-':
        result = leftValue - rightValue;
        break;
      case '*':
        result = leftValue * rightValue;
        break;
      case '/':
        if (rightValue === 0) {
          return 'Division by zero';
        }
        result = leftValue / rightValue;
        break;
    }

    // If we have a target currency or currencies were involved, convert back
    if (resultCurrency && (left.currency || right.currency)) {
      result = convertCurrency(result, 'EUR', resultCurrency);
    } else if (!resultCurrency) {
      // Pure numeric operation - no currency
      return { value: Math.round(result * 100) / 100, currency: null, hasMultipleCurrencies: false };
    }

    return { value: Math.round(result * 100) / 100, currency: resultCurrency, hasMultipleCurrencies };
  }
}

/**
 * Calculate expression with numbers and/or currencies
 *
 * Supports:
 * - Basic arithmetic: +, -, *, /
 * - Parentheses for grouping
 * - Currency amounts: 100USD, 50EUR, etc.
 * - Mixed currency operations (converted via EUR)
 * - Optional target currency for conversion
 *
 * Examples:
 * - "10+20*3" → 70
 * - "(10+5)*2" → 30
 * - "100USD" → 100 USD
 * - "100USD+50EUR" → 143 EUR (approx, based on exchange rates)
 * - "100USD" with target_currency="EUR" → 93 EUR
 */
export function calculate(
  expression: string,
  targetCurrency?: string
): CalculatorResult {
  // Tokenize
  const tokens = tokenizeExpression(expression);
  if (typeof tokens === 'string') {
    return { success: false, error: tokens };
  }

  // Validate target currency if provided
  let targetCurrencyCode: CurrencyCode | undefined;
  if (targetCurrency) {
    const upperTarget = targetCurrency.toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(upperTarget as CurrencyCode)) {
      return { success: false, error: `Unknown currency: ${targetCurrency}` };
    }
    targetCurrencyCode = upperTarget as CurrencyCode;
  }

  // Parse and evaluate
  const parser = new ExpressionParser(tokens, targetCurrencyCode);
  const result = parser.parse();

  if (typeof result === 'string') {
    return { success: false, error: result };
  }

  // Determine final currency
  let finalCurrency = result.currency;
  if (!finalCurrency) {
    // Pure numeric result - use EUR as default
    finalCurrency = targetCurrencyCode || 'EUR';
  }

  // Format result
  const formatted = `${result.value.toFixed(2)} ${finalCurrency}`;

  return {
    success: true,
    value: result.value,
    currency: finalCurrency,
    formatted,
  };
}
