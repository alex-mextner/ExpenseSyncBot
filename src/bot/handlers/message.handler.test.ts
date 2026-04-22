// Tests for message.handler — budget alert math + expense-parsing pipeline

import { beforeEach, describe, expect, it, mock, test } from 'bun:test';
import type { TelegramMessage } from '@gramio/types';
import type { Group, User } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { BotInstance, Ctx } from '../types';

describe('buildBudgetAlertStatus — budget currency conversion', () => {
  // RSD fallback rate: 1 RSD = 0.0086 EUR → 1 EUR ≈ 116 RSD
  // 100 EUR ≈ 11 600 RSD; budget limit = 15 000 RSD → ~77%

  it('converts EUR spending to budget currency before computing percentage', () => {
    const result = buildBudgetAlertStatus(100, {
      category: 'Food',
      limit_amount: 15_000,
      currency: 'RSD',
    });
    // 100 EUR ≈ 11 600 RSD, so percentage should be around 77%, not 0.67%
    expect(result.percentage).toBeGreaterThan(50);
    expect(result.percentage).toBeLessThan(100);
  });

  it('isExceeded is false when EUR spending converts below limit', () => {
    // 100 EUR ≈ 11 600 RSD < 15 000 RSD limit
    const result = buildBudgetAlertStatus(100, {
      category: 'Food',
      limit_amount: 15_000,
      currency: 'RSD',
    });
    expect(result.isExceeded).toBe(false);
  });

  it('isExceeded is true when EUR spending converts above limit', () => {
    // 200 EUR ≈ 23 200 RSD > 15 000 RSD limit
    const result = buildBudgetAlertStatus(200, {
      category: 'Food',
      limit_amount: 15_000,
      currency: 'RSD',
    });
    expect(result.isExceeded).toBe(true);
  });

  it('isWarning triggers when spending is 90–99% of limit in budget currency', () => {
    // 125 EUR ≈ 14 500 RSD, limit 15 000 RSD → ~97% → warning
    const result = buildBudgetAlertStatus(125, {
      category: 'Food',
      limit_amount: 15_000,
      currency: 'RSD',
    });
    expect(result.isWarning).toBe(true);
    expect(result.isExceeded).toBe(false);
  });

  it('EUR budget: 1:1, no conversion needed', () => {
    const result = buildBudgetAlertStatus(150, {
      category: 'Rent',
      limit_amount: 200,
      currency: 'EUR',
    });
    expect(result.percentage).toBe(75);
    expect(result.isExceeded).toBe(false);
  });

  it('spentInCurrency is in budget currency, not EUR', () => {
    const result = buildBudgetAlertStatus(100, {
      category: 'Food',
      limit_amount: 15_000,
      currency: 'RSD',
    });
    // spentInCurrency should be ~11 600 RSD, not 100
    expect(result.spentInCurrency).toBeGreaterThan(1_000);
  });
});

// ─── Expense-parsing pipeline (handleExpenseMessage) ────────────────────────

// All module mocks must be declared before importing handleExpenseMessage.

const logMock = createMockLogger();
mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

mock.module('../../config/env', () => ({
  env: { BOT_USERNAME: 'ExpenseSyncBot' },
}));

