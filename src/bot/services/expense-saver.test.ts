// Tests for saveReceiptExpenses — budget check integration after receipt save

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { TelegramMessage } from '@gramio/types';
import type { CurrencyCode } from '../../config/constants';
import type { ReceiptItem } from '../../database/types';
import { mockDatabase } from '../../test-utils/mocks/database';

// ── Mock functions ───────────────────────────────────────────────────────────

const appendExpenseRow = mock(() => Promise.resolve(undefined));
const appendExpenseRows = mock(() => Promise.resolve(undefined));
const googleConn = mock(() => ({}));

const convertToEUR = mock(() => 1.72);
const convertCurrency = mock(() => 0);
const formatAmount = mock((amount: number, currency: string) => `${amount} ${currency}`);
const getExchangeRate = mock(() => 1);

const sentMessages: {
  text: string;
  options: Record<string, unknown> | undefined;
}[] = [];
const sendMessage = mock((text: string, options?: Record<string, unknown>) => {
  sentMessages.push({ text, options });
  return Promise.resolve({ message_id: 1 } as TelegramMessage);
});
const sendDirect = mock(() => Promise.resolve(null));
const editMessageText = mock(() => Promise.resolve(undefined));
const deleteMessage = mock(() => Promise.resolve(undefined));
const withChatContext = mock((_c: number, _t: number | null, fn: () => unknown) => fn());

// ── Database mocks ───────────────────────────────────────────────────────────

const mockExpenseCreate = mock(() => ({
  id: 1,
  group_id: 1,
  user_id: 1,
  date: '2024-01-15',
  category: 'Продукты',
  comment: 'test',
  amount: 200,
  currency: 'RSD',
  eur_amount: 1.72,
  created_at: '2024-01-01',
  synced: 0,
}));
const mockExpenseSumByCategory = mock(() => 0);
const mockReceiptItemsFind = mock(() => [] as ReceiptItem[]);
const mockReceiptItemsDelete = mock(() => {});
const mockGroupsFindById = mock(() => makeGroup());
const mockExpenseItemsCreate = mock(() => ({
  id: 1,
  expense_id: 1,
  name_ru: 'Молоко',
  name_original: 'Mleko',
  quantity: 1,
  price: 200,
  total: 200,
}));
const mockBudgetsGetForMonth = mock(
  (
    ..._args: unknown[]
  ): {
    id: number;
    category: string;
    limit_amount: number;
    currency: string;
    month: string;
  } | null => null,
);
const mockTransaction = mock((fn: () => void) => fn());
const mockPendingExpenseFindById = mock(
  (
    _id: number,
  ): {
    id: number;
    user_id: number;
    message_id: number;
    parsed_amount: number;
    parsed_currency: CurrencyCode;
    detected_category: string | null;
    comment: string;
    status: 'confirmed';
    created_at: string;
  } | null => null,
);
const mockPendingExpenseDelete = mock(() => {});

const db = {
  ...mockDatabase({
    expenses: {
      create: mockExpenseCreate,
      sumByCategory: mockExpenseSumByCategory,
    },
    receiptItems: {
      findConfirmedByPhotoQueueId: mockReceiptItemsFind,
      deleteProcessedByPhotoQueueId: mockReceiptItemsDelete,
    },
    groups: {
      findById: mockGroupsFindById,
    },
    expenseItems: {
      create: mockExpenseItemsCreate,
    },
    budgets: {
      getBudgetForMonth: mockBudgetsGetForMonth,
    },
    pendingExpenses: {
      findById: mockPendingExpenseFindById,
      delete: mockPendingExpenseDelete,
    },
  }),
  transaction: mockTransaction,
};

// ── mock.module declarations (must precede module under test import) ─────────

mock.module('../../services/google/sheets', () => ({
  appendExpenseRow,
  appendExpenseRows,
  googleConn,
}));
mock.module('../../services/currency/converter', () => ({
  convertToEUR,
  convertCurrency,
  formatAmount,
  getExchangeRate,
}));
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage,
  sendDirect,
  editMessageText,
  deleteMessage,
  withChatContext,
}));
mock.module('../../database', () => ({ database: db }));
mock.module('./budget-sync', () => ({ silentSyncBudgets: mock(() => Promise.resolve(0)) }));
const sendToChat = mock((text: string, options?: Record<string, unknown>) => {
  sentMessages.push({ text, options });
  return Promise.resolve({ message_id: 1 } as TelegramMessage);
});
mock.module('../send', () => ({ sendToChat }));

