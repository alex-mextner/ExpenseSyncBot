import { test, expect, describe } from "bun:test";
import {
  parseExpenseMessage,
  validateParsedExpense,
  evaluateMathExpression,
} from "./parser";

describe("parseExpenseMessage", () => {
  describe("valid formats", () => {
    test("should parse amount with currency symbol before ($ prefix)", () => {
      const result = parseExpenseMessage("$100 food lunch", "USD");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(100);
      expect(result?.currency).toBe("USD");
      expect(result?.category).toBe("Food");
      expect(result?.comment).toBe("Lunch");
    });

    test("should parse amount with currency symbol after (€ suffix)", () => {
      const result = parseExpenseMessage("190 евро Алекс кулёма", "USD");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(190);
      expect(result?.currency).toBe("EUR");
      expect(result?.category).toBe("Алекс");
      expect(result?.comment).toBe("Кулёма");
    });

    test("should parse amount with short currency (е for EUR)", () => {
      const result = parseExpenseMessage("190е Алекс кулёма", "USD");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(190);
      expect(result?.currency).toBe("EUR");
      expect(result?.category).toBe("Алекс");
      expect(result?.comment).toBe("Кулёма");
    });

    test("should parse amount with short currency (д for USD)", () => {
      const result = parseExpenseMessage("190д Алекс кулёма", "USD");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(190);
      expect(result?.currency).toBe("USD");
      expect(result?.category).toBe("Алекс");
      expect(result?.comment).toBe("Кулёма");
    });

    test("should parse abbreviated currency (дол for USD)", () => {
      const result = parseExpenseMessage("1 дол алекс тест", "EUR");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(1);
      expect(result?.currency).toBe("USD");
      expect(result?.category).toBe("Алекс");
      expect(result?.comment).toBe("Тест");
    });

    test("should parse amount with currency code (RSD)", () => {
      const result = parseExpenseMessage("1900 RSD транспорт", "USD");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(1900);
      expect(result?.currency).toBe("RSD");
      expect(result?.category).toBe("Транспорт");
    });

    test("should parse amount with spaces in number (1 900)", () => {
      const result = parseExpenseMessage("1 900 RSD транспорт", "USD");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(1900);
      expect(result?.currency).toBe("RSD");
    });

    test("should use default currency when no currency specified", () => {
      const result = parseExpenseMessage("100 food lunch", "EUR");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(100);
      expect(result?.currency).toBe("EUR");
      expect(result?.category).toBe("Food");
    });

    test("should parse decimal amounts", () => {
      const result = parseExpenseMessage("150.50 USD food", "USD");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(150.5);
      expect(result?.currency).toBe("USD");
    });

    test("should normalize category to capitalize first letter", () => {
      const result = parseExpenseMessage("100 USD food lunch", "USD");
      expect(result).not.toBeNull();
      expect(result?.category).toBe("Food");
    });

    test("should normalize category from lowercase", () => {
      const result = parseExpenseMessage("100 USD алекс обед", "USD");
      expect(result).not.toBeNull();
      expect(result?.category).toBe("Алекс");
    });

    test("should normalize category from uppercase", () => {
      const result = parseExpenseMessage("100 USD FOOD lunch", "USD");
      expect(result).not.toBeNull();
      expect(result?.category).toBe("Food");
    });

    test("should parse translit currency (рсд)", () => {
      const result = parseExpenseMessage("1900 рсд транспорт такси", "USD");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(1900);
      expect(result?.currency).toBe("RSD");
      expect(result?.category).toBe("Транспорт");
    });

    test("should parse translit currency (усд)", () => {
      const result = parseExpenseMessage("100 усд еда обед", "EUR");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(100);
      expect(result?.currency).toBe("USD");
      expect(result?.category).toBe("Еда");
    });

    test("should parse translit currency (еур)", () => {
      const result = parseExpenseMessage("50 еур кофе", "USD");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(50);
      expect(result?.currency).toBe("EUR");
      expect(result?.category).toBe("Кофе");
    });
  });

  describe("invalid formats", () => {
    test("should return null for empty string", () => {
      const result = parseExpenseMessage("", "USD");
      expect(result).toBeNull();
    });

    test("should return null for amount only (no comment)", () => {
      const result = parseExpenseMessage("100", "USD");
      expect(result).toBeNull();
    });

    test("should parse amount with currency as category (100 USD parsed as default currency + category USD)", () => {
      const result = parseExpenseMessage("100 USD", "EUR");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(100);
      expect(result?.currency).toBe("EUR"); // Uses default currency
      expect(result?.category).toBe("Usd");
      expect(result?.comment).toBe(""); // Single word = category only, no comment
    });

    test("should return null for invalid amount", () => {
      const result = parseExpenseMessage("abc USD food", "USD");
      expect(result).toBeNull();
    });

    test("should return null for negative amount", () => {
      const result = parseExpenseMessage("-100 USD food", "USD");
      expect(result).toBeNull();
    });

    test("should return null for zero amount", () => {
      const result = parseExpenseMessage("0 USD food", "USD");
      expect(result).toBeNull();
    });
  });

  describe("edge cases", () => {
    test("should handle single word as category only (no comment)", () => {
      const result = parseExpenseMessage("100 USD food", "USD");
      expect(result).not.toBeNull();
      expect(result?.category).toBe("Food");
      expect(result?.comment).toBe("");
    });

    test("should handle multiple spaces between words", () => {
      const result = parseExpenseMessage("100   USD   food   lunch", "USD");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(100);
      expect(result?.currency).toBe("USD");
    });

    test("should handle comma as decimal separator", () => {
      const result = parseExpenseMessage("100,50 USD food", "USD");
      expect(result).not.toBeNull();
      expect(result?.amount).toBe(100.5);
    });

    test("should extract comment without category", () => {
      const result = parseExpenseMessage("100 USD food tasty lunch", "USD");
      expect(result).not.toBeNull();
      expect(result?.category).toBe("Food");
      expect(result?.comment).toBe("Tasty lunch");
    });
  });
});

