/**
 * Shared module mocks + fakes for the callback handler characterization tests
 * (callback.routing.test.ts, callback.flows.test.ts, callback.receipt.test.ts).
 *
 * Importing this file registers every `mock.module` the callback handler needs, so
 * a test file only has to `import './callback.test-support'` first and then
 * `await import('./callback.handler')`. It is deliberately NOT named `*.test.ts`:
 * the test runner would otherwise execute it as a test file.
 */

import type { Mock } from 'bun:test';
import { mock } from 'bun:test';
import type {
  Group,
  PendingExpense,
  PhotoQueueItem,
  ReceiptItem,
  User,
} from '../../database/types';
import { mockDatabase } from '../../test-utils/mocks/database';
import { createMockLogger } from '../../test-utils/mocks/logger';

export const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

export const sendMessageMock = mock((_text: string, _opts?: unknown) =>
  Promise.resolve({ message_id: 1 }),
);
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  sendDirect: mock(() => Promise.resolve(null)),
  editMessageText: mock(() => Promise.resolve()),
  deleteMessage: mock(() => Promise.resolve()),
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
}));

export const mockGroups = {
  findByTelegramGroupId: mock<(_id: number) => Group | null>(() => null),
  findById: mock<(_id: number) => Group | null>(() => null),
};
export const mockUsers = {
  findByTelegramId: mock<(_id: number) => User | null>(() => null),
  create: mock((_d: unknown) => null as User | null),
  update: mock(() => undefined),
};
export const mockCategories = {
  create: mock(() => undefined),
  exists: mock(() => true),
  findByGroupId: mock(() => [] as Array<{ id: number; name: string }>),
  findById: mock(() => null as { id: number; name: string } | null),
};
export const mockPendingExpenses = {
  update: mock(() => undefined),
  delete: mock(() => undefined),
};
export const mockReceiptItems = {
  findById: mock<(_id: number) => ReceiptItem | null>(() => null),
  findByPhotoQueueId: mock<(_id: number) => ReceiptItem[]>(() => []),
  update: mock(() => undefined),
  deleteProcessedByPhotoQueueId: mock(() => undefined),
};
export const mockPhotoQueue = {
  findById: mock<(_id: number) => PhotoQueueItem | null>(() => null),
  update: mock(() => undefined),
};
export const mockMerchantRules = {
  updateStatus: mock(() => undefined),
};
mock.module('../../database', () => ({
  database: mockDatabase({
    groups: mockGroups,
    users: mockUsers,
    categories: mockCategories,
    pendingExpenses: mockPendingExpenses,
    receiptItems: mockReceiptItems,
    photoQueue: mockPhotoQueue,
    merchantRules: mockMerchantRules,
  }),
}));

export const bankMocks = {
  handleBankConfirmCallback: mock(() => Promise.resolve()),
  handleBankEditCallback: mock(() => Promise.resolve()),
  handleBankNoCommentCallback: mock(() => Promise.resolve()),
  handleBankMergeCallback: mock(() => Promise.resolve()),
  handleBankNewCallback: mock(() => Promise.resolve()),
  handleBankReceiptCallback: mock(() => Promise.resolve()),
  handleBankSetupCallback: mock(() => Promise.resolve()),
  handleBankReconnectCallback: mock(() => Promise.resolve()),
  handleBankWizardStartCallback: mock(() => Promise.resolve()),
  handleBankWizardCancelCallback: mock(() => Promise.resolve()),
  handleBankSettingsCallback: mock(() => Promise.resolve()),
  handleBankSyncCallback: mock(() => Promise.resolve()),
  handleBankSyncAllCallback: mock(() => Promise.resolve()),
  handleBankDisconnectCallback: mock(() => Promise.resolve()),
  handleBankDisconnectConfirmCallback: mock(() => Promise.resolve()),
  handleBankDisconnectCancelCallback: mock(() => Promise.resolve()),
  handleBankSettingsBackCallback: mock(() => Promise.resolve()),
  handleBankAddCallback: mock(() => Promise.resolve()),
  handleBankLetterCallback: mock(() => Promise.resolve()),
  handleBankLetterNavCallback: mock(() => Promise.resolve()),
  handleBankAccountsCallback: mock(() => Promise.resolve()),
  handleBankAccountToggleCallback: mock(() => Promise.resolve()),
};
mock.module('../commands/bank', () => bankMocks);

export const connectMocks = {
  handleCurrencyCallback: mock(() => Promise.resolve()),
  handleDefaultCurrencyCallback: mock(() => Promise.resolve()),
  handleSetupChoiceCallback: mock(() => Promise.resolve()),
};
mock.module('../commands/connect', () => connectMocks);