import { saveExpenseBatch, saveReceiptExpenses } from './expense-saver';

// ── Test data ────────────────────────────────────────────────────────────────

const TEST_GROUP_ID = 1;
const TEST_USER_ID = 1;
const TEST_PHOTO_QUEUE_ID = 42;
const TEST_TELEGRAM_GROUP_ID = -100123456;

function makeGroup() {
  return {
    id: TEST_GROUP_ID,
    telegram_group_id: TEST_TELEGRAM_GROUP_ID,
    google_refresh_token: 'encrypted-token',
    spreadsheet_id: 'sheet-123',
    default_currency: 'EUR' as CurrencyCode,
    enabled_currencies: ['EUR', 'RSD'] as CurrencyCode[],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'legacy' as const,
    bank_panel_summary_message_id: null,
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  };
}

function makeReceiptItem(overrides: Partial<ReceiptItem> = {}): ReceiptItem {
  return {
    id: 1,
    photo_queue_id: TEST_PHOTO_QUEUE_ID,
    name_ru: 'Молоко',
    name_original: 'Mleko',
    quantity: 1,
    price: 200,
    total: 200,
    currency: 'RSD' as CurrencyCode,
    suggested_category: 'Продукты',
    possible_categories: ['Продукты', 'Напитки'],
    status: 'confirmed' as const,
    confirmed_category: 'Продукты',
    waiting_for_category_input: 0,
    created_at: '2024-01-01',
    ...overrides,
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  sentMessages.length = 0;

  appendExpenseRow.mockReset().mockResolvedValue(undefined);
  appendExpenseRows.mockReset().mockResolvedValue(undefined);
  convertToEUR.mockReset().mockReturnValue(1.72);
  convertCurrency.mockReset().mockReturnValue(0);
  formatAmount
    .mockReset()
    .mockImplementation((amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`);
  getExchangeRate.mockReset().mockReturnValue(1);
  sendMessage.mockReset().mockImplementation((text: string, options?: Record<string, unknown>) => {
    sentMessages.push({ text, options });
    return Promise.resolve({ message_id: 1 } as TelegramMessage);
  });
  sendDirect.mockReset().mockResolvedValue(null);
  editMessageText.mockReset().mockResolvedValue(undefined);
  deleteMessage.mockReset().mockResolvedValue(undefined);
  withChatContext
    .mockReset()
    .mockImplementation((_c: number, _t: number | null, fn: () => unknown) => fn());

  mockExpenseCreate.mockReset().mockReturnValue({
    id: 1,
    group_id: TEST_GROUP_ID,
    user_id: TEST_USER_ID,
    date: '2024-01-15',
    category: 'Продукты',
    comment: 'test',
    amount: 200,
    currency: 'RSD',
    eur_amount: 1.72,
    created_at: '2024-01-01',
    synced: 0,
  });
  mockExpenseSumByCategory.mockReset().mockReturnValue(0);
  mockReceiptItemsFind.mockReset().mockReturnValue([]);
  mockReceiptItemsDelete.mockReset();
  mockGroupsFindById.mockReset().mockReturnValue(makeGroup());
  mockExpenseItemsCreate.mockReset();
  mockBudgetsGetForMonth.mockReset().mockReturnValue(null);
  mockTransaction.mockReset().mockImplementation((fn: () => void) => fn());
  mockPendingExpenseFindById.mockReset().mockReturnValue(null);
  mockPendingExpenseDelete.mockReset();
});

afterEach(() => {
  mock.restore();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('saveReceiptExpenses', () => {
  it('does nothing when no confirmed items', async () => {
    mockReceiptItemsFind.mockReturnValue([]);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    expect(appendExpenseRows).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('saves receipt items and sends completion message', async () => {
    mockReceiptItemsFind.mockReturnValue([makeReceiptItem()]);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    expect(appendExpenseRows).toHaveBeenCalledTimes(1);
    expect(mockExpenseCreate).toHaveBeenCalledTimes(1);
    expect(mockReceiptItemsDelete).toHaveBeenCalledTimes(1);

    // Completion message via sendMessage
    const completionMsg = sentMessages.find((m) => m.text.includes('Чек обработан'));
    expect(completionMsg).toBeDefined();
  });

  it('sends budget exceeded warning after saving receipt with over-budget category', async () => {
    const items = [
      makeReceiptItem({ id: 1, confirmed_category: 'Продукты', total: 5000 }),
      makeReceiptItem({ id: 2, confirmed_category: 'Продукты', total: 3000 }),
      makeReceiptItem({ id: 3, confirmed_category: 'Транспорт', total: 1000 }),
    ];
    mockReceiptItemsFind.mockReturnValue(items);

    // Budget set for Продукты — will be exceeded
    mockBudgetsGetForMonth.mockImplementation((...args: unknown[]) => {
      const category = args[1] as string;
      if (category === 'Продукты') {
        return {
          id: 1,
          category: 'Продукты',
          limit_amount: 10,
          currency: 'EUR',
          month: '2024-01',
        };
      }
      return null;
    });

    // Spent EUR so far exceeds budget
    mockExpenseSumByCategory.mockReturnValue(15);
    convertCurrency.mockReturnValue(15);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    // 2 categories → 2 sheet writes
    expect(appendExpenseRows).toHaveBeenCalledTimes(1);

    // Budget warning for Продукты (exceeded) via sendMessage
    const budgetMsg = sentMessages.find((m) => m.text.includes('ПРЕВЫШЕН БЮДЖЕТ'));
    expect(budgetMsg).toBeDefined();
    expect(budgetMsg?.text).toContain('Продукты');
  });

  it('sends warning when budget is at 90%+', async () => {
    mockReceiptItemsFind.mockReturnValue([makeReceiptItem({ total: 500 })]);

    mockBudgetsGetForMonth.mockReturnValue({
      id: 1,
      category: 'Продукты',
      limit_amount: 100,
      currency: 'EUR',
      month: '2024-01',
    });

    // 92 EUR spent out of 100 limit → 92% → warning
    mockExpenseSumByCategory.mockReturnValue(92);
    convertCurrency.mockReturnValue(92);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    const warningMsg = sentMessages.find((m) => m.text.includes('Приближение к лимиту'));
    expect(warningMsg).toBeDefined();
  });

  it('does not send warning when budget is under 90%', async () => {
    mockReceiptItemsFind.mockReturnValue([makeReceiptItem({ total: 500 })]);

    mockBudgetsGetForMonth.mockReturnValue({
      id: 1,
      category: 'Продукты',
      limit_amount: 100,
      currency: 'EUR',
      month: '2024-01',
    });

    // 50 EUR spent out of 100 → 50% → no warning
    mockExpenseSumByCategory.mockReturnValue(50);
    convertCurrency.mockReturnValue(50);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    // Only completion message, no budget warning
    const budgetMsgs = sentMessages.filter(
      (m) => m.text.includes('ПРЕВЫШЕН') || m.text.includes('Приближение'),
    );
    expect(budgetMsgs.length).toBe(0);
  });

  it('skips items without confirmed_category', async () => {
    mockReceiptItemsFind.mockReturnValue([
      makeReceiptItem({ id: 1, confirmed_category: null }),
      makeReceiptItem({ id: 2, confirmed_category: 'Продукты' }),
    ]);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    // Only 1 category processed (the one with confirmed_category)
    expect(appendExpenseRows).toHaveBeenCalledTimes(1);
  });

  it('commits nothing to DB when any sheet write fails (atomic)', async () => {
    mockReceiptItemsFind.mockReturnValue([
      makeReceiptItem({ id: 1, confirmed_category: 'Продукты', total: 200 }),
      makeReceiptItem({ id: 2, confirmed_category: 'Транспорт', total: 100 }),
    ]);

    appendExpenseRows.mockRejectedValueOnce(new Error('Sheet error'));

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    // Batch write attempted once, failed
    expect(appendExpenseRows).toHaveBeenCalledTimes(1);
    // No DB writes — atomic rollback
    expect(mockExpenseCreate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    // Receipt items NOT deleted — user can retry after /reconnect
    expect(mockReceiptItemsDelete).not.toHaveBeenCalled();
    // Error message sent to user
    const errorMsg = sentMessages.find((m) => m.text.includes('Не удалось'));
    expect(errorMsg).toBeDefined();
  });
});

// ── saveExpenseBatch ────────────────────────────────────────────────────────

function makePendingExpense(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: TEST_USER_ID,
    message_id: 100,
    parsed_amount: 500,
    parsed_currency: 'RSD' as CurrencyCode,
    detected_category: 'Продукты',
    comment: 'молоко',
    status: 'confirmed' as const,
    created_at: '2024-01-01',
    ...overrides,
  };
}

describe('saveExpenseBatch', () => {
  beforeEach(() => {
    mockGroupsFindById.mockReturnValue(makeGroup());
  });

  it('does nothing for empty array', async () => {
    await saveExpenseBatch(TEST_USER_ID, TEST_GROUP_ID, []);

    expect(appendExpenseRows).not.toHaveBeenCalled();
    expect(mockExpenseCreate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('writes all expenses to sheet then commits to DB atomically', async () => {
    const pe1 = makePendingExpense(10, { detected_category: 'Продукты', parsed_amount: 500 });
    const pe2 = makePendingExpense(11, { detected_category: 'Транспорт', parsed_amount: 300 });

    mockPendingExpenseFindById.mockImplementation((id: number) => {
      if (id === 10) return pe1;
      if (id === 11) return pe2;
      return null;
    });

    await saveExpenseBatch(TEST_USER_ID, TEST_GROUP_ID, [10, 11]);

    // Both written to sheet
    expect(appendExpenseRows).toHaveBeenCalledTimes(1);

    // One atomic transaction for both DB writes
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExpenseCreate).toHaveBeenCalledTimes(2);
    expect(mockPendingExpenseDelete).toHaveBeenCalledTimes(2);
  });

  it('commits nothing to DB when sheet batch write fails', async () => {
    const pe1 = makePendingExpense(10);
    const pe2 = makePendingExpense(11);

    mockPendingExpenseFindById.mockImplementation((id: number) => {
      if (id === 10) return pe1;
      if (id === 11) return pe2;
      return null;
    });

    appendExpenseRows.mockRejectedValueOnce(new Error('Auth expired'));

    await expect(saveExpenseBatch(TEST_USER_ID, TEST_GROUP_ID, [10, 11])).rejects.toThrow(
      'Auth expired',
    );

    // Batch write attempted once, failed
    expect(appendExpenseRows).toHaveBeenCalledTimes(1);

    // No DB writes at all — atomic rollback
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockExpenseCreate).not.toHaveBeenCalled();
    expect(mockPendingExpenseDelete).not.toHaveBeenCalled();
  });

  it('throws when group is not configured for Google Sheets', async () => {
    mockGroupsFindById.mockReturnValue({
      ...makeGroup(),
      spreadsheet_id: null as unknown as string,
    });

    await expect(saveExpenseBatch(TEST_USER_ID, TEST_GROUP_ID, [10])).rejects.toThrow(
      'Group not configured',
    );
  });

  it('throws when pending expense not found', async () => {
    mockPendingExpenseFindById.mockReturnValue(null);

    await expect(saveExpenseBatch(TEST_USER_ID, TEST_GROUP_ID, [999])).rejects.toThrow(
      'Pending expense 999 not found',
    );
  });

  it('checks budget limits after commit (deduplicated by category)', async () => {
    const pe1 = makePendingExpense(10, { detected_category: 'Продукты' });
    const pe2 = makePendingExpense(11, { detected_category: 'Продукты' });
    const pe3 = makePendingExpense(12, { detected_category: 'Транспорт' });

    mockPendingExpenseFindById.mockImplementation((id: number) => {
      if (id === 10) return pe1;
      if (id === 11) return pe2;
      if (id === 12) return pe3;
      return null;
    });

    mockBudgetsGetForMonth.mockReturnValue({
      id: 1,
      category: 'Продукты',
      limit_amount: 1000,
      currency: 'EUR',
      month: '2024-01',
    });

    await saveExpenseBatch(TEST_USER_ID, TEST_GROUP_ID, [10, 11, 12]);

    // 3 expenses but only 2 unique categories → 2 budget checks
    // (getBudgetForMonth is called once per unique category)
    expect(mockBudgetsGetForMonth).toHaveBeenCalledTimes(2);
  });
});
