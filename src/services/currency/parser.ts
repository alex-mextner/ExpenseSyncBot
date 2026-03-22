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

type MathToken = number | '+' | '*' | '/';

/**
 * Tokenize a cleaned math expression into alternating numbers and operators.
 * Returns null if the expression is structurally invalid.
 */
function tokenize(expr: string): MathToken[] | null {
  const tokens: MathToken[] = [];
  const regex = /(\d+(?:[.,]\d+)?)|([+*×/])/g;

  for (const match of expr.matchAll(regex)) {
    if (match[1]) {
      let numStr = match[1];
      if (numStr.includes(',')) {
        numStr = numStr.replace(',', '.');
      }
      const num = parseFloat(numStr);
      if (Number.isNaN(num)) return null;
      tokens.push(num);
    } else if (match[2]) {
      const op = match[2] === '×' ? '*' : match[2];
      tokens.push(op as MathToken);
    }
  }

  // Must alternate number-operator-number: minimum 3 tokens, always odd count
  if (tokens.length < 3 || tokens.length % 2 === 0) return null;

  for (let i = 0; i < tokens.length; i++) {
    const isNumber = i % 2 === 0;
    if (isNumber && typeof tokens[i] !== 'number') return null;
    if (!isNumber && typeof tokens[i] !== 'string') return null;
  }

  return tokens;
}

/**
 * Evaluate tokens with standard operator precedence (* / before +).
 * Returns null on division by zero.
 */
function evaluateTokens(tokens: MathToken[]): number | null {
  if (!tokens || tokens.length === 0) return null;

  // Phase 1: handle * and / (higher precedence)
  const addQueue: MathToken[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (i + 2 <= tokens.length) {
      const op = tokens[i + 1];
      if (op === '*' || op === '/') {
        let left = tokens[i] as number;
        // Consume all consecutive * and /
        while (i + 2 < tokens.length && (tokens[i + 1] === '*' || tokens[i + 1] === '/')) {
          const operator = tokens[i + 1] as string;
          const right = tokens[i + 2] as number;
          if (operator === '*') {
            left *= right;
          } else {
            if (right === 0) return null;
            left = left / right;
          }
          i += 2;
        }
        addQueue.push(left);
        i++;
        continue;
      }
    }
    const token = tokens[i];
    if (token !== undefined) addQueue.push(token);
    i++;
  }

  // Phase 2: handle + (lower precedence)
  let result = addQueue[0] as number;
  for (let j = 1; j < addQueue.length; j += 2) {
    const op = addQueue[j];
    const right = addQueue[j + 1] as number;
    if (op === '+') result += right;
  }

  return result;
}

/**
 * Evaluate a simple math expression (no eval, no Function).
 * Supports: +, *, ×, /
 * Does NOT support: -, parentheses
 *
 * Returns null for invalid expressions, single numbers, overflow, or division by zero.
 *
 * Examples: "10*3" → 30, "100/4" → 25, "10*3+5" → 35
 */
export function evaluateMathExpression(expr: string): number | null {
  // Remove spaces
  const cleaned = expr.replace(/\s+/g, '');

  // Safety: reject overly long expressions
  if (cleaned.length > 50) return null;

  // Validate: only digits, dots, commas, and operators +*/×
  // Must have at least one operator (single numbers are not expressions)
  if (!/^[\d.,]+([+*×/][\d.,]+)+$/.test(cleaned)) {
    return null;
  }

  // Tokenize
  const tokens = tokenize(cleaned);
  if (!tokens) return null;

  // Safety: max 10 operators
  const opCount = tokens.filter((t) => typeof t === 'string').length;
  if (opCount > 10) return null;

  // Evaluate with operator precedence (* / before +)
  const result = evaluateTokens(tokens);

  // Safety: reject unreasonable amounts
  if (result === null || result >= 10_000_000) return null;

  return result;
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

  // Pattern 1: Currency symbol before amount ($190, €100, ₽500, $10*3)
  const pattern1 = /^([$€£₽¥])\s*([\d\s,.+*×/]+)\s*(.+)?$/;
  const match1 = trimmed.match(pattern1);

  if (match1) {
    const [, currencySymbol, amountStr, rest] = match1;
    if (!currencySymbol || !amountStr) return null;
    const normalizedCurrency = normalizeCurrency(currencySymbol);

    if (normalizedCurrency) {
      const amount = parseAmount(amountStr);
      if (amount !== null) {
        const { category, comment } = parseRest(rest || '');
        return {
          amount,
          currency: normalizedCurrency,
          category,
          comment,
          raw: trimmed,
        };
      }
    }
  }

  // Pattern 2: Amount with currency symbol/code after (190€, 100$, 1900RSD, 190 евро, 10*3$)
  const pattern2 = /^([\d\s,.+*×/]+)\s*([а-яА-ЯёЁa-zA-Z$€£₽¥]+)\s+(.+)$/;
  const match2 = trimmed.match(pattern2);

  if (match2) {
    const [, amountStr, currencyStr, rest] = match2;
    if (!amountStr || !currencyStr || !rest) return null;
    const amount = parseAmount(amountStr);
    const normalizedCurrency = normalizeCurrency(currencyStr);

    if (amount !== null && normalizedCurrency) {
      const { category, comment } = parseRest(rest);
      return {
        amount,
        currency: normalizedCurrency,
        category,
        comment,
        raw: trimmed,
      };
    }
  }

  // Pattern 3: Amount only (use default currency), must start with digit
  const pattern3 = /^(\d[\d\s,.+*×/]*)\s+(.+)$/;
  const match3 = trimmed.match(pattern3);

  if (match3) {
    const [, amountStr, rest] = match3;
    if (!amountStr || !rest) return null;
    const amount = parseAmount(amountStr);

    if (amount !== null) {
      const { category, comment } = parseRest(rest);
      return {
        amount,
        currency: defaultCurrency,
        category,
        comment,
        raw: trimmed,
      };
    }
  }

  // Pattern 4: Currency symbol after, no space (190е, 100д, 10*3д)
  const pattern4 = /^([\d\s,.+*×/]+)([а-яА-ЯёЁ])\s+(.+)$/;
  const match4 = trimmed.match(pattern4);

  if (match4) {
    const [, amountStr, currencyLetter, rest] = match4;
    if (!amountStr || !currencyLetter || !rest) return null;
    const amount = parseAmount(amountStr);
    const normalizedCurrency = normalizeCurrency(currencyLetter);

    if (amount !== null && normalizedCurrency) {
      const { category, comment } = parseRest(rest);
      return {
        amount,
        currency: normalizedCurrency,
        category,
        comment,
        raw: trimmed,
      };
    }
  }

  return null;
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
    if (/[+*×/]/.test(cleaned)) {
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
  } catch (_err) {
    return null;
  }
}

/**
 * Normalize category name - capitalize first letter
 */
function normalizeCategory(category: string): string {
  const trimmed = category.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

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
