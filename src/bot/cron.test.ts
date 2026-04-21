// Tests for registerExchangeRateCron — startup fetch, retry, admin notification.
// Also covers registerMonthlyCron, backfillSortExpensesTabs, recoverPriorYearExpenses.

import { mock } from 'bun:test';
import type { TelegramMessage } from '@gramio/types';
import { createMockLogger } from '../test-utils/mocks/logger';

// ── Logger mock ─────────────────────────────────────────────────────────
const logMock = createMockLogger();
mock.module('../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Module mocks (must be declared before importing the module under test) ──

const updateExchangeRatesMock = mock(async (): Promise<void> => {});
const sendDirectMock = mock(
  async (_chatId: number, _text: string): Promise<TelegramMessage | null> => null,
);
const sendMessageMock = mock(
  async (_text: string, _opts?: unknown): Promise<TelegramMessage | null> => null,
);
const withChatContextMock = mock(
  async <T>(_chatId: number, _threadId: number | null, fn: () => Promise<T>): Promise<T> => fn(),
);

mock.module('../services/currency/converter', () => ({
  updateExchangeRates: updateExchangeRatesMock,
  convertCurrency: (amount: number) => amount,
  formatAmount: (amount: number, currency: string) => `${amount} ${currency}`,
}));

mock.module('../services/bank/telegram-sender', () => ({
  sendDirect: sendDirectMock,
  sendMessage: sendMessageMock,
  sendChatAction: mock(),
  withChatContext: withChatContextMock,
  editMessageText: mock(async () => undefined),
  deleteMessage: mock(async () => undefined),
}));

// ── Database mock for monthly cron / backfill / recover ─────────────────

interface GroupRow {
  id: number;
  telegram_group_id: number;
  google_refresh_token: string | null;
  default_currency: string;
  enabled_currencies: string[];
  active_topic_id: number | null;
}
interface SheetRow {
  year: number;
  spreadsheetId: string;
}

const mockGroupsRepo = {
  findAll: mock((): GroupRow[] => []),
  findById: mock((_id: number) => null),
};
const mockGroupSpreadsheets = {
  listAll: mock((_groupId: number): SheetRow[] => []),
  getByYear: mock((_groupId: number, _year: number): string | null => null),
  setYear: mock((_groupId: number, _year: number, _sid: string): void => {}),
};
const mockExpensesRepo = {
  findByDateRange: mock(
    (_g: number, _f: string, _t: string): Array<{ category: string; eur_amount: number }> => [],
  ),
};
const mockBudgetsRepo = {
  getAllBudgetsForMonth: mock(
    (
      _groupId: number,
      _month: string,
    ): Array<{ category: string; limit_amount: number; currency: string }> => [],
  ),
};

mock.module('../database', () => ({
  database: {
    groups: mockGroupsRepo,
    groupSpreadsheets: mockGroupSpreadsheets,
    expenses: mockExpensesRepo,
    budgets: mockBudgetsRepo,
  },
}));

// ── Google Sheets mock ──────────────────────────────────────────────────

const googleConnMock = mock(() => ({ refreshToken: 'tok', oauthClient: 'current' as const }));
const monthTabExistsMock = mock(async (): Promise<boolean> => false);
const createEmptyMonthTabMock = mock(async (): Promise<void> => {});
const cloneMonthTabMock = mock(async (): Promise<void> => {});
const createExpenseSpreadsheetMock = mock(
  async (): Promise<{ spreadsheetId: string }> => ({ spreadsheetId: 'new-sheet-id' }),
);
const sortExpensesTabMock = mock(async (): Promise<void> => {});
const getSpreadsheetUrlMock = mock(
  (sid: string): string => `https://docs.google.com/spreadsheets/d/${sid}`,
);

mock.module('../services/google/sheets', () => ({
  googleConn: googleConnMock,
  monthTabExists: monthTabExistsMock,
  createEmptyMonthTab: createEmptyMonthTabMock,
  cloneMonthTab: cloneMonthTabMock,
  createExpenseSpreadsheet: createExpenseSpreadsheetMock,
  sortExpensesTab: sortExpensesTabMock,
  getSpreadsheetUrl: getSpreadsheetUrlMock,
}));

// ── Supporting helpers ──────────────────────────────────────────────────

const silentSyncBudgetsMock = mock(async (): Promise<number> => 0);
mock.module('./services/budget-sync', () => ({
  silentSyncBudgets: silentSyncBudgetsMock,
}));

const importExpensesFromSheetMock = mock(
  async (_token: string, _groupId: number, _spreadsheetId: string): Promise<number> => 0,
);
mock.module('./commands/sync', () => ({
  importExpensesFromSheet: importExpensesFromSheetMock,
}));

const formatBudgetProgressTextMock = mock(
  (_groupId: number): { text: string; hasBudgets: boolean } => ({
    text: 'Бюджет на April 2026\n\nБюджеты не установлены.',
    hasBudgets: false,
  }),
);
mock.module('./commands/budget', () => ({
  formatBudgetProgressText: formatBudgetProgressTextMock,
}));

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import cron from 'node-cron';
import { env } from '../config/env';

// Dynamic import AFTER mock.module calls so the logger mock intercepts cron.ts's
// `createLogger('cron')` call. Top-level ESM imports are hoisted above mock.module,
// bypassing the mock.
const {
  backfillSortExpensesTabs,
  recoverPriorYearExpenses,
  registerExchangeRateCron,
  registerMonthlyCron,
} = await import('./cron');

let cronSpy: ReturnType<typeof spyOn>;
let savedAdminChatId: number | null;

const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  const fakeTask = { stop: mock(() => {}) };
  cronSpy = spyOn(cron, 'schedule').mockReturnValue(
    fakeTask as unknown as ReturnType<typeof cron.schedule>,
  );

  updateExchangeRatesMock.mockReset();
  updateExchangeRatesMock.mockResolvedValue(undefined);
  sendDirectMock.mockReset();
  sendDirectMock.mockResolvedValue(null);

  savedAdminChatId = env.BOT_ADMIN_CHAT_ID;

  // Make backoff delays instant in tests
  // @ts-expect-error -- simplified mock for test, real setTimeout has complex overloads
  spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void) => {
    fn();
    return 0;
  });
});