// '' for the sentinel 'bad' lets tests pin the `|| group.default_currency` fallback.
mock.module('../commands/budget', () => ({
  normalizeCurrency: (s: string) => (s === 'bad' ? '' : s.toUpperCase()),
}));

export const devMock = mock(() => Promise.resolve());
mock.module('../commands/dev', () => ({ handleDevCallback: devMock }));

export const disconnectMocks = {
  handleDisconnectConfirm: mock(() => Promise.resolve()),
  handleDisconnectCancel: mock(() => Promise.resolve()),
};
mock.module('../commands/disconnect', () => disconnectMocks);

export const cancelFeedbackMock = mock(() => undefined);
mock.module('../commands/feedback', () => ({ cancelPendingFeedback: cancelFeedbackMock }));

export const settingsMocks = { handleSettingsCallback: mock(() => Promise.resolve()) };
mock.module('../commands/settings', () => settingsMocks);

export const sendOldMock = mock(() => Promise.resolve(0));
export const skipOldMock = mock(() => Promise.resolve(0));
mock.module('../../services/bank/sync-service', () => ({
  sendOldTransactionCards: sendOldMock,
  skipOldTransactions: skipOldMock,
}));

export const saveExpenseBatchMock = mock(() => Promise.resolve());
export const saveReceiptExpensesMock = mock(() => Promise.resolve());
mock.module('../services/expense-saver', () => ({
  saveExpenseBatch: saveExpenseBatchMock,
  saveReceiptExpenses: saveReceiptExpensesMock,
}));

export const setBudgetMock = mock(() => Promise.resolve());
mock.module('../../services/budget-manager', () => ({
  getBudgetManager: () => ({ set: setBudgetMock }),
}));

mock.module('../services/sheet-errors', () => ({
  getSheetErrorMessage: (_e: unknown) => 'sheet error',
}));

export const budgetPromptKeyboardMock = mock((category: string, currency: string) => ({
  inline_keyboard: [[{ text: `${category}/${currency}`, callback_data: 'x' }]],
}));
export const categoriesListKeyboardMock = mock((_categories: unknown, pendingId: number) => ({
  inline_keyboard: [[{ text: `list/${pendingId}`, callback_data: 'x' }]],
}));
mock.module('../keyboards', () => ({
  createBudgetPromptKeyboard: budgetPromptKeyboardMock,
  createCategoriesListKeyboard: categoriesListKeyboardMock,
  createCategoryConfirmKeyboard: mock(() => ({ inline_keyboard: [] })),
}));

export const getPendingCategoryExpenseMock = mock<
  (userId: number, pendingExpenseId: number) => PendingExpense | null
>(() => null);
export const getPendingCategorySiblingsMock = mock<
  (userId: number, current: PendingExpense) => PendingExpense[]
>(() => []);
export const queueCategoryBudgetPromptMock = mock(() => undefined);
export const showNextPendingCategoryStepMock = mock(() => Promise.resolve(true));
export const takeQueuedCategoryBudgetPromptsMock = mock(() => [] as string[]);
mock.module('../services/category-wizard', () => ({
  getPendingCategoryExpense: getPendingCategoryExpenseMock,
  getPendingCategorySiblings: getPendingCategorySiblingsMock,
  queueCategoryBudgetPrompt: queueCategoryBudgetPromptMock,
  showNextPendingCategoryStep: showNextPendingCategoryStepMock,
  takeQueuedCategoryBudgetPrompts: takeQueuedCategoryBudgetPromptsMock,
}));

export const trackMembershipMock = mock(() => undefined);
mock.module('./message.handler', () => ({ trackMembership: trackMembershipMock }));

interface SyncOverflowItem {
  date: string;
  amount: number;
  currency: string;
  category: string;
  comment: string;
  field?: string;
}
interface SyncOverflowResult {
  added: SyncOverflowItem[];
  deleted: SyncOverflowItem[];
  updated: SyncOverflowItem[];
}
interface BudgetOverflowItem {
  category: string;
  limit: number;
  currency: string;
  oldLimit?: number;
}
interface BudgetOverflowResult {
  added: BudgetOverflowItem[];
  deleted: BudgetOverflowItem[];
  updated: BudgetOverflowItem[];
}
export const getSyncCachedResultMock = mock<(key: string) => SyncOverflowResult | null>(() => null);
export const getBudgetSyncCachedResultMock = mock<(key: string) => BudgetOverflowResult | null>(
  () => null,
);
mock.module('../commands/sync', () => ({ getSyncCachedResult: getSyncCachedResultMock }));
mock.module('../services/budget-sync', () => ({
  getBudgetSyncCachedResult: getBudgetSyncCachedResultMock,
}));

