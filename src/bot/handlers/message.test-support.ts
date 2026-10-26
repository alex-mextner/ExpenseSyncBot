// Shared mock setup + fixtures for message.*.test.ts (flows, category input).
// Importing this module registers every mock.module() the message handler needs,
// so test files must import it BEFORE dynamically importing './message.handler'.

import { type Mock, mock } from 'bun:test';
import type { TelegramMessage } from '@gramio/types';
import type { Group, PhotoQueueItem, ReceiptItem, User } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { BotInstance, Ctx } from '../types';

export const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

mock.module('../../config/env', () => ({
  env: { BOT_USERNAME: 'ExpenseSyncBot' },
}));

// ── telegram-sender ──
export const sendMessageMock = mock(
  (_text: string, _opts?: unknown): Promise<TelegramMessage | null> => Promise.resolve(null),
);
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  createInviteLink: mock(() => Promise.resolve(null)),
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
  initSender: mock(),
  editMessageText: mock(() => Promise.resolve()),
  deleteMessage: mock(() => Promise.resolve()),
  sendDirect: mock(() => Promise.resolve(null)),
  sendDocumentDirect: mock(() => Promise.resolve()),
  sendChatAction: mock(() => Promise.resolve()),
}));

// ── expense-saver ──
export const saveExpenseBatchMock = mock((_uid: number, _gid: number, _ids: number[]) =>
  Promise.resolve(),
);
export const saveReceiptExpensesMock = mock(
  (_photoQueueId: number, _groupId: number, _userId: number) => Promise.resolve(),
);
mock.module('../services/expense-saver', () => ({
  saveExpenseBatch: saveExpenseBatchMock,
  saveReceiptExpenses: saveReceiptExpensesMock,
}));

// ── ask ──
export const maybeSmartAdviceMock = mock((_groupId: number) => Promise.resolve());
mock.module('../commands/ask', () => ({
  maybeSmartAdvice: maybeSmartAdviceMock,
}));

// ── dev pipeline ──
export interface FakePipeline {
  editPR: Mock<(taskId: number, text: string) => Promise<void>>;
  editDesign: Mock<(taskId: number, text: string) => Promise<void>>;
}
export const consumePendingDesignEditMock = mock((_groupId: number): number | null => null);
export const getPipelineInstanceMock = mock((): FakePipeline | null => null);
mock.module('../commands/dev', () => ({
  consumePendingDesignEdit: consumePendingDesignEditMock,
  getPipelineInstance: getPipelineInstanceMock,
}));

// ── feedback ──
export const consumePendingFeedbackMock = mock(
  (_groupId: number, _telegramId: number): number | null => null,
);
export const submitFeedbackMock = mock(
  (_ctx: unknown, _group: unknown, _text: string, _opts: unknown) => Promise.resolve(),
);
mock.module('../commands/feedback', () => ({
  consumePendingFeedback: consumePendingFeedbackMock,
  submitFeedback: submitFeedbackMock,
}));

// ── connect / bank / otp ──
export const isAwaitingCustomCurrencyMock = mock((_groupId: number) => false);
export const handleCustomCurrencyInputMock = mock(() => Promise.resolve(true));
mock.module('../commands/connect', () => ({
  isAwaitingCustomCurrency: isAwaitingCustomCurrencyMock,
  handleCustomCurrencyInput: handleCustomCurrencyInputMock,
}));

export const handleWizardInputMock = mock(() => Promise.resolve(false));
export const handleBankEditReplyMock = mock(() => Promise.resolve(false));
mock.module('../commands/bank', () => ({
  handleWizardInput: handleWizardInputMock,
  handleBankEditReply: handleBankEditReplyMock,
}));

export const resolveOtpForGroupMock = mock((_groupId: number, _text: string) => false);
mock.module('../../services/bank/otp-manager', () => ({
  resolveOtpForGroup: resolveOtpForGroupMock,
}));

// ── link-analyzer ──
export const extractURLsFromTextMock = mock((_t: string): string[] => []);
export const processPaymentLinksMock = mock<(...args: unknown[]) => Promise<boolean>>(() =>
  Promise.resolve(false),
);
mock.module('../../services/receipt/link-analyzer', () => ({
  extractURLsFromText: extractURLsFromTextMock,
  processPaymentLinks: processPaymentLinksMock,
}));

// ── fuzzy-search ──
export const findBestCategoryMatchAsyncMock = mock(
  (_input: string, _categories: string[]): Promise<string | null> => Promise.resolve(null),
);
export const normalizeCategoryNameMock = mock((s: string) => s);
mock.module('../../utils/fuzzy-search', () => ({
  findBestCategoryMatch: (_input: string, _categories: string[]): string | null => null,
  findBestCategoryMatchAsync: findBestCategoryMatchAsyncMock,
  normalizeCategoryName: normalizeCategoryNameMock,
}));

