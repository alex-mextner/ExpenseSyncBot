/** Expense message parser — extracts amount, currency, category, and comment from free-form text */
import Big from 'big.js';
import currency from 'currency.js';
import { CURRENCY_ALIASES, type CurrencyCode } from '../../config/constants';

export interface ParsedExpense {
  amount: number;
  currency: CurrencyCode;
  category: string | null;
  comment: string;
  raw: string;
}

// ── Math expression evaluator (no eval/Function) ──────────────────────

type MathOperator = '+' | '-' | '*' | '/';
// Numbers stored as strings so Big.js receives exact decimal representations (not parseFloat-imprecise floats)
type MathToken = string | MathOperator;

function isOperator(t: string): t is MathOperator {
  return t === '+' || t === '-' || t === '*' || t === '/';
}

/**
 * Tokenize a cleaned math expression into alternating number strings and operators.
 * Returns null if the expression is structurally invalid.
 */
function tokenize(expr: string): MathToken[] | null {
  const tokens = scanTokens(expr);
  if (!tokens) return null;

  // Must alternate number-operator-number: minimum 3 tokens, always odd count
  if (tokens.length < 3 || tokens.length % 2 === 0) return null;
  return tokens.every((tok, i) => (i % 2 === 0 ? !isOperator(tok) : isOperator(tok)))
    ? tokens
    : null;
}

/** Split into number strings (comma → dot) and operators (× → *); null on an unparseable number. */
function scanTokens(expr: string): MathToken[] | null {
  const tokens: MathToken[] = [];
  const regex = /(\d+(?:[.,]\d+)?)|([+\-*×/])/g;

  for (const match of expr.matchAll(regex)) {
    if (match[1]) {
      const numStr = match[1].includes(',') ? match[1].replace(',', '.') : match[1];
      if (Number.isNaN(parseFloat(numStr))) return null;
      tokens.push(numStr);
    } else if (match[2]) {
      const op = match[2] === '×' ? '*' : match[2];
      tokens.push(op as MathToken);
    }
  }
  return tokens;
}
/**
 * Evaluate tokens with standard operator precedence (* / before + -).
 * Returns null on division by zero or Big.js error.
 */
function evaluateTokens(tokens: MathToken[]): Big | null {
  if (!tokens || tokens.length === 0) return null;

  try {
    const reduced = applyMultiplicativeOperators(tokens);
    if (reduced === null) return null;
    return applyAdditiveOperators(reduced.values, reduced.ops);
  } catch {
    return null;
  }
}

/**
 * Phase 1: apply * and / immediately (higher precedence), leaving the + / - operators and the
 * operands between them. Returns null on division by zero.
 */
function applyMultiplicativeOperators(
  tokens: MathToken[],
): { values: Big[]; ops: string[] } | null {
  const values: Big[] = [new Big(tokens[0] as string)];
  const ops: string[] = [];

  for (let i = 1; i < tokens.length - 1; i += 2) {
    const op = tokens[i] as string;
    const right = new Big(tokens[i + 1] as string);

    if (op !== '*' && op !== '/') {
      ops.push(op);
      values.push(right);
      continue;
    }

    const left = values[values.length - 1] as Big;
    if (op === '/' && right.eq(0)) return null;
    values[values.length - 1] = op === '/' ? left.div(right) : left.times(right);
  }

  return { values, ops };
}

/** Phase 2: apply + and - (lower precedence, left to right). */
function applyAdditiveOperators(values: Big[], ops: string[]): Big {
  let result = values[0] as Big;
  for (let j = 0; j < ops.length; j++) {
    const op = ops[j] as string;
    const right = values[j + 1] as Big;
    if (op === '+') result = result.plus(right);
    else if (op === '-') result = result.minus(right);
  }
  return result;
}

/**
 * Evaluate a simple math expression (no eval, no Function).
 * Supports: +, -, *, ×, /
 * Does NOT support: parentheses
 *
 * Returns null for invalid expressions, single numbers, or division by zero.
 * No upper bound on the result — callers apply their own limits as needed.
 *
 * Examples: "10*3" → Big(30), "100/4" → Big(25), "10*3+5" → Big(35)
 */
