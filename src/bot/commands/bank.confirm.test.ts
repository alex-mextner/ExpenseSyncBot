// Tests for the bank transaction confirm flow:
// Принять → dedup check → (auto-merge | merge prompt | comment prompt)

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import type { TelegramMessage } from '@gramio/types';
import type { BankTransaction, Expense, Group, User } from '../../database/types';
import * as senderModule from '../../services/bank/telegram-sender';
import { mockDatabase } from '../../test-utils/mocks/database';

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
  setMatchedReceipt: mock((_id: number, _groupId: number, _receiptId: number): void => {}),
};

const mockBankConnections = {
  findActiveByGroupId: mock((_groupId: number): { id: number }[] => []),
};

const mockExpenses = {
  create: mock((_data: unknown): { id: number } => ({ id: 99 })),
  findById: mock((_id: number): Expense | null => null),
  findPotentialDuplicates: mock(
    (
      _groupId: number,
      _date: string,
      _amount: number,
      _currency: string,
    ): {
      exact: Expense[];
      fuzzy: Expense[];
    } => ({ exact: [], fuzzy: [] }),
  ),
};

const mockReceipts = {
  findPotentialMatches: mock(
    (
      _groupId: number,
      _date: string,
      _amount: number,
      _currency: string,
    ): { exact: never[]; fuzzy: never[] } => ({ exact: [], fuzzy: [] }),
  ),
  findById: mock((_id: number): import('../../database/types').Receipt | null => null),
  findExpensesByReceiptId: mock(
    (
      _receiptId: number,
    ): Array<{
      id: number;
      category: string;
      amount: number;
      currency: string;
      comment: string;
    }> => [],
  ),
};

const mockMerchantRules = {
  insertRuleRequest: mock((_data: unknown): void => {}),
};

// database.transaction — executes callback inline (no real transaction)
// database.queryOne — returns null by default (no race-condition conflict)
const mockTransaction = mock((fn: () => unknown) => fn());
const mockQueryOne = mock((_sql: string, ..._params: unknown[]): unknown => null);
const mockDb = {
  transaction: mock((fn: () => unknown) => fn),
  query: mock(() => ({ get: mock(() => ({ n: 0 })) })),
};

const bankSent: string[] = [];
const mockBankSendMessage = mock((text: string, _options?: Record<string, unknown>) => {
  bankSent.push(text);
  return Promise.resolve({ message_id: 1 } as TelegramMessage);
});

// Route senderModule calls through spyOn — no mock.module pollution.
const spies: { mockRestore: () => void }[] = [];

