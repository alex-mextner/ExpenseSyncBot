// Tests for budget progress calculation in /sum command

import { beforeEach, describe, expect, it, mock, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Group } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Ctx } from '../types';
import { buildBudgetProgressEntry, buildBudgetTotals } from './sum';

describe('buildBudgetProgressEntry — budget currency conversion', () => {
  // RSD fallback rate: 1 RSD = 0.0086 EUR → 1 EUR ≈ 116 RSD

  it('converts EUR spending to budget currency for percentage', () => {
    // 50 EUR ≈ 5 800 RSD; limit 10 000 RSD → ~58%
    const entry = buildBudgetProgressEntry(50, {
      category: 'Еда',
      limit_amount: 10_000,
      currency: 'RSD',
    });
    expect(entry.percentage).toBeGreaterThan(40);
    expect(entry.percentage).toBeLessThan(80);
  });

  it('is_exceeded false when EUR spending converts below limit', () => {
    // 50 EUR ≈ 5 800 RSD < 10 000 RSD
    const entry = buildBudgetProgressEntry(50, {
      category: 'Еда',
      limit_amount: 10_000,
      currency: 'RSD',
    });
    expect(entry.is_exceeded).toBe(false);
  });

  it('is_exceeded true when EUR spending converts above limit', () => {
    // 150 EUR ≈ 17 400 RSD > 10 000 RSD
    const entry = buildBudgetProgressEntry(150, {
      category: 'Еда',
      limit_amount: 10_000,
      currency: 'RSD',
    });
    expect(entry.is_exceeded).toBe(true);
  });

  it('is_warning triggers at 90–99% of limit in budget currency', () => {
    // 85 EUR ≈ 9 860 RSD, limit 10 000 → ~99% → warning
    const entry = buildBudgetProgressEntry(85, {
      category: 'Еда',
      limit_amount: 10_000,
      currency: 'RSD',
    });
    expect(entry.is_warning).toBe(true);
    expect(entry.is_exceeded).toBe(false);
  });

  it('EUR budget: no conversion, direct comparison', () => {
    const entry = buildBudgetProgressEntry(75, {
      category: 'Transport',
      limit_amount: 100,
      currency: 'EUR',
    });
    expect(entry.percentage).toBe(75);
    expect(entry.is_exceeded).toBe(false);
    expect(entry.spentInCurrency).toBeCloseTo(75);
  });

  it('returns correct currency code', () => {
    const entry = buildBudgetProgressEntry(10, {
      category: 'Еда',
      limit_amount: 5_000,
      currency: 'RSD',
    });
    expect(entry.currency).toBe('RSD');
  });
});

describe('buildBudgetTotals — cross-currency totals in display currency', () => {
  it('converts all limits to EUR and then to display currency', () => {
    // Budget: 10 000 RSD ≈ 86 EUR; spent: 50 EUR → 50/86 ≈ 58%
    const totals = buildBudgetTotals(
      { Еда: 50 },
      [{ category: 'Еда', limit_amount: 10_000, currency: 'RSD' }],
      'EUR',
    );
    expect(totals.percentage).toBeGreaterThan(40);
    expect(totals.percentage).toBeLessThan(80);
  });

  it('mixed currencies sum correctly in display currency', () => {
    // Budget A: 100 EUR; Budget B: 10 000 RSD ≈ 86 EUR → total ≈ 186 EUR
    // Spent: 50 EUR (A) + 43 EUR (B) = 93 EUR → ~50%
    const totals = buildBudgetTotals(
      { A: 50, B: 43 },
      [
        { category: 'A', limit_amount: 100, currency: 'EUR' },
        { category: 'B', limit_amount: 10_000, currency: 'RSD' },
      ],
      'EUR',
    );
    expect(totals.percentage).toBeGreaterThan(35);
    expect(totals.percentage).toBeLessThan(65);
  });

  it('display currency affects output amounts but not percentage', () => {
    const eurTotals = buildBudgetTotals(
      { Еда: 50 },
      [{ category: 'Еда', limit_amount: 100, currency: 'EUR' }],
      'EUR',
    );
    const rsdTotals = buildBudgetTotals(
      { Еда: 50 },
      [{ category: 'Еда', limit_amount: 100, currency: 'EUR' }],
      'RSD',
    );
    expect(eurTotals.percentage).toBe(rsdTotals.percentage);
    // RSD amounts should be much larger than EUR amounts
    expect(rsdTotals.totalBudgetDisplay).toBeGreaterThan(eurTotals.totalBudgetDisplay * 50);
  });

  it('missing category spending treated as 0', () => {
    const totals = buildBudgetTotals(
      {},
      [{ category: 'Еда', limit_amount: 100, currency: 'EUR' }],
      'EUR',
    );
    expect(totals.totalSpentDisplay).toBe(0);
    expect(totals.percentage).toBe(0);
  });

  it('zero limit_amount returns 0% without division by zero', () => {
    const totals = buildBudgetTotals(
      { Еда: 50 },
      [{ category: 'Еда', limit_amount: 0, currency: 'EUR' }],
      'EUR',
    );
    expect(totals.percentage).toBe(0);
    expect(totals.totalBudgetDisplay).toBe(0);
  });

  it('multiple budgets same currency — spent sums across categories', () => {
    const totals = buildBudgetTotals(
      { Еда: 30, Транспорт: 20 },
      [
        { category: 'Еда', limit_amount: 100, currency: 'EUR' },
        { category: 'Транспорт', limit_amount: 100, currency: 'EUR' },
      ],
      'EUR',
    );
    expect(totals.totalSpentDisplay).toBeCloseTo(50);
    expect(totals.totalBudgetDisplay).toBeCloseTo(200);
    expect(totals.percentage).toBe(25);
  });

  it('100% spending reports 100%', () => {
    const totals = buildBudgetTotals(
      { Еда: 100 },
      [{ category: 'Еда', limit_amount: 100, currency: 'EUR' }],
      'EUR',
    );
    expect(totals.percentage).toBe(100);
  });

  it('empty budget list returns zero totals', () => {
    const totals = buildBudgetTotals({ Еда: 50 }, [], 'EUR');
    expect(totals.totalSpentDisplay).toBe(0);
    expect(totals.totalBudgetDisplay).toBe(0);
    expect(totals.percentage).toBe(0);
  });
});

