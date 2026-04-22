// Tests for /stats — per-currency totals, last N expenses, error path

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Expense, Group } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Ctx } from '../types';

// ── Logger (stats.ts imports from '../../utils/logger.ts') ────────────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Database ──────────────────────────────────────────────────────────────

const mockExpenses = {
  findByGroupId: mock((_groupId: number, _limit?: number): Expense[] => []),
  getTotalsByCurrency: mock((_groupId: number): Record<string, number> => ({})),
  getTotalInEUR: mock((_groupId: number): number => 0),
};

mock.module('../../database', () => ({
  database: { expenses: mockExpenses },
}));

// ── Currency converter (identity-ish) ─────────────────────────────────────

mock.module('../../services/currency/converter', () => ({
  convertCurrency: mock((amount: number) => amount),
  formatAmount: mock((amount: number, currency: string) => `${amount} ${currency}`),
}));

// ── Mini App URL ──────────────────────────────────────────────────────────

const buildMiniAppUrlMock = mock((_tab?: string, _gid?: number): string | null => null);

mock.module('../../utils/miniapp-url', () => ({
  buildMiniAppUrl: buildMiniAppUrlMock,
}));

// ── maybeSmartAdvice — no-op ──────────────────────────────────────────────

const maybeSmartAdviceMock = mock(async (_groupId: number): Promise<void> => undefined);

mock.module('./ask', () => ({
  maybeSmartAdvice: maybeSmartAdviceMock,
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

// ── Import after mocks ────────────────────────────────────────────────────

const { handleStatsCommand } = await import('./stats');

// ── Fixtures ──────────────────────────────────────────────────────────────

function fakeCtx(): Ctx['Command'] {
  return { chat: { id: -100, type: 'supergroup' }, from: { id: 1 } } as unknown as Ctx['Command'];
}

function fakeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    title: null,
    invite_link: null,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR' as CurrencyCode,
    enabled_currencies: ['EUR'] as CurrencyCode[],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'current',
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  } as Group;
}

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 1,
    group_id: 1,
    user_id: 1,
    date: '2026-03-29',
    category: 'Food',
    comment: '',
    amount: 100,
    currency: 'EUR' as CurrencyCode,
    eur_amount: 100,
    receipt_id: null,
    receipt_file_id: null,
    created_at: '2026-03-29T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  mockExpenses.findByGroupId.mockReset().mockReturnValue([]);
  mockExpenses.getTotalsByCurrency.mockReset().mockReturnValue({});
  mockExpenses.getTotalInEUR.mockReset().mockReturnValue(0);
  buildMiniAppUrlMock.mockReset().mockReturnValue(null);
  maybeSmartAdviceMock.mockReset().mockResolvedValue(undefined);
  logMock.error.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('/stats', () => {
  test('empty state — no expenses, no totals', async () => {
    mockExpenses.findByGroupId.mockReturnValue([]);
    mockExpenses.getTotalsByCurrency.mockReturnValue({});
    mockExpenses.getTotalInEUR.mockReturnValue(0);

    await handleStatsCommand(fakeCtx(), fakeGroup());

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Статистика расходов');
    expect(msg).toContain('По валютам');
    // "Последние 0 расходов"
    expect(msg).toContain('0 расходов');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('renders per-currency totals and grand total in default currency', async () => {
    mockExpenses.findByGroupId.mockReturnValue([
      makeExpense({
        currency: 'EUR' as CurrencyCode,
        amount: 50,
        date: '2026-03-29',
        category: 'Food',
      }),
    ]);
    mockExpenses.getTotalsByCurrency.mockReturnValue({ EUR: 50, USD: 20 });
    mockExpenses.getTotalInEUR.mockReturnValue(70);

    await handleStatsCommand(fakeCtx(), fakeGroup({ default_currency: 'EUR' as CurrencyCode }));

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('50 EUR');
    expect(msg).toContain('20 USD');
    expect(msg).toContain('Всего:');
    expect(msg).toContain('70 EUR');
  });

  test('uses Russian pluralization for recent-count header', async () => {
    // 3 expenses → "3 расхода"
    mockExpenses.findByGroupId.mockReturnValue([
      makeExpense({ id: 1 }),
      makeExpense({ id: 2 }),
      makeExpense({ id: 3 }),
    ]);

    await handleStatsCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Последние 3 расхода');
  });

  test('lists individual recent expenses with date/symbol/amount/category', async () => {
    mockExpenses.findByGroupId.mockReturnValue([
      makeExpense({
        date: '2026-03-29',
        amount: 12.5,
        currency: 'EUR' as CurrencyCode,
        category: 'Еда',
      }),
      makeExpense({
        date: '2026-03-28',
        amount: 100,
        currency: 'USD' as CurrencyCode,
        category: 'Транспорт',
      }),
    ]);

    await handleStatsCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('2026-03-29');
    expect(msg).toContain('€12.5');
    expect(msg).toContain('Еда');
    expect(msg).toContain('2026-03-28');
    expect(msg).toContain('$100');
    expect(msg).toContain('Транспорт');
  });

  test('attaches Mini App dashboard button when URL is available', async () => {
    buildMiniAppUrlMock.mockReturnValue('https://t.me/ExpenseSyncBot/app?startapp=dashboard_-100');

    await handleStatsCommand(fakeCtx(), fakeGroup());

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const opts = sendMessageMock.mock.calls[0]?.[1] as { reply_markup?: unknown } | undefined;
    expect(opts?.reply_markup).toBeDefined();
  });

  test('omits reply_markup when Mini App URL is null', async () => {
    buildMiniAppUrlMock.mockReturnValue(null);

    await handleStatsCommand(fakeCtx(), fakeGroup());

    const opts = sendMessageMock.mock.calls[0]?.[1] as { reply_markup?: unknown } | undefined;
    expect(opts?.reply_markup).toBeUndefined();
  });

  test('triggers maybeSmartAdvice after sending stats', async () => {
    const group = fakeGroup();
    group.id = 77;

    await handleStatsCommand(fakeCtx(), group);

    expect(maybeSmartAdviceMock).toHaveBeenCalledWith(77);
  });

  test('logs error and sends friendly message when repo throws', async () => {
    mockExpenses.findByGroupId.mockImplementation(() => {
      throw new Error('sqlite disk full');
    });

    await handleStatsCommand(fakeCtx(), fakeGroup());

    expect(logMock.error).toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('непредвиденная');
    // maybeSmartAdvice should NOT run when the try-block throws
    expect(maybeSmartAdviceMock).not.toHaveBeenCalled();
  });
});