// ── telegram-sender: track sendMessage payloads ──
const sendMessageMock = mock(
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

// ── expense-saver: no real sheets IO ──
const saveExpenseBatchMock = mock((_uid: number, _gid: number, _ids: number[]) =>
  Promise.resolve(),
);
const saveReceiptExpensesMock = mock(() => Promise.resolve());
mock.module('../services/expense-saver', () => ({
  saveExpenseBatch: saveExpenseBatchMock,
  saveReceiptExpenses: saveReceiptExpensesMock,
}));

// ── ask (maybeSmartAdvice is fire-and-forget advice hook) ──
const maybeSmartAdviceMock = mock(() => Promise.resolve());
mock.module('../commands/ask', () => ({
  maybeSmartAdvice: maybeSmartAdviceMock,
}));

// ── dev pipeline — never trigger in these tests ──
mock.module('../commands/dev', () => ({
  consumePendingDesignEdit: mock(() => null),
  getPipelineInstance: mock(() => null),
}));

// ── feedback — never waiting ──
mock.module('../commands/feedback', () => ({
  consumePendingFeedback: mock(() => null),
  submitFeedback: mock(() => Promise.resolve()),
}));

// ── connect — currency-select branch default-off ──
const isAwaitingCustomCurrencyMock = mock(() => false);
const handleCustomCurrencyInputMock = mock(() => Promise.resolve(true));
mock.module('../commands/connect', () => ({
  isAwaitingCustomCurrency: isAwaitingCustomCurrencyMock,
  handleCustomCurrencyInput: handleCustomCurrencyInputMock,
}));

// ── bank wizard + reply edit ──
const handleWizardInputMock = mock(() => Promise.resolve(false));
const handleBankEditReplyMock = mock(() => Promise.resolve(false));
mock.module('../commands/bank', () => ({
  handleWizardInput: handleWizardInputMock,
  handleBankEditReply: handleBankEditReplyMock,
}));

// ── otp-manager — never resolves in these tests ──
const resolveOtpForGroupMock = mock(() => false);
mock.module('../../services/bank/otp-manager', () => ({
  resolveOtpForGroup: resolveOtpForGroupMock,
}));

// ── link-analyzer — no URLs / no payment ──
const extractURLsFromTextMock = mock((_t: string): string[] => []);
const processPaymentLinksMock = mock(() => Promise.resolve(false));
mock.module('../../services/receipt/link-analyzer', () => ({
  extractURLsFromText: extractURLsFromTextMock,
  processPaymentLinks: processPaymentLinksMock,
}));

// ── fuzzy-search — default: no fuzzy match (controlled in individual tests) ──
const findBestCategoryMatchAsyncMock = mock(() => Promise.resolve<string | null>(null));
mock.module('../../utils/fuzzy-search', () => ({
  findBestCategoryMatch: (_input: string, _categories: string[]): string | null => null,
  findBestCategoryMatchAsync: findBestCategoryMatchAsyncMock,
  normalizeCategoryName: (s: string) => s,
}));

// ── digit-emoji — stub reaction setter ──
mock.module('../../utils/digit-emoji', () => ({
  digitEmoji: (n: number) => String(n),
  setExpenseReaction: mock(() => Promise.resolve()),
}));

// ── database: mutable per-test state ──
const mockGroups = {
  findByTelegramGroupId: mock((_id: number): Group | null => null),
  hasCompletedSetup: mock((_id: number): boolean => true),
  update: mock(),
};
const mockUsers = {
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
  update: mock(),
};
const mockCategories = {
  exists: mock((_gid: number, _name: string): boolean => false),
  getCategoryNames: mock((_gid: number): string[] => []),
};
const mockPendingExpenses = {
  create: mock((data: Record<string, unknown>) => ({ id: 42, ...data })),
  delete: mock(() => {}),
};
const mockPhotoQueue = {
  findWaitingForBulkCorrection: mock(() => null),
};
const mockReceiptItems = {
  findWaitingForCategoryInput: mock(() => null),
};
const mockGroupMembers = {
  upsert: mock(),
  findGroupsByTelegramId: mock(() => []),
};
const mockDevTasks = {
  findById: mock(() => null),
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
  },
}));

