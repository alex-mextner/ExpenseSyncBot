// Tests for sheet write error tracking and budget alert logic in message handler

import { describe, expect, it } from 'bun:test';
import {
  buildBudgetAlertStatus,
  getSheetWriteErrorMessage,
  resetSheetWriteFailures,
} from './message.handler';

describe('getSheetWriteErrorMessage', () => {
  it('returns simple retry message on first failure', () => {
    resetSheetWriteFailures(999);
    const msg = getSheetWriteErrorMessage(999);
    expect(msg).toContain('Попробуй ещё раз');
    expect(msg).not.toContain('/reconnect');
  });

  it('suggests /reconnect on second consecutive failure', () => {
    resetSheetWriteFailures(998);
    getSheetWriteErrorMessage(998);
    const msg = getSheetWriteErrorMessage(998);
    expect(msg).toContain('/reconnect');
  });

  it('suggests /reconnect on third+ consecutive failure', () => {
    resetSheetWriteFailures(997);
    getSheetWriteErrorMessage(997);
    getSheetWriteErrorMessage(997);
    const msg = getSheetWriteErrorMessage(997);
    expect(msg).toContain('/reconnect');
  });

  it('resets counter after resetSheetWriteFailures', () => {
    resetSheetWriteFailures(996);
    getSheetWriteErrorMessage(996);
    getSheetWriteErrorMessage(996);
    resetSheetWriteFailures(996);
    const msg = getSheetWriteErrorMessage(996);
    expect(msg).toContain('Попробуй ещё раз');
    expect(msg).not.toContain('/reconnect');
  });

  it('tracks failures independently per group', () => {
    resetSheetWriteFailures(100);
    resetSheetWriteFailures(200);
    getSheetWriteErrorMessage(100);
    getSheetWriteErrorMessage(100);
    const msg100 = getSheetWriteErrorMessage(100);
    const msg200 = getSheetWriteErrorMessage(200);
    expect(msg100).toContain('/reconnect');
    expect(msg200).not.toContain('/reconnect');
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
