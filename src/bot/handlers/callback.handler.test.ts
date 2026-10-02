// Routing tests for src/bot/handlers/callback.handler.ts
// Covers every top-level `switch (action)` branch: verifies the correct downstream
// handler is invoked and answerCallbackQuery is always called (otherwise the button spins).

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mockDatabase } from '../../test-utils/mocks/database';
import { createMockLogger } from '../../test-utils/mocks/logger';

// ─── Logger mock ──────────────────────────────────────────────────────────────
const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ─── Telegram sender mock ─────────────────────────────────────────────────────
const sendMessageMock = mock((_text: string, _opts?: unknown) =>
  Promise.resolve({ message_id: 1 }),
);
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  sendDirect: mock(() => Promise.resolve(null)),
  editMessageText: mock(() => Promise.resolve()),
  deleteMessage: mock(() => Promise.resolve()),
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
}));

// ─── Database mock ────────────────────────────────────────────────────────────
type GroupStub = { id: number; telegram_group_id: number; default_currency: 'EUR' };
const mockGroups = {
  findByTelegramGroupId: mock<(_id: number) => GroupStub | null>(() => ({
    id: 1,
    telegram_group_id: -100,
    default_currency: 'EUR',
  })),
  findById: mock((_id: number) => ({
    id: 1,
    telegram_group_id: -100,
    default_currency: 'EUR' as const,
  })),
};
const mockUsers = {
  findByTelegramId: mock((_id: number) => ({ id: 10, telegram_id: 42, group_id: 1 })),
  create: mock((_d: unknown) => ({ id: 10, telegram_id: 42, group_id: 1 })),
  update: mock(() => undefined),
};
const mockCategories = {
  create: mock(() => undefined),
  exists: mock(() => true),
  findByGroupId: mock(() => []),
  findById: mock(() => null),
};
const mockPendingExpenses = {
  findById: mock(() => null),
  findByUserId: mock(() => []),
  update: mock(() => undefined),
  delete: mock(() => undefined),
};
const mockReceiptItems = {
  findById: mock(() => null),
  findByPhotoQueueId: mock(() => []),
  update: mock(() => undefined),
  deleteProcessedByPhotoQueueId: mock(() => undefined),
};
const mockPhotoQueue = {
  findById: mock(() => null),
  update: mock(() => undefined),
};
const mockMerchantRules = {
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

// ─── Downstream handler mocks (bank command module) ────────────────────────────
const bankMocks = {
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

// ─── connect / budget / dev / disconnect / feedback mocks ──────────────────────
const connectMocks = {
  handleCurrencyCallback: mock(() => Promise.resolve()),
  handleDefaultCurrencyCallback: mock(() => Promise.resolve()),
  handleSetupChoiceCallback: mock(() => Promise.resolve()),
};
mock.module('../commands/connect', () => connectMocks);

const sendBudgetViewMock = mock((_group: unknown) => Promise.resolve());
mock.module('../commands/budget', () => ({
  normalizeCurrency: (s: string) => s.toUpperCase(),
  sendBudgetView: sendBudgetViewMock,
}));

// ─── Smart budget prompt service ──────────────────────────────────────────────
interface PromptStub {
  id: number;
  group_id: number;
  user_id: number;
  category: string;
  currency: 'EUR';
}
const promptStub: PromptStub = {
  id: 5,
  group_id: 1,
  user_id: 10,
  category: 'Food',
  currency: 'EUR',
};
type LookupResult = { ok: true; prompt: PromptStub } | { ok: false; reason: 'stale' | 'foreign' };
const lookupPromptMock = mock(
  (_id: number, _groupId: number, _userId: number): LookupResult => ({
    ok: true,
    prompt: promptStub,
  }),
);
const applyPromptMock = mock(
  (_prompt: PromptStub, _amount: number, _currency: string): Promise<string> =>
    Promise.resolve('applied'),
);
const skipPromptMock = mock((_prompt: PromptStub) => true);
const sendBudgetPromptMock = mock((_params: unknown) => Promise.resolve());
mock.module('../services/budget-prompt', () => ({
  sendBudgetPrompt: sendBudgetPromptMock,
  lookupPromptForCallback: lookupPromptMock,
  applyBudgetPrompt: applyPromptMock,
  skipBudgetPrompt: skipPromptMock,
}));

const devMock = mock(() => Promise.resolve());
mock.module('../commands/dev', () => ({ handleDevCallback: devMock }));

const disconnectMocks = {
  handleDisconnectConfirm: mock(() => Promise.resolve()),
  handleDisconnectCancel: mock(() => Promise.resolve()),
};
mock.module('../commands/disconnect', () => disconnectMocks);

const cancelFeedbackMock = mock(() => undefined);
mock.module('../commands/feedback', () => ({
  cancelPendingFeedback: cancelFeedbackMock,
}));

const settingsMocks = {
  handleSettingsCallback: mock(() => Promise.resolve()),
};
mock.module('../commands/settings', () => settingsMocks);

// ─── sync-service (sendOldTransactionCards, skipOldTransactions) ──────────────
const sendOldMock = mock(() => Promise.resolve(0));
const skipOldMock = mock(() => Promise.resolve(0));
mock.module('../../services/bank/sync-service', () => ({
  sendOldTransactionCards: sendOldMock,
  skipOldTransactions: skipOldMock,
}));

// ─── expense saver / budget manager / sheet errors / keyboards ─────────────────
const saveExpenseBatchMock = mock(() => Promise.resolve());
mock.module('../services/expense-saver', () => ({
  saveExpenseBatch: saveExpenseBatchMock,
  saveReceiptExpenses: mock(() => Promise.resolve()),
}));

const setBudgetMock = mock(() => Promise.resolve());
mock.module('../../services/budget-manager', () => ({
  getBudgetManager: () => ({ set: setBudgetMock }),
}));

mock.module('../services/sheet-errors', () => ({
  getSheetErrorMessage: (_e: unknown) => 'sheet error',
}));

mock.module('../keyboards', () => ({
  createCategoriesListKeyboard: mock(() => ({ inline_keyboard: [] })),
  createCategoryConfirmKeyboard: mock(() => ({ inline_keyboard: [] })),
}));

const getPendingCategoryExpenseMock = mock<
  (userId: number, pendingExpenseId: number) => import('../../database/types').PendingExpense | null
>(() => null);
const getPendingCategorySiblingsMock = mock<
  (
    userId: number,
    current: import('../../database/types').PendingExpense,
  ) => import('../../database/types').PendingExpense[]
>(() => []);
const queueCategoryBudgetPromptMock = mock(() => undefined);
const showNextPendingCategoryStepMock = mock(() => Promise.resolve(true));
const takeQueuedCategoryBudgetPromptsMock = mock(() => [] as string[]);
mock.module('../services/category-wizard', () => ({
  getPendingCategoryExpense: getPendingCategoryExpenseMock,
  getPendingCategorySiblings: getPendingCategorySiblingsMock,
  queueCategoryBudgetPrompt: queueCategoryBudgetPromptMock,
  showNextPendingCategoryStep: showNextPendingCategoryStepMock,
  takeQueuedCategoryBudgetPrompts: takeQueuedCategoryBudgetPromptsMock,
}));

// trackMembership lives in the sibling message.handler — mock it to avoid pulling in the whole handler.
mock.module('./message.handler', () => ({
  trackMembership: mock(() => undefined),
}));

// Dynamic imports inside the handler — stub the modules they target.
mock.module('../commands/sync', () => ({
  getSyncCachedResult: mock(() => null),
}));
mock.module('../services/budget-sync', () => ({
  getBudgetSyncCachedResult: mock(() => null),
}));
mock.module('../../services/receipt/photo-processor', () => ({
  showNextItemForConfirmation: mock(() => Promise.resolve()),
}));
mock.module('../../services/receipt/receipt-summarizer', () => ({
  buildSummaryFromItems: mock(() => ({})),
  formatSummaryMessage: mock(() => ''),
  summaryToCategoryMap: mock(() => new Map()),
}));
mock.module('../../utils/fuzzy-search', () => ({
  normalizeCategoryName: (s: string) => s,
}));

// ─── Import SUT after all mocks are in place ──────────────────────────────────
const { handleCallbackQuery } = await import('./callback.handler');

// ─── Helpers ──────────────────────────────────────────────────────────────────
interface FakeCtx {
  data: string;
  from: { id: number };
  message?: { id: number; chat: { id: number; type: string } };
  answerCallbackQuery: ReturnType<typeof mock>;
  editText: ReturnType<typeof mock>;
  editReplyMarkup: ReturnType<typeof mock>;
}

function fakeCallbackCtx(data: string): FakeCtx {
  return {
    data,
    from: { id: 42 },
    message: { id: 200, chat: { id: -100, type: 'supergroup' } },
    answerCallbackQuery: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    editReplyMarkup: mock(() => Promise.resolve()),
  };
}

// Minimal BotInstance shape used inside the handler.
function fakeBot() {
  return {
    api: {
      deleteMessage: mock(() => Promise.resolve()),
      editMessageReplyMarkup: mock(() => Promise.resolve()),
      editMessageText: mock(() => Promise.resolve()),
    },
  };
}

// ─── Reset all mocks between tests ────────────────────────────────────────────
const resetables: ReturnType<typeof mock>[] = [
  sendMessageMock,
  cancelFeedbackMock,
  sendOldMock,
  skipOldMock,
  setBudgetMock,
  saveExpenseBatchMock,
  getPendingCategoryExpenseMock,
  getPendingCategorySiblingsMock,
  queueCategoryBudgetPromptMock,
  showNextPendingCategoryStepMock,
  takeQueuedCategoryBudgetPromptsMock,
  sendBudgetViewMock,
  lookupPromptMock,
  applyPromptMock,
  skipPromptMock,
  sendBudgetPromptMock,
  devMock,
  mockMerchantRules.updateStatus,
  mockGroups.findByTelegramGroupId,
  mockUsers.findByTelegramId,
  ...Object.values(bankMocks),
  ...Object.values(connectMocks),
  ...Object.values(disconnectMocks),
  ...Object.values(settingsMocks),
  logMock.error,
  logMock.warn,
  logMock.info,
];

afterEach(() => {
  for (const m of resetables) m.mockClear();
  // Reset common defaults that tests may have overridden.
  sendOldMock.mockImplementation(() => Promise.resolve(0));
  skipOldMock.mockImplementation(() => Promise.resolve(0));
  mockGroups.findByTelegramGroupId.mockImplementation(() => ({
    id: 1,
    telegram_group_id: -100,
    default_currency: 'EUR' as const,
  }));
  mockUsers.findByTelegramId.mockImplementation(() => ({
    id: 10,
    telegram_id: 42,
    group_id: 1,
  }));
  mockCategories.exists.mockImplementation(() => true);
  mockCategories.create.mockImplementation(() => undefined);
  mockCategories.findByGroupId.mockImplementation(() => []);
  mockCategories.findById.mockImplementation(() => null);
  getPendingCategoryExpenseMock.mockReturnValue(null);
  getPendingCategorySiblingsMock.mockReturnValue([]);
  showNextPendingCategoryStepMock.mockResolvedValue(true);
  takeQueuedCategoryBudgetPromptsMock.mockReturnValue([]);
  saveExpenseBatchMock.mockResolvedValue(undefined);
  lookupPromptMock.mockImplementation(() => ({ ok: true, prompt: promptStub }));
  applyPromptMock.mockImplementation(() => Promise.resolve('applied'));
  skipPromptMock.mockImplementation(() => true);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('handleCallbackQuery — routing table', () => {
  describe('connect / setup flow', () => {
    test('routes "setup:foo" → handleSetupChoiceCallback', async () => {
      const ctx = fakeCallbackCtx('setup:currency');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(connectMocks.handleSetupChoiceCallback).toHaveBeenCalledTimes(1);
      expect(connectMocks.handleSetupChoiceCallback).toHaveBeenCalledWith(ctx, 'currency');
    });

    test('routes "currency:EUR" → handleCurrencyCallback', async () => {
      const ctx = fakeCallbackCtx('currency:EUR');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(connectMocks.handleCurrencyCallback).toHaveBeenCalledTimes(1);
      expect(connectMocks.handleCurrencyCallback).toHaveBeenCalledWith(ctx, 'EUR', -100);
    });

    test('routes "default:RSD" → handleDefaultCurrencyCallback', async () => {
      const ctx = fakeCallbackCtx('default:RSD');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(connectMocks.handleDefaultCurrencyCallback).toHaveBeenCalledTimes(1);
      expect(connectMocks.handleDefaultCurrencyCallback).toHaveBeenCalledWith(ctx, 'RSD', -100);
    });
  });

  describe('feedback / disconnect / confirm', () => {
    test('routes "feedback_cancel" → cancelPendingFeedback + answer', async () => {
      const ctx = fakeCallbackCtx('feedback_cancel');
      const bot = fakeBot();
      await handleCallbackQuery(ctx as never, bot as never);
      expect(cancelFeedbackMock).toHaveBeenCalledWith(-100);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(bot.api.deleteMessage).toHaveBeenCalledTimes(1);
    });

    test('routes "confirm:disconnect:yes" → handleDisconnectConfirm', async () => {
      const ctx = fakeCallbackCtx('confirm:disconnect:yes');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(disconnectMocks.handleDisconnectConfirm).toHaveBeenCalledTimes(1);
      expect(disconnectMocks.handleDisconnectCancel).not.toHaveBeenCalled();
    });

    test('routes "confirm:disconnect:no" → handleDisconnectCancel', async () => {
      const ctx = fakeCallbackCtx('confirm:disconnect:no');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(disconnectMocks.handleDisconnectCancel).toHaveBeenCalledTimes(1);
      expect(disconnectMocks.handleDisconnectConfirm).not.toHaveBeenCalled();
    });

    test('routes "confirm:whatever:yes" → generic confirm answer', async () => {
      const ctx = fakeCallbackCtx('confirm:whatever:yes');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Подтверждено') }),
      );
    });
  });

  describe('settings routing', () => {
    test('routes "settings:edit:default_currency" → handleSettingsCallback with params', async () => {
      const ctx = fakeCallbackCtx('settings:edit:default_currency');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(settingsMocks.handleSettingsCallback).toHaveBeenCalledTimes(1);
      expect(settingsMocks.handleSettingsCallback).toHaveBeenCalledWith(ctx, [
        'edit',
        'default_currency',
      ]);
    });

    test('routes legacy "settings:bankcards" → handleSettingsCallback', async () => {
      const ctx = fakeCallbackCtx('settings:bankcards');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(settingsMocks.handleSettingsCallback).toHaveBeenCalledWith(ctx, ['bankcards']);
    });
  });

  describe('bank_* routing (numeric-ID shape)', () => {
    const cases: Array<{ data: string; fn: keyof typeof bankMocks }> = [
      { data: 'bank_confirm:7', fn: 'handleBankConfirmCallback' },
      { data: 'bank_edit:7', fn: 'handleBankEditCallback' },
      { data: 'bank_nocomment:7', fn: 'handleBankNoCommentCallback' },
      { data: 'bank_new:7', fn: 'handleBankNewCallback' },
      { data: 'bank_reconnect:3', fn: 'handleBankReconnectCallback' },
      { data: 'bank_settings:3', fn: 'handleBankSettingsCallback' },
      { data: 'bank_sync:3', fn: 'handleBankSyncCallback' },
      { data: 'bank_disconnect:3', fn: 'handleBankDisconnectCallback' },
      { data: 'bank_disconnect_confirm:3', fn: 'handleBankDisconnectConfirmCallback' },
      { data: 'bank_disconnect_cancel:3', fn: 'handleBankDisconnectCancelCallback' },
      { data: 'bank_settings_back:3', fn: 'handleBankSettingsBackCallback' },
      { data: 'bank_accounts:3', fn: 'handleBankAccountsCallback' },
    ];

    for (const { data, fn } of cases) {
      test(`routes "${data}" → ${fn}`, async () => {
        const ctx = fakeCallbackCtx(data);
        await handleCallbackQuery(ctx as never, fakeBot() as never);
        expect(bankMocks[fn]).toHaveBeenCalledTimes(1);
      });
    }

    test('routes "bank_merge:7:50" with two numeric args', async () => {
      const ctx = fakeCallbackCtx('bank_merge:7:50');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(bankMocks.handleBankMergeCallback).toHaveBeenCalledTimes(1);
      expect(bankMocks.handleBankMergeCallback).toHaveBeenCalledWith(ctx, 7, 50, -100);
    });

    test('routes "bank_receipt:7:10" with two numeric args', async () => {
      const ctx = fakeCallbackCtx('bank_receipt:7:10');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(bankMocks.handleBankReceiptCallback).toHaveBeenCalledTimes(1);
      expect(bankMocks.handleBankReceiptCallback).toHaveBeenCalledWith(ctx, 7, 10, -100);
    });

    test('routes "bank_account_toggle:11:3"', async () => {
      const ctx = fakeCallbackCtx('bank_account_toggle:11:3');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(bankMocks.handleBankAccountToggleCallback).toHaveBeenCalledTimes(1);
    });

    test('routes "bank_setup:tinkoff"', async () => {
      const ctx = fakeCallbackCtx('bank_setup:tinkoff');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(bankMocks.handleBankSetupCallback).toHaveBeenCalledTimes(1);
    });

    test('routes "bank_wizard_start:my:bank:key" (joins remaining params)', async () => {
      const ctx = fakeCallbackCtx('bank_wizard_start:my:bank:key');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(bankMocks.handleBankWizardStartCallback).toHaveBeenCalledTimes(1);
      // Fourth arg: the joined bankKey
      expect(bankMocks.handleBankWizardStartCallback).toHaveBeenCalledWith(
        ctx,
        expect.anything(),
        'my:bank:key',
        -100,
      );
    });

    test('routes "bank_wizard_cancel"', async () => {
      const ctx = fakeCallbackCtx('bank_wizard_cancel');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(bankMocks.handleBankWizardCancelCallback).toHaveBeenCalledTimes(1);
    });

    test('routes "bank_sync_all"', async () => {
      const ctx = fakeCallbackCtx('bank_sync_all');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(bankMocks.handleBankSyncAllCallback).toHaveBeenCalledTimes(1);
    });

    test('routes "bank_add"', async () => {
      const ctx = fakeCallbackCtx('bank_add');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(bankMocks.handleBankAddCallback).toHaveBeenCalledTimes(1);
    });

    test('routes "bank_letter:a" and uppercases the letter', async () => {
      const ctx = fakeCallbackCtx('bank_letter:a');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(bankMocks.handleBankLetterCallback).toHaveBeenCalledWith(
        ctx,
        expect.anything(),
        'A',
        -100,
      );
    });

    test('routes "bank_letter_nav"', async () => {
      const ctx = fakeCallbackCtx('bank_letter_nav');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(bankMocks.handleBankLetterNavCallback).toHaveBeenCalledTimes(1);
    });

    test('rejects numeric bank_* action with missing id (NaN-guard)', async () => {
      const ctx = fakeCallbackCtx('bank_confirm:');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(bankMocks.handleBankConfirmCallback).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Неверные данные') }),
      );
    });
  });

  describe('bank_show_old / bank_skip_old', () => {
    test('routes "bank_show_old:3" → sendOldTransactionCards', async () => {
      sendOldMock.mockImplementationOnce(() => Promise.resolve(5));
      const ctx = fakeCallbackCtx('bank_show_old:3');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(sendOldMock).toHaveBeenCalledWith(3);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(ctx.editText).toHaveBeenCalledTimes(2); // "sending..." then result
    });

    test('routes "bank_show_old:3" with 0 count → "нет транзакций"', async () => {
      sendOldMock.mockImplementationOnce(() => Promise.resolve(0));
      const ctx = fakeCallbackCtx('bank_show_old:3');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      const lastEdit = ctx.editText.mock.calls.at(-1)?.[0];
      expect(String(lastEdit)).toContain('Нет транзакций');
    });

    test('routes "bank_skip_old:3" → skipOldTransactions', async () => {
      skipOldMock.mockImplementationOnce(() => Promise.resolve(7));
      const ctx = fakeCallbackCtx('bank_skip_old:3');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(skipOldMock).toHaveBeenCalledWith(3);
      expect(ctx.editText).toHaveBeenCalled();
    });
  });

  describe('merchant_*', () => {
    test('routes "merchant_approve:11" → updateStatus(approved)', async () => {
      const ctx = fakeCallbackCtx('merchant_approve:11');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(mockMerchantRules.updateStatus).toHaveBeenCalledWith(11, 'approved');
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    test('routes "merchant_reject:11" → updateStatus(rejected)', async () => {
      const ctx = fakeCallbackCtx('merchant_reject:11');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(mockMerchantRules.updateStatus).toHaveBeenCalledWith(11, 'rejected');
    });

    test('routes "merchant_edit:11" — answers only', async () => {
      const ctx = fakeCallbackCtx('merchant_edit:11');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    test('rejects "merchant_approve:" (NaN id)', async () => {
      const ctx = fakeCallbackCtx('merchant_approve:');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(mockMerchantRules.updateStatus).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Неверные данные') }),
      );
    });
  });

  describe('dev / sync_more / bsync_more', () => {
    test('routes "dev:foo:bar" → handleDevCallback', async () => {
      const ctx = fakeCallbackCtx('dev:foo:bar');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(devMock).toHaveBeenCalledTimes(1);
      expect(devMock).toHaveBeenCalledWith(ctx, ['foo', 'bar'], 42, expect.anything());
    });

    test('routes "sync_more:cachekey:a" — stale cache answers gracefully', async () => {
      const ctx = fakeCallbackCtx('sync_more:cachekey:a');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
      // Cache miss → "данные устарели" message
      const answer = ctx.answerCallbackQuery.mock.calls[0]?.[0] as { text?: string };
      expect(answer?.text?.toLowerCase()).toContain('устарели');
    });

    test('routes "bsync_more:cachekey:d" — stale cache answers gracefully', async () => {
      const ctx = fakeCallbackCtx('bsync_more:cachekey:d');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('category / budget actions (require group lookup)', () => {
    test('legacy name-based category add is rejected instead of guessing a pending expense', async () => {
      const ctx = fakeCallbackCtx('category:add:Животные');
      await handleCallbackQuery(ctx as never, fakeBot() as never);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('устарела') }),
      );
      expect(saveExpenseBatchMock).not.toHaveBeenCalled();
    });

    test('category add is bound to pending id, batches duplicate rows, then advances one wizard step', async () => {
      const pending = {
        id: 77,
        user_id: 10,
        message_id: 500,
        parsed_amount: 100,
        parsed_currency: 'EUR' as const,
        detected_category: 'Животные',
        comment: '',
        status: 'pending_category' as const,
        created_at: '2026-10-01 00:00:00',
      };
      getPendingCategoryExpenseMock.mockReturnValue(pending);
      getPendingCategorySiblingsMock.mockReturnValue([pending]);
      mockCategories.exists.mockReturnValue(false);

      const ctx = fakeCallbackCtx('category:add:77');
      await handleCallbackQuery(ctx as never, fakeBot() as never);

      expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'Животные' });
      expect(mockPendingExpenses.update).toHaveBeenCalledWith(77, { status: 'confirmed' });
      expect(saveExpenseBatchMock).toHaveBeenCalledWith(10, 1, [77]);
      expect(queueCategoryBudgetPromptMock).toHaveBeenCalledWith(10, 500, 'Животные');
      expect(showNextPendingCategoryStepMock).toHaveBeenCalledWith(10, 500);
    });

    test('routes "category:cancel" → answer + deleteMessage', async () => {
      const ctx = fakeCallbackCtx('category:cancel');
      const bot = fakeBot();
      await handleCallbackQuery(ctx as never, bot as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Отменено' }),
      );
      expect(bot.api.deleteMessage).toHaveBeenCalledTimes(1);
    });

    test('routes "category:*" when group missing → friendly rejection', async () => {
      mockGroups.findByTelegramGroupId.mockImplementationOnce(() => null);
      const ctx = fakeCallbackCtx('category:cancel');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Группа не настроена') }),
      );
    });

    test('routes "budget:skip" → answer + deleteMessage', async () => {
      const ctx = fakeCallbackCtx('budget:skip');
      const bot = fakeBot();
      await handleCallbackQuery(ctx as never, bot as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Пропущено') }),
      );
    });

    test('routes "budget:xxx" unknown subaction → answers "Unknown"', async () => {
      const ctx = fakeCallbackCtx('budget:totally-unknown');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Unknown') }),
      );
    });

    test('routes "budget:set:Food:100:EUR" → BudgetManager.set', async () => {
      const ctx = fakeCallbackCtx('budget:set:Food:100:EUR');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(setBudgetMock).toHaveBeenCalledTimes(1);
      expect(setBudgetMock).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: 1,
          category: 'Food',
          amount: 100,
          currency: 'EUR',
        }),
      );
    });

    describe('smart budget prompt buttons', () => {
      test('budget:psuggest applies the amount to the prompt found by numeric id', async () => {
        const ctx = fakeCallbackCtx('budget:psuggest:5:150');
        const bot = fakeBot();
        await handleCallbackQuery(ctx as never, bot as never);

        expect(lookupPromptMock).toHaveBeenCalledWith(5, 1, 10);
        expect(applyPromptMock).toHaveBeenCalledWith(promptStub, 150, 'EUR');
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining('Бюджет установлен') }),
        );
        expect(bot.api.deleteMessage).toHaveBeenCalledTimes(1);
      });

      test('a stale prompt id does not mutate anything', async () => {
        lookupPromptMock.mockReturnValueOnce({ ok: false, reason: 'stale' });
        const ctx = fakeCallbackCtx('budget:psuggest:5:150');
        const bot = fakeBot();
        await handleCallbackQuery(ctx as never, bot as never);

        expect(applyPromptMock).not.toHaveBeenCalled();
        expect(setBudgetMock).not.toHaveBeenCalled();
        expect(bot.api.deleteMessage).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining('устарел') }),
        );
      });

      test('a prompt owned by another member is rejected', async () => {
        lookupPromptMock.mockReturnValueOnce({ ok: false, reason: 'foreign' });
        const ctx = fakeCallbackCtx('budget:psuggest:5:150');
        await handleCallbackQuery(ctx as never, fakeBot() as never);

        expect(applyPromptMock).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining('другим участником') }),
        );
      });

      test('an already handled prompt (double tap) keeps the message and reports stale', async () => {
        applyPromptMock.mockResolvedValueOnce('already_handled');
        const ctx = fakeCallbackCtx('budget:psuggest:5:150');
        const bot = fakeBot();
        await handleCallbackQuery(ctx as never, bot as never);

        expect(bot.api.deleteMessage).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining('уже обработан') }),
        );
      });

      test('a failed budget write is reported and the message stays', async () => {
        applyPromptMock.mockResolvedValueOnce('failed');
        const ctx = fakeCallbackCtx('budget:psuggest:5:150');
        const bot = fakeBot();
        await handleCallbackQuery(ctx as never, bot as never);

        expect(bot.api.deleteMessage).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining('Не удалось') }),
        );
      });

      test.each([
        'budget:psuggest:abc:150',
        'budget:psuggest:5:0',
        'budget:psuggest:5',
      ])('malformed "%s" is treated as stale', async (data) => {
        const ctx = fakeCallbackCtx(data);
        await handleCallbackQuery(ctx as never, fakeBot() as never);
        expect(applyPromptMock).not.toHaveBeenCalled();
        expect(lookupPromptMock).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
      });

      test('budget:pskip retires the prompt and removes the message', async () => {
        const ctx = fakeCallbackCtx('budget:pskip:5');
        const bot = fakeBot();
        await handleCallbackQuery(ctx as never, bot as never);

        expect(skipPromptMock).toHaveBeenCalledWith(promptStub);
        expect(setBudgetMock).not.toHaveBeenCalled();
        expect(bot.api.deleteMessage).toHaveBeenCalledTimes(1);
      });

      test('budget:pskip on a stale prompt does nothing', async () => {
        lookupPromptMock.mockReturnValueOnce({ ok: false, reason: 'stale' });
        const ctx = fakeCallbackCtx('budget:pskip:5');
        const bot = fakeBot();
        await handleCallbackQuery(ctx as never, bot as never);

        expect(skipPromptMock).not.toHaveBeenCalled();
        expect(bot.api.deleteMessage).not.toHaveBeenCalled();
      });

      test('budget:view answers the button and sends the shared budget view', async () => {
        const ctx = fakeCallbackCtx('budget:view');
        await handleCallbackQuery(ctx as never, fakeBot() as never);

        expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
        expect(sendBudgetViewMock).toHaveBeenCalledTimes(1);
        expect(sendBudgetViewMock.mock.calls[0]?.[0]).toMatchObject({ id: 1 });
      });

      test('finishing the category wizard sends one persistent prompt per queued category', async () => {
        const pending = {
          id: 77,
          user_id: 10,
          message_id: 500,
          parsed_amount: 100,
          parsed_currency: 'EUR' as const,
          detected_category: 'Животные',
          comment: '',
          status: 'pending_category' as const,
          created_at: '2026-10-01 00:00:00',
        };
        getPendingCategoryExpenseMock.mockReturnValue(pending);
        getPendingCategorySiblingsMock.mockReturnValue([pending]);
        mockCategories.exists.mockReturnValue(false);
        showNextPendingCategoryStepMock.mockResolvedValue(false);
        takeQueuedCategoryBudgetPromptsMock.mockReturnValue(['Животные', 'Еда']);

        await handleCallbackQuery(fakeCallbackCtx('category:add:77') as never, fakeBot() as never);

        expect(sendBudgetPromptMock).toHaveBeenCalledTimes(2);
        expect(sendBudgetPromptMock.mock.calls[0]?.[0]).toMatchObject({
          userId: 10,
          category: 'Животные',
        });
        expect(sendBudgetPromptMock.mock.calls[1]?.[0]).toMatchObject({ category: 'Еда' });
      });
    });
  });

  describe('receipt_item / receipt routing', () => {
    test('routes "receipt_item_other:99" with missing receipt item → answers gracefully', async () => {
      // receiptItems.findById returns null by default → answered "не найден"
      const ctx = fakeCallbackCtx('receipt_item_other:99');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('не найден') }),
      );
    });

    test('routes "confirm_receipt_item:99:0" with missing item → answers gracefully', async () => {
      const ctx = fakeCallbackCtx('confirm_receipt_item:99:0');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    });

    test('routes "skip_receipt_item:99" with missing item → answers gracefully', async () => {
      const ctx = fakeCallbackCtx('skip_receipt_item:99');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    });

    test('routes "use_found_category:99:Food" with missing item → answers gracefully', async () => {
      const ctx = fakeCallbackCtx('use_found_category:99:Food');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    });

    test('routes "create_new_category:99:Food" with missing item → answers gracefully', async () => {
      const ctx = fakeCallbackCtx('create_new_category:99:Food');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    });

    test('routes "receipt:cancel:42" with missing queue item → answers gracefully', async () => {
      // photoQueue.findById returns null by default
      const ctx = fakeCallbackCtx('receipt:cancel:42');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('не найден') }),
      );
    });
  });

  describe('error handling / malformed data', () => {
    test('empty data → no-op (early return, no answer needed)', async () => {
      const ctx = fakeCallbackCtx('');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      // data === '' → handler returns early without answering
      expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
      expect(logMock.error).not.toHaveBeenCalled();
    });

    test('unknown action → answers "Unknown action"', async () => {
      const ctx = fakeCallbackCtx('totally_unknown_prefix');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Unknown action') }),
      );
    });

    test('downstream throws → logs error and sends "Internal error"', async () => {
      bankMocks.handleBankConfirmCallback.mockImplementationOnce(() =>
        Promise.reject(new Error('boom')),
      );
      const ctx = fakeCallbackCtx('bank_confirm:7');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(logMock.error).toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Internal error') }),
      );
    });

    test('malformed currency action (missing currency) → rejected with "Invalid parameters"', async () => {
      const ctx = fakeCallbackCtx('currency:');
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(connectMocks.handleCurrencyCallback).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Invalid parameters') }),
      );
    });

    test('no chat.id (DM-less callback) + currency action → rejected', async () => {
      const ctx = fakeCallbackCtx('currency:EUR');
      (ctx as { message?: unknown }).message = undefined;
      await handleCallbackQuery(ctx as never, fakeBot() as never);
      expect(connectMocks.handleCurrencyCallback).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Invalid parameters') }),
      );
    });
  });
});