afterEach(() => {
  env.BOT_ADMIN_CHAT_ID = savedAdminChatId;
  mock.restore();
});

/** Wait for async chains to settle */
function tick(ms = 50): Promise<void> {
  return new Promise((r) => realSetTimeout(r, ms));
}

describe('registerExchangeRateCron', () => {
  it('calls updateExchangeRates on startup', () => {
    registerExchangeRateCron();
    expect(updateExchangeRatesMock).toHaveBeenCalledTimes(1);
  });

  it('registers daily cron job at "0 1 * * *" (01:00 UTC)', () => {
    registerExchangeRateCron();
    expect(cronSpy).toHaveBeenCalledTimes(1);
    expect(cronSpy.mock.calls[0]?.[0]).toBe('0 1 * * *');
  });

  it('does not retry or notify admin on success', async () => {
    registerExchangeRateCron();
    await tick();

    expect(updateExchangeRatesMock).toHaveBeenCalledTimes(1);
    expect(sendDirectMock).not.toHaveBeenCalled();
  });

  it('retries 3 times then notifies admin', async () => {
    updateExchangeRatesMock.mockRejectedValue(new Error('API down'));
    env.BOT_ADMIN_CHAT_ID = 12345;

    registerExchangeRateCron();
    await tick();

    expect(updateExchangeRatesMock).toHaveBeenCalledTimes(3);
    expect(sendDirectMock).toHaveBeenCalledTimes(1);
    expect(sendDirectMock.mock.calls[0]?.[0]).toBe(12345);
    const msg = sendDirectMock.mock.calls[0]?.[1] as string;
    expect(msg).toContain('не обновились');
  });

  it('does not notify admin when BOT_ADMIN_CHAT_ID is null', async () => {
    updateExchangeRatesMock.mockRejectedValue(new Error('API down'));
    env.BOT_ADMIN_CHAT_ID = null;

    registerExchangeRateCron();
    await tick();

    expect(updateExchangeRatesMock).toHaveBeenCalledTimes(3);
    expect(sendDirectMock).not.toHaveBeenCalled();
  });

  it('cron callback also retries and notifies admin', async () => {
    // Startup succeeds
    updateExchangeRatesMock.mockResolvedValueOnce(undefined);

    registerExchangeRateCron();
    await tick();

    // Now make subsequent calls fail
    updateExchangeRatesMock.mockRejectedValue(new Error('API down'));
    env.BOT_ADMIN_CHAT_ID = 12345;

    const cronCallback = cronSpy.mock.calls[0]?.[1] as () => void;
    cronCallback();
    await tick();

    // 1 startup success + 3 retries from cron
    expect(updateExchangeRatesMock).toHaveBeenCalledTimes(4);
    expect(sendDirectMock).toHaveBeenCalledTimes(1);
  });

  it('logs error (does not throw) when admin notification itself fails', async () => {
    updateExchangeRatesMock.mockRejectedValue(new Error('API down'));
    sendDirectMock.mockRejectedValue(new Error('telegram down'));
    env.BOT_ADMIN_CHAT_ID = 12345;

    registerExchangeRateCron();
    await tick();

    expect(logMock.error).toHaveBeenCalled();
    const errCalls = logMock.error.mock.calls.map((c) => JSON.stringify(c));
    expect(errCalls.some((c) => c.includes('Failed to notify admin'))).toBe(true);
  });

  it('logs info on successful registration', () => {
    registerExchangeRateCron();
    expect(logMock.info).toHaveBeenCalled();
  });
});

