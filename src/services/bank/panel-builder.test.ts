// Tests for panel-builder — status text, keyboard generation, and timeSince helper.

import { describe, expect, mock, test } from 'bun:test';
import type { BankAccount, BankTransaction } from '../../database/types';
import { makeBankTransaction } from '../../test-utils/fixtures';
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
import {
  buildBankManageKeyboard,
  buildBankStatusText,
  buildCombinedBankKeyboard,
  buildCombinedBankStatusText,
  timeSince,
} from './panel-builder';

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
      makeBankTransaction({
        date: '2026-03-27',
        amount: 50,
        currency: 'GEL',
        merchant: 'Cafe',
        merchant_normalized: 'Cafe',
      }),
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

  test('boundary: exactly 59 мин stays in minutes unit', () => {
    const fiftyNine = new Date(Date.now() - 59 * 60 * 1000).toISOString();
    expect(timeSince(fiftyNine)).toBe('59 мин');
  });

  test('boundary: exactly 60 мин flips to hours', () => {
    const sixty = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(timeSince(sixty)).toBe('1 ч');
  });

  test('handles far-past dates (days ago) by collapsing to hours count', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(timeSince(threeDaysAgo)).toBe('72 ч');
  });

  test('handles future dates with negative result (no crash)', () => {
    const inFuture = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const result = timeSince(inFuture);
    // Future date: Math.floor(negative diff / 60000) produces a negative value with "мин" suffix.
    // Contract is "don't throw"; format is undefined behaviour but we capture current output.
    expect(result).toMatch(/мин|ч/);
  });
});

// ── Status text — additional branches ────────────────────────────────────────

describe('buildBankStatusText — status & balance branches', () => {
  test('shows "балансы не найдены" when synced but no accounts', () => {
    mockAccounts.findByConnectionId = () => [];
    const conn = { ...baseConn, last_sync_at: new Date().toISOString() };
    const text = buildBankStatusText(conn);
    expect(text).toContain('балансы не найдены');
  });

  test('shows "балансы загрузятся..." when pending first sync', () => {
    const text = buildBankStatusText(baseConn);
    expect(text).toContain('балансы загрузятся после первой синхронизации');
  });

  test('renders multiple accounts joined by comma', () => {
    mockAccounts.findByConnectionId = () => [
      {
        id: 1,
        connection_id: 1,
        account_id: 'a1',
        title: 'C1',
        balance: 100,
        currency: 'EUR',
        type: null,
        is_excluded: 0,
        updated_at: '',
      },
      {
        id: 2,
        connection_id: 1,
        account_id: 'a2',
        title: 'C2',
        balance: 250.5,
        currency: 'USD',
        type: null,
        is_excluded: 0,
        updated_at: '',
      },
    ];
    try {
      const conn = { ...baseConn, last_sync_at: new Date().toISOString() };
      const text = buildBankStatusText(conn);
      expect(text).toContain('100.00 EUR');
      expect(text).toContain('250.50 USD');
      expect(text).toContain(',');
    } finally {
      mockAccounts.findByConnectionId = () => [];
    }
  });

  test('includes display_name and header emoji 🏦', () => {
    const text = buildBankStatusText({ ...baseConn, display_name: 'My TBC' });
    expect(text).toContain('🏦');
    expect(text).toContain('My TBC');
  });

  test('formats tx merchant from merchant field when merchant_normalized is null', () => {
    mockTxs.findPendingByConnectionId = () => [
      makeBankTransaction({
        amount: 12.34,
        currency: 'USD',
        merchant: 'RawStore',
        merchant_normalized: null,
      }),
    ];
    try {
      const conn = { ...baseConn, last_sync_at: new Date().toISOString() };
      const text = buildBankStatusText(conn);
      expect(text).toContain('RawStore');
      expect(text).toContain('12.34 USD');
    } finally {
      mockTxs.findPendingByConnectionId = () => [];
    }
  });

  test('falls back to em-dash when both merchant fields are null', () => {
    mockTxs.findPendingByConnectionId = () => [
      makeBankTransaction({
        amount: 1,
        currency: 'EUR',
        merchant: null,
        merchant_normalized: null,
      }),
    ];
    try {
      const conn = { ...baseConn, last_sync_at: new Date().toISOString() };
      const text = buildBankStatusText(conn);
      expect(text).toContain(' — —');
    } finally {
      mockTxs.findPendingByConnectionId = () => [];
    }
  });

  test('omits "Последние операции" section when there are no pending txs', () => {
    mockTxs.findPendingByConnectionId = () => [];
    const conn = { ...baseConn, last_sync_at: new Date().toISOString() };
    const text = buildBankStatusText(conn);
    expect(text).not.toContain('Последние операции');
  });

  test('error line is suppressed when last_error set but consecutive_failures=0', () => {
    const conn: BankConnection = {
      ...baseConn,
      last_sync_at: new Date().toISOString(),
      consecutive_failures: 0,
      last_error: 'stale',
    };
    const text = buildBankStatusText(conn);
    expect(text).not.toContain('Ошибка синхронизации');
  });

  test('error line is suppressed when consecutive_failures > 0 but last_error is null', () => {
    const conn: BankConnection = {
      ...baseConn,
      last_sync_at: new Date().toISOString(),
      consecutive_failures: 5,
      last_error: null,
    };
    const text = buildBankStatusText(conn);
    expect(text).not.toContain('Ошибка синхронизации');
  });
});