export function evaluateMathExpressionBig(expr: string): Big | null {
  // Remove spaces
  const cleaned = expr.replace(/\s+/g, '');

  // Validate: only digits, optional single decimal separator, and operators +*/×
  // Must have at least one operator (single numbers are not expressions).
  // \d+(?:[.,]\d+)? prevents multi-separator tokens like 1.2.3
  if (!/^\d+(?:[.,]\d+)?([+\-*×/]\d+(?:[.,]\d+)?)+$/.test(cleaned)) {
    return null;
  }

  const tokens = tokenize(cleaned);
  if (!tokens) return null;

  return evaluateTokens(tokens);
}

/** Convenience wrapper that converts the Big result to a JS number. */
function evaluateMathExpression(expr: string): number | null {
  return evaluateMathExpressionBig(expr)?.toNumber() ?? null;
}

// ── End math expression evaluator ─────────────────────────────────────

/**
 * Normalize currency code from alias
 */
function normalizeCurrency(currencyStr: string): CurrencyCode | null {
  const normalized = currencyStr.toLowerCase().trim();
  return (CURRENCY_ALIASES[normalized] as CurrencyCode) || null;
}

/**
 * Parse expense message
 *
 * Supported formats:
 * - 190 евро Алекс кулёма
 * - 190е Алекс кулёма
 * - 190д Алекс кулёма
 * - 190$ Алекс кулёма
 * - 190 $ Алекс кулёма
 * - $190 Алекс кулёма
 * - $ 190 евро Алекс кулёма
 * - 190 euro Алекс кулёма
 * - 190 Eur Алекс кулёма
 * - 190 EUR Алекс кулёма
 * - 1 900 RSD   Алекс
 * - 10*3$ food pizza (math expressions)
 */
export function parseExpenseMessage(
  text: string,
  defaultCurrency: CurrencyCode,
): ParsedExpense | null {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  return (
    parseSymbolBeforeAmount(trimmed) ??
    parseCurrencyAfterAmount(trimmed) ??
    parseAmountOnly(trimmed, defaultCurrency) ??
    parseCyrillicLetterCurrency(trimmed)
  );
}

/** Assemble a ParsedExpense from the matched pieces; null if amount or currency is invalid. */
function buildParsedExpense(
  raw: string,
  amountStr: string,
  currency: CurrencyCode | null,
  rest: string,
): ParsedExpense | null {
  if (!currency) return null;
  const amount = parseAmount(amountStr);
  if (amount === null) return null;

  const { category, comment } = parseRest(rest);
  return { amount, currency, category, comment, raw };
}

// Pattern 1: Currency symbol before amount ($190, €100, ₽500, $10*3)
function parseSymbolBeforeAmount(trimmed: string): ParsedExpense | null {
  const match = trimmed.match(/^([$€£₽¥])\s*([\d\s,.+*×/]+)\s*(.+)?$/);
  if (!match) return null;

  const [, currencySymbol, amountStr, rest] = match;
  if (!currencySymbol || !amountStr) return null;
  return buildParsedExpense(trimmed, amountStr, normalizeCurrency(currencySymbol), rest || '');
}

// Pattern 2: Amount with currency symbol/code after (190€, 100$, 1900RSD, 190 евро, 10*3$)
function parseCurrencyAfterAmount(trimmed: string): ParsedExpense | null {
  const match = trimmed.match(/^([\d\s,.+*×/]+)\s*([а-яА-ЯёЁa-zA-Z$€£₽¥]+)\s+(.+)$/);
  if (!match) return null;

  const [, amountStr, currencyStr, rest] = match;
  if (!amountStr || !currencyStr || !rest) return null;
  return buildParsedExpense(trimmed, amountStr, normalizeCurrency(currencyStr), rest);
}

// Pattern 3: Amount only (use default currency), must start with digit
function parseAmountOnly(trimmed: string, defaultCurrency: CurrencyCode): ParsedExpense | null {
  const match = trimmed.match(/^(\d[\d\s,.+*×/]*)\s+(.+)$/);
  if (!match) return null;

  const [, amountStr, rest] = match;
  if (!amountStr || !rest) return null;
  return buildParsedExpense(trimmed, amountStr, defaultCurrency, rest);
}

