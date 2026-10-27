// Pins the exact /sum message text (averages, category deltas, trend lines) and the
// rounding / ordering / cap rules behind it, so the message-building code can be
// restructured without changing what users see. EUR is the display currency
// throughout so no exchange-rate lookups influence the expected strings.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { format } from 'date-fns';
import type { Group } from '../../database/types';
import type { TechnicalAnalysis } from '../../services/analytics/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Ctx } from '../types';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

interface ExpenseRow {
  date: string;
  category: string;
  amount: number;
  currency: string;
  eur_amount: number;
}

const mockExpensesRepo = {
  findByGroupId: mock((_id: number, _limit: number): ExpenseRow[] => []),
};
const mockBudgetsRepo = {
  getAllBudgetsForMonth: mock((_id: number, _month: string): never[] => []),
};
mock.module('../../database', () => ({
  database: { expenses: mockExpensesRepo, budgets: mockBudgetsRepo },
}));

const snapshotMock = mock((_groupId: number): { technicalAnalysis: TechnicalAnalysis | null } => ({
  technicalAnalysis: null,
}));
mock.module('../../services/analytics/spending-analytics', () => ({
  spendingAnalytics: { getFinancialSnapshot: snapshotMock },
}));

mock.module('../services/budget-sync', () => ({
  silentSyncBudgets: mock(async (): Promise<number> => 0),
}));
mock.module('./ask', () => ({ maybeSmartAdvice: mock(async () => undefined) }));
mock.module('../../services/google/sheets', () => ({
  googleConn: mock(() => ({ refreshToken: 'tok', oauthClient: 'current' as const })),
}));

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

const { handleSumCommand } = await import('./sum');

const ctx = {
  chat: { id: -100, type: 'supergroup' },
  from: { id: 1 },
  text: '/sum',
} as unknown as Ctx['Command'];
const group = {
  id: 1,
  telegram_group_id: -100,
  google_refresh_token: null,
  spreadsheet_id: null,
  default_currency: 'EUR',
} as unknown as Group;

const MONTH_START = `${format(new Date(), 'yyyy-MM')}-01`;
const HEADER = `📊 Расходы за ${format(new Date(), 'LLLL yyyy')}\n\n`;

function exp(date: string, category: string, eur: number): ExpenseRow {
  return { date, category, amount: eur, currency: 'EUR', eur_amount: eur };
}

/** Minimal TA category: only the fields the /sum trend summary reads. */
function taCategory(
  category: string,
  signals: {
    anomaly?: boolean;
    direction?: 'rising' | 'falling' | 'flat';
    confidence?: number;
    crossover?: 'bullish' | 'bearish' | 'none';
    breakout?: boolean;
    forecast?: number;
  } = {},
): TechnicalAnalysis['categories'][number] {
  return {
    category,
    forecasts: { ensemble: signals.forecast ?? 10 },
    anomaly: { isAnomaly: signals.anomaly ?? false },
    trend: {
      direction: signals.direction ?? 'flat',
      confidence: signals.confidence ?? 0,
      macd: { crossover: signals.crossover ?? 'none' },
    },
    volatility: { donchian: { isBreakoutHigh: signals.breakout ?? false } },
  } as unknown as TechnicalAnalysis['categories'][number];
}

function withTa(categories: TechnicalAnalysis['categories']): void {
  snapshotMock.mockReturnValue({ technicalAnalysis: { categories } as TechnicalAnalysis });
}

async function sentText(): Promise<string> {
  await handleSumCommand(ctx, group);
  return sendMessageMock.mock.calls.at(-1)?.[0] as string;
}

