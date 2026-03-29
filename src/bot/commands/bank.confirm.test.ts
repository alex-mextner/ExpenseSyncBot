// Tests for the two-step bank transaction confirm flow:
// Принять → comment prompt → user types comment (or "Без комментария")

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { BankTransaction, Group, User } from '../../database/types';

// ─── Mutable mock state ───────────────────────────────────────────────────────

const mockGroups = {
  findByTelegramGroupId: mock((_id: number): Group | null => null),
};

const mockUsers = {
  findByTelegramId: mock((_id: number): User | null => null),
};

const mockBankTransactions = {
  findById: mock((_id: number, _groupId: number): BankTransaction | null => null),
  findPendingByConnectionId: mock((_connId: number): BankTransaction[] => []),
  setEditInProgress: mock((_id: number, _flag: boolean): void => {}),
  setAwaitingComment: mock((_id: number, _flag: boolean): void => {}),
  setTelegramMessageId: mock((_id: number, _msgId: number): void => {}),
  updateStatus: mock((_id: number, _groupId: number, _status: string): void => {}),
  setMatchedExpense: mock((_id: number, _groupId: number, _expenseId: number): void => {}),
};

const mockBankConnections = {
  findActiveByGroupId: mock((_groupId: number): { id: number }[] => []),
};

const mockExpenses = {
  create: mock((_data: unknown): { id: number } => ({ id: 99 })),
};

const mockMerchantRules = {
  insertRuleRequest: mock((_data: unknown): void => {}),
};

// database.db.transaction — executes callback inline (no real transaction)
const mockDb = {
  transaction: mock((fn: () => unknown) => fn),
};

mock.module('../../database', () => ({
  database: {
    groups: mockGroups,
    users: mockUsers,
    bankTransactions: mockBankTransactions,
    bankConnections: mockBankConnections,
    expenses: mockExpenses,
    merchantRules: mockMerchantRules,
    db: mockDb,
  },
}));

import { afterEach } from 'bun:test';
import {
  handleBankConfirmCallback,
  handleBankEditReply,
  handleBankNoCommentCallback,
} from './bank';

// Reset all mock call counts after each test to prevent cross-test pollution.
const allMocks = [
  mockGroups.findByTelegramGroupId,
  mockUsers.findByTelegramId,
  mockBankTransactions.findById,
  mockBankTransactions.findPendingByConnectionId,
  mockBankTransactions.setEditInProgress,
  mockBankTransactions.setAwaitingComment,
  mockBankTransactions.setTelegramMessageId,
  mockBankTransactions.updateStatus,
  mockBankTransactions.setMatchedExpense,
  mockBankConnections.findActiveByGroupId,
  mockExpenses.create,
  mockMerchantRules.insertRuleRequest,
  mockDb.transaction,
];

