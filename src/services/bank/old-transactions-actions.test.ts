// Tests for sendOldTransactionCards and skipOldTransactions — callback handler actions.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { format } from 'date-fns';
import type { BankAccount, BankConnection, BankTransaction, Group } from '../../database/types';

// ── Mock repositories (defined before mock.module so spyOn can target them) ──
const mockBankConnections = { findById: () => null as BankConnection | null };
const mockGroups = { findById: () => null as Group | null };
const mockBankAccounts = { findByConnectionId: () => [] as BankAccount[] };
const mockBankTransactions = {
  findPendingByConnectionId: () => [] as BankTransaction[],
  updateStatus: (_id: number, _gid: number, _s: string) => {},
  setTelegramMessageId: (_id: number, _mid: number) => {},
};

// Other test files poison ../../database via mock.module — must mock here too.
mock.module('../../database', () => ({
  database: {
    bankConnections: mockBankConnections,
    groups: mockGroups,
    bankAccounts: mockBankAccounts,
    bankTransactions: mockBankTransactions,
  },
}));

// node-cron is called at module load time in sync-service — must mock before import.
mock.module('node-cron', () => ({ default: { schedule: () => {} } }));

import * as prefillModule from './prefill';
import {
  notifyOldTransactions,
  sendOldTransactionCards,
  skipOldTransactions,
} from './sync-service';
import * as senderModule from './telegram-sender';

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
    invoice_amount: null,
    invoice_currency: null,
    status: 'pending',
    created_at: '2026-03-28T10:00:00Z',
    ...overrides,
  };
}

let findConnectionByIdSpy: ReturnType<typeof mock>;
let findGroupByIdSpy: ReturnType<typeof mock>;
let findAccountsByConnectionIdSpy: ReturnType<typeof mock>;
let findPendingByConnectionIdSpy: ReturnType<typeof mock>;
let updateStatusSpy: ReturnType<typeof mock>;
let setTelegramMessageIdSpy: ReturnType<typeof mock>;
let sendMessageSpy: ReturnType<typeof mock>;
let withChatContextSpy: ReturnType<typeof mock>;

beforeEach(() => {
  findConnectionByIdSpy = spyOn(mockBankConnections, 'findById').mockReturnValue(null);
  findGroupByIdSpy = spyOn(mockGroups, 'findById').mockReturnValue(null);
  findAccountsByConnectionIdSpy = spyOn(mockBankAccounts, 'findByConnectionId').mockReturnValue([]);
  findPendingByConnectionIdSpy = spyOn(
    mockBankTransactions,
    'findPendingByConnectionId',
  ).mockReturnValue([]);
  updateStatusSpy = spyOn(mockBankTransactions, 'updateStatus');
  setTelegramMessageIdSpy = spyOn(mockBankTransactions, 'setTelegramMessageId');

  spyOn(prefillModule, 'preFillTransactions').mockResolvedValue([]);

  sendMessageSpy = spyOn(senderModule, 'sendMessage').mockResolvedValue({
    message_id: 42,
    date: 0,
    chat: { id: 1, type: 'group' },
  } as import('@gramio/types').TelegramMessage);
  spyOn(senderModule, 'editMessageText').mockResolvedValue(undefined);
  withChatContextSpy = spyOn(senderModule, 'withChatContext').mockImplementation(
    <T>(_c: number, _th: number | null, fn: () => Promise<T>) => fn(),
  );
  spyOn(senderModule, 'sendDirect').mockResolvedValue(null);
});

afterEach(() => {
  mock.restore();
});

