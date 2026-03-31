// Tests for saveReceiptExpenses — budget check integration after receipt save

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { ReceiptItem } from '../../database/types';

// ── Mock database (10+ other test files poison it via mock.module — we must do the same) ──

const mockReceiptItems = {
  findConfirmedByPhotoQueueId: mock(() => [] as ReceiptItem[]),
  deleteProcessedByPhotoQueueId: mock(() => {}),
};

const mockGroups = {
  findById: mock(() => makeGroup()),
};

const mockExpenses = {
  create: mock(() => ({
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
  })),
  sumByCategory: mock(() => 0),
};

const mockExpenseItems = {
  create: mock(() => ({
    id: 1,
    expense_id: 1,
    name_ru: 'Молоко',
    name_original: 'Mleko',
    quantity: 1,
    price: 200,
    total: 200,
  })),
};

const mockBudgets = {
  getBudgetForMonth: mock(
    (
      ..._args: unknown[]
    ): {
      id: number;
      category: string;
      limit_amount: number;
      currency: string;
      month: string;
    } | null => null,
  ),
};

const mockTransaction = mock((fn: () => void) => fn());

mock.module('../../database', () => ({
  database: {
    receiptItems: mockReceiptItems,
    groups: mockGroups,
    expenses: mockExpenses,
    expenseItems: mockExpenseItems,
    budgets: mockBudgets,
    transaction: mockTransaction,
  },
}));

// ── Mock sendToChat (used by both saveReceiptExpenses and checkBudgetLimit) ──

const sentMessages: { text: string; options: Record<string, unknown> | undefined }[] = [];
const mockSendToChat = mock((text: string, options?: Record<string, unknown>) => {
  sentMessages.push({ text, options });
  return Promise.resolve({ message_id: 1 });
});

mock.module('../send', () => ({
  sendToChat: mockSendToChat,
  initSend: () => {},
}));

// Import after mocks are set up (sheets/converter are spied via spyOn below)
import * as converterModule from '../../services/currency/converter';
import * as sheetsModule from '../../services/google/sheets';
import { saveReceiptExpenses } from './expense-saver';

// ── Test data ───────────────────────────────────────────────────────────────────

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

// ── Spies on real modules ───────────────────────────────────────────────────────

let appendRowSpy: ReturnType<typeof spyOn>;
let convertCurrencySpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  sentMessages.length = 0;

  // Reset database mocks
  mockReceiptItems.findConfirmedByPhotoQueueId.mockReset().mockReturnValue([]);
  mockReceiptItems.deleteProcessedByPhotoQueueId.mockReset();
  mockGroups.findById.mockReset().mockReturnValue(makeGroup());
  mockExpenses.create.mockReset().mockReturnValue({
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
  mockExpenses.sumByCategory.mockReset().mockReturnValue(0);
  mockExpenseItems.create.mockReset();
  mockBudgets.getBudgetForMonth.mockReset().mockReturnValue(null);
  mockTransaction.mockReset().mockImplementation((fn: () => void) => fn());
  mockSendToChat.mockClear();

  // Spy on real module exports
  appendRowSpy = spyOn(sheetsModule, 'appendExpenseRow').mockResolvedValue(undefined);
  spyOn(converterModule, 'convertToEUR').mockReturnValue(1.72);
  convertCurrencySpy = spyOn(converterModule, 'convertCurrency').mockReturnValue(0);
  spyOn(converterModule, 'formatAmount').mockImplementation(
    (amount: number, currency: CurrencyCode) => `${amount.toFixed(2)} ${currency}`,
  );
});

afterEach(() => {
  mock.restore();
});

