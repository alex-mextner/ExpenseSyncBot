// Tests for buildOldTxSummaryText — N+2 truncation rule and HTML escaping.

import { describe, expect, mock, test } from 'bun:test';
import type { BankTransaction } from '../../database/types';

mock.module('../../database', () => ({ database: {} }));
mock.module('../../config/env', () => ({
  env: { BOT_TOKEN: 'test', LARGE_TX_THRESHOLD_EUR: 500, NODE_ENV: 'test' },
}));
mock.module('node-cron', () => ({ default: { schedule: () => {} } }));
mock.module('./prefill', () => ({ preFillTransaction: async () => ({}) }));
mock.module('./telegram-sender', () => ({
  sendMessage: async () => null,
  editMessageText: async () => null,
}));

import { buildOldTxSummaryText } from './sync-service';

function makeTx(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: 1,
    connection_id: 1,
    external_id: 'ext-1',
    account_id: null,
    date: '2026-03-28',
    time: null,
    amount: 100,
    sign_type: 'debit',
    currency: 'RSD',
    merchant: 'METRO',
    merchant_normalized: null,
    mcc: null,
    raw_data: '{}',
    matched_expense_id: null,
    telegram_message_id: null,
    edit_in_progress: 0,
    awaiting_comment: 0,
    prefill_category: null,
    prefill_comment: null,
    status: 'pending',
    created_at: '2026-03-28T10:00:00Z',
    ...overrides,
  };
}

function makeTxList(count: number): { tx: BankTransaction; category: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    tx: makeTx({
      id: i + 1,
      external_id: `ext-${i + 1}`,
      date: `2026-03-${String(20 + (i % 10)).padStart(2, '0')}`,
      amount: 100 + i * 50,
      merchant: `Store ${i + 1}`,
    }),
    category: `cat-${i + 1}`,
  }));
}

describe('buildOldTxSummaryText', () => {
  test('shows all items when count <= 10', () => {
    const items = makeTxList(5);
    const text = buildOldTxSummaryText(items, 'TBC');
    expect(text).toContain('5 необработанных');
    expect(text).toContain('Store 1');
    expect(text).toContain('Store 5');
    expect(text).not.toContain('и ещё');
  });

  test('shows all items when count is 12 (N+2: 12-10=2 < 3)', () => {
    const items = makeTxList(12);
    const text = buildOldTxSummaryText(items, 'TBC');
    expect(text).toContain('12 необработанных');
    expect(text).toContain('Store 12');
    expect(text).not.toContain('и ещё');
  });

  test('truncates when count is 13 (N+2: 13-10=3 >= 3)', () => {
    const items = makeTxList(13);
    const text = buildOldTxSummaryText(items, 'TBC');
    expect(text).toContain('13 необработанных');
    expect(text).toContain('Store 10');
    expect(text).not.toContain('Store 11');
    expect(text).toContain('и ещё 3');
  });

  test('truncates when count is 20', () => {
    const items = makeTxList(20);
    const text = buildOldTxSummaryText(items, 'TBC');
    expect(text).toContain('и ещё 10');
  });

  test('escapes HTML in bank name and merchant', () => {
    const items = [
      {
        tx: makeTx({ merchant: '<script>alert("xss")</script>' }),
        category: 'food',
      },
    ];
    const text = buildOldTxSummaryText(items, 'Bank & Trust');
    expect(text).toContain('Bank &amp; Trust');
    expect(text).toContain('&lt;script&gt;');
    expect(text).not.toContain('<script>');
  });

  test('uses merchant_normalized over merchant', () => {
    const items = [
      {
        tx: makeTx({ merchant: 'RAW MERCHANT', merchant_normalized: 'Clean Merchant' }),
        category: 'food',
      },
    ];
    const text = buildOldTxSummaryText(items, 'TBC');
    expect(text).toContain('Clean Merchant');
    expect(text).not.toContain('RAW MERCHANT');
  });

  test('formats amount with two decimals', () => {
    const items = [{ tx: makeTx({ amount: 7285.5 }), category: 'food' }];
    const text = buildOldTxSummaryText(items, 'TBC');
    expect(text).toContain('7285.50');
  });

  test('shows dash for missing merchant', () => {
    const items = [{ tx: makeTx({ merchant: null, merchant_normalized: null }), category: 'food' }];
    const text = buildOldTxSummaryText(items, 'TBC');
    expect(text).toContain('— —');
  });
});