// ── Monthly cron ────────────────────────────────────────────────────────

describe('registerMonthlyCron', () => {
  beforeEach(() => {
    mockGroupsRepo.findAll.mockReset().mockReturnValue([]);
    mockGroupSpreadsheets.listAll.mockReset().mockReturnValue([]);
    mockGroupSpreadsheets.getByYear.mockReset().mockReturnValue(null);
    mockGroupSpreadsheets.setYear.mockReset();
    mockExpensesRepo.findByDateRange.mockReset().mockReturnValue([]);
    monthTabExistsMock.mockReset().mockResolvedValue(false);
    createEmptyMonthTabMock.mockReset().mockResolvedValue(undefined);
    cloneMonthTabMock.mockReset().mockResolvedValue(undefined);
    createExpenseSpreadsheetMock.mockReset().mockResolvedValue({ spreadsheetId: 'new-sheet-id' });
    silentSyncBudgetsMock.mockReset().mockResolvedValue(0);
    sendMessageMock.mockReset().mockResolvedValue(null);
    formatBudgetProgressTextMock
      .mockReset()
      .mockReturnValue({ text: 'Бюджет на April 2026', hasBudgets: false });
    logMock.error.mockReset();
    logMock.warn.mockReset();
  });

  it('registers cron at "0 0 1 * *" (monthly, 1st)', () => {
    registerMonthlyCron();

    expect(cronSpy).toHaveBeenCalledTimes(1);
    expect(cronSpy.mock.calls[0]?.[0]).toBe('0 0 1 * *');
  });

  it('skips groups without google_refresh_token', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: null,
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);

    registerMonthlyCron();
    const cb = cronSpy.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();

    expect(createEmptyMonthTabMock).not.toHaveBeenCalled();
    expect(cloneMonthTabMock).not.toHaveBeenCalled();
  });

  it('skips groups with no spreadsheets registered', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([]);

    registerMonthlyCron();
    const cb = cronSpy.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();

    expect(createExpenseSpreadsheetMock).not.toHaveBeenCalled();
    expect(createEmptyMonthTabMock).not.toHaveBeenCalled();
  });

  it('creates a new spreadsheet when this year has none', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    // group has at least one older sheet registered
    mockGroupSpreadsheets.listAll.mockReturnValue([{ year: 2025, spreadsheetId: 'old-sid' }]);
    // No spreadsheet for current year
    mockGroupSpreadsheets.getByYear.mockImplementation((_g, y) =>
      y === new Date().getFullYear() ? null : 'old-sid',
    );

    registerMonthlyCron();
    const cb = cronSpy.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();

    expect(createExpenseSpreadsheetMock).toHaveBeenCalledTimes(1);
    expect(mockGroupSpreadsheets.setYear).toHaveBeenCalledTimes(1);
  });

  it('skips cloning when the month tab already exists', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: new Date().getFullYear(), spreadsheetId: 'sid-current' },
    ]);
    mockGroupSpreadsheets.getByYear.mockReturnValue('sid-current');
    monthTabExistsMock.mockResolvedValue(true);

    registerMonthlyCron();
    const cb = cronSpy.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();

    expect(cloneMonthTabMock).not.toHaveBeenCalled();
    expect(createEmptyMonthTabMock).not.toHaveBeenCalled();
  });

  it('clones previous month tab when it exists', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: new Date().getFullYear(), spreadsheetId: 'sid-current' },
      { year: new Date().getFullYear() - 1, spreadsheetId: 'sid-prev' },
    ]);
    mockGroupSpreadsheets.getByYear.mockImplementation(
      (_g, _y) => 'sid-current', // always find sheet
    );
    // First call for current month: false; second for prev month: true
    monthTabExistsMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    registerMonthlyCron();
    const cb = cronSpy.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();

    expect(cloneMonthTabMock).toHaveBeenCalledTimes(1);
    expect(createEmptyMonthTabMock).not.toHaveBeenCalled();
  });

  it('creates an empty tab when previous month cannot be found', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: new Date().getFullYear(), spreadsheetId: 'sid-current' },
    ]);
    mockGroupSpreadsheets.getByYear.mockReturnValue('sid-current');
    // Current month: false; prev month check: false
    monthTabExistsMock.mockResolvedValue(false);

    registerMonthlyCron();
    const cb = cronSpy.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();

    expect(createEmptyMonthTabMock).toHaveBeenCalledTimes(1);
    expect(cloneMonthTabMock).not.toHaveBeenCalled();
  });

  it('notifies group after successful clone', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: new Date().getFullYear(), spreadsheetId: 'sid-current' },
    ]);
    mockGroupSpreadsheets.getByYear.mockReturnValue('sid-current');
    monthTabExistsMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    registerMonthlyCron();
    const cb = cronSpy.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [text] = sendMessageMock.mock.calls[0] as [string];
    expect(text).toContain('Гугл таблица');
  });

  it('uses "Новый бюджет сформирован" wording when group has budgets', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: new Date().getFullYear(), spreadsheetId: 'sid-current' },
    ]);
    mockGroupSpreadsheets.getByYear.mockReturnValue('sid-current');
    monthTabExistsMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    formatBudgetProgressTextMock.mockReturnValue({
      text: 'Food: 50/100',
      hasBudgets: true,
    });

    registerMonthlyCron();
    const cb = cronSpy.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();

    const text = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(text).toContain('Новый бюджет сформирован');
    expect(text).toContain('Food: 50/100');
  });

  it('uses "Пора сформировать бюджет" wording when group has no budgets', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: new Date().getFullYear(), spreadsheetId: 'sid-current' },
    ]);
    mockGroupSpreadsheets.getByYear.mockReturnValue('sid-current');
    monthTabExistsMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    formatBudgetProgressTextMock.mockReturnValue({ text: '', hasBudgets: false });

    registerMonthlyCron();
    const cb = cronSpy.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();

    const text = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(text).toContain('Пора сформировать бюджет');
  });

  it('error in one group does not abort the loop', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
      {
        id: 2,
        telegram_group_id: -200,
        google_refresh_token: 'tok2',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: new Date().getFullYear(), spreadsheetId: 'sid' },
    ]);
    mockGroupSpreadsheets.getByYear.mockReturnValue('sid');
    // First group: throws on monthTabExists. Second group: works.
    monthTabExistsMock
      .mockRejectedValueOnce(new Error('sheets 500'))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    registerMonthlyCron();
    const cb = cronSpy.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();

    // Second group succeeded (clone + notify)
    expect(cloneMonthTabMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    // And we logged the first group's error
    expect(logMock.error).toHaveBeenCalled();
  });
});

