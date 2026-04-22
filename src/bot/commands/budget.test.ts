// Tests for /budget — list, set (per currency), sync, guards, error paths

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { GoogleConnectedGroup } from '../guards';
import type { Ctx } from '../types';

// ── Logger (before any import of budget.ts) ───────────────────────────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Database ──────────────────────────────────────────────────────────────

const mockExpenses = {
  findByDateRange: mock(
    (
      _groupId: number,
      _from: string,
      _to: string,
    ): Array<{ category: string; eur_amount: number }> => [],
  ),
};

const mockBudgets = {
  getAllBudgetsForMonth: mock(
    (
      _groupId: number,
      _month: string,
    ): Array<{
      category: string;
      limit_amount: number;
      currency: CurrencyCode;
    }> => [],
  ),
};

const mockCategories = {
  exists: mock((_groupId: number, _name: string): boolean => true),
  create: mock((_data: { group_id: number; name: string }): void => {}),
  getCategoryNames: mock((_groupId: number): string[] => []),
};

mock.module('../../database', () => ({
  database: {
    expenses: mockExpenses,
    budgets: mockBudgets,
    categories: mockCategories,
  },
}));

// ── BudgetManager ─────────────────────────────────────────────────────────

interface SetArgs {
  groupId: number;
  category: string;
  month: string;
  amount: number;
  currency: CurrencyCode;
}

const budgetManagerMock = {
  set: mock(async (_p: SetArgs): Promise<{ sheetsSynced: boolean }> => ({ sheetsSynced: true })),
  delete: mock(
    async (_p: {
      groupId: number;
      category: string;
      month: string;
    }): Promise<{ deleted: boolean; sheetsSynced: boolean; resolvedCategory?: string }> => ({
      deleted: true,
      sheetsSynced: true,
    }),
  ),
  importFromSheet: mock((_p: SetArgs): { multiWordWarning?: string } => ({})),
};

mock.module('../../services/budget-manager', () => ({
  getBudgetManager: () => budgetManagerMock,
}));

// ── Google Sheets ─────────────────────────────────────────────────────────

const monthTabExistsMock = mock(async (): Promise<boolean> => true);
const createEmptyMonthTabMock = mock(async (): Promise<void> => {});
const readMonthBudgetMock = mock(
  async (): Promise<Array<{ category: string; limit: number; currency: CurrencyCode }>> => [],
);
const googleConnMock = mock(() => ({ refreshToken: 'tok', oauthClient: 'current' as const }));

mock.module('../../services/google/sheets', () => ({
  createEmptyMonthTab: createEmptyMonthTabMock,
  googleConn: googleConnMock,
  monthTabExists: monthTabExistsMock,
  readMonthBudget: readMonthBudgetMock,
}));

// ── Telegram sender ───────────────────────────────────────────────────────

const sendMessageMock = mock(
  (_text: string, _options?: unknown): Promise<null> => Promise.resolve(null),
);

mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
  editMessageText: mock(() => Promise.resolve()),
  sendDirect: mock(() => Promise.resolve(null)),
  deleteMessage: mock(() => Promise.resolve()),
}));

// ── Budget-sync (silent) ──────────────────────────────────────────────────

const silentSyncBudgetsMock = mock(async (): Promise<number> => 0);
mock.module('../services/budget-sync', () => ({
  silentSyncBudgets: silentSyncBudgetsMock,
}));

// ── Analytics (used by formatBudgetProgressText — we stub to avoid noise) ─

mock.module('../../services/analytics/spending-analytics', () => ({
  spendingAnalytics: {
    getFinancialSnapshot: () => ({ technicalAnalysis: null }),
  },
}));

// ── maybeSmartAdvice — no-op ──────────────────────────────────────────────

mock.module('./ask', () => ({
  maybeSmartAdvice: mock(async () => undefined),
}));

// ── Currency converter / format (identity-ish to simplify assertions) ─────