export const showNextItemMock = mock(() => Promise.resolve());
mock.module('../../services/receipt/photo-processor', () => ({
  showNextItemForConfirmation: showNextItemMock,
}));

export const summaryToCategoryMapMock = mock(() => new Map<string, string>());
export const buildSummaryMock = mock(() => ({ built: true }));
export const formatSummaryMock = mock(
  (_summary: unknown, count: number) => `SUMMARY(${count} items)`,
);
mock.module('../../services/receipt/receipt-summarizer', () => ({
  buildSummaryFromItems: buildSummaryMock,
  formatSummaryMessage: formatSummaryMock,
  summaryToCategoryMap: summaryToCategoryMapMock,
}));

// Wrapping makes the normalization observable: tests assert the wrapped value is persisted.
mock.module('../../utils/fuzzy-search', () => ({
  normalizeCategoryName: (s: string) => `N(${s})`,
}));

// ─── Domain fixtures ──────────────────────────────────────────────────────────
export const GROUP: Group = {
  id: 1,
  telegram_group_id: -100,
  default_currency: 'EUR',
} as Group;
export const USER: User = { id: 10, telegram_id: 42, group_id: 1 } as User;

export function pendingExpense(overrides: Partial<PendingExpense> = {}): PendingExpense {
  return {
    id: 77,
    user_id: 10,
    message_id: 500,
    parsed_amount: 100,
    parsed_currency: 'EUR',
    detected_category: 'Животные',
    comment: '',
    status: 'pending_category',
    created_at: '2026-10-01 00:00:00',
    ...overrides,
  };
}

export function receiptItem(overrides: Partial<ReceiptItem> = {}): ReceiptItem {
  return {
    id: 5,
    photo_queue_id: 9,
    name_ru: 'Молоко',
    name_original: null,
    quantity: 1,
    price: 2,
    total: 2,
    currency: 'EUR',
    suggested_category: 'Еда',
    possible_categories: ['Напитки', 'Молочка'],
    status: 'pending',
    confirmed_category: null,
    waiting_for_category_input: 0,
    created_at: '2026-10-01 00:00:00',
    ...overrides,
  };
}

export function queueItem(overrides: Partial<PhotoQueueItem> = {}): PhotoQueueItem {
  return {
    id: 9,
    group_id: 1,
    user_id: 10,
    message_id: 1,
    message_thread_id: null,
    file_id: 'f',
    status: 'processing',
    error_message: null,
    created_at: '2026-10-01 00:00:00',
    summary_mode: 0,
    ai_summary: null,
    correction_history: null,
    waiting_for_bulk_correction: 0,
    summary_message_id: null,
    ...overrides,
  };
}

// ─── Fakes ────────────────────────────────────────────────────────────────────
export interface FakeCtx {
  data: string;
  from: { id: number };
  message?: { id: number; chat: { id: number; type: string } } | undefined;
  answerCallbackQuery: Mock<(arg?: { text?: string }) => Promise<void>>;
  editText: Mock<(text: string) => Promise<void>>;
  editReplyMarkup: Mock<(markup: unknown) => Promise<void>>;
}

export function fakeCallbackCtx(data: string): FakeCtx {
  return {
    data,
    from: { id: 42 },
    message: { id: 200, chat: { id: -100, type: 'supergroup' } },
    answerCallbackQuery: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    editReplyMarkup: mock(() => Promise.resolve()),
  };
}

export interface FakeBot {
  api: {
    deleteMessage: Mock<() => Promise<void>>;
    editMessageReplyMarkup: Mock<() => Promise<void>>;
    editMessageText: Mock<() => Promise<void>>;
  };
}

export function fakeBot(): FakeBot {
  return {
    api: {
      deleteMessage: mock(() => Promise.resolve()),
      editMessageReplyMarkup: mock(() => Promise.resolve()),
      editMessageText: mock(() => Promise.resolve()),
    },
  };
}

/**
 * Run the real dispatcher against a prepared fake ctx/bot. The handler is imported lazily:
 * `mock.module` calls above must be registered before callback.handler first loads.
 */
export async function runCallback(ctx: FakeCtx, bot: FakeBot): Promise<void> {
  const { handleCallbackQuery } = await import('./callback.handler');
  await handleCallbackQuery(ctx as never, bot as never);
}