describe("validateParsedExpense", () => {
  test("should validate correct expense", () => {
    const expense = {
      amount: 100,
      currency: "USD" as const,
      category: "Food",
      comment: "lunch",
      raw: "100 USD food lunch",
    };
    expect(validateParsedExpense(expense)).toBe(true);
  });

  test("should reject null", () => {
    expect(validateParsedExpense(null)).toBe(false);
  });

  test("should reject zero amount", () => {
    const expense = {
      amount: 0,
      currency: "USD" as const,
      category: "Food",
      comment: "lunch",
      raw: "0 USD food lunch",
    };
    expect(validateParsedExpense(expense)).toBe(false);
  });

  test("should reject negative amount", () => {
    const expense = {
      amount: -100,
      currency: "USD" as const,
      category: "Food",
      comment: "lunch",
      raw: "-100 USD food lunch",
    };
    expect(validateParsedExpense(expense)).toBe(false);
  });

  test("should accept expense with category but no comment", () => {
    const expense = {
      amount: 100,
      currency: "USD" as const,
      category: "Food",
      comment: "",
      raw: "100 USD food",
    };
    expect(validateParsedExpense(expense)).toBe(true);
  });

  test("should reject expense without category", () => {
    const expense = {
      amount: 100,
      currency: "USD" as const,
      category: null,
      comment: "lunch",
      raw: "100 USD lunch",
    };
    expect(validateParsedExpense(expense)).toBe(false);
  });
});

// ── Math expression evaluator tests ───────────────────────────────────