// ── Expanded keyboard ────────────────────────────────────────────────────────

describe('buildBankManageKeyboard — expanded mode', () => {
  test('expanded: no ⚙️ navigation row', () => {
    const conn = { ...baseConn, last_sync_at: new Date().toISOString() };
    const rows = buildBankManageKeyboard(conn, true);
    const all = rows.flat();
    expect(all.some((b) => b.callback_data.startsWith('bank_settings:'))).toBe(false);
  });

  test('expanded: includes reconnect and disconnect rows', () => {
    const rows = buildBankManageKeyboard(baseConn, true);
    const all = rows.flat();
    expect(all.some((b) => b.callback_data.startsWith('bank_reconnect:'))).toBe(true);
    expect(all.some((b) => b.callback_data.startsWith('bank_disconnect:'))).toBe(true);
  });

  test('expanded: includes "Счета" button when accounts exist', () => {
    mockAccounts.findByConnectionId = () => [
      {
        id: 1,
        connection_id: 1,
        account_id: 'a',
        title: 't',
        balance: 0,
        currency: 'EUR',
        type: null,
        is_excluded: 0,
        updated_at: '',
      },
    ];
    try {
      const rows = buildBankManageKeyboard(baseConn, true);
      const all = rows.flat();
      expect(all.some((b) => b.callback_data.startsWith('bank_accounts:'))).toBe(true);
    } finally {
      mockAccounts.findByConnectionId = () => [];
    }
  });

  test('expanded: omits "Счета" button when no accounts', () => {
    const rows = buildBankManageKeyboard(baseConn, true);
    const all = rows.flat();
    expect(all.some((b) => b.callback_data.startsWith('bank_accounts:'))).toBe(false);
  });

  test('expanded: omits sync button when consecutive_failures > 0', () => {
    const conn = {
      ...baseConn,
      last_sync_at: new Date().toISOString(),
      consecutive_failures: 4,
    };
    const rows = buildBankManageKeyboard(conn, true);
    const all = rows.flat();
    expect(all.some((b) => b.callback_data.startsWith('bank_sync:'))).toBe(false);
  });
});

// ── Combined panel ───────────────────────────────────────────────────────────

describe('buildCombinedBankStatusText', () => {
  test('joins sections with blank line and appends total', () => {
    const c1 = { ...baseConn, id: 1, display_name: 'A' };
    const c2 = { ...baseConn, id: 2, display_name: 'B' };
    const text = buildCombinedBankStatusText([c1, c2], 1234);
    expect(text).toContain('A');
    expect(text).toContain('B');
    expect(text).toContain('Итого: ~1234 EUR');
    expect(text).toContain('\n\n'); // section separator
  });

  test('rounds total to whole EUR', () => {
    const text = buildCombinedBankStatusText([baseConn], 87.63);
    expect(text).toContain('Итого: ~88 EUR');
  });

  test('handles a single connection', () => {
    const text = buildCombinedBankStatusText([baseConn], 0);
    expect(text).toContain(baseConn.display_name);
    expect(text).toContain('Итого: ~0 EUR');
  });
});

