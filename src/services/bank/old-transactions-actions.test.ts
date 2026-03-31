// Tests for sendOldTransactionCards and skipOldTransactions — callback handler actions.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { format } from 'date-fns';
import type { BankAccount, BankConnection, BankTransaction, Group } from '../../database/types';

// sync-service imports database/env/cron at module level — must mock before import.
const mockFindConnectionById = mock<(id: number) => BankConnection | null>();
const mockFindGroupById = mock<(id: number) => Group | null>();
const mockFindAccountsByConnectionId = mock<(id: number) => BankAccount[]>();
const mockFindPendingByConnectionId = mock<(id: number) => BankTransaction[]>();
const mockUpdateStatus = mock<(id: number, groupId: number, status: string) => void>();
const mockSetTelegramMessageId = mock<(id: number, messageId: number) => void>();

mock.module('../../database', () => ({
  database: {
    bankConnections: { findById: mockFindConnectionById },
    groups: { findById: mockFindGroupById },
    bankAccounts: { findByConnectionId: mockFindAccountsByConnectionId },
    bankTransactions: {
      findPendingByConnectionId: mockFindPendingByConnectionId,
      updateStatus: mockUpdateStatus,
      setTelegramMessageId: mockSetTelegramMessageId,
    },
  },
}));
mock.module('../../config/env', () => ({
  env: { BOT_TOKEN: 'test-token', LARGE_TX_THRESHOLD_EUR: 500, NODE_ENV: 'test' },
}));
mock.module('node-cron', () => ({ default: { schedule: () => {} } }));
mock.module('./prefill', () => ({ preFillTransaction: async () => ({}) }));

const mockSendMessage = mock<
  (text: string, options?: { reply_markup?: unknown }) => Promise<{ message_id: number } | null>
>(() => Promise.resolve({ message_id: 42 }));
const mockWithChatContext = mock(
  (_chatId: number, _threadId: number | null, fn: () => Promise<void>) => fn(),
);
mock.module('./telegram-sender', () => ({
  sendMessage: mockSendMessage,
  editMessageText: mock(() => Promise.resolve()),
  withChatContext: mockWithChatContext,
  sendDirect: mock(() => Promise.resolve()),
}));

import { sendOldTransactionCards, skipOldTransactions } from './sync-service';

const CONN: BankConnection = {
  id: 10,
  group_id: 1,
  bank_name: 'tbc',
  display_name: 'TBC',
  status: 'active',
  consecutive_failures: 0,
  last_sync_at: null,
  last_error: null,
  panel_message_id: 100,
  panel_message_thread_id: 55,
  created_at: '2026-01-01',
};

const GROUP: Group = {
  id: 1,
  telegram_group_id: -1001234,
  default_currency: 'RSD',
  enabled_currencies: ['RSD', 'EUR'],
  custom_prompt: null,
  google_refresh_token: null,
  spreadsheet_id: null,
  active_topic_id: 77,
  oauth_client: 'legacy',
  bank_panel_summary_message_id: null,
  created_at: '',
  updated_at: '',
};

function makeTx(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: 1,
    connection_id: 10,
    external_id: 'ext-1',
    account_id: null,
    date: '2026-03-28',
    time: null,
    amount: 500,
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
    prefill_category: 'food',
    prefill_comment: null,
    status: 'pending',
    created_at: '2026-03-28T10:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockFindConnectionById.mockReset();
  mockFindGroupById.mockReset();
  mockFindAccountsByConnectionId.mockReset();
  mockFindPendingByConnectionId.mockReset();
  mockUpdateStatus.mockReset();
  mockSetTelegramMessageId.mockReset();
  mockSendMessage.mockReset();
  mockSendMessage.mockImplementation(() => Promise.resolve({ message_id: 42 }));
  mockWithChatContext.mockReset();
  mockWithChatContext.mockImplementation((_c, _th, fn) => fn());
});

afterEach(() => {
  mock.restore();
});