mock.module('../../services/currency/converter', () => ({
  convertCurrency: mock((amount: number) => amount),
  formatAmount: mock((amount: number, currency: string) => `${amount} ${currency}`),
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { handleBudgetCommand } = await import('./budget');

// ── Fixtures ──────────────────────────────────────────────────────────────

function fakeCtx(text: string): Ctx['Command'] {
  return {
    chat: { id: -100, type: 'supergroup' },
    from: { id: 1 },
    text,
  } as unknown as Ctx['Command'];
}

function fakeGroup(overrides: Partial<GoogleConnectedGroup> = {}): GoogleConnectedGroup {
  return {
    id: 1,
    telegram_group_id: -100,
    title: null,
    invite_link: null,
    google_refresh_token: 'tok',
    spreadsheet_id: 'sheet-123',
    default_currency: 'EUR',
    enabled_currencies: ['EUR'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'current',
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  } as GoogleConnectedGroup;
}

// Reset everything between tests
beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  silentSyncBudgetsMock.mockReset().mockResolvedValue(0);

  budgetManagerMock.set.mockReset().mockResolvedValue({ sheetsSynced: true });
  budgetManagerMock.delete.mockReset().mockResolvedValue({ deleted: true, sheetsSynced: true });
  budgetManagerMock.importFromSheet.mockReset().mockReturnValue({});

  mockExpenses.findByDateRange.mockReset().mockReturnValue([]);
  mockBudgets.getAllBudgetsForMonth.mockReset().mockReturnValue([]);
  mockCategories.exists.mockReset().mockReturnValue(true);
  mockCategories.create.mockReset();
  mockCategories.getCategoryNames.mockReset().mockReturnValue([]);

  monthTabExistsMock.mockReset().mockResolvedValue(true);
  createEmptyMonthTabMock.mockReset().mockResolvedValue(undefined);
  readMonthBudgetMock.mockReset().mockResolvedValue([]);

  logMock.error.mockReset();
  logMock.warn.mockReset();
});

// ── /budget (list view) ───────────────────────────────────────────────────

describe('/budget list view', () => {
  test('renders "Бюджеты не установлены" when no budgets exist', async () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);

    await handleBudgetCommand(fakeCtx('/budget'), fakeGroup());

    expect(sendMessageMock).toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Бюджеты не установлены');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('renders category list with progress when budgets exist', async () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 500, currency: 'EUR' as CurrencyCode },
    ]);
    mockExpenses.findByDateRange.mockReturnValue([{ category: 'Food', eur_amount: 250 }]);

    await handleBudgetCommand(fakeCtx('/budget'), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Food');
    expect(msg).toContain('(50%)');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('notifies about newly synced budgets when silentSyncBudgets returns > 0', async () => {
    silentSyncBudgetsMock.mockResolvedValue(3);

    await handleBudgetCommand(fakeCtx('/budget'), fakeGroup());

    const all = sendMessageMock.mock.calls.map((c) => c[0] as string);
    expect(all.some((t) => t.includes('Синхронизировано записей бюджета: 3'))).toBe(true);
  });
});

// ── /budget set ───────────────────────────────────────────────────────────

describe('/budget set', () => {
  test('saves budget via BudgetManager.set() and reports success (EUR default)', async () => {
    await handleBudgetCommand(fakeCtx('/budget set Food 500'), fakeGroup());

    expect(budgetManagerMock.set).toHaveBeenCalledTimes(1);
    const args = budgetManagerMock.set.mock.calls[0]?.[0] as SetArgs;
    expect(args.groupId).toBe(1);
    expect(args.category).toBe('Food');
    expect(args.amount).toBe(500);
    expect(args.currency).toBe('EUR');
    expect(args.month).toMatch(/^\d{4}-\d{2}$/);

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Бюджет установлен');
    expect(msg).toContain('Food');
  });

  test('parses RSD via suffix ("500 RSD") when group default is EUR', async () => {
    await handleBudgetCommand(fakeCtx('/budget set Транспорт 500 RSD'), fakeGroup());

    expect(budgetManagerMock.set).toHaveBeenCalledTimes(1);
    const args = budgetManagerMock.set.mock.calls[0]?.[0] as SetArgs;
    expect(args.amount).toBe(500);
    expect(args.currency).toBe('RSD');
  });

  test('parses USD via "$500" symbol-before-amount syntax', async () => {
    await handleBudgetCommand(fakeCtx('/budget set Food $500'), fakeGroup());

    const args = budgetManagerMock.set.mock.calls[0]?.[0] as SetArgs;
    expect(args.currency).toBe('USD');
    expect(args.amount).toBe(500);
  });

  test('updates existing budget — calling set again overwrites', async () => {
    // First call
    await handleBudgetCommand(fakeCtx('/budget set Food 500'), fakeGroup());
    // Second call: new amount
    await handleBudgetCommand(fakeCtx('/budget set Food 800'), fakeGroup());

    expect(budgetManagerMock.set).toHaveBeenCalledTimes(2);
    expect((budgetManagerMock.set.mock.calls[0]?.[0] as SetArgs).amount).toBe(500);
    expect((budgetManagerMock.set.mock.calls[1]?.[0] as SetArgs).amount).toBe(800);
  });

  test('rejects invalid amount ("abc") with hint', async () => {
    await handleBudgetCommand(fakeCtx('/budget set Food abc'), fakeGroup());

    expect(budgetManagerMock.set).not.toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Неверная сумма');
  });

  test('asks to create category when it does not exist — no budget write', async () => {
    mockCategories.exists.mockReturnValue(false);
    mockCategories.getCategoryNames.mockReturnValue(['Food', 'Транспорт']);

    await handleBudgetCommand(fakeCtx('/budget set Новая 500'), fakeGroup());

    // Did NOT write a budget — user must confirm category first
    expect(budgetManagerMock.set).not.toHaveBeenCalled();

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('не существует');
    expect(msg).toContain('Новая');
  });

  test('warns when sheetsSynced=false and group has Google token', async () => {
    budgetManagerMock.set.mockResolvedValue({ sheetsSynced: false });

    await handleBudgetCommand(fakeCtx('/budget set Food 500'), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Бюджет установлен');
    expect(msg).toContain('Не удалось записать в Google Sheets');
  });

  test('surface BudgetManager.set() throw — propagates (no silent swallow)', async () => {
    budgetManagerMock.set.mockRejectedValue(new Error('db is locked'));

    await expect(handleBudgetCommand(fakeCtx('/budget set Food 500'), fakeGroup())).rejects.toThrow(
      'db is locked',
    );
  });
});

// ── /budget sync ──────────────────────────────────────────────────────────

describe('/budget sync', () => {
  test('creates empty month tab if missing', async () => {
    monthTabExistsMock.mockResolvedValue(false);

    await handleBudgetCommand(fakeCtx('/budget sync'), fakeGroup());

    expect(createEmptyMonthTabMock).toHaveBeenCalledTimes(1);
    expect(budgetManagerMock.importFromSheet).not.toHaveBeenCalled();

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('создана');
  });

  test('reports empty sheet when no budgets in tab', async () => {
    monthTabExistsMock.mockResolvedValue(true);
    readMonthBudgetMock.mockResolvedValue([]);

    await handleBudgetCommand(fakeCtx('/budget sync'), fakeGroup());

    expect(budgetManagerMock.importFromSheet).not.toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('нет бюджетов');
  });

  test('imports every sheet row via importFromSheet', async () => {
    monthTabExistsMock.mockResolvedValue(true);
    readMonthBudgetMock.mockResolvedValue([
      { category: 'Food', limit: 500, currency: 'EUR' as CurrencyCode },
      { category: 'Transport', limit: 200, currency: 'EUR' as CurrencyCode },
    ]);

    await handleBudgetCommand(fakeCtx('/budget sync'), fakeGroup());

    expect(budgetManagerMock.importFromSheet).toHaveBeenCalledTimes(2);
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Синхронизировано записей бюджета: 2');
  });

  test('creates missing categories on import', async () => {
    monthTabExistsMock.mockResolvedValue(true);
    readMonthBudgetMock.mockResolvedValue([
      { category: 'Newcat', limit: 100, currency: 'EUR' as CurrencyCode },
    ]);
    mockCategories.exists.mockReturnValue(false);

    await handleBudgetCommand(fakeCtx('/budget sync'), fakeGroup());

    expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'Newcat' });
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Создано новых категорий: 1');
  });

  test('handles Sheets error gracefully and logs', async () => {
    monthTabExistsMock.mockRejectedValue(new Error('rate limit'));

    await handleBudgetCommand(fakeCtx('/budget sync'), fakeGroup());

    expect(logMock.error).toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Не удалось синхронизировать');
  });
});

// ── Invalid subcommand ────────────────────────────────────────────────────

describe('/budget invalid usage', () => {
  test('shows usage help for unknown subcommand', async () => {
    await handleBudgetCommand(fakeCtx('/budget unknown'), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Неверный формат');
    expect(budgetManagerMock.set).not.toHaveBeenCalled();
  });

  test('/budget set without amount falls through to usage help', async () => {
    // "/budget set Food" → args.length < 3
    await handleBudgetCommand(fakeCtx('/budget set Food'), fakeGroup());

    expect(budgetManagerMock.set).not.toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Неверный формат');
  });
});