beforeAll(() => {
  spies.push(
    spyOn(senderModule, 'sendMessage').mockImplementation(mockBankSendMessage),
    spyOn(senderModule, 'sendDirect').mockResolvedValue(null),
    spyOn(senderModule, 'editMessageText').mockResolvedValue(undefined),
    spyOn(senderModule, 'deleteMessage').mockResolvedValue(undefined),
    spyOn(senderModule, 'withChatContext').mockImplementation(
      // @ts-expect-error — mock returns synchronous result, real withChatContext is async generic
      (_c: number, _t: number | null, fn: () => unknown) => fn(),
    ),
  );
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

mock.module('../../database', () => ({
  database: {
    ...mockDatabase({
      groups: mockGroups,
      users: mockUsers,
      bankTransactions: mockBankTransactions,
      bankConnections: mockBankConnections,
      expenses: mockExpenses,
      receipts: mockReceipts,
      merchantRules: mockMerchantRules,
    }),
    db: mockDb,
    transaction: mockTransaction,
    queryOne: mockQueryOne,
  },
}));

import {
  handleBankConfirmCallback,
  handleBankEditReply,
  handleBankMergeCallback,
  handleBankNewCallback,
  handleBankNoCommentCallback,
  handleBankReceiptCallback,
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
  mockBankTransactions.setMatchedReceipt,
  mockBankConnections.findActiveByGroupId,
  mockExpenses.create,
  mockExpenses.findById,
  mockExpenses.findPotentialDuplicates,
  mockReceipts.findPotentialMatches,
  mockReceipts.findById,
  mockReceipts.findExpensesByReceiptId,
  mockMerchantRules.insertRuleRequest,
  mockTransaction,
  mockQueryOne,
  mockDb.transaction,
  mockDb.query,
];

afterEach(() => {
  for (const m of allMocks) m.mockReset();
  bankSent.length = 0;
  mockBankSendMessage.mockClear();
  (senderModule.editMessageText as ReturnType<typeof mock>).mockClear();
  // Restore defaults cleared by mockReset — these must return structured objects, not undefined
  mockExpenses.findPotentialDuplicates.mockImplementation(() => ({ exact: [], fuzzy: [] }));
  mockReceipts.findPotentialMatches.mockImplementation(() => ({ exact: [], fuzzy: [] }));
  mockReceipts.findById.mockImplementation(() => null);
  mockReceipts.findExpensesByReceiptId.mockImplementation(() => []);
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const group: Group = {
  id: 1,
  telegram_group_id: 100,
  title: null,
  invite_link: null,
  google_refresh_token: null,
  spreadsheet_id: null,
  default_currency: 'EUR',
  enabled_currencies: ['EUR'],
  custom_prompt: null,
  active_topic_id: null,
  oauth_client: 'legacy' as const,
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
    matched_receipt_id: null,
    telegram_message_id: 555,
    edit_in_progress: 0,
    awaiting_comment: 0,
    prefill_category: 'Кафе',
    prefill_comment: null,
    invoice_amount: null,
    invoice_currency: null,
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

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 50,
    group_id: 1,
    user_id: 1,
    date: '2026-03-29',
    category: 'Кафе',
    comment: '',
    amount: 25.5,
    currency: 'EUR',
    eur_amount: 25.5,
    receipt_id: null,
    created_at: '2026-03-29T09:00:00Z',
    ...overrides,
  };
}

// ─── Tests: handleBankConfirmCallback ─────────────────────────────────────────

describe('handleBankConfirmCallback', () => {
  beforeEach(() => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => group);
    mockUsers.findByTelegramId.mockImplementation(() => user);
    // By default: transaction() calls the callback and returns its result
    mockTransaction.mockImplementation((fn: () => unknown) => fn());
    mockDb.transaction.mockImplementation((fn: () => unknown) => fn);
    // By default: no duplicates found
    mockExpenses.findPotentialDuplicates.mockImplementation(() => ({ exact: [], fuzzy: [] }));
  });

  test('sends comment prompt when transaction is pending', async () => {
    const tx = makeTx();
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();
    mockBankSendMessage.mockImplementation(() =>
      Promise.resolve({ message_id: 600 } as TelegramMessage),
    );

    await handleBankConfirmCallback(ctx as never, tx.id, 100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(mockBankSendMessage).toHaveBeenCalledTimes(1);

    const text = mockBankSendMessage.mock.calls[0]?.[0] as string;
    const opts = mockBankSendMessage.mock.calls[0]?.[1] as {
      reply_markup: {
        inline_keyboard: { text: string; callback_data: string }[][];
      };
    };
    expect(text.toLowerCase()).toContain('комментарий');

    const keyboard = opts['reply_markup']['inline_keyboard'];
    expect(keyboard[0]).toHaveLength(1);
    expect(keyboard[0]?.[0]?.['callback_data']).toBe(`bank_nocomment:${tx.id}`);
  });

  test('sets edit_in_progress and awaiting_comment flags', async () => {
    const tx = makeTx();
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();

    await handleBankConfirmCallback(ctx as never, tx.id, 100);

    expect(mockBankTransactions.setEditInProgress).toHaveBeenCalledWith(tx.id, true);
    expect(mockBankTransactions.setAwaitingComment).toHaveBeenCalledWith(tx.id, true);
  });

  test('stores prompt message_id on the transaction', async () => {
    const tx = makeTx({ telegram_message_id: null });
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();
    mockBankSendMessage.mockImplementation(() =>
      Promise.resolve({ message_id: 777 } as TelegramMessage),
    );

    await handleBankConfirmCallback(ctx as never, tx.id, 100);

    expect(mockBankTransactions.setTelegramMessageId).toHaveBeenCalledWith(tx.id, 777);
  });

  test('rejects already-processed transaction', async () => {
    const tx = makeTx({ status: 'confirmed' });
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();

    await handleBankConfirmCallback(ctx as never, tx.id, 100);

    expect(mockBankSendMessage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('обработана') }),
    );
  });

  test('rejects when another edit is in progress', async () => {
    const tx = makeTx({ edit_in_progress: 1 });
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();

    await handleBankConfirmCallback(ctx as never, tx.id, 100);

    expect(mockBankSendMessage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('исправление') }),
    );
  });

  test('rejects when group not found', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    const ctx = makeCallbackCtx();

    await handleBankConfirmCallback(ctx as never, 7, 100);

    expect(mockBankSendMessage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Группа') }),
    );
  });

  test('auto-merges when exact duplicate found', async () => {
    const tx = makeTx();
    const existing = makeExpense();
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockExpenses.findPotentialDuplicates.mockImplementation(() => ({
      exact: [existing],
      fuzzy: [],
    }));
    const ctx = makeCallbackCtx({ message: { id: 200 } });

    await handleBankConfirmCallback(ctx as never, tx.id, 100);

    expect(mockBankTransactions.updateStatus).toHaveBeenCalledWith(tx.id, group.id, 'confirmed');
    expect(mockBankTransactions.setMatchedExpense).toHaveBeenCalledWith(
      tx.id,
      group.id,
      existing.id,
    );
    expect(mockExpenses.create).not.toHaveBeenCalled();
    expect(mockBankSendMessage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Связано') }),
    );
  });

  test('shows merge prompt when fuzzy duplicate found', async () => {
    const tx = makeTx();
    const nearby = makeExpense({ date: '2026-03-28', id: 51 });
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockExpenses.findPotentialDuplicates.mockImplementation(() => ({
      exact: [],
      fuzzy: [nearby],
    }));
    const ctx = makeCallbackCtx();

    await handleBankConfirmCallback(ctx as never, tx.id, 100);

    expect(mockBankSendMessage).toHaveBeenCalledTimes(1);
    const text = mockBankSendMessage.mock.calls[0]?.[0] as string;
    const opts = mockBankSendMessage.mock.calls[0]?.[1] as {
      reply_markup: {
        inline_keyboard: { text: string; callback_data: string }[][];
      };
    };
    expect(text).toContain('похожий расход');
    const keyboard = opts['reply_markup']['inline_keyboard'];
    expect(keyboard[0]?.[0]?.['callback_data']).toBe(`bank_merge:${tx.id}:${nearby.id}`);
    expect(keyboard[0]?.[1]?.['callback_data']).toBe(`bank_new:${tx.id}`);
    expect(mockExpenses.create).not.toHaveBeenCalled();
    expect(mockBankTransactions.setAwaitingComment).not.toHaveBeenCalled();
  });
});

