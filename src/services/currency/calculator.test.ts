import { describe, test, expect } from 'bun:test';
import { calculate, type CalculateResult } from './calculator';

describe('Calculator', () => {
  describe('Pure arithmetic (no currencies)', () => {
    test('simple addition', () => {
      const result = calculate('10+20');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(30);
    });

    test('simple subtraction', () => {
      const result = calculate('50-15');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(35);
    });

    test('simple multiplication', () => {
      const result = calculate('5*7');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(35);
    });

    test('simple division', () => {
      const result = calculate('100/4');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(25);
    });

    test('operator precedence', () => {
      const result = calculate('10+20*3');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(70); // 10 + (20*3), not (10+20)*3
    });

    test('parentheses', () => {
      const result = calculate('(10+5)*2');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(30);
    });

    test('nested parentheses', () => {
      const result = calculate('((2+3)*4)');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(20);
    });

    test('complex expression', () => {
      const result = calculate('(100+50)/3-10');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(40); // (150/3) - 10 = 50 - 10
    });
  });

  describe('Single currency amount', () => {
    test('single currency without conversion', () => {
      const result = calculate('100USD');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(100);
      expect((result as CalculateResult).currency).toBe('USD');
    });

    test('single currency with decimal', () => {
      const result = calculate('99.99EUR');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(99.99);
      expect((result as CalculateResult).currency).toBe('EUR');
    });
  });

  describe('Currency operations', () => {
    test('same currency addition', () => {
      const result = calculate('100USD+50USD');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(150);
      expect((result as CalculateResult).currency).toBe('USD');
    });

    test('same currency subtraction', () => {
      const result = calculate('100USD-30USD');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(70);
      expect((result as CalculateResult).currency).toBe('USD');
    });

    test('same currency multiplication', () => {
      const result = calculate('10USD*5');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(50);
      expect((result as CalculateResult).currency).toBe('USD');
    });

    test('same currency division', () => {
      const result = calculate('100USD/4');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(25);
      expect((result as CalculateResult).currency).toBe('USD');
    });

    test('mixed currencies addition (uses EUR as default)', () => {
      // 100 USD + 50 EUR in EUR
      // 100 USD ≈ 93 EUR, so 93 + 50 = 143 EUR
      const result = calculate('100USD+50EUR');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).currency).toBe('EUR'); // Mixed currencies default to EUR
      // We need to check the actual conversion
      const expectedInEUR = 100 * 0.93 + 50; // Using fallback rates
      expect((result as CalculateResult).value).toBeCloseTo(expectedInEUR, 1);
    });

    test('complex currency expression', () => {
      const result = calculate('(100USD+50EUR)*2');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).currency).toBe('EUR');
    });

    test('currency division by number', () => {
      const result = calculate('100USD/3');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBeCloseTo(33.33, 1);
      expect((result as CalculateResult).currency).toBe('USD');
    });
  });

  describe('Currency conversion', () => {
    test('convert single currency to target', () => {
      const result = calculate('100USD', 'EUR');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).currency).toBe('EUR');
      // 100 USD ≈ 93 EUR
      expect((result as CalculateResult).value).toBeCloseTo(93, 0);
    });

    test('convert result to different currency', () => {
      const result = calculate('100EUR+50EUR', 'USD');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).currency).toBe('USD');
      // 150 EUR ≈ 161 USD (1/0.93)
      expect((result as CalculateResult).value).toBeCloseTo(161, 0);
    });
  });

  describe('Error handling', () => {
    test('division by zero', () => {
      const result = calculate('10/0');
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('Division by zero');
    });

    test('invalid currency code', () => {
      const result = calculate('100XYZ');
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('Unknown currency');
    });

    test('empty expression', () => {
      const result = calculate('');
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('Empty expression');
    });

    test('invalid syntax - missing operator', () => {
      const result = calculate('10 20');
      expect(result.success).toBe(false);
    });

    test('invalid syntax - unbalanced parentheses', () => {
      const result = calculate('(10+20');
      expect(result.success).toBe(false);
    });

    test('invalid syntax - extra operator', () => {
      const result = calculate('10++20');
      expect(result.success).toBe(false);
    });
  });

  describe('Formatting', () => {
    test('format result with currency', () => {
      const result = calculate('100USD');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).formatted).toBe('100.00 USD');
    });

    test('format result with conversion', () => {
      const result = calculate('100USD', 'EUR');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).formatted).toMatch(/\d+\.\d{2} EUR/);
    });
  });

  // NEW TESTS FOR CODE REVIEW ISSUES

  describe('Pure numeric results (no currency)', () => {
    test('pure numeric expression should have no currency in formatted output', () => {
      const result = calculate('10+20');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(30);
      // BUG FIX: pure numeric should not have currency
      expect((result as CalculateResult).currency).toBeNull();
      expect((result as CalculateResult).formatted).toBe('30.00');
    });

    test('pure numeric with target currency should apply target currency', () => {
      const result = calculate('10+20', 'EUR');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(30);
      expect((result as CalculateResult).currency).toBe('EUR');
      expect((result as CalculateResult).formatted).toBe('30.00 EUR');
    });

    test('complex pure numeric expression - no currency', () => {
      const result = calculate('(10+5)*2/3');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).currency).toBeNull();
      expect((result as CalculateResult).formatted).toBe('10.00');
    });
  });

  describe('Currency division by same currency (dimensionless ratio)', () => {
    test('same currency division should produce dimensionless result', () => {
      const result = calculate('100USD/50USD');
      expect(result.success).toBe(true);
      // 100USD / 50USD = 2 (dimensionless ratio)
      expect((result as CalculateResult).value).toBe(2);
      expect((result as CalculateResult).currency).toBeNull();
      expect((result as CalculateResult).formatted).toBe('2.00');
    });

    test('same currency division with target currency', () => {
      const result = calculate('100USD/50USD', 'EUR');
      expect(result.success).toBe(true);
      expect((result as CalculateResult).value).toBe(2);
      expect((result as CalculateResult).currency).toBe('EUR');
      expect((result as CalculateResult).formatted).toBe('2.00 EUR');
    });
  });

  describe('Malformed number inputs', () => {
    test('rejects double decimal points', () => {
      const result = calculate('1..2+3');
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('Invalid number');
    });

    test('rejects trailing decimal point with another decimal', () => {
      const result = calculate('.1.+2');
      expect(result.success).toBe(false);
    });

    test('rejects multiple decimals in number', () => {
      const result = calculate('1.2.3+4');
      expect(result.success).toBe(false);
    });
  });

  describe('Overflow/underflow protection', () => {
    test('handles very large numbers', () => {
      const result = calculate('1e308*10');
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toMatch(/too large|overflow|infinity/i);
    });

    test('handles multiplication overflow', () => {
      const result = calculate('99999999999999999999*99999999999999999999');
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toMatch(/too large|overflow|infinity/i);
    });

    test('handles division resulting in infinity', () => {
      const result = calculate('1e308/0.0000001');
      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toMatch(/too large|overflow|infinity/i);
    });
  });

  describe('convertCurrency error handling', () => {
    // Note: These tests assume convertCurrency could throw for unavailable rates
    // Since current implementation has fallback rates, these are defensive tests
    test('currency operations should not crash on conversion errors', () => {
      // This test ensures the calculator handles conversion errors gracefully
      // In current implementation, fallback rates exist so this won't throw
      // But the try-catch should be in place for future-proofing
      const result = calculate('100USD+50EUR');
      expect(result.success).toBe(true);
    });
  });
});