// ── backfillSortExpensesTabs ────────────────────────────────────────────

describe('backfillSortExpensesTabs', () => {
  beforeEach(() => {
    mockGroupsRepo.findAll.mockReset().mockReturnValue([]);
    mockGroupSpreadsheets.listAll.mockReset().mockReturnValue([]);
    sortExpensesTabMock.mockReset().mockResolvedValue(undefined);
    logMock.error.mockReset();
  });

  it('skips groups without google_refresh_token', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: null,
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);

    await backfillSortExpensesTabs();
    expect(sortExpensesTabMock).not.toHaveBeenCalled();
  });

  it('sorts every year for each connected group', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: 2024, spreadsheetId: 'sid-2024' },
      { year: 2025, spreadsheetId: 'sid-2025' },
    ]);

    await backfillSortExpensesTabs();

    expect(sortExpensesTabMock).toHaveBeenCalledTimes(2);
  });

  it('logs error and continues when one sheet fails', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: 2024, spreadsheetId: 'sid-2024' },
      { year: 2025, spreadsheetId: 'sid-2025' },
    ]);
    sortExpensesTabMock.mockRejectedValueOnce(new Error('403')).mockResolvedValueOnce(undefined);

    await backfillSortExpensesTabs();

    expect(sortExpensesTabMock).toHaveBeenCalledTimes(2);
    expect(logMock.error).toHaveBeenCalled();
  });
});