// ─── Tests: handleBankMergeCallback ───────────────────────────────────────────

describe('handleBankMergeCallback', () => {
  beforeEach(() => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => group);
    mockTransaction.mockImplementation((fn: () => unknown) => fn());
    mockQueryOne.mockImplementation(() => ({ n: 0 }));
    mockDb.transaction.mockImplementation((fn: () => unknown) => fn);
    mockDb.query.mockImplementation(() => ({ get: mock(() => ({ n: 0 })) }));
  });

  test('links transaction to existing expense', async () => {
    const tx = makeTx({ edit_in_progress: 1 });
    const expense = makeExpense({ id: 50 });
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockExpenses.findById.mockImplementation(() => expense);

    const ctx = makeCallbackCtx({ message: { id: 300 } });

    await handleBankMergeCallback(ctx as never, tx.id, expense.id, 100);

    expect(mockBankTransactions.updateStatus).toHaveBeenCalledWith(tx.id, group.id, 'confirmed');
    expect(mockBankTransactions.setMatchedExpense).toHaveBeenCalledWith(
      tx.id,
      group.id,
      expense.id,
    );
    expect(mockBankTransactions.setEditInProgress).toHaveBeenCalledWith(tx.id, false);
    expect(mockExpenses.create).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Связано') }),
    );
  });

  test('rejects when expense belongs to different group', async () => {
    const tx = makeTx();
    const expense = makeExpense({ group_id: 999 });
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockExpenses.findById.mockImplementation(() => expense);

    const ctx = makeCallbackCtx();

    await handleBankMergeCallback(ctx as never, tx.id, expense.id, 100);

    expect(mockBankTransactions.updateStatus).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Расход не найден') }),
    );
  });

  test('rejects already-processed transaction', async () => {
    const tx = makeTx({ status: 'confirmed' });
    const expense = makeExpense();
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockExpenses.findById.mockImplementation(() => expense);

    const ctx = makeCallbackCtx();

    await handleBankMergeCallback(ctx as never, tx.id, expense.id, 100);

    expect(mockBankTransactions.updateStatus).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('обработана') }),
    );
  });

  test('rejects when expense is already linked to another transaction (race condition)', async () => {
    const tx = makeTx({ edit_in_progress: 1 });
    const expense = makeExpense({ id: 50 });
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockExpenses.findById.mockImplementation(() => expense);
    mockQueryOne.mockImplementation(() => ({ n: 1 }));

    const ctx = makeCallbackCtx();

    await handleBankMergeCallback(ctx as never, tx.id, expense.id, 100);

    expect(mockBankTransactions.updateStatus).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('уже привязан') }),
    );
  });
});