describe('buildBudgetProgressEntry — boundary cases', () => {
  it('is_warning false at 85% (just under 90% threshold)', () => {
    const entry = buildBudgetProgressEntry(85, {
      category: 'Food',
      limit_amount: 100,
      currency: 'EUR',
    });
    expect(entry.percentage).toBe(85);
    expect(entry.is_warning).toBe(false);
  });

  it('is_warning true at exactly 90%', () => {
    const entry = buildBudgetProgressEntry(90, {
      category: 'Food',
      limit_amount: 100,
      currency: 'EUR',
    });
    expect(entry.percentage).toBe(90);
    expect(entry.is_warning).toBe(true);
    expect(entry.is_exceeded).toBe(false);
  });

  it('is_warning false at 101% (already exceeded)', () => {
    const entry = buildBudgetProgressEntry(101, {
      category: 'Food',
      limit_amount: 100,
      currency: 'EUR',
    });
    expect(entry.is_exceeded).toBe(true);
    expect(entry.is_warning).toBe(false);
  });

  it('zero spending gives 0%', () => {
    const entry = buildBudgetProgressEntry(0, {
      category: 'Food',
      limit_amount: 100,
      currency: 'EUR',
    });
    expect(entry.percentage).toBe(0);
    expect(entry.is_exceeded).toBe(false);
    expect(entry.is_warning).toBe(false);
  });

  it('zero limit_amount returns 0% and is_exceeded when spent > 0', () => {
    const entry = buildBudgetProgressEntry(50, {
      category: 'Food',
      limit_amount: 0,
      currency: 'EUR',
    });
    expect(entry.percentage).toBe(0);
    expect(entry.is_exceeded).toBe(true);
  });

  it('spentInCurrency correctly converts EUR→RSD', () => {
    const entry = buildBudgetProgressEntry(100, {
      category: 'Food',
      limit_amount: 100_000,
      currency: 'RSD',
    });
    // 100 EUR → ~11,600 RSD (via fallback rate)
    expect(entry.spentInCurrency).toBeGreaterThan(10_000);
    expect(entry.spentInCurrency).toBeLessThan(13_000);
  });
});

// ── Logger mock ─────────────────────────────────────────────────────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Database mock ───────────────────────────────────────────────────────

interface ExpenseRow {
  date: string;
  category: string;
  amount: number;
  currency: string;
  eur_amount: number;
}

interface BudgetRow {
  category: string;
  limit_amount: number;
  currency: CurrencyCode;
}

const mockExpensesRepo = {
  findByGroupId: mock((_id: number, _limit: number): ExpenseRow[] => []),
};
const mockBudgetsRepo = {
  getAllBudgetsForMonth: mock((_id: number, _month: string): BudgetRow[] => []),
};