describe("evaluateMathExpression", () => {
  // Basic operations
  test("10*3 → 30", () => expect(evaluateMathExpression("10*3")).toBe(30));
  test("100/4 → 25", () => expect(evaluateMathExpression("100/4")).toBe(25));
  test("10+5 → 15", () => expect(evaluateMathExpression("10+5")).toBe(15));
  test("10×3 → 30 (unicode multiplication)", () =>
    expect(evaluateMathExpression("10×3")).toBe(30));

  // Combined (operator precedence)
  test("10*3+5 → 35", () => expect(evaluateMathExpression("10*3+5")).toBe(35));
  test("5+10*3 → 35", () => expect(evaluateMathExpression("5+10*3")).toBe(35));
  test("100/4+10 → 35", () =>
    expect(evaluateMathExpression("100/4+10")).toBe(35));
  test("10*2*3 → 60", () => expect(evaluateMathExpression("10*2*3")).toBe(60));
  test("2+3+5 → 10", () => expect(evaluateMathExpression("2+3+5")).toBe(10));

  // Decimals
  test("10.5*2 → 21", () => expect(evaluateMathExpression("10.5*2")).toBe(21));
  test("10,5*2 → 21 (comma as decimal)", () =>
    expect(evaluateMathExpression("10,5*2")).toBe(21));

  // Errors
  test("10/0 → null (division by zero)", () =>
    expect(evaluateMathExpression("10/0")).toBeNull());
  test("10**3 → null (double operator)", () =>
    expect(evaluateMathExpression("10**3")).toBeNull());
  test("*10 → null (leading operator)", () =>
    expect(evaluateMathExpression("*10")).toBeNull());
  test("10* → null (trailing operator)", () =>
    expect(evaluateMathExpression("10*")).toBeNull());
  test("abc → null (non-numeric)", () =>
    expect(evaluateMathExpression("abc")).toBeNull());
  test("empty string → null", () =>
    expect(evaluateMathExpression("")).toBeNull());

  // Single number is not an expression
  test("100 → null (not an expression)", () =>
    expect(evaluateMathExpression("100")).toBeNull());

  // Overflow
  test("999999*999999 → null (too large)", () =>
    expect(evaluateMathExpression("999999*999999")).toBeNull());

  // Division precision
  test("100/3 → ~33.333", () => {
    const result = evaluateMathExpression("100/3");
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(33.333, 2);
  });

  // Mixed decimal separators
  test("10.5+2,5 → 13", () =>
    expect(evaluateMathExpression("10.5+2,5")).toBe(13));

  // Trailing operator
  test("10+ → null", () => expect(evaluateMathExpression("10+")).toBeNull());

  // Spaces (evaluateMathExpression strips spaces)
  test("10 * 3 → 30 (spaces stripped)", () =>
    expect(evaluateMathExpression("10 * 3")).toBe(30));
});

// ── Math expressions in expense messages (integration) ────────────────