// ─── Tests: handleBankNewCallback ────────────────────────────────────────────

describe('handleBankNewCallback', () => {
  beforeEach(() => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => group);
  });

  test('sets awaiting_comment and shows comment prompt', async () => {
    const tx = makeTx({ edit_in_progress: 1 });
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();
    mockBankSendMessage.mockImplementation(() =>
      Promise.resolve({ message_id: 700 } as TelegramMessage),
    );

    await handleBankNewCallback(ctx as never, tx.id, 100);

    expect(mockBankTransactions.setAwaitingComment).toHaveBeenCalledWith(tx.id, true);
    expect(mockBankSendMessage).toHaveBeenCalledTimes(1);
    const text = mockBankSendMessage.mock.calls[0]?.[0] as string;
    expect(text.toLowerCase()).toContain('комментарий');
    expect(mockBankTransactions.setTelegramMessageId).toHaveBeenCalledWith(tx.id, 700);
  });

  test('rejects when transaction is not in edit_in_progress state', async () => {
    const tx = makeTx({ edit_in_progress: 0 });
    mockBankTransactions.findById.mockImplementation(() => tx);
    const ctx = makeCallbackCtx();

    await handleBankNewCallback(ctx as never, tx.id, 100);

    expect(mockBankSendMessage).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('обработана') }),
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

    expect(mockBankSendMessage).toHaveBeenCalledTimes(1);
    const msg = (mockBankSendMessage.mock.calls[0]?.[0] ?? '') as string;
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
    mockTransaction.mockImplementation((fn: () => unknown) => fn());
    mockDb.transaction.mockImplementation((fn: () => unknown) => fn);
    mockExpenses.create.mockImplementation(() => ({ id: 99 }));
  });

  test('confirms transaction with empty comment using prefill_category', async () => {
    const tx = makeTx({ prefill_category: 'Кафе', awaiting_comment: 1, edit_in_progress: 1 });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx();

    await handleBankNoCommentCallback(ctx as never, tx.id, 100);

    expect(mockExpenses.create).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Кафе', comment: '' }),
    );
  });

  test('clears edit_in_progress and awaiting_comment flags', async () => {
    const tx = makeTx({ prefill_category: 'Кафе', awaiting_comment: 1, edit_in_progress: 1 });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx();

    await handleBankNoCommentCallback(ctx as never, tx.id, 100);

    expect(mockBankTransactions.setEditInProgress).toHaveBeenCalledWith(tx.id, false);
    expect(mockBankTransactions.setAwaitingComment).toHaveBeenCalledWith(tx.id, false);
  });

  test('answers callback with success text', async () => {
    const tx = makeTx({ prefill_category: 'Кафе' });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx({ message: { id: 200 } });

    await handleBankNoCommentCallback(ctx as never, tx.id, 100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('✅') }),
    );
  });

  test('edits message to show confirmation', async () => {
    const tx = makeTx({ prefill_category: 'Транспорт' });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx({ message: { id: 200 } });

    await handleBankNoCommentCallback(ctx as never, tx.id, 100);

    expect(senderModule.editMessageText).toHaveBeenCalledWith(
      200,
      expect.stringContaining('Транспорт'),
    );
  });

  test('rejects already-processed transaction', async () => {
    const tx = makeTx({ status: 'confirmed' });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx();

    await handleBankNoCommentCallback(ctx as never, tx.id, 100);

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

    await handleBankNoCommentCallback(ctx as never, tx.id, 100);

    expect(mockExpenses.create).toHaveBeenCalledWith(expect.objectContaining({ category: 'Bolt' }));
  });
});

// ─── Tests: handleBankReceiptCallback ────────────────────────────────────────

