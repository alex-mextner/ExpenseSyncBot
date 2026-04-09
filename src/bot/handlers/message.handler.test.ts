// Tests for sheet write error tracking and budget alert logic in message handler

import { describe, expect, it } from 'bun:test';
import { buildBudgetAlertStatus, SHEET_WRITE_ERROR } from './message.handler';

describe('SHEET_WRITE_ERROR', () => {
  it('mentions /connect for recovery', () => {
    expect(SHEET_WRITE_ERROR).toContain('/connect');
  });

  it('contains error indicator', () => {
    expect(SHEET_WRITE_ERROR).toContain('❌');
  });
});

describe('buildBudgetAlertStatus — budget currency conversion', () => {
  // RSD fallback rate: 1 RSD = 0.0086 EUR → 1 EUR ≈ 116 RSD
  // 100 EUR ≈ 11 600 RSD; budget limit = 15 000 RSD → ~77%

  it('converts EUR spending to budget currency before computing percentage', () => {
    const result = buildBudgetAlertStatus(100, { limit_amount: 15_000, currency: 'RSD' });
    // 100 EUR ≈ 11 600 RSD, so percentage should be around 77%, not 0.67%
    expect(result.percentage).toBeGreaterThan(50);
    expect(result.percentage).toBeLessThan(100);
  });

  it('isExceeded is false when EUR spending converts below limit', () => {
    // 100 EUR ≈ 11 600 RSD < 15 000 RSD limit
    const result = buildBudgetAlertStatus(100, { limit_amount: 15_000, currency: 'RSD' });
    expect(result.isExceeded).toBe(false);
  });

  it('isExceeded is true when EUR spending converts above limit', () => {
    // 200 EUR ≈ 23 200 RSD > 15 000 RSD limit
    const result = buildBudgetAlertStatus(200, { limit_amount: 15_000, currency: 'RSD' });
    expect(result.isExceeded).toBe(true);
  });

  it('isWarning triggers when spending is 90–99% of limit in budget currency', () => {
    // 125 EUR ≈ 14 500 RSD, limit 15 000 RSD → ~97% → warning
    const result = buildBudgetAlertStatus(125, { limit_amount: 15_000, currency: 'RSD' });
    expect(result.isWarning).toBe(true);
    expect(result.isExceeded).toBe(false);
  });

  it('EUR budget: 1:1, no conversion needed', () => {
    const result = buildBudgetAlertStatus(150, { limit_amount: 200, currency: 'EUR' });
    expect(result.percentage).toBe(75);
    expect(result.isExceeded).toBe(false);
  });

  it('spentInCurrency is in budget currency, not EUR', () => {
    const result = buildBudgetAlertStatus(100, { limit_amount: 15_000, currency: 'RSD' });
    // spentInCurrency should be ~11 600 RSD, not 100
    expect(result.spentInCurrency).toBeGreaterThan(1_000);
  });
});
