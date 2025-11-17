import { test, expect, describe } from "bun:test";
import { parseExpenseMessage, validateParsedExpense } from "./parser";

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
      expect(result?.amount).toBe(150.50);
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
      expect(result?.amount).toBe(100.50);
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