describe('buildCombinedBankKeyboard', () => {
  test('per-bank: sync button present when active + synced + no failures', () => {
    const conn = {
      ...baseConn,
      last_sync_at: new Date().toISOString(),
      status: 'active' as const,
    };
    const rows = buildCombinedBankKeyboard([conn]);
    // First row is the per-bank row
    const firstRow = rows[0];
    expect(firstRow).toBeDefined();
    expect(firstRow?.some((b) => b.callback_data.startsWith('bank_sync:'))).toBe(true);
    expect(firstRow?.some((b) => b.callback_data.startsWith('bank_settings:'))).toBe(true);
  });

  test('per-bank: sync button hidden for disconnected status', () => {
    const conn: BankConnection = {
      ...baseConn,
      last_sync_at: new Date().toISOString(),
      status: 'disconnected',
    };
    const rows = buildCombinedBankKeyboard([conn]);
    const firstRow = rows[0] ?? [];
    expect(firstRow.some((b) => b.callback_data.startsWith('bank_sync:'))).toBe(false);
    expect(firstRow.some((b) => b.callback_data.startsWith('bank_settings:'))).toBe(true);
  });

  test('per-bank: sync button hidden when setup (no last_sync_at)', () => {
    const conn: BankConnection = { ...baseConn, status: 'setup', last_sync_at: null };
    const rows = buildCombinedBankKeyboard([conn]);
    const firstRow = rows[0] ?? [];
    expect(firstRow.some((b) => b.callback_data.startsWith('bank_sync:'))).toBe(false);
  });

  test('global "Синхронизировать все" appears when any bank is syncable', () => {
    const syncable = {
      ...baseConn,
      id: 1,
      last_sync_at: new Date().toISOString(),
      status: 'active' as const,
    };
    const broken: BankConnection = {
      ...baseConn,
      id: 2,
      last_sync_at: new Date().toISOString(),
      status: 'disconnected',
    };
    const rows = buildCombinedBankKeyboard([syncable, broken]);
    const lastRow = rows[rows.length - 1] ?? [];
    expect(lastRow.some((b) => b.callback_data === 'bank_sync_all')).toBe(true);
    expect(lastRow.some((b) => b.callback_data === 'bank_add')).toBe(true);
  });

  test('global "Синхронизировать все" hidden when no bank is syncable', () => {
    const b1: BankConnection = { ...baseConn, id: 1, status: 'setup' };
    const b2: BankConnection = {
      ...baseConn,
      id: 2,
      status: 'active',
      last_sync_at: new Date().toISOString(),
      consecutive_failures: 3,
    };
    const rows = buildCombinedBankKeyboard([b1, b2]);
    const lastRow = rows[rows.length - 1] ?? [];
    expect(lastRow.some((b) => b.callback_data === 'bank_sync_all')).toBe(false);
    expect(lastRow.some((b) => b.callback_data === 'bank_add')).toBe(true);
  });

  test('produces one row per connection plus one bottom row', () => {
    const conns = [
      { ...baseConn, id: 1 },
      { ...baseConn, id: 2 },
      { ...baseConn, id: 3 },
    ];
    const rows = buildCombinedBankKeyboard(conns);
    expect(rows).toHaveLength(conns.length + 1);
  });

  test('empty connections list still produces an "➕ Добавить банк" row', () => {
    const rows = buildCombinedBankKeyboard([]);
    expect(rows).toHaveLength(1);
    const only = rows[0] ?? [];
    expect(only.some((b) => b.callback_data === 'bank_add')).toBe(true);
    expect(only.some((b) => b.callback_data === 'bank_sync_all')).toBe(false);
  });

  test('callback_data stays within Telegram 64-byte limit', () => {
    const conns = Array.from({ length: 5 }, (_, i) => ({
      ...baseConn,
      id: i + 1,
      display_name: 'Very Long Bank Display Name 1234567890',
      last_sync_at: new Date().toISOString(),
    }));
    const rows = buildCombinedBankKeyboard(conns);
    for (const row of rows) {
      for (const btn of row) {
        expect(Buffer.byteLength(btn.callback_data, 'utf-8')).toBeLessThanOrEqual(64);
      }
    }
  });
});