describe('saveReceiptExpenses', () => {
  it('does nothing when no confirmed items', async () => {
    mockReceiptItems.findConfirmedByPhotoQueueId.mockReturnValue([]);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    expect(appendRowSpy).not.toHaveBeenCalled();
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it('saves receipt items and sends completion message', async () => {
    mockReceiptItems.findConfirmedByPhotoQueueId.mockReturnValue([makeReceiptItem()]);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    expect(appendRowSpy).toHaveBeenCalledTimes(1);
    expect(mockExpenses.create).toHaveBeenCalledTimes(1);
    expect(mockReceiptItems.deleteProcessedByPhotoQueueId).toHaveBeenCalledTimes(1);

    // Completion message via sendToChat
    const completionMsg = sentMessages.find((m) => m.text.includes('Чек обработан'));
    expect(completionMsg).toBeDefined();
  });

  it('sends budget exceeded warning after saving receipt with over-budget category', async () => {
    const items = [
      makeReceiptItem({ id: 1, confirmed_category: 'Продукты', total: 5000 }),
      makeReceiptItem({ id: 2, confirmed_category: 'Продукты', total: 3000 }),
      makeReceiptItem({ id: 3, confirmed_category: 'Транспорт', total: 1000 }),
    ];
    mockReceiptItems.findConfirmedByPhotoQueueId.mockReturnValue(items);

    // Budget set for Продукты — will be exceeded
    mockBudgets.getBudgetForMonth.mockImplementation((...args: unknown[]) => {
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
    mockExpenses.sumByCategory.mockReturnValue(15);
    convertCurrencySpy.mockReturnValue(15);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    // 2 categories → 2 sheet writes
    expect(appendRowSpy).toHaveBeenCalledTimes(2);

    // Budget warning for Продукты (exceeded) via sendToChat
    const budgetMsg = sentMessages.find((m) => m.text.includes('ПРЕВЫШЕН БЮДЖЕТ'));
    expect(budgetMsg).toBeDefined();
    expect(budgetMsg?.text).toContain('Продукты');
  });

  it('sends warning when budget is at 90%+', async () => {
    mockReceiptItems.findConfirmedByPhotoQueueId.mockReturnValue([makeReceiptItem({ total: 500 })]);

    mockBudgets.getBudgetForMonth.mockReturnValue({
      id: 1,
      category: 'Продукты',
      limit_amount: 100,
      currency: 'EUR',
      month: '2024-01',
    });

    // 92 EUR spent out of 100 limit → 92% → warning
    mockExpenses.sumByCategory.mockReturnValue(92);
    convertCurrencySpy.mockReturnValue(92);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    const warningMsg = sentMessages.find((m) => m.text.includes('Приближение к лимиту'));
    expect(warningMsg).toBeDefined();
  });

  it('does not send warning when budget is under 90%', async () => {
    mockReceiptItems.findConfirmedByPhotoQueueId.mockReturnValue([makeReceiptItem({ total: 500 })]);

    mockBudgets.getBudgetForMonth.mockReturnValue({
      id: 1,
      category: 'Продукты',
      limit_amount: 100,
      currency: 'EUR',
      month: '2024-01',
    });

    // 50 EUR spent out of 100 → 50% → no warning
    mockExpenses.sumByCategory.mockReturnValue(50);
    convertCurrencySpy.mockReturnValue(50);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    // Only completion message, no budget warning
    const budgetMsgs = sentMessages.filter(
      (m) => m.text.includes('ПРЕВЫШЕН') || m.text.includes('Приближение'),
    );
    expect(budgetMsgs.length).toBe(0);
  });

  it('skips items without confirmed_category', async () => {
    mockReceiptItems.findConfirmedByPhotoQueueId.mockReturnValue([
      makeReceiptItem({ id: 1, confirmed_category: null }),
      makeReceiptItem({ id: 2, confirmed_category: 'Продукты' }),
    ]);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    // Only 1 category processed (the one with confirmed_category)
    expect(appendRowSpy).toHaveBeenCalledTimes(1);
  });

  it('continues to next category when sheet write fails', async () => {
    mockReceiptItems.findConfirmedByPhotoQueueId.mockReturnValue([
      makeReceiptItem({ id: 1, confirmed_category: 'Продукты', total: 200 }),
      makeReceiptItem({ id: 2, confirmed_category: 'Транспорт', total: 100 }),
    ]);

    appendRowSpy.mockRejectedValueOnce(new Error('Sheet error')).mockResolvedValueOnce(undefined);

    await saveReceiptExpenses(TEST_PHOTO_QUEUE_ID, TEST_GROUP_ID, TEST_USER_ID);

    // Sheet was attempted for both categories
    expect(appendRowSpy).toHaveBeenCalledTimes(2);
    // But only Транспорт expense was created (Продукты was skipped due to sheet error)
    expect(mockExpenses.create).toHaveBeenCalledTimes(1);
  });
});