describe('sendOldTransactionCards', () => {
  test('returns 0 when connection not found', async () => {
    mockFindConnectionById.mockReturnValue(null);
    expect(await sendOldTransactionCards(999)).toBe(0);
  });

  test('returns 0 when group not found', async () => {
    mockFindConnectionById.mockReturnValue(CONN);
    mockFindGroupById.mockReturnValue(null);
    expect(await sendOldTransactionCards(10)).toBe(0);
  });

  test('sends cards for all unsent pending txs', async () => {
    mockFindConnectionById.mockReturnValue(CONN);
    mockFindGroupById.mockReturnValue(GROUP);
    mockFindAccountsByConnectionId.mockReturnValue([]);
    mockFindPendingByConnectionId.mockReturnValue([
      makeTx({ id: 1, telegram_message_id: null }),
      makeTx({ id: 2, telegram_message_id: null }),
    ]);

    const count = await sendOldTransactionCards(10);

    expect(count).toBe(2);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSetTelegramMessageId).toHaveBeenCalledTimes(2);
  });

  test('skips txs that already have telegram_message_id', async () => {
    mockFindConnectionById.mockReturnValue(CONN);
    mockFindGroupById.mockReturnValue(GROUP);
    mockFindAccountsByConnectionId.mockReturnValue([]);
    mockFindPendingByConnectionId.mockReturnValue([
      makeTx({ id: 1, telegram_message_id: null }),
      makeTx({ id: 2, telegram_message_id: 999 }),
    ]);

    const count = await sendOldTransactionCards(10);

    expect(count).toBe(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  test('skips excluded accounts', async () => {
    mockFindConnectionById.mockReturnValue(CONN);
    mockFindGroupById.mockReturnValue(GROUP);
    mockFindAccountsByConnectionId.mockReturnValue([
      {
        id: 1,
        connection_id: 10,
        account_id: 'acc-excluded',
        title: '',
        balance: 0,
        currency: 'RSD',
        type: null,
        is_excluded: 1,
      },
    ] as BankAccount[]);
    mockFindPendingByConnectionId.mockReturnValue([
      makeTx({ id: 1, account_id: 'acc-excluded', telegram_message_id: null }),
      makeTx({ id: 2, account_id: 'acc-normal', telegram_message_id: null }),
    ]);

    const count = await sendOldTransactionCards(10);

    expect(count).toBe(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  test('uses prefill_category, falls back to dash', async () => {
    mockFindConnectionById.mockReturnValue(CONN);
    mockFindGroupById.mockReturnValue(GROUP);
    mockFindAccountsByConnectionId.mockReturnValue([]);
    mockFindPendingByConnectionId.mockReturnValue([
      makeTx({ id: 1, prefill_category: null, telegram_message_id: null }),
    ]);

    await sendOldTransactionCards(10);

    const firstCall = mockSendMessage.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(String(firstCall?.[0])).toContain('Категория: —');
  });

  test('sets up withChatContext with conn panel thread', async () => {
    mockFindConnectionById.mockReturnValue(CONN);
    mockFindGroupById.mockReturnValue(GROUP);
    mockFindAccountsByConnectionId.mockReturnValue([]);
    mockFindPendingByConnectionId.mockReturnValue([]);

    await sendOldTransactionCards(10);

    expect(mockWithChatContext).toHaveBeenCalledWith(
      GROUP.telegram_group_id,
      CONN.panel_message_thread_id,
      expect.any(Function),
    );
  });

  test('falls back to group.active_topic_id when no panel thread', async () => {
    const connNoPanel = { ...CONN, panel_message_thread_id: null };
    mockFindConnectionById.mockReturnValue(connNoPanel);
    mockFindGroupById.mockReturnValue(GROUP);
    mockFindAccountsByConnectionId.mockReturnValue([]);
    mockFindPendingByConnectionId.mockReturnValue([]);

    await sendOldTransactionCards(10);

    expect(mockWithChatContext).toHaveBeenCalledWith(
      GROUP.telegram_group_id,
      GROUP.active_topic_id,
      expect.any(Function),
    );
  });
});

describe('skipOldTransactions', () => {
  const todayStr = format(new Date(), 'yyyy-MM-dd');

  test('returns 0 when connection not found', async () => {
    mockFindConnectionById.mockReturnValue(null);
    expect(await skipOldTransactions(999)).toBe(0);
  });

  test('returns 0 when group not found', async () => {
    mockFindConnectionById.mockReturnValue(CONN);
    mockFindGroupById.mockReturnValue(null);
    expect(await skipOldTransactions(10)).toBe(0);
  });

  test('marks old txs as skipped', async () => {
    mockFindConnectionById.mockReturnValue(CONN);
    mockFindGroupById.mockReturnValue(GROUP);
    mockFindAccountsByConnectionId.mockReturnValue([]);
    mockFindPendingByConnectionId.mockReturnValue([
      makeTx({ id: 1, date: '2026-03-01', telegram_message_id: null }),
      makeTx({ id: 2, date: '2026-03-02', telegram_message_id: null }),
    ]);

    const skipped = await skipOldTransactions(10);

    expect(skipped).toBe(2);
    expect(mockUpdateStatus).toHaveBeenCalledTimes(2);
    expect(mockUpdateStatus).toHaveBeenCalledWith(1, CONN.group_id, 'skipped');
    expect(mockUpdateStatus).toHaveBeenCalledWith(2, CONN.group_id, 'skipped');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('sends cards for today txs, skips old', async () => {
    mockFindConnectionById.mockReturnValue(CONN);
    mockFindGroupById.mockReturnValue(GROUP);
    mockFindAccountsByConnectionId.mockReturnValue([]);
    mockFindPendingByConnectionId.mockReturnValue([
      makeTx({ id: 1, date: '2026-03-01', telegram_message_id: null }),
      makeTx({ id: 2, date: todayStr, telegram_message_id: null }),
    ]);

    const skipped = await skipOldTransactions(10);

    expect(skipped).toBe(1);
    expect(mockUpdateStatus).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  test('returns 0 when all txs are today', async () => {
    mockFindConnectionById.mockReturnValue(CONN);
    mockFindGroupById.mockReturnValue(GROUP);
    mockFindAccountsByConnectionId.mockReturnValue([]);
    mockFindPendingByConnectionId.mockReturnValue([
      makeTx({ id: 1, date: todayStr, telegram_message_id: null }),
    ]);

    const skipped = await skipOldTransactions(10);

    expect(skipped).toBe(0);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });
});