describe("math expressions in expenses", () => {
  // Multiplication
  test("10*3$ food pizza → $30", () => {
    const r = parseExpenseMessage("10*3$ food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("USD");
    expect(r?.category).toBe("Food");
  });

  test("$10*3 food pizza → $30", () => {
    const r = parseExpenseMessage("$10*3 food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("USD");
  });

  test("10*3 food pizza → 30 (default currency)", () => {
    const r = parseExpenseMessage("10*3 food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("EUR");
  });

  test("10*3д food pizza → $30", () => {
    const r = parseExpenseMessage("10*3д food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("USD");
  });

  test("10*3е food pizza → €30", () => {
    const r = parseExpenseMessage("10*3е food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("EUR");
  });

  test("10*3 EUR food pizza → €30", () => {
    const r = parseExpenseMessage("10*3 EUR food pizza", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("EUR");
  });

  // Division
  test("100/4€ food → €25", () => {
    const r = parseExpenseMessage("100/4€ food", "USD");
    expect(r?.amount).toBe(25);
    expect(r?.currency).toBe("EUR");
  });

  // Addition
  test("10+5$ food → $15", () => {
    const r = parseExpenseMessage("10+5$ food", "EUR");
    expect(r?.amount).toBe(15);
    expect(r?.currency).toBe("USD");
  });

  // Combined operators
  test("10*3+5 food → 35 (default)", () => {
    const r = parseExpenseMessage("10*3+5 food", "EUR");
    expect(r?.amount).toBe(35);
    expect(r?.currency).toBe("EUR");
  });

  // Decimals in expression
  test("10.5*2$ food → $21", () => {
    const r = parseExpenseMessage("10.5*2$ food", "EUR");
    expect(r?.amount).toBe(21);
    expect(r?.currency).toBe("USD");
  });

  // Unicode multiplication
  test("10×3 food → 30 (default)", () => {
    const r = parseExpenseMessage("10×3 food", "EUR");
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("EUR");
  });

  // --- Regression tests (existing functionality must not break) ---

  test("100$ food → $100 (no regression)", () => {
    const r = parseExpenseMessage("100$ food", "EUR");
    expect(r?.amount).toBe(100);
    expect(r?.currency).toBe("USD");
  });

  test("1 900 RSD транспорт → 1900 RSD (no regression)", () => {
    const r = parseExpenseMessage("1 900 RSD транспорт", "EUR");
    expect(r?.amount).toBe(1900);
    expect(r?.currency).toBe("RSD");
  });

  test("190е Алекс кулёма → €190 (no regression)", () => {
    const r = parseExpenseMessage("190е Алекс кулёма", "USD");
    expect(r?.amount).toBe(190);
    expect(r?.currency).toBe("EUR");
  });

  test("$100 food lunch → $100 (no regression)", () => {
    const r = parseExpenseMessage("$100 food lunch", "EUR");
    expect(r?.amount).toBe(100);
    expect(r?.currency).toBe("USD");
  });

  test("100 food lunch → 100 default (no regression)", () => {
    const r = parseExpenseMessage("100 food lunch", "EUR");
    expect(r?.amount).toBe(100);
    expect(r?.currency).toBe("EUR");
  });

  // Result <= 0 → null
  test("0*5 food → null", () => {
    const r = parseExpenseMessage("0*5 food", "EUR");
    expect(r).toBeNull();
  });

  // Overflow → null
  test("999999*999999 food → null (too large)", () => {
    const r = parseExpenseMessage("999999*999999 food", "EUR");
    expect(r).toBeNull();
  });

  // Division precision
  test("100/3 EUR food → 33.33", () => {
    const r = parseExpenseMessage("100/3 EUR food", "EUR");
    expect(r?.amount).toBe(33.33);
    expect(r?.currency).toBe("EUR");
  });

  // Spaces around operator
  test("10 * 3 food → 30 (behavior change from old parser)", () => {
    const r = parseExpenseMessage("10 * 3 food", "EUR");
    // With new regex: amount captures "10 * 3", parseAmount strips spaces → "10*3" → 30
    expect(r?.amount).toBe(30);
    expect(r?.currency).toBe("EUR");
  });

  // 1 900 food — regression with spaces in number
  test("1 900 food → 1900 (no regression, spaces in number)", () => {
    const r = parseExpenseMessage("1 900 food", "EUR");
    expect(r?.amount).toBe(1900);
    expect(r?.currency).toBe("EUR");
  });

  // Invalid expression should fail completely
  test("100+tax food → null (invalid expression)", () => {
    const r = parseExpenseMessage("100+tax food", "EUR");
    expect(r).toBeNull();
  });

  // 1 900*3 RSD — spaces + operator
  test("1 900*3 RSD food → 5700 RSD", () => {
    const r = parseExpenseMessage("1 900*3 RSD food", "EUR");
    expect(r?.amount).toBe(5700);
    expect(r?.currency).toBe("RSD");
  });
});

// ── BYN (Belarusian Ruble) currency tests ─────────────────────────────

describe("BYN currency parsing", () => {
  test("should parse 100 BYN food", () => {
    const result = parseExpenseMessage("100 BYN food", "EUR");
    expect(result).not.toBeNull();
    expect(result?.amount).toBe(100);
    expect(result?.currency).toBe("BYN");
    expect(result?.category).toBe("Food");
  });

  test("should parse 50б food (Cyrillic б alias)", () => {
    const result = parseExpenseMessage("50б food", "EUR");
    expect(result).not.toBeNull();
    expect(result?.amount).toBe(50);
    expect(result?.currency).toBe("BYN");
    expect(result?.category).toBe("Food");
  });

  test("should parse 100 бр food (Cyrillic бр alias)", () => {
    const result = parseExpenseMessage("100 бр food", "EUR");
    expect(result).not.toBeNull();
    expect(result?.amount).toBe(100);
    expect(result?.currency).toBe("BYN");
    expect(result?.category).toBe("Food");
  });

  test("should parse byn lowercase alias", () => {
    const result = parseExpenseMessage("75 byn coffee", "EUR");
    expect(result).not.toBeNull();
    expect(result?.amount).toBe(75);
    expect(result?.currency).toBe("BYN");
    expect(result?.category).toBe("Coffee");
  });

  test("should parse Br symbol (Latin)", () => {
    const result = parseExpenseMessage("120 Br lunch", "EUR");
    expect(result).not.toBeNull();
    expect(result?.amount).toBe(120);
    expect(result?.currency).toBe("BYN");
    expect(result?.category).toBe("Lunch");
  });

  test("should parse br lowercase symbol", () => {
    const result = parseExpenseMessage("80 br transport", "EUR");
    expect(result).not.toBeNull();
    expect(result?.amount).toBe(80);
    expect(result?.currency).toBe("BYN");
    expect(result?.category).toBe("Transport");
  });
});