// Dynamic-import target — must come AFTER all mock.module calls.
const { handleExpenseMessage, buildBudgetAlertStatus } = await import('./message.handler');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeGroup(overrides: Partial<Group> = {}): Group {
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
    oauth_client: 'current',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    telegram_id: 99,
    group_id: 1,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

/** Build a minimal Ctx['Message'] carrying just the shape the handler reads. */
function fakeMessageCtx(
  text: string,
  overrides: {
    chatType?: 'private' | 'group' | 'supergroup';
    chatId?: number;
    chatTitle?: string;
    fromId?: number;
    messageId?: number;
    username?: string;
    threadId?: number | null;
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
    chat: { id: chatId, type: chatType, title: overrides.chatTitle ?? 'Test Group' },
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

/** Minimal bot stub — only what handler touches (setMessageReaction). */
function fakeBot(): BotInstance {
  return {
    api: {
      setMessageReaction: mock(() => Promise.resolve()),
    },
  } as unknown as BotInstance;
}

// ─── Reset helpers ───────────────────────────────────────────────────────────

function resetAllMocks(): void {
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(null);
  saveExpenseBatchMock.mockReset().mockResolvedValue();
  saveReceiptExpensesMock.mockReset().mockResolvedValue();
  maybeSmartAdviceMock.mockReset().mockResolvedValue();
  isAwaitingCustomCurrencyMock.mockReset().mockReturnValue(false);
  handleCustomCurrencyInputMock.mockReset().mockResolvedValue(true);
  handleWizardInputMock.mockReset().mockResolvedValue(false);
  handleBankEditReplyMock.mockReset().mockResolvedValue(false);
  resolveOtpForGroupMock.mockReset().mockReturnValue(false);
  extractURLsFromTextMock.mockReset().mockReturnValue([]);
  processPaymentLinksMock.mockReset().mockResolvedValue(false);
  findBestCategoryMatchAsyncMock.mockReset().mockResolvedValue(null);

  mockGroups.findByTelegramGroupId.mockReset().mockReturnValue(null);
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
  mockPendingExpenses.create
    .mockReset()
    .mockImplementation((data) => ({ id: 42, ...(data as object) }));
  mockPendingExpenses.delete.mockReset();
  mockPhotoQueue.findWaitingForBulkCorrection.mockReset().mockReturnValue(null);
  mockReceiptItems.findWaitingForCategoryInput.mockReset().mockReturnValue(null);
  mockGroupMembers.upsert.mockReset();

  logMock.error.mockClear();
  logMock.warn.mockClear();
  logMock.info.mockClear();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleExpenseMessage — private chat redirect', () => {
  beforeEach(resetAllMocks);

  test('private chat → redirect, never touches group logic', async () => {
    mockGroupMembers.findGroupsByTelegramId = mock(() => []);
    const ctx = fakeMessageCtx('100 EUR groceries', { chatType: 'private', chatId: 42 });

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(mockGroups.findByTelegramGroupId).not.toHaveBeenCalled();
    expect(saveExpenseBatchMock).not.toHaveBeenCalled();
    // At least the "работает только в группах" notice is sent
    expect(sendMessageMock).toHaveBeenCalled();
  });
});

describe('handleExpenseMessage — group guards', () => {
  beforeEach(resetAllMocks);

  test('ignores message when required fields missing', async () => {
    const ctx = fakeMessageCtx('', { chatType: 'group' });
    delete (ctx as { text?: string }).text;

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(mockGroups.findByTelegramGroupId).not.toHaveBeenCalled();
    expect(saveExpenseBatchMock).not.toHaveBeenCalled();
  });

  test('group not set up → asks user to /connect', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(null);
    const ctx = fakeMessageCtx('100 EUR groceries');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(saveExpenseBatchMock).not.toHaveBeenCalled();
    const [msg] = sendMessageMock.mock.calls[0] ?? [];
    expect(String(msg)).toContain('/connect');
  });

  test('setup not completed → asks user to /connect', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockGroups.hasCompletedSetup.mockReturnValue(false);
    const ctx = fakeMessageCtx('100 EUR groceries');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(saveExpenseBatchMock).not.toHaveBeenCalled();
    const [msg] = sendMessageMock.mock.calls[0] ?? [];
    expect(String(msg)).toContain('/connect');
  });

  test('topic restriction: message from wrong topic is ignored', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup({ active_topic_id: 7 }));
    const ctx = fakeMessageCtx('100 EUR groceries', { threadId: 3 });

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(saveExpenseBatchMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('handleExpenseMessage — happy path (existing category)', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockCategories.getCategoryNames.mockReturnValue(['groceries']);
    mockCategories.exists.mockReturnValue(true);
  });

  test('"100 EUR groceries" saves expense, no new-category prompt', async () => {
    const ctx = fakeMessageCtx('100 EUR groceries');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(mockPendingExpenses.create).toHaveBeenCalledTimes(1);
    const [data] = mockPendingExpenses.create.mock.calls[0] ?? [];
    expect(data).toMatchObject({
      parsed_amount: 100,
      parsed_currency: 'EUR',
      detected_category: 'groceries',
      status: 'confirmed',
    });
    expect(saveExpenseBatchMock).toHaveBeenCalledTimes(1);
    // No new-category prompt sent
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('batch-save error surfaces as user-facing sheet error message', async () => {
    saveExpenseBatchMock.mockRejectedValue(new Error('sheets blew up'));
    const ctx = fakeMessageCtx('100 EUR groceries');

    await handleExpenseMessage(ctx, fakeBot());

    expect(mockPendingExpenses.delete).toHaveBeenCalledWith(42);
    expect(sendMessageMock).toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('handleExpenseMessage — multi-currency parsing', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockCategories.exists.mockReturnValue(true);
  });

  test.each<[string, number, string]>([
    ['100€ groceries', 100, 'EUR'],
    ['1 900 RSD ужин', 1900, 'RSD'],
    ['100е groceries', 100, 'EUR'],
    ['100д groceries', 100, 'USD'],
    ['$50 lunch', 50, 'USD'],
  ])('%s → amount=%s, currency=%s', async (text, amount, currency) => {
    const ctx = fakeMessageCtx(text);

    await handleExpenseMessage(ctx, fakeBot());

    expect(mockPendingExpenses.create).toHaveBeenCalledTimes(1);
    const [data] = mockPendingExpenses.create.mock.calls[0] ?? [];
    expect(data).toMatchObject({ parsed_amount: amount, parsed_currency: currency });
  });
});

describe('handleExpenseMessage — edge cases', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockCategories.exists.mockReturnValue(true);
  });

  test('message without amount is silently ignored (no expense)', async () => {
    const ctx = fakeMessageCtx('just chatting here');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
    expect(saveExpenseBatchMock).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });

  test('zero amount fails validation → no expense created', async () => {
    const ctx = fakeMessageCtx('0 EUR groceries');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
    expect(saveExpenseBatchMock).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });

  test('negative amount is not parsed by default regex → ignored', async () => {
    const ctx = fakeMessageCtx('-50 EUR refund');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });

  test('non-numeric text is ignored (no amount match)', async () => {
    // Plain words with no digit-led pattern → no expense created
    const ctx = fakeMessageCtx('привет как дела');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });
});