// Pattern 4: Currency symbol after, no space (190е, 100д, 10*3д)
function parseCyrillicLetterCurrency(trimmed: string): ParsedExpense | null {
  const match = trimmed.match(/^([\d\s,.+*×/]+)([а-яА-ЯёЁ])\s+(.+)$/);
  if (!match) return null;

  const [, amountStr, currencyLetter, rest] = match;
  if (!amountStr || !currencyLetter || !rest) return null;
  return buildParsedExpense(trimmed, amountStr, normalizeCurrency(currencyLetter), rest);
}

/**
 * Parse amount string to number
 * Handles: 190, 1900, 1 900, 1,900, 1.900, 1900.50
 * Also handles math expressions: 10*3, 100/4, 10+5, 10*3+5
 */
function parseAmount(amountStr: string): number | null {
  try {
    // Remove spaces
    let cleaned = amountStr.replace(/\s+/g, '');

    // Check if this is a math expression (contains operator)
    if (/[+\-*×/]/.test(cleaned)) {
      const result = evaluateMathExpression(cleaned);
      if (result === null || result <= 0) return null;
      // Round to 2 decimal places (e.g. 100/3 = 33.333... → 33.33)
      return Math.round(result * 100) / 100;
    }

    // Handle European format (1.234,56 -> 1234.56)
    if (cleaned.match(/\d+\.\d{3},\d{2}$/)) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    }
    // Handle US format with comma thousands separator (1,234.56)
    else if (cleaned.match(/\d+,\d{3}(\.\d+)?$/)) {
      cleaned = cleaned.replace(/,/g, '');
    }
    // Handle just comma as decimal separator (1234,56 -> 1234.56)
    else if (cleaned.match(/^\d+,\d{1,2}$/)) {
      cleaned = cleaned.replace(',', '.');
    }

    const parsed = currency(cleaned, { separator: '', decimal: '.' });

    if (parsed.value <= 0) {
      return null;
    }

    return parsed.value;
  } catch {
    return null;
  }
}

import { normalizeCategoryName as normalizeCategory } from '../../utils/fuzzy-search';

/**
 * Parse rest of message (category and comment)
 * First word is category, rest is comment
 */
function parseRest(rest: string | undefined): {
  category: string | null;
  comment: string;
} {
  const trimmedRest = (rest || '').trim();

  if (!trimmedRest) {
    return { category: null, comment: '' };
  }

  const words = trimmedRest.split(/\s+/).filter((w) => w);

  if (words.length === 0) {
    return { category: null, comment: trimmedRest };
  }

  if (words.length === 1) {
    // Only category, no comment
    return { category: normalizeCategory(words[0] ?? ''), comment: '' };
  }

  // Category is first word, comment is the rest (also capitalized)
  const category = normalizeCategory(words[0] ?? '');
  const commentWords = words.slice(1);

  if (commentWords.length === 0) {
    return { category, comment: '' };
  }

  // Capitalize first word of comment, keep rest as-is
  const firstCommentWord = commentWords[0];
  if (!firstCommentWord) {
    return { category, comment: '' };
  }

  const normalizedFirst = normalizeCategory(firstCommentWord);
  const comment =
    commentWords.length > 1
      ? `${normalizedFirst} ${commentWords.slice(1).join(' ')}`
      : normalizedFirst;

  return { category, comment };
}

/**
 * Validate parsed expense
 *
 * Rules:
 * - Amount must be > 0
 * - Currency must be present
 * - Category is required
 * - Comment is optional
 */
export function validateParsedExpense(parsed: ParsedExpense | null): parsed is ParsedExpense {
  if (!parsed) {
    return false;
  }

  if (parsed.amount <= 0) {
    return false;
  }

  if (!parsed.currency) {
    return false;
  }

  // Category is required
  const hasCategory = parsed.category !== null && parsed.category.trim() !== '';

  if (!hasCategory) {
    return false;
  }

  return true;
}
