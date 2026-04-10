// Tests for panel-builder — status text, keyboard generation, and timeSince helper.

import { describe, expect, mock, test } from 'bun:test';
import type { BankAccount, BankTransaction } from '../../database/types';
import { mockDatabase } from '../../test-utils/mocks/database';

// Mutable mock state — individual tests can override these to inject fixture data.
const mockAccounts: { findByConnectionId: (id: number) => BankAccount[] } = {
  findByConnectionId: () => [],
};
const mockTxs: { findPendingByConnectionId: (id: number) => BankTransaction[] } = {
  findPendingByConnectionId: () => [],
};

mock.module('../../database', () => ({
  database: mockDatabase({
    bankAccounts: { findByConnectionId: mock((id: number) => mockAccounts.findByConnectionId(id)) },
    bankTransactions: {
      findPendingByConnectionId: mock((id: number) => mockTxs.findPendingByConnectionId(id)),
    },
  }),
}));

import type { BankConnection } from '../../database/types';
import { buildBankManageKeyboard, buildBankStatusText, timeSince } from './panel-builder';

const baseConn: BankConnection = {
  id: 1,
  group_id: 1,
  bank_name: 'tbc',
  display_name: 'TBC Bank',
  status: 'active',
  consecutive_failures: 0,
  last_sync_at: null,
  last_error: null,
  panel_message_id: null,
  panel_message_thread_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('buildBankStatusText', () => {
  test('shows pending-sync state when last_sync_at is null', () => {
    const text = buildBankStatusText(baseConn);
    expect(text).toContain('⌛');
    expect(text).toContain('ожидает первой синхронизации');
    expect(text).not.toContain('✅');
  });

  test('shows synced state when last_sync_at is set', () => {
    const conn = { ...baseConn, last_sync_at: new Date().toISOString() };
    const text = buildBankStatusText(conn);
    expect(text).toContain('✅');
    expect(text).not.toContain('⌛');
    expect(text).not.toContain('ожидает первой синхронизации');
  });

  test('shows warning emoji for disconnected status', () => {
    const conn: BankConnection = {
      ...baseConn,
      status: 'disconnected',
      last_sync_at: new Date().toISOString(),
    };
    const text = buildBankStatusText(conn);
    expect(text).toContain('⚠️');
  });

  test('shows error line when consecutive_failures > 0', () => {
    const conn: BankConnection = {
      ...baseConn,
      last_sync_at: new Date().toISOString(),
      consecutive_failures: 3,
      last_error: 'session expired',
    };
    const text = buildBankStatusText(conn);
    expect(text).toContain('session expired');
  });

  test('does not show error line when consecutive_failures is 0', () => {
    const conn: BankConnection = {
      ...baseConn,
      last_sync_at: new Date().toISOString(),
      consecutive_failures: 0,
      last_error: 'session expired',
    };
    const text = buildBankStatusText(conn);
    expect(text).not.toContain('session expired');
  });

  test('includes account balances when accounts exist', () => {
    mockAccounts.findByConnectionId = () => [
      {
        id: 1,
        connection_id: 1,
        account_id: 'acc1',
        title: 'Card',
        balance: 1234.56,
        currency: 'GEL',
        type: null,
        is_excluded: 0,
        updated_at: '',
      },
    ];

    try {
      const conn = { ...baseConn, last_sync_at: new Date().toISOString() };
      const text = buildBankStatusText(conn);
      expect(text).toContain('1234.56 GEL');
    } finally {
      mockAccounts.findByConnectionId = () => [];
    }
  });

  test('includes pending transactions section when pending txs exist', () => {
    mockTxs.findPendingByConnectionId = () => [
      {
        id: 1,
        connection_id: 1,
        external_id: 'e1',
        account_id: null,
        date: '2026-03-27',
        time: null,
        amount: 50,
        sign_type: 'debit',
        currency: 'GEL',
        merchant: 'Cafe',
        merchant_normalized: 'Cafe',
        mcc: null,
        raw_data: '{}',
        status: 'pending',
        matched_expense_id: null,
        matched_receipt_id: null,
        telegram_message_id: null,
        prefill_category: null,
        prefill_comment: null,
        invoice_amount: null,
        invoice_currency: null,
        edit_in_progress: 0,
        awaiting_comment: 0,
        created_at: '',
      },
    ];

    try {
      const conn = { ...baseConn, last_sync_at: new Date().toISOString() };
      const text = buildBankStatusText(conn);
      expect(text).toContain('Последние операции');
      expect(text).toContain('50.00 GEL');
    } finally {
      mockTxs.findPendingByConnectionId = () => [];
    }
  });
});

describe('buildBankManageKeyboard', () => {
  test('omits sync button when last_sync_at is null', () => {
    const rows = buildBankManageKeyboard(baseConn);
    const allButtons = rows.flat();
    expect(allButtons.some((b) => b.callback_data.startsWith('bank_sync:'))).toBe(false);
  });

  test('includes sync button after first sync completes', () => {
    const conn = { ...baseConn, last_sync_at: new Date().toISOString() };
    const rows = buildBankManageKeyboard(conn);
    const allButtons = rows.flat();
    expect(allButtons.some((b) => b.callback_data.startsWith('bank_sync:'))).toBe(true);
  });

  test('does not include disconnect button in main panel (it lives in settings submenu)', () => {
    const rows = buildBankManageKeyboard(baseConn);
    const allButtons = rows.flat();
    expect(allButtons.some((b) => b.callback_data.startsWith('bank_disconnect:'))).toBe(false);
  });

  test('hides sync button when consecutive_failures > 0 even after first sync', () => {
    const conn = {
      ...baseConn,
      last_sync_at: new Date().toISOString(),
      consecutive_failures: 2,
    };
    const rows = buildBankManageKeyboard(conn);
    const allButtons = rows.flat();
    expect(allButtons.some((b) => b.callback_data.startsWith('bank_sync:'))).toBe(false);
  });

  test('always includes settings button', () => {
    const rows = buildBankManageKeyboard(baseConn);
    const allButtons = rows.flat();
    expect(allButtons.some((b) => b.callback_data.startsWith('bank_settings:'))).toBe(true);
  });
});

describe('timeSince', () => {
  test('returns minutes for recent dates', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(timeSince(fiveMinAgo)).toBe('5 мин');
  });

  test('returns hours for older dates', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(timeSince(twoHoursAgo)).toBe('2 ч');
  });

  test('returns 0 мин for very recent dates', () => {
    const justNow = new Date(Date.now() - 30 * 1000).toISOString();
    expect(timeSince(justNow)).toBe('0 мин');
  });
});
