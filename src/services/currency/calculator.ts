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

type OperatorToken = { type: 'operator'; value: '+' | '-' | '*' | '/' };
type NumberToken = { type: 'number'; value: number };
type CurrencyToken = { type: 'currency'; value: number; currency: CurrencyCode };
type LParenToken = { type: 'lparen' };
type RParenToken = { type: 'rparen' };

type Token = OperatorToken | NumberToken | CurrencyToken | LParenToken | RParenToken;

// Type guards for narrowing Token types
function isOperatorToken(token: Token | null): token is OperatorToken {
  return token !== null && token.type === 'operator';
}

function isNumberToken(token: Token | null): token is NumberToken {
  return token !== null && token.type === 'number';
}

function isCurrencyToken(token: Token | null): token is CurrencyToken {
  return token !== null && token.type === 'currency';
}

/**
 * Check if a string looks like a currency code (3 uppercase letters)
 */
function looksLikeCurrencyCode(str: string): boolean {
  return /^[A-Z]{3}$/.test(str);
}

/**
 * Tokenize expression into numbers, currencies, operators, and parentheses
 */
function tokenizeExpression(expr: string): Token[] | string {
  const tokens: Token[] = [];
  let pos = 0;

  // Check for empty expression (after trimming whitespace)
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    return 'Empty expression';
  }

  while (pos < expr.length) {
    const char = expr[pos];

    // Skip whitespace
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      pos++;
      continue;
    }

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
      while (pos < expr.length && (/\d/.test(expr[pos]!) || expr[pos] === '.')) {
        numStr += expr[pos];
        pos++;
      }

      const num = parseFloat(numStr);
      if (isNaN(num)) {
        return `Invalid number: ${numStr}`;
      }

      // Check for currency suffix (skip any whitespace before currency)
      const savedPos = pos;
      while (pos < expr.length && (expr[pos] === ' ' || expr[pos] === '\t')) {
        pos++;
      }
      
      const remaining = expr.slice(pos);
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
        // Restore position if no currency found (we consumed whitespace for nothing)
        pos = savedPos;
        
        // Check if it looks like a currency code but is unknown
        const possibleCurrency = remaining.slice(0, 3).toUpperCase();
        if (remaining.length >= 3 && looksLikeCurrencyCode(possibleCurrency)) {
          return `Unknown currency: ${possibleCurrency}`;
        }
        tokens.push({ type: 'number', value: num });
      }
      continue;
    }

    return `Unexpected character at position ${pos}: ${char}`;
  }

  return tokens;
}

/**
 * Validate token sequence for syntax errors
 */
function validateTokens(tokens: Token[]): string | null {
  if (tokens.length === 0) {
    return 'Empty expression';
  }
  
  let expectOperand = true; // Start expecting an operand (number, currency, or lparen)

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (expectOperand) {
      // Expecting: number, currency, lparen, or unary +/-
      if (token.type === 'number' || token.type === 'currency') {
        expectOperand = false;
      } else if (token.type === 'lparen') {
        // Still expecting operand after (
      } else if (token.type === 'operator') {
        // Only unary + or - is allowed when expecting operand
        if (!isOperatorToken(token) || (token.value !== '+' && token.value !== '-')) {
          return `Unexpected operator '${isOperatorToken(token) ? token.value : ''}' - expected number or currency`;
        }
        // After unary operator, still expect operand
      } else if (token.type === 'rparen') {
        return 'Unexpected closing parenthesis without matching opening';
      }
    } else {
      // Expecting: operator or rparen
      if (token.type === 'operator') {
        expectOperand = true;
      } else if (token.type === 'rparen') {
        // After ), can have operator or another )
        expectOperand = false;
      } else {
        // number, currency, or lparen after operand - missing operator
        return 'Missing operator between values';
      }
    }
  }

  if (expectOperand) {
    return 'Expression ends with operator - expected number or currency';
  }

  // Check parentheses balance
  let depth = 0;
  for (const token of tokens) {
    if (token.type === 'lparen') depth++;
    if (token.type === 'rparen') depth--;
    if (depth < 0) return 'Unbalanced parentheses';
  }
  if (depth !== 0) return 'Unbalanced parentheses';

  return null;
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

    const curr = this.current();
    while (isOperatorToken(curr) && (curr.value === '+' || curr.value === '-')) {
      const op = curr.value;
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

    const curr = this.current();
    while (isOperatorToken(curr) && (curr.value === '*' || curr.value === '/')) {
      const op = curr.value;
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

    if (isOperatorToken(token) && token.value === '-') {
      this.advance();
      const operand = this.parsePrimary();
      if (typeof operand === 'string') return operand;
      return { value: -operand.value, currency: operand.currency, hasMultipleCurrencies: operand.hasMultipleCurrencies };
    }

    if (isOperatorToken(token) && token.value === '+') {
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

    // Number
    if (isNumberToken(token)) {
      this.advance();
      return { value: token.value, currency: null, hasMultipleCurrencies: false };
    }

    // Currency
    if (isCurrencyToken(token)) {
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

  // Validate token sequence
  const validationError = validateTokens(tokens);
  if (validationError) {
    return { success: false, error: validationError };
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

  // Handle single currency with target conversion
  if (result.currency && targetCurrencyCode && result.currency !== targetCurrencyCode) {
    // Convert single currency amount to target
    const convertedValue = convertCurrency(result.value, result.currency, targetCurrencyCode);
    const formatted = `${convertedValue.toFixed(2)} ${targetCurrencyCode}`;
    return {
      success: true,
      value: convertedValue,
      currency: targetCurrencyCode,
      formatted,
    };
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