// ── digit-emoji ──
export const setExpenseReactionMock = mock(() => Promise.resolve());
mock.module('../../utils/digit-emoji', () => ({
  digitEmoji: (n: number) => String(n),
  setExpenseReaction: setExpenseReactionMock,
}));

// ── receipt photo-processor (dynamic import in category text input) ──
export const showNextItemForConfirmationMock = mock((_groupId: number, _photoQueueId: number) =>
  Promise.resolve(),
);
mock.module('../../services/receipt/photo-processor', () => ({
  showNextItemForConfirmation: showNextItemForConfirmationMock,
}));

// ── category wizard ──
export const showNextPendingCategoryStepMock = mock((_userId: number, _messageId: number) =>
  Promise.resolve(true),
);
mock.module('../services/category-wizard', () => ({
  showNextPendingCategoryStep: showNextPendingCategoryStepMock,
}));

// ── database ──
export const mockGroups = {
  findByTelegramGroupId: mock((_id: number): Group | null => null),
  findById: mock((_id: number): Group | null => null),
  hasCompletedSetup: mock((_id: number): boolean => true),
  update: mock((_id: number, _data: Record<string, unknown>) => {}),
};
export const mockUsers = {
  findByTelegramId: mock((_id: number): User | null => null),
  create: mock(
    (data: { telegram_id: number; group_id: number }): User => ({
      id: 1,
      telegram_id: data.telegram_id,
      group_id: data.group_id,
      created_at: '',
      updated_at: '',
    }),
  ),
  update: mock((_id: number, _data: Record<string, unknown>) => {}),
};
export const mockCategories = {
  exists: mock((_gid: number, _name: string): boolean => false),
  getCategoryNames: mock((_gid: number): string[] => []),
  findByGroupId: mock((_gid: number): Array<{ name: string }> => []),
  create: mock((_data: { group_id: number; name: string }) => {}),
};
export const mockPendingExpenses = {
  create: mock((data: Record<string, unknown>) => ({ id: 42, ...data })),
  delete: mock((_id: number) => {}),
};
export const mockPhotoQueue = {
  findWaitingForBulkCorrection: mock((_gid: number): PhotoQueueItem | null => null),
  update: mock((_id: number, _data: Record<string, unknown>) => {}),
};
export const mockReceiptItems = {
  findWaitingForCategoryInput: mock((_gid: number): ReceiptItem | null => null),
  findByPhotoQueueId: mock((_qid: number): Array<Pick<ReceiptItem, 'status'>> => []),
  update: mock((_id: number, _data: Record<string, unknown>) => {}),
};
export const mockGroupMembers = {
  upsert: mock((_telegramId: number, _groupId: number) => {}),
  findGroupsByTelegramId: mock(() => []),
};
export const mockDevTasks = {
  findById: mock((_id: number): { state: string } | null => null),
};
export const mockChatMessages = {
  create: mock((_data: Record<string, unknown>) => ({ id: 1 })),
  pruneOldMessagesIfNeeded: mock(
    (_groupId: number, _messageThreadId: number | null, _keepCount: number, _everyWrites: number) =>
      0,
  ),
};