// ── recoverPriorYearExpenses ────────────────────────────────────────────

describe('recoverPriorYearExpenses', () => {
  beforeEach(() => {
    mockGroupsRepo.findAll.mockReset().mockReturnValue([]);
    mockGroupSpreadsheets.listAll.mockReset().mockReturnValue([]);
    importExpensesFromSheetMock.mockReset().mockResolvedValue(0);
    logMock.error.mockReset();
    logMock.info.mockReset();
  });

  it('skips the current-year spreadsheet', async () => {
    const currentYear = new Date().getFullYear();
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: currentYear, spreadsheetId: 'sid-now' },
      { year: currentYear - 1, spreadsheetId: 'sid-prev' },
    ]);

    await recoverPriorYearExpenses();

    expect(importExpensesFromSheetMock).toHaveBeenCalledTimes(1);
    expect(importExpensesFromSheetMock.mock.calls[0]?.[2]).toBe('sid-prev');
  });

  it('logs the restore count when expenses were inserted', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: new Date().getFullYear() - 1, spreadsheetId: 'sid-prev' },
    ]);
    importExpensesFromSheetMock.mockResolvedValue(7);

    await recoverPriorYearExpenses();

    const infoCalls = logMock.info.mock.calls.map((c) => JSON.stringify(c));
    expect(infoCalls.some((c) => c.includes('Restored 7'))).toBe(true);
  });

  it('logs and continues on per-sheet import failure', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: 'tok',
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: 2024, spreadsheetId: 'sid-2024' },
      { year: 2023, spreadsheetId: 'sid-2023' },
    ]);
    importExpensesFromSheetMock
      .mockRejectedValueOnce(new Error('OAuth expired'))
      .mockResolvedValueOnce(3);

    await recoverPriorYearExpenses();

    expect(importExpensesFromSheetMock).toHaveBeenCalledTimes(2);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('skips groups without google_refresh_token', async () => {
    mockGroupsRepo.findAll.mockReturnValue([
      {
        id: 1,
        telegram_group_id: -100,
        google_refresh_token: null,
        default_currency: 'EUR',
        enabled_currencies: ['EUR'],
        active_topic_id: null,
      },
    ]);
    await recoverPriorYearExpenses();
    expect(importExpensesFromSheetMock).not.toHaveBeenCalled();
  });
});