mock.module('../../database', () => ({
  database: {
    expenses: mockExpensesRepo,
    budgets: mockBudgetsRepo,
  },
}));

// ── Analytics — neutral snapshot (no TA section) ────────────────────────

mock.module('../../services/analytics/spending-analytics', () => ({
  spendingAnalytics: {
    getFinancialSnapshot: mock(() => ({ technicalAnalysis: null })),
  },
}));

// ── Budget-sync (silent) ────────────────────────────────────────────────

const silentSyncBudgetsMock = mock(async (): Promise<number> => 0);
mock.module('../services/budget-sync', () => ({
  silentSyncBudgets: silentSyncBudgetsMock,
}));

// ── maybeSmartAdvice — no-op ────────────────────────────────────────────

mock.module('./ask', () => ({
  maybeSmartAdvice: mock(async () => undefined),
}));

// ── Google sheets — just a stub so googleConn() doesn't touch OAuth ─────

mock.module('../../services/google/sheets', () => ({
  googleConn: mock(() => ({ refreshToken: 'tok', oauthClient: 'current' as const })),
}));

// ── Telegram sender ─────────────────────────────────────────────────────

const sendMessageMock = mock(
  (_text: string, _opts?: unknown): Promise<null> => Promise.resolve(null),
);
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
  editMessageText: mock(() => Promise.resolve()),
  sendDirect: mock(() => Promise.resolve(null)),
  deleteMessage: mock(() => Promise.resolve()),
}));

// ── Currency converter — keep real module so conversion tests above still work.
//    We only short-circuit formatAmount to avoid locale assertions. The real
//    conversion helpers remain accessible via ../../services/currency/converter.

const { handleSumCommand } = await import('./sum');

// ── Fixtures ────────────────────────────────────────────────────────────

function fakeCtx(): Ctx['Command'] {
  return {
    chat: { id: -100, type: 'supergroup' },
    from: { id: 1 },
    text: '/sum',
  } as unknown as Ctx['Command'];
}

function fakeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR',
    enabled_currencies: ['EUR'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'current',
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
    title: null,
    invite_link: null,
    ...overrides,
  } as unknown as Group;
}

function makeExp(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    date: '2026-04-10',
    category: 'Food',
    amount: 10,
    currency: 'EUR',
    eur_amount: 10,
    ...overrides,
  };
}