mock.module('../../database', () => ({
  database: {
    groups: mockGroups,
    users: mockUsers,
    categories: mockCategories,
    pendingExpenses: mockPendingExpenses,
    photoQueue: mockPhotoQueue,
    receiptItems: mockReceiptItems,
    groupMembers: mockGroupMembers,
    devTasks: mockDevTasks,
    chatMessages: mockChatMessages,
  },
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

export function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    title: 'Test Group',
    invite_link: null,
    google_refresh_token: 'tok',
    spreadsheet_id: 'sheet-1',
    default_currency: 'EUR',
    enabled_currencies: ['EUR', 'USD', 'RSD'],
    custom_prompt: null,
    active_topic_id: null,
    bank_panel_summary_message_id: null,
    bank_cards_enabled: 1,
    oauth_client: 'current',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    telegram_id: 99,
    group_id: 1,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

/** Receipt item stub — only the fields the category-input flow reads. */
export function makeReceiptItem(overrides: Partial<ReceiptItem> = {}): ReceiptItem {
  return {
    id: 7,
    photo_queue_id: 70,
    ...overrides,
  } as ReceiptItem;
}

/** Build a minimal Ctx['Message'] carrying just the shape the handler reads. */
export function fakeMessageCtx(
  text: string,
  overrides: {
    chatType?: 'private' | 'group' | 'supergroup';
    chatId?: number;
    chatTitle?: string;
    fromId?: number;
    messageId?: number;
    username?: string;
    threadId?: number | null;
    isForum?: boolean;
    replyToMessageId?: number;
  } = {},
): Ctx['Message'] {
  const chatType = overrides.chatType ?? 'group';
  const chatId = overrides.chatId ?? -100;
  const fromId = overrides.fromId ?? 99;
  const messageId = overrides.messageId ?? 500;
  return {
    id: messageId,
    text,
    from: { id: fromId, username: overrides.username ?? 'alex', firstName: 'Alex' },
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
      isForum: overrides.isForum ?? false,
    },
    update: {
      message: {
        message_thread_id: overrides.threadId,
        reply_to_message: overrides.replyToMessageId
          ? { message_id: overrides.replyToMessageId }
          : undefined,
      },
    },
  } as unknown as Ctx['Message'];
}

/** Bot stub plus the setMessageReaction mock, the sole API call the handler makes. */
export interface FakeBot {
  bot: BotInstance;
  setReaction: Mock<(params: unknown) => Promise<void>>;
}

export function fakeBotWithReactions(): FakeBot {
  const setReaction = mock((_params: unknown) => Promise.resolve());
  const bot = { api: { setMessageReaction: setReaction } } as unknown as BotInstance;
  return { bot, setReaction };
}

// ─── Reset ───────────────────────────────────────────────────────────────────

/** Reset every shared mock to its default "nothing special happens" behavior. */
export function resetAllMocks(): void {
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(null);
  saveExpenseBatchMock.mockReset().mockResolvedValue();
  saveReceiptExpensesMock.mockReset().mockResolvedValue();
  maybeSmartAdviceMock.mockReset().mockResolvedValue();
  consumePendingDesignEditMock.mockReset().mockReturnValue(null);
  getPipelineInstanceMock.mockReset().mockReturnValue(null);
  consumePendingFeedbackMock.mockReset().mockReturnValue(null);
  submitFeedbackMock.mockReset().mockResolvedValue();
  isAwaitingCustomCurrencyMock.mockReset().mockReturnValue(false);
  handleCustomCurrencyInputMock.mockReset().mockResolvedValue(true);
  handleWizardInputMock.mockReset().mockResolvedValue(false);
  handleBankEditReplyMock.mockReset().mockResolvedValue(false);
  resolveOtpForGroupMock.mockReset().mockReturnValue(false);
  extractURLsFromTextMock.mockReset().mockReturnValue([]);
  processPaymentLinksMock.mockReset().mockResolvedValue(false);
  findBestCategoryMatchAsyncMock.mockReset().mockResolvedValue(null);
  normalizeCategoryNameMock.mockReset().mockImplementation((s: string) => s);
  setExpenseReactionMock.mockReset().mockResolvedValue();
  showNextItemForConfirmationMock.mockReset().mockResolvedValue();
  showNextPendingCategoryStepMock.mockReset().mockResolvedValue(true);

  mockGroups.findByTelegramGroupId.mockReset().mockReturnValue(null);
  mockGroups.findById.mockReset().mockReturnValue(null);
  mockGroups.hasCompletedSetup.mockReset().mockReturnValue(true);
  mockGroups.update.mockReset();
  mockUsers.findByTelegramId.mockReset().mockReturnValue(makeUser());
  mockUsers.create
    .mockReset()
    .mockImplementation((data) =>
      makeUser({ telegram_id: data.telegram_id, group_id: data.group_id }),
    );
  mockUsers.update.mockReset();
  mockCategories.exists.mockReset().mockReturnValue(false);
  mockCategories.getCategoryNames.mockReset().mockReturnValue([]);
  mockCategories.findByGroupId.mockReset().mockReturnValue([]);
  mockCategories.create.mockReset();
  mockPendingExpenses.create
    .mockReset()
    .mockImplementation((data) => ({ id: 42, ...(data as object) }));
  mockPendingExpenses.delete.mockReset();
  mockPhotoQueue.findWaitingForBulkCorrection.mockReset().mockReturnValue(null);
  mockPhotoQueue.update.mockReset();
  mockReceiptItems.findWaitingForCategoryInput.mockReset().mockReturnValue(null);
  mockReceiptItems.findByPhotoQueueId.mockReset().mockReturnValue([]);
  mockReceiptItems.update.mockReset();
  mockGroupMembers.upsert.mockReset();
  mockDevTasks.findById.mockReset().mockReturnValue(null);
  mockChatMessages.create.mockReset().mockImplementation(() => ({ id: 1 }));
  mockChatMessages.pruneOldMessagesIfNeeded.mockReset().mockReturnValue(0);

  logMock.error.mockClear();
  logMock.warn.mockClear();
  logMock.info.mockClear();
}