describe('handleBankReceiptCallback', () => {
  const receipt = {
    id: 10,
    group_id: 1,
    photo_queue_id: null,
    image_path: 'data/receipts/test.jpg',
    total_amount: 2500,
    currency: 'RSD',
    date: '2026-03-29',
    created_at: '2026-03-29T10:00:00Z',
  };

  const receiptExpenses = [
    { id: 50, category: 'Продукты', amount: 1500, currency: 'RSD', comment: 'Meat' },
    { id: 51, category: 'Дом', amount: 1000, currency: 'RSD', comment: 'Soap' },
  ];

  beforeEach(() => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => group);
    mockTransaction.mockImplementation((fn: () => unknown) => fn());
  });

  test('links transaction to receipt and edits message', async () => {
    const tx = makeTx({ status: 'pending' });
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockReceipts.findById.mockImplementation(() => receipt);
    mockReceipts.findExpensesByReceiptId.mockImplementation(() => receiptExpenses);

    const ctx = makeCallbackCtx({ message: { id: 300 } });

    await handleBankReceiptCallback(ctx as never, tx.id, receipt.id, 100);

    expect(mockBankTransactions.updateStatus).toHaveBeenCalledWith(tx.id, group.id, 'confirmed');
    expect(mockBankTransactions.setMatchedExpense).toHaveBeenCalledWith(tx.id, group.id, 50);
    expect(mockBankTransactions.setMatchedReceipt).toHaveBeenCalledWith(
      tx.id,
      group.id,
      receipt.id,
    );
    expect(mockBankTransactions.setEditInProgress).toHaveBeenCalledWith(tx.id, false);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: '✅ Связано с чеком' }),
    );
    expect(senderModule.editMessageText).toHaveBeenCalledWith(
      300,
      expect.stringContaining('Продукты, Дом'),
    );
  });

  test('rejects when group not found', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    const ctx = makeCallbackCtx();

    await handleBankReceiptCallback(ctx as never, 7, 10, 100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Группа не найдена' }),
    );
    expect(mockBankTransactions.updateStatus).not.toHaveBeenCalled();
  });

  test('rejects already-processed transaction', async () => {
    const tx = makeTx({ status: 'confirmed' });
    mockBankTransactions.findById.mockImplementation(() => tx);

    const ctx = makeCallbackCtx();

    await handleBankReceiptCallback(ctx as never, tx.id, receipt.id, 100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Транзакция уже обработана' }),
    );
    expect(mockBankTransactions.updateStatus).not.toHaveBeenCalled();
  });

  test('rejects when receipt not found', async () => {
    const tx = makeTx({ status: 'pending' });
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockReceipts.findById.mockImplementation(() => null);

    const ctx = makeCallbackCtx();

    await handleBankReceiptCallback(ctx as never, tx.id, 999, 100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Чек не найден' }),
    );
    expect(mockBankTransactions.updateStatus).not.toHaveBeenCalled();
  });

  test('rejects when receipt belongs to different group', async () => {
    const tx = makeTx({ status: 'pending' });
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockReceipts.findById.mockImplementation(() => ({ ...receipt, group_id: 999 }));

    const ctx = makeCallbackCtx();

    await handleBankReceiptCallback(ctx as never, tx.id, receipt.id, 100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Чек не найден' }),
    );
    expect(mockBankTransactions.updateStatus).not.toHaveBeenCalled();
  });

  test('rejects when receipt has no linked expenses', async () => {
    const tx = makeTx({ status: 'pending' });
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockReceipts.findById.mockImplementation(() => receipt);
    mockReceipts.findExpensesByReceiptId.mockImplementation(() => []);

    const ctx = makeCallbackCtx();

    await handleBankReceiptCallback(ctx as never, tx.id, receipt.id, 100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'У чека нет связанных расходов' }),
    );
    expect(mockBankTransactions.updateStatus).not.toHaveBeenCalled();
  });

  test('skips message edit when ctx.message is absent', async () => {
    const tx = makeTx({ status: 'pending' });
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockReceipts.findById.mockImplementation(() => receipt);
    mockReceipts.findExpensesByReceiptId.mockImplementation(() => receiptExpenses);

    const ctx = makeCallbackCtx({ message: undefined });

    await handleBankReceiptCallback(ctx as never, tx.id, receipt.id, 100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: '✅ Связано с чеком' }),
    );
    expect(senderModule.editMessageText).not.toHaveBeenCalled();
  });

  test('edits message with receipt amount, currency, and categories', async () => {
    const tx = makeTx({ status: 'pending' });
    mockBankTransactions.findById.mockImplementation(() => tx);
    mockReceipts.findById.mockImplementation(() => receipt);
    mockReceipts.findExpensesByReceiptId.mockImplementation(() => [
      { id: 50, category: 'Кафе', amount: 2500, currency: 'RSD', comment: 'Coffee' },
    ]);

    const ctx = makeCallbackCtx({ message: { id: 300 } });

    await handleBankReceiptCallback(ctx as never, tx.id, receipt.id, 100);

    expect(senderModule.editMessageText).toHaveBeenCalledWith(
      300,
      expect.stringContaining('Связано с чеком: 2500.00 RSD (Кафе)'),
    );
  });
});