describe('handleSumCommand — integration', () => {
  beforeEach(() => {
    sendMessageMock.mockReset().mockResolvedValue(null);
    silentSyncBudgetsMock.mockReset().mockResolvedValue(0);
    mockExpensesRepo.findByGroupId.mockReset().mockReturnValue([]);
    mockBudgetsRepo.getAllBudgetsForMonth.mockReset().mockReturnValue([]);
    logMock.error.mockReset();
    logMock.warn.mockReset();
  });

  test('empty expenses → shows "Пока нет расходов"', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([]);

    await handleSumCommand(fakeCtx(), fakeGroup());

    const all = sendMessageMock.mock.calls.map((c) => c[0] as string);
    expect(all.some((t) => t.includes('Пока нет расходов'))).toBe(true);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('only past-month expenses → "В <месяц> пока нет расходов"', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([
      makeExp({ date: '2025-01-10' }),
      makeExp({ date: '2025-02-10' }),
    ]);

    await handleSumCommand(fakeCtx(), fakeGroup());

    const all = sendMessageMock.mock.calls.map((c) => c[0] as string);
    expect(all.some((t) => /пока нет расходов/.test(t))).toBe(true);
  });

  test('current-month expenses → header with "Расходы за <месяц>"', async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    mockExpensesRepo.findByGroupId.mockReturnValue([
      makeExp({ date: today, amount: 25, eur_amount: 25 }),
    ]);

    await handleSumCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Расходы за');
    expect(msg).toContain('Всего:');
  });

  test('skips silentSyncBudgets when google_refresh_token is null', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([]);

    await handleSumCommand(fakeCtx(), fakeGroup({ google_refresh_token: null }));

    expect(silentSyncBudgetsMock).not.toHaveBeenCalled();
  });

  test('notifies when silentSyncBudgets synced records', async () => {
    silentSyncBudgetsMock.mockResolvedValue(4);
    mockExpensesRepo.findByGroupId.mockReturnValue([]);

    await handleSumCommand(fakeCtx(), fakeGroup({ google_refresh_token: 'tok' }));

    const all = sendMessageMock.mock.calls.map((c) => c[0] as string);
    expect(all.some((t) => t.includes('Синхронизировано записей бюджета: 4'))).toBe(true);
  });

  test('does not notify about sync when count=0', async () => {
    silentSyncBudgetsMock.mockResolvedValue(0);
    mockExpensesRepo.findByGroupId.mockReturnValue([]);

    await handleSumCommand(fakeCtx(), fakeGroup({ google_refresh_token: 'tok' }));

    const all = sendMessageMock.mock.calls.map((c) => c[0] as string);
    expect(all.some((t) => t.includes('Синхронизировано'))).toBe(false);
  });

  test('budgets section rendered when budgets exist for current month', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExpensesRepo.findByGroupId.mockReturnValue([
      makeExp({ date: today, category: 'Food', amount: 100, eur_amount: 100 }),
    ]);
    mockBudgetsRepo.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 100, currency: 'EUR' as CurrencyCode },
    ]);

    await handleSumCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Бюджет:');
    expect(msg).toContain('Всего:');
  });

  test('average-per-month line shown when prior months have data', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExpensesRepo.findByGroupId.mockReturnValue([
      makeExp({ date: '2025-01-10', amount: 100, eur_amount: 100 }),
      makeExp({ date: '2025-02-10', amount: 50, eur_amount: 50 }),
      makeExp({ date: today, amount: 10, eur_amount: 10 }),
    ]);

    await handleSumCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Средняя:');
    expect(msg).toContain('Разница:');
  });

  test('no average line when only current month has data', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExpensesRepo.findByGroupId.mockReturnValue([makeExp({ date: today })]);

    await handleSumCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).not.toContain('Средняя:');
  });

  test('ignores budgets section when none set (no "Бюджет:" block)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExpensesRepo.findByGroupId.mockReturnValue([makeExp({ date: today })]);
    mockBudgetsRepo.getAllBudgetsForMonth.mockReturnValue([]);

    await handleSumCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).not.toContain('Бюджет:');
  });

  test('displays totals in RUB when group.default_currency=RUB', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExpensesRepo.findByGroupId.mockReturnValue([
      makeExp({ date: today, amount: 10, currency: 'EUR', eur_amount: 10 }),
    ]);

    await handleSumCommand(fakeCtx(), fakeGroup({ default_currency: 'RUB' as CurrencyCode }));

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    // formatAmount renders RUB with the ₽ symbol (per CURRENCY_SYMBOLS)
    expect(msg).toContain('₽');
  });

  test('repo throws → error bubbles up (nothing silently swallowed)', async () => {
    mockExpensesRepo.findByGroupId.mockImplementation(() => {
      throw new Error('DB down');
    });

    await expect(handleSumCommand(fakeCtx(), fakeGroup())).rejects.toThrow('DB down');
  });

  test('exceeded budget shown with 🔴 marker', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExpensesRepo.findByGroupId.mockReturnValue([
      makeExp({ date: today, category: 'Food', amount: 200, eur_amount: 200 }),
    ]);
    mockBudgetsRepo.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 100, currency: 'EUR' as CurrencyCode },
    ]);

    await handleSumCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('🔴');
    expect(msg).toContain('Food');
  });

  test('warning budget (≥90%) shown with ⚠️ marker', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExpensesRepo.findByGroupId.mockReturnValue([
      makeExp({ date: today, category: 'Food', amount: 95, eur_amount: 95 }),
    ]);
    mockBudgetsRepo.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 100, currency: 'EUR' as CurrencyCode },
    ]);

    await handleSumCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('⚠️');
  });

  test('healthy budget (<90%) does not trigger category line', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExpensesRepo.findByGroupId.mockReturnValue([
      makeExp({ date: today, category: 'Food', amount: 10, eur_amount: 10 }),
    ]);
    mockBudgetsRepo.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Food', limit_amount: 100, currency: 'EUR' as CurrencyCode },
    ]);

    await handleSumCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    // No per-category highlight line for a healthy budget
    expect(msg).not.toContain('🔴');
    expect(msg).not.toContain('⚠️');
  });

  test('category-difference section shown only when diff > 5% or < -5%', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExpensesRepo.findByGroupId.mockReturnValue([
      // History: 100 EUR Food (Jan), 100 EUR Food (Feb)
      makeExp({ date: '2025-01-15', category: 'Food', amount: 100, eur_amount: 100 }),
      makeExp({ date: '2025-02-15', category: 'Food', amount: 100, eur_amount: 100 }),
      // Current month: 300 EUR Food — well above average of 100
      makeExp({ date: today, category: 'Food', amount: 300, eur_amount: 300 }),
    ]);

    await handleSumCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Больше среднего');
    expect(msg).toContain('Food');
  });
});
