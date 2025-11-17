import currency from "currency.js";
import { CURRENCY_ALIASES, type CurrencyCode } from "../../config/constants";

export interface ParsedExpense {
  amount: number;
  currency: CurrencyCode;
  category: string | null;
  comment: string;
  raw: string;
}

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
 */
export function parseExpenseMessage(
  text: string,
  defaultCurrency: CurrencyCode
): ParsedExpense | null {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  // Pattern 1: Currency symbol before amount ($190, €100, ₽500)
  const pattern1 = /^([\$€£₽¥])\s*([\d\s,\.]+)\s*(.+)?$/;
  const match1 = trimmed.match(pattern1);

  if (match1) {
    const [, currencySymbol, amountStr, rest] = match1;
    if (!currencySymbol || !amountStr) return null;
    const normalizedCurrency = normalizeCurrency(currencySymbol);

    if (normalizedCurrency) {
      const amount = parseAmount(amountStr);
      if (amount !== null) {
        const { category, comment } = parseRest(rest || "");
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

  // Pattern 2: Amount with currency symbol/code after (190€, 100$, 1900RSD, 190 евро)
  const pattern2 = /^([\d\s,\.]+)\s*([а-яА-ЯёЁa-zA-Z\$€£₽¥]+)\s+(.+)$/;
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

  // Pattern 3: Amount only (use default currency)
  const pattern3 = /^([\d\s,\.]+)\s+(.+)$/;
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

  // Pattern 4: Currency symbol after, no space (190е, 100д)
  const pattern4 = /^([\d\s,\.]+)([а-яА-ЯёЁ])\s+(.+)$/;
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
 */
function parseAmount(amountStr: string): number | null {
  try {
    // Remove spaces
    let cleaned = amountStr.replace(/\s+/g, "");

    // Handle European format (1.234,56 -> 1234.56)
    if (cleaned.match(/\d+\.\d{3},\d{2}$/)) {
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    }
    // Handle US format with comma thousands separator (1,234.56)
    else if (cleaned.match(/\d+,\d{3}(\.\d+)?$/)) {
      cleaned = cleaned.replace(/,/g, "");
    }
    // Handle just comma as decimal separator (1234,56 -> 1234.56)
    else if (cleaned.match(/^\d+,\d{1,2}$/)) {
      cleaned = cleaned.replace(",", ".");
    }

    const parsed = currency(cleaned, { separator: "", decimal: "." });

    if (parsed.value <= 0) {
      return null;
    }

    return parsed.value;
  } catch (err) {
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
  const trimmedRest = (rest || "").trim();

  if (!trimmedRest) {
    return { category: null, comment: "" };
  }

  const words = trimmedRest.split(/\s+/).filter((w) => w);

  if (words.length === 0) {
    return { category: null, comment: trimmedRest };
  }

  if (words.length === 1) {
    // Only category, no comment
    return { category: normalizeCategory(words[0]!), comment: "" };
  }

  // Category is first word, comment is the rest (also capitalized)
  const category = normalizeCategory(words[0]!);
  const commentWords = words.slice(1);

  if (commentWords.length === 0) {
    return { category, comment: "" };
  }

  // Capitalize first word of comment, keep rest as-is
  const firstCommentWord = commentWords[0];
  if (!firstCommentWord) {
    return { category, comment: "" };
  }

  const normalizedFirst = normalizeCategory(firstCommentWord);
  const comment = commentWords.length > 1
    ? `${normalizedFirst} ${commentWords.slice(1).join(" ")}`
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
export function validateParsedExpense(
  parsed: ParsedExpense | null
): parsed is ParsedExpense {
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
  const hasCategory = parsed.category !== null && parsed.category.trim() !== "";

  if (!hasCategory) {
    return false;
  }

  return true;
}