/** Build a fake ctx for `data` (optionally customised by `mutate`) and dispatch it. */
export async function dispatch(data: string, mutate?: (ctx: FakeCtx) => void) {
  const ctx = fakeCallbackCtx(data);
  const bot = fakeBot();
  mutate?.(ctx);
  await runCallback(ctx, bot);
  return { ctx, bot };
}

/** Texts passed to `answerCallbackQuery`, in call order (undefined = bare answer). */
export function answeredTexts(ctx: FakeCtx): Array<string | undefined> {
  return ctx.answerCallbackQuery.mock.calls.map(
    (call) => (call[0] as { text?: string } | undefined)?.text,
  );
}

const resettable: Array<{ mockReset(): void }> = [
  sendMessageMock,
  cancelFeedbackMock,
  sendOldMock,
  skipOldMock,
  setBudgetMock,
  saveExpenseBatchMock,
  saveReceiptExpensesMock,
  getPendingCategoryExpenseMock,
  getPendingCategorySiblingsMock,
  queueCategoryBudgetPromptMock,
  showNextPendingCategoryStepMock,
  takeQueuedCategoryBudgetPromptsMock,
  budgetPromptKeyboardMock,
  categoriesListKeyboardMock,
  trackMembershipMock,
  getSyncCachedResultMock,
  getBudgetSyncCachedResultMock,
  showNextItemMock,
  summaryToCategoryMapMock,
  buildSummaryMock,
  formatSummaryMock,
  devMock,
  mockMerchantRules.updateStatus,
  mockGroups.findByTelegramGroupId,
  mockGroups.findById,
  mockUsers.findByTelegramId,
  mockUsers.create,
  mockUsers.update,
  mockCategories.create,
  mockCategories.exists,
  mockCategories.findByGroupId,
  mockCategories.findById,
  mockPendingExpenses.update,
  mockPendingExpenses.delete,
  mockReceiptItems.findById,
  mockReceiptItems.findByPhotoQueueId,
  mockReceiptItems.update,
  mockReceiptItems.deleteProcessedByPhotoQueueId,
  mockPhotoQueue.findById,
  mockPhotoQueue.update,
  ...Object.values(bankMocks),
  ...Object.values(connectMocks),
  ...Object.values(disconnectMocks),
  ...Object.values(settingsMocks),
  logMock.error,
  logMock.warn,
  logMock.info,
];

/** Restore every mock to the default "configured group, existing user, nothing pending" world. */
export function resetCallbackMocks(): void {
  for (const m of resettable) m.mockReset();
  sendMessageMock.mockImplementation(() => Promise.resolve({ message_id: 1 }));
  sendOldMock.mockImplementation(() => Promise.resolve(0));
  skipOldMock.mockImplementation(() => Promise.resolve(0));
  mockGroups.findByTelegramGroupId.mockImplementation(() => GROUP);
  mockGroups.findById.mockImplementation(() => GROUP);
  mockUsers.findByTelegramId.mockImplementation(() => USER);
  mockCategories.exists.mockImplementation(() => true);
  mockCategories.findByGroupId.mockImplementation(() => []);
  mockCategories.findById.mockImplementation(() => null);
  mockReceiptItems.findById.mockImplementation(() => null);
  mockReceiptItems.findByPhotoQueueId.mockImplementation(() => []);
  mockPhotoQueue.findById.mockImplementation(() => null);
  getPendingCategoryExpenseMock.mockImplementation(() => null);
  getPendingCategorySiblingsMock.mockImplementation(() => []);
  showNextPendingCategoryStepMock.mockImplementation(() => Promise.resolve(true));
  takeQueuedCategoryBudgetPromptsMock.mockImplementation(() => []);
  saveExpenseBatchMock.mockImplementation(() => Promise.resolve());
  saveReceiptExpensesMock.mockImplementation(() => Promise.resolve());
  showNextItemMock.mockImplementation(() => Promise.resolve());
  summaryToCategoryMapMock.mockImplementation(() => new Map<string, string>());
  getSyncCachedResultMock.mockImplementation(() => null);
  getBudgetSyncCachedResultMock.mockImplementation(() => null);
  budgetPromptKeyboardMock.mockImplementation((category, currency) => ({
    inline_keyboard: [[{ text: `${category}/${currency}`, callback_data: 'x' }]],
  }));
  categoriesListKeyboardMock.mockImplementation((_categories, pendingId) => ({
    inline_keyboard: [[{ text: `list/${pendingId}`, callback_data: 'x' }]],
  }));
  formatSummaryMock.mockImplementation((_summary, count) => `SUMMARY(${count} items)`);
  buildSummaryMock.mockImplementation(() => ({ built: true }));
}