describe('/sum message text', () => {
  beforeEach(() => {
    sendMessageMock.mockReset().mockResolvedValue(null);
    mockExpensesRepo.findByGroupId.mockReset().mockReturnValue([]);
    mockBudgetsRepo.getAllBudgetsForMonth.mockReset().mockReturnValue([]);
    snapshotMock.mockReset().mockReturnValue({ technicalAnalysis: null });
  });

  test('only current month: total line only, nothing else', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([
      exp(MONTH_START, 'Food', 10),
      exp(MONTH_START, 'Food', 5.5),
    ]);
    expect(await sentText()).toBe(`${HEADER}💰 Всего: 15.50 €\n`);
  });

  test('above average: signed difference, category deltas, rounding to 1 decimal', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([
      exp('2020-01-10', 'Food', 100),
      exp('2020-01-11', 'Rent', 200),
      exp('2020-02-10', 'Food', 100),
      exp(MONTH_START, 'Food', 150),
      exp(MONTH_START, 'Rent', 100),
      exp(MONTH_START, 'Fun', 30),
    ]);
    expect(await sentText()).toBe(
      `${HEADER}💰 Всего: 280.00 €\n📈 Средняя: 200.00 €\n📊 Разница: +80.00 € (+40.0%)\n` +
        `\n🔥 Больше среднего:\n  • Food: +50.00 € (+50.0%)\n` +
        `\n❄️ Меньше среднего:\n  • Rent: -100.00 € (-50.0%)\n`,
    );
  });

  test('below average: negative difference printed without plus sign', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([
      exp('2020-01-10', 'Food', 200),
      exp(MONTH_START, 'Food', 100),
    ]);
    expect(await sentText()).toBe(
      `${HEADER}💰 Всего: 100.00 €\n📈 Средняя: 200.00 €\n📊 Разница: -100.00 € (-50.0%)\n` +
        `\n🔥 Больше среднего:\n  • Нет категорий\n` +
        `\n❄️ Меньше среднего:\n  • Food: -100.00 € (-50.0%)\n`,
    );
  });

  test('exactly on average: "точно в среднем" and both category lists empty', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([
      exp('2020-01-10', 'Food', 100),
      exp(MONTH_START, 'Food', 100),
    ]);
    expect(await sentText()).toBe(
      `${HEADER}💰 Всего: 100.00 €\n📈 Средняя: 100.00 €\n📊 Разница: точно в среднем\n` +
        `\n🔥 Больше среднего:\n  • Нет категорий\n` +
        `\n❄️ Меньше среднего:\n  • Нет категорий\n`,
    );
  });

  test('within ±5% of category average is not listed', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([
      exp('2020-01-10', 'Food', 100),
      exp('2020-01-10', 'Rent', 100),
      exp(MONTH_START, 'Food', 105),
      exp(MONTH_START, 'Rent', 95),
    ]);
    const msg = await sentText();
    expect(msg).toContain('🔥 Больше среднего:\n  • Нет категорий\n');
    expect(msg).toContain('❄️ Меньше среднего:\n  • Нет категорий\n');
  });

  test('top 3 above-average categories by absolute percent, largest first', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([
      exp('2020-01-10', 'A', 100),
      exp('2020-01-10', 'B', 100),
      exp('2020-01-10', 'C', 100),
      exp('2020-01-10', 'D', 100),
      exp(MONTH_START, 'A', 110),
      exp(MONTH_START, 'B', 140),
      exp(MONTH_START, 'C', 120),
      exp(MONTH_START, 'D', 130),
    ]);
    expect(await sentText()).toContain(
      '🔥 Больше среднего:\n  • B: +40.00 € (+40.0%)\n  • D: +30.00 € (+30.0%)\n  • C: +20.00 € (+20.0%)\n',
    );
  });

  test('below-average categories: top 3, most negative first', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([
      exp('2020-01-10', 'A', 100),
      exp('2020-01-10', 'B', 100),
      exp('2020-01-10', 'C', 100),
      exp('2020-01-10', 'D', 100),
      exp(MONTH_START, 'A', 90),
      exp(MONTH_START, 'B', 60),
      exp(MONTH_START, 'C', 80),
      exp(MONTH_START, 'D', 70),
    ]);
    expect(await sentText()).toContain(
      '❄️ Меньше среднего:\n  • B: -40.00 € (-40.0%)\n  • D: -30.00 € (-30.0%)\n  • C: -20.00 € (-20.0%)\n',
    );
  });

  test('category average divides by months in which the category appeared', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([
      exp('2020-01-10', 'Food', 100),
      exp('2020-01-20', 'Food', 100),
      exp('2020-02-10', 'Rent', 300),
      exp(MONTH_START, 'Food', 300),
    ]);
    // Food: 200 over 1 month with Food → avg 200, so +100 (+50.0%).
    expect(await sentText()).toContain('  • Food: +100.00 € (+50.0%)\n');
  });

  test('month key uses the YYYY-MM prefix: same month twice counts once for the average', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([
      exp('2020-01-01', 'Food', 50),
      exp('2020-01-31', 'Food', 50),
      exp(MONTH_START, 'Food', 100),
    ]);
    expect(await sentText()).toContain('📈 Средняя: 100.00 €\n📊 Разница: точно в среднем\n');
  });
});

describe('/sum trend summary', () => {
  beforeEach(() => {
    sendMessageMock.mockReset().mockResolvedValue(null);
    mockExpensesRepo.findByGroupId.mockReset().mockReturnValue([exp(MONTH_START, 'Food', 10)]);
    mockBudgetsRepo.getAllBudgetsForMonth.mockReset().mockReturnValue([]);
    snapshotMock.mockReset().mockReturnValue({ technicalAnalysis: null });
  });

  test('no signals → no trends section', async () => {
    withTa([taCategory('Food'), taCategory('Rent', { direction: 'rising', confidence: 0.59 })]);
    expect(await sentText()).not.toContain('Тренды');
  });

  test('empty category list → no trends section', async () => {
    withTa([]);
    expect(await sentText()).not.toContain('Тренды');
  });

  test('signals are joined in fixed order with the converted forecast', async () => {
    withTa([
      taCategory('Food', {
        anomaly: true,
        direction: 'rising',
        confidence: 0.6,
        crossover: 'bullish',
        breakout: true,
        forecast: 12.5,
      }),
    ]);
    expect(await sentText()).toBe(
      `${HEADER}💰 Всего: 10.00 €\n\n📈 Тренды:\n` +
        `  🍔 Food: ⚠️ необычный расход, ↑ растут, 📈 начали расти, 🚨 рекорд (прогноз 12.50 €)\n`,
    );
  });

  test('falling trend (confidence >= 0.6) and bearish crossover wording', async () => {
    withTa([taCategory('A', { direction: 'falling', confidence: 0.6, crossover: 'bearish' })]);
    expect(await sentText()).toContain('A: ↓ снижаются, 📉 пошли на спад');
  });

  test('falling trend below 0.6 confidence is ignored', async () => {
    withTa([taCategory('A', { direction: 'falling', confidence: 0.59 })]);
    expect(await sentText()).not.toContain('Тренды');
  });

  test('N+2 rule: 12 lines are all shown', async () => {
    withTa(Array.from({ length: 12 }, (_, i) => taCategory(`C${i}`, { anomaly: true })));
    const msg = await sentText();
    expect(msg).toContain('C11:');
    expect(msg).not.toContain('и ещё');
  });

  test('N+2 rule: 13 lines are cut to 10 plus "… и ещё 3"', async () => {
    withTa(Array.from({ length: 13 }, (_, i) => taCategory(`C${i}`, { anomaly: true })));
    const msg = await sentText();
    expect(msg).toContain('C9:');
    expect(msg).not.toContain('C10:');
    expect(msg).toEndWith('  … и ещё 3\n');
  });
});