describe('sendOldTransactionCards', () => {
  test('returns 0 when connection not found', async () => {
    findConnectionByIdSpy.mockReturnValue(null);
    expect(await sendOldTransactionCards(999)).toBe(0);
  });

  test('returns 0 when group not found', async () => {
    findConnectionByIdSpy.mockReturnValue(CONN);
    findGroupByIdSpy.mockReturnValue(null);
    expect(await sendOldTransactionCards(10)).toBe(0);
  });

  test('sends cards for all unsent pending txs', async () => {
    findConnectionByIdSpy.mockReturnValue(CONN);
    findGroupByIdSpy.mockReturnValue(GROUP);
    findAccountsByConnectionIdSpy.mockReturnValue([]);
    findPendingByConnectionIdSpy.mockReturnValue([
      makeTx({ id: 1, telegram_message_id: null }),
      makeTx({ id: 2, telegram_message_id: null }),
    ]);

    const count = await sendOldTransactionCards(10);

    expect(count).toBe(2);
    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(setTelegramMessageIdSpy).toHaveBeenCalledTimes(2);
  });

  test('skips txs that already have telegram_message_id', async () => {
    findConnectionByIdSpy.mockReturnValue(CONN);
    findGroupByIdSpy.mockReturnValue(GROUP);
    findAccountsByConnectionIdSpy.mockReturnValue([]);
    findPendingByConnectionIdSpy.mockReturnValue([
      makeTx({ id: 1, telegram_message_id: null }),
      makeTx({ id: 2, telegram_message_id: 999 }),
    ]);

    const count = await sendOldTransactionCards(10);

    expect(count).toBe(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  test('skips excluded accounts', async () => {
    findConnectionByIdSpy.mockReturnValue(CONN);
    findGroupByIdSpy.mockReturnValue(GROUP);
    findAccountsByConnectionIdSpy.mockReturnValue([
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
    findPendingByConnectionIdSpy.mockReturnValue([
      makeTx({ id: 1, account_id: 'acc-excluded', telegram_message_id: null }),
      makeTx({ id: 2, account_id: 'acc-normal', telegram_message_id: null }),
    ]);

    const count = await sendOldTransactionCards(10);

    expect(count).toBe(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  test('uses prefill_category, falls back to dash', async () => {
    findConnectionByIdSpy.mockReturnValue(CONN);
    findGroupByIdSpy.mockReturnValue(GROUP);
    findAccountsByConnectionIdSpy.mockReturnValue([]);
    findPendingByConnectionIdSpy.mockReturnValue([
      makeTx({ id: 1, prefill_category: null, telegram_message_id: null }),
    ]);

    await sendOldTransactionCards(10);

    const firstCall = sendMessageSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(String(firstCall?.[0])).toContain('Категория: —');
  });

  test('sets up withChatContext with conn panel thread', async () => {
    findConnectionByIdSpy.mockReturnValue(CONN);
    findGroupByIdSpy.mockReturnValue(GROUP);
    findAccountsByConnectionIdSpy.mockReturnValue([]);
    findPendingByConnectionIdSpy.mockReturnValue([]);

    await sendOldTransactionCards(10);

    expect(withChatContextSpy).toHaveBeenCalledWith(
      GROUP.telegram_group_id,
      CONN.panel_message_thread_id,
      expect.any(Function),
    );
  });

  test('falls back to group.active_topic_id when no panel thread', async () => {
    const connNoPanel = { ...CONN, panel_message_thread_id: null };
    findConnectionByIdSpy.mockReturnValue(connNoPanel);
    findGroupByIdSpy.mockReturnValue(GROUP);
    findAccountsByConnectionIdSpy.mockReturnValue([]);
    findPendingByConnectionIdSpy.mockReturnValue([]);

    await sendOldTransactionCards(10);

    expect(withChatContextSpy).toHaveBeenCalledWith(
      GROUP.telegram_group_id,
      GROUP.active_topic_id,
      expect.any(Function),
    );
  });
});

describe('notifyOldTransactions', () => {
  test('does nothing when txs list is empty', async () => {
    await notifyOldTransactions([], CONN, GROUP);
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  test('sends summary message with show/skip buttons', async () => {
    const txs = [
      { tx: makeTx({ id: 1, date: '2026-03-28', merchant: 'METRO' }), category: 'food' },
      { tx: makeTx({ id: 2, date: '2026-03-29', merchant: 'Bolt' }), category: 'transport' },
    ];

    await notifyOldTransactions(txs, CONN, GROUP);

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const [text, options] = sendMessageSpy.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } },
    ];
    expect(text).toContain('METRO');
    expect(text).toContain('Bolt');
    const buttons = options.reply_markup.inline_keyboard[0];
    expect(buttons?.some((b) => b.callback_data === `bank_show_old:${CONN.id}`)).toBe(true);
    expect(buttons?.some((b) => b.callback_data === `bank_skip_old:${CONN.id}`)).toBe(true);
  });

  test('uses conn panel thread for chat context', async () => {
    const txs = [{ tx: makeTx({ id: 1 }), category: 'food' }];

    await notifyOldTransactions(txs, CONN, GROUP);

    expect(withChatContextSpy).toHaveBeenCalledWith(
      GROUP.telegram_group_id,
      CONN.panel_message_thread_id,
      expect.any(Function),
    );
  });

  test('falls back to active_topic_id when no panel thread', async () => {
    const connNoPanel = { ...CONN, panel_message_thread_id: null };
    const txs = [{ tx: makeTx({ id: 1 }), category: 'food' }];

    await notifyOldTransactions(txs, connNoPanel, GROUP);

    expect(withChatContextSpy).toHaveBeenCalledWith(
      GROUP.telegram_group_id,
      GROUP.active_topic_id,
      expect.any(Function),
    );
  });
});

describe('skipOldTransactions', () => {
  const todayStr = format(new Date(), 'yyyy-MM-dd');

  test('returns 0 when connection not found', async () => {
    findConnectionByIdSpy.mockReturnValue(null);
    expect(await skipOldTransactions(999)).toBe(0);
  });

  test('returns 0 when group not found', async () => {
    findConnectionByIdSpy.mockReturnValue(CONN);
    findGroupByIdSpy.mockReturnValue(null);
    expect(await skipOldTransactions(10)).toBe(0);
  });

  test('marks old txs as skipped', async () => {
    findConnectionByIdSpy.mockReturnValue(CONN);
    findGroupByIdSpy.mockReturnValue(GROUP);
    findAccountsByConnectionIdSpy.mockReturnValue([]);
    findPendingByConnectionIdSpy.mockReturnValue([
      makeTx({ id: 1, date: '2026-03-01', telegram_message_id: null }),
      makeTx({ id: 2, date: '2026-03-02', telegram_message_id: null }),
    ]);

    const skipped = await skipOldTransactions(10);

    expect(skipped).toBe(2);
    expect(updateStatusSpy).toHaveBeenCalledTimes(2);
    expect(updateStatusSpy).toHaveBeenCalledWith(1, CONN.group_id, 'skipped');
    expect(updateStatusSpy).toHaveBeenCalledWith(2, CONN.group_id, 'skipped');
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  test('sends cards for today txs, skips old', async () => {
    findConnectionByIdSpy.mockReturnValue(CONN);
    findGroupByIdSpy.mockReturnValue(GROUP);
    findAccountsByConnectionIdSpy.mockReturnValue([]);
    findPendingByConnectionIdSpy.mockReturnValue([
      makeTx({ id: 1, date: '2026-03-01', telegram_message_id: null }),
      makeTx({ id: 2, date: todayStr, telegram_message_id: null }),
    ]);

    const skipped = await skipOldTransactions(10);

    expect(skipped).toBe(1);
    expect(updateStatusSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  test('returns 0 when all txs are today', async () => {
    findConnectionByIdSpy.mockReturnValue(CONN);
    findGroupByIdSpy.mockReturnValue(GROUP);
    findAccountsByConnectionIdSpy.mockReturnValue([]);
    findPendingByConnectionIdSpy.mockReturnValue([
      makeTx({ id: 1, date: todayStr, telegram_message_id: null }),
    ]);

    const skipped = await skipOldTransactions(10);

    expect(skipped).toBe(0);
    expect(updateStatusSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });
});