describe('handleExpenseMessage — new category confirmation', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockCategories.getCategoryNames.mockReturnValue([]);
    mockCategories.exists.mockReturnValue(false);
    findBestCategoryMatchAsyncMock.mockResolvedValue(null);
  });

  test('unknown category triggers confirmation keyboard', async () => {
    const ctx = fakeMessageCtx('100 EUR экзотика');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    // Pending expense created with pending_category status
    const [data] = mockPendingExpenses.create.mock.calls[0] ?? [];
    expect(data).toMatchObject({ status: 'pending_category' });

    // A confirmation message with inline keyboard is sent
    expect(sendMessageMock).toHaveBeenCalled();
    const [text, opts] = sendMessageMock.mock.calls[0] ?? [];
    expect(String(text)).toContain('экзотика');
    const kb = (opts as { reply_markup?: unknown })?.reply_markup;
    expect(kb).toBeDefined();

    // No sheet save because category is unresolved
    expect(saveExpenseBatchMock).not.toHaveBeenCalled();
  });

  test('fuzzy match resolves unknown → existing category, saves directly', async () => {
    mockCategories.getCategoryNames.mockReturnValue(['groceries']);
    findBestCategoryMatchAsyncMock.mockResolvedValue('groceries');
    // exists() returns false on first call (original word), but fuzzy matched
    // value is assumed to exist via the fuzzy return path.
    mockCategories.exists.mockReturnValue(false);
    const ctx = fakeMessageCtx('100 EUR grocerys');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    const [data] = mockPendingExpenses.create.mock.calls[0] ?? [];
    expect(data).toMatchObject({ detected_category: 'groceries', status: 'confirmed' });
    expect(saveExpenseBatchMock).toHaveBeenCalledTimes(1);
  });
});

describe('handleExpenseMessage — routing to other flows', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockCategories.exists.mockReturnValue(true);
  });

  test('bank wizard intercept short-circuits everything', async () => {
    handleWizardInputMock.mockResolvedValue(true);
    const ctx = fakeMessageCtx('1234');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
    expect(saveExpenseBatchMock).not.toHaveBeenCalled();
  });

  test('OTP resolve short-circuits expense parsing', async () => {
    resolveOtpForGroupMock.mockReturnValue(true);
    const ctx = fakeMessageCtx('654321');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
  });

  test('reply-to-message routes to handleBankEditReply', async () => {
    handleBankEditReplyMock.mockResolvedValue(true);
    const ctx = fakeMessageCtx('Кафе — latte', { replyToMessageId: 555 });

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(handleBankEditReplyMock).toHaveBeenCalledWith(ctx, -100, 'Кафе — latte', 555);
    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
  });

  test('URL message with payment short-circuits expense parsing', async () => {
    extractURLsFromTextMock.mockReturnValue(['https://bank.example/receipt/123']);
    processPaymentLinksMock.mockResolvedValue(true);
    const ctx = fakeMessageCtx('https://bank.example/receipt/123');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(processPaymentLinksMock).toHaveBeenCalled();
    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
  });

  test('custom-currency onboarding input is consumed by connect flow', async () => {
    isAwaitingCustomCurrencyMock.mockReturnValue(true);
    handleCustomCurrencyInputMock.mockResolvedValue(true);
    const ctx = fakeMessageCtx('AUD');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(handleCustomCurrencyInputMock).toHaveBeenCalled();
    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
  });
});

describe('handleExpenseMessage — multi-line batch', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockCategories.exists.mockReturnValue(true);
    let nextId = 100;
    mockPendingExpenses.create.mockImplementation((data) => ({
      id: nextId++,
      ...(data as object),
    }));
  });

  test('two lines → two pending expenses, batched save, numbered summary', async () => {
    const ctx = fakeMessageCtx('100 EUR groceries\n50 EUR coffee');

    const handled = await handleExpenseMessage(ctx, fakeBot());

    expect(handled).toBe(true);
    expect(mockPendingExpenses.create).toHaveBeenCalledTimes(2);
    expect(saveExpenseBatchMock).toHaveBeenCalledTimes(1);
    // Summary is sent because >1 expense recognized
    const summaryCall = sendMessageMock.mock.calls.find((c) => String(c[0]).includes('groceries'));
    expect(summaryCall).toBeDefined();
  });
});