afterEach(() => {
  for (const m of allMocks) m.mockReset();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const group: Group = {
  id: 1,
  telegram_group_id: 100,
  google_refresh_token: null,
  spreadsheet_id: null,
  default_currency: 'EUR',
  enabled_currencies: ['EUR'],
  custom_prompt: null,
  active_topic_id: null,
  bank_panel_summary_message_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const user: User = {
  id: 1,
  telegram_id: 42,
  group_id: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function makeTx(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: 7,
    connection_id: 3,
    external_id: 'ext-1',
    account_id: null,
    date: '2026-03-29',
    time: '14:35',
    amount: 25.5,
    sign_type: 'debit',
    currency: 'GEL',
    merchant: 'Starbucks',
    merchant_normalized: 'Starbucks Coffee',
    mcc: 5812,
    raw_data: '{}',
    matched_expense_id: null,
    telegram_message_id: 555,
    edit_in_progress: 0,
    awaiting_comment: 0,
    prefill_category: 'Кафе',
    prefill_comment: null,
    status: 'pending',
    created_at: '2026-03-29T10:00:00Z',
    ...overrides,
  };
}

function makeCallbackCtx(overrides: Record<string, unknown> = {}) {
  return {
    from: { id: 42 },
    message: { id: 200 },
    answerCallbackQuery: mock((_data?: unknown): Promise<void> => Promise.resolve()),
    ...overrides,
  };
}

function makeMsgCtx(overrides: Record<string, unknown> = {}) {
  return {
    from: { id: 42 },
    send: mock((_text: string, _opts?: unknown): Promise<unknown> => Promise.resolve({})),
    ...overrides,
  };
}

function makeBot(sendMessageReturn: unknown = { message_id: 600 }) {
  return {
    api: {
      sendMessage: mock((_params: unknown): Promise<unknown> => Promise.resolve(sendMessageReturn)),
      editMessageText: mock((_params: unknown): Promise<void> => Promise.resolve()),
    },
  };
}

// ─── Tests: handleBankConfirmCallback ─────────────────────────────────────────

describe('handleBankConfirmCallback', () => {
  beforeEach(() => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => group);
    mockUsers.findByTelegramId.mockImplementation(() => user);
    // By default: transaction() returns the callback; let tests override what findById returns
    mockDb.transaction.mockImplementation((fn: () => unknown) => fn);
  });

  test('sends comment prompt when transaction is pending', async () => {
    const tx = makeTx();
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();
    const bot = makeBot({ message_id: 600 });

    await handleBankConfirmCallback(ctx as never, bot as never, tx.id, 100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);

    const params = bot.api.sendMessage.mock.calls[0]?.[0] as {
      chat_id: number;
      text: string;
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(params['chat_id']).toBe(100);
    expect(params['text'].toLowerCase()).toContain('комментарий');

    const keyboard = params['reply_markup']['inline_keyboard'];
    expect(keyboard[0]).toHaveLength(1);
    expect(keyboard[0]?.[0]?.['callback_data']).toBe(`bank_nocomment:${tx.id}`);
  });

  test('sets edit_in_progress and awaiting_comment flags', async () => {
    const tx = makeTx();
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankConfirmCallback(ctx as never, bot as never, tx.id, 100);

    expect(mockBankTransactions.setEditInProgress).toHaveBeenCalledWith(tx.id, true);
    expect(mockBankTransactions.setAwaitingComment).toHaveBeenCalledWith(tx.id, true);
  });

  test('stores prompt message_id on the transaction', async () => {
    const tx = makeTx({ telegram_message_id: null });
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();
    const bot = makeBot({ message_id: 777 });

    await handleBankConfirmCallback(ctx as never, bot as never, tx.id, 100);

    expect(mockBankTransactions.setTelegramMessageId).toHaveBeenCalledWith(tx.id, 777);
  });

  test('rejects already-processed transaction', async () => {
    const tx = makeTx({ status: 'confirmed' });
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankConfirmCallback(ctx as never, bot as never, tx.id, 100);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('обработана') }),
    );
  });

  test('rejects when another edit is in progress', async () => {
    const tx = makeTx({ edit_in_progress: 1 });
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankConfirmCallback(ctx as never, bot as never, tx.id, 100);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('исправление') }),
    );
  });

  test('rejects when group not found', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankConfirmCallback(ctx as never, bot as never, 7, 100);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Группа') }),
    );
  });
});

// ─── Tests: handleBankEditReply — awaiting_comment branch ─────────────────────

describe('handleBankEditReply with awaiting_comment=1', () => {
  const conn = { id: 3 };
  const promptMsgId = 555;

  beforeEach(() => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => group);
    mockUsers.findByTelegramId.mockImplementation(() => user);
    mockBankConnections.findActiveByGroupId.mockImplementation(() => [conn]);
    mockExpenses.create.mockImplementation(() => ({ id: 99 }));
  });

  test('uses prefill_category and user text as comment', async () => {
    const tx = makeTx({ edit_in_progress: 1, awaiting_comment: 1, prefill_category: 'Кафе' });
    mockBankTransactions.findPendingByConnectionId.mockImplementation(() => [tx]);

    const ctx = makeMsgCtx();
    const handled = await handleBankEditReply(ctx as never, 100, 'Вкусный кофе', promptMsgId);

    expect(handled).toBe(true);
    expect(mockExpenses.create).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Кафе', comment: 'Вкусный кофе' }),
    );
  });

  test('clears flags after saving', async () => {
    const tx = makeTx({
      edit_in_progress: 1,
      awaiting_comment: 1,
      telegram_message_id: promptMsgId,
    });
    mockBankTransactions.findPendingByConnectionId.mockImplementation(() => [tx]);

    const ctx = makeMsgCtx();
    await handleBankEditReply(ctx as never, 100, 'Comment', promptMsgId);

    expect(mockBankTransactions.setEditInProgress).toHaveBeenCalledWith(tx.id, false);
    expect(mockBankTransactions.setAwaitingComment).toHaveBeenCalledWith(tx.id, false);
  });

  test('sends confirmation message to chat', async () => {
    const tx = makeTx({
      edit_in_progress: 1,
      awaiting_comment: 1,
      telegram_message_id: promptMsgId,
    });
    mockBankTransactions.findPendingByConnectionId.mockImplementation(() => [tx]);

    const ctx = makeMsgCtx();
    await handleBankEditReply(ctx as never, 100, 'Coffee', promptMsgId);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = ((ctx.send as ReturnType<typeof mock>).mock.calls[0]?.[0] ?? '') as string;
    expect(msg).toContain('Кафе');
    expect(msg).toContain('Coffee');
  });

  test('falls back to merchant when prefill_category is null', async () => {
    const tx = makeTx({
      edit_in_progress: 1,
      awaiting_comment: 1,
      prefill_category: null,
      merchant_normalized: 'Starbucks Coffee',
      telegram_message_id: promptMsgId,
    });
    mockBankTransactions.findPendingByConnectionId.mockImplementation(() => [tx]);

    const ctx = makeMsgCtx();
    await handleBankEditReply(ctx as never, 100, 'big latte', promptMsgId);

    expect(mockExpenses.create).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Starbucks Coffee' }),
    );
  });

  test('returns false when no matching transaction found', async () => {
    mockBankTransactions.findPendingByConnectionId.mockImplementation(() => []);

    const ctx = makeMsgCtx();
    const handled = await handleBankEditReply(ctx as never, 100, 'text', 999);

    expect(handled).toBe(false);
    expect(mockExpenses.create).not.toHaveBeenCalled();
  });
});

// ─── Tests: handleBankEditReply — Исправить branch (awaiting_comment=0) ────────

describe('handleBankEditReply with awaiting_comment=0', () => {
  const conn = { id: 3 };
  const promptMsgId = 555;

  beforeEach(() => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => group);
    mockUsers.findByTelegramId.mockImplementation(() => user);
    mockBankConnections.findActiveByGroupId.mockImplementation(() => [conn]);
    mockExpenses.create.mockImplementation(() => ({ id: 99 }));
  });

  test('parses "категория — комментарий" format', async () => {
    const tx = makeTx({
      edit_in_progress: 1,
      awaiting_comment: 0,
      telegram_message_id: promptMsgId,
    });
    mockBankTransactions.findPendingByConnectionId.mockImplementation(() => [tx]);

    const ctx = makeMsgCtx();
    await handleBankEditReply(ctx as never, 100, 'Рестораны — ужин с друзьями', promptMsgId);

    expect(mockExpenses.create).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Рестораны', comment: 'ужин с друзьями' }),
    );
  });

  test('parses category-only format (no em dash)', async () => {
    const tx = makeTx({
      edit_in_progress: 1,
      awaiting_comment: 0,
      telegram_message_id: promptMsgId,
    });
    mockBankTransactions.findPendingByConnectionId.mockImplementation(() => [tx]);

    const ctx = makeMsgCtx();
    await handleBankEditReply(ctx as never, 100, 'Транспорт', promptMsgId);

    expect(mockExpenses.create).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Транспорт' }),
    );
  });
});

// ─── Tests: handleBankNoCommentCallback ──────────────────────────────────────

describe('handleBankNoCommentCallback', () => {
  beforeEach(() => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => group);
    mockUsers.findByTelegramId.mockImplementation(() => user);
    mockDb.transaction.mockImplementation((fn: () => unknown) => fn);
    mockExpenses.create.mockImplementation(() => ({ id: 99 }));
  });

  test('confirms transaction with empty comment using prefill_category', async () => {
    const tx = makeTx({ prefill_category: 'Кафе', awaiting_comment: 1, edit_in_progress: 1 });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankNoCommentCallback(ctx as never, bot as never, tx.id, 100);

    expect(mockExpenses.create).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Кафе', comment: '' }),
    );
  });

  test('clears edit_in_progress and awaiting_comment flags', async () => {
    const tx = makeTx({ prefill_category: 'Кафе', awaiting_comment: 1, edit_in_progress: 1 });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankNoCommentCallback(ctx as never, bot as never, tx.id, 100);

    expect(mockBankTransactions.setEditInProgress).toHaveBeenCalledWith(tx.id, false);
    expect(mockBankTransactions.setAwaitingComment).toHaveBeenCalledWith(tx.id, false);
  });

  test('answers callback with success text', async () => {
    const tx = makeTx({ prefill_category: 'Кафе' });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx({ message: { id: 200 } });
    const bot = makeBot();

    await handleBankNoCommentCallback(ctx as never, bot as never, tx.id, 100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('✅') }),
    );
  });

  test('edits message to show confirmation', async () => {
    const tx = makeTx({ prefill_category: 'Транспорт' });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx({ message: { id: 200 } });
    const bot = makeBot();

    await handleBankNoCommentCallback(ctx as never, bot as never, tx.id, 100);

    expect(bot.api.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 100,
        message_id: 200,
        text: expect.stringContaining('Транспорт'),
      }),
    );
  });

  test('rejects already-processed transaction', async () => {
    const tx = makeTx({ status: 'confirmed' });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankNoCommentCallback(ctx as never, bot as never, tx.id, 100);

    expect(mockExpenses.create).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('обработана') }),
    );
  });

  test('falls back to merchant_normalized when prefill_category is null', async () => {
    const tx = makeTx({
      prefill_category: null,
      merchant_normalized: 'Bolt',
      merchant: 'BOLT*TRIP',
    });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankNoCommentCallback(ctx as never, bot as never, tx.id, 100);

    expect(mockExpenses.create).toHaveBeenCalledWith(expect.objectContaining({ category: 'Bolt' }));
  });
});
