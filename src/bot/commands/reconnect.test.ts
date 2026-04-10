// Tests for /reconnect — verifies guard conditions, year spreadsheet logic, and budget grouping

import type { Database as SqliteDb } from 'bun:sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import { BudgetRepository } from '../../database/repositories/budget.repository';
import { CategoryRepository } from '../../database/repositories/category.repository';
import { ExpenseRepository } from '../../database/repositories/expense.repository';
import { GroupRepository } from '../../database/repositories/group.repository';
import { GroupSpreadsheetRepository } from '../../database/repositories/group-spreadsheet.repository';
import { UserRepository } from '../../database/repositories/user.repository';
import type { Group } from '../../database/types';
import { MONTH_ABBREVS } from '../../services/google/month-abbr';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import type { Ctx } from '../types';

const sendMessageMock = mock(
  (_text: string, _options?: unknown): Promise<null> => Promise.resolve(null),
);

mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  // Passthrough for transitive importers (e.g. ./sync) — reconnect tests never hit the sync path.
  withChatContext: async <T>(_chatId: number, _threadId: number | null, fn: () => Promise<T>) =>
    fn(),
  editMessageText: mock(() => Promise.resolve()),
  sendDirect: mock(() => Promise.resolve(null)),
}));

const { handleReconnectCommand } = await import('./reconnect');

let db: SqliteDb;
let groups: GroupRepository;
let spreadsheets: GroupSpreadsheetRepository;
let expenses: ExpenseRepository;
let budgets: BudgetRepository;
let users: UserRepository;
let categories: CategoryRepository;

beforeAll(() => {
  db = createTestDb();
  groups = new GroupRepository(db);
  spreadsheets = new GroupSpreadsheetRepository(db);
  expenses = new ExpenseRepository(db);
  budgets = new BudgetRepository(db);
  users = new UserRepository(db);
  categories = new CategoryRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
});

/** Build a minimal fake command context with the given chat shape */
function fakeCtx(chat: { id: number; type: string } | undefined): Ctx['Command'] {
  return { chat, from: { id: 111 } } as unknown as Ctx['Command'];
}

describe('/reconnect guard conditions', () => {
  let findByTelegramGroupIdSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue(null);
    findByTelegramGroupIdSpy = spyOn(database.groups, 'findByTelegramGroupId').mockReturnValue(
      null,
    );
  });

  afterEach(() => {
    mock.restore();
  });

  test('rejects private chats with "только в группах" message', async () => {
    await handleReconnectCommand(fakeCtx({ id: 123, type: 'private' }));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toContain('только в группах');
    expect(findByTelegramGroupIdSpy).not.toHaveBeenCalled();
  });

  test('rejects when ctx.chat is undefined', async () => {
    await handleReconnectCommand(fakeCtx(undefined));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toContain('только в группах');
    expect(findByTelegramGroupIdSpy).not.toHaveBeenCalled();
  });

  test('sends setup hint when group is not in DB', async () => {
    await handleReconnectCommand(fakeCtx({ id: -1009999, type: 'group' }));

    expect(findByTelegramGroupIdSpy).toHaveBeenCalledWith(-1009999);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toContain('Группа не настроена');
  });

  test('sends setup hint when group has no spreadsheet_id', async () => {
    findByTelegramGroupIdSpy.mockReturnValue({
      id: 42,
      telegram_group_id: -1001234,
      spreadsheet_id: null,
      google_refresh_token: null,
    } as unknown as Group);

    await handleReconnectCommand(fakeCtx({ id: -1001234, type: 'supergroup' }));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toContain('Таблица не создана');
  });

  test('sends OAuth URL keyboard when group is fully configured', async () => {
    findByTelegramGroupIdSpy.mockReturnValue({
      id: 42,
      telegram_group_id: -1001234,
      spreadsheet_id: 'sheet-abc',
      google_refresh_token: 'old-token',
    } as unknown as Group);
    // Simulate successful delivery (non-null return).
    sendMessageMock.mockResolvedValue({ message_id: 1 } as unknown as null);

    await expect(
      handleReconnectCommand(fakeCtx({ id: -1001234, type: 'supergroup' })),
    ).resolves.toBeUndefined();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [text, options] = sendMessageMock.mock.calls[0] ?? [];
    expect(String(text)).toContain('Переподключение Google');
    expect(options).toMatchObject({ reply_markup: expect.any(Object) });
  });

  test('handles null return from sendMessage without throwing (send failure)', async () => {
    findByTelegramGroupIdSpy.mockReturnValue({
      id: 42,
      telegram_group_id: -1001234,
      spreadsheet_id: 'sheet-abc',
      google_refresh_token: 'old-token',
    } as unknown as Group);
    // Simulate Telegram send failure (telegram-sender returns null on error).
    sendMessageMock.mockResolvedValue(null);

    await expect(
      handleReconnectCommand(fakeCtx({ id: -1001234, type: 'supergroup' })),
    ).resolves.toBeUndefined();

    // Still attempted the send exactly once — doesn't retry silently.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe('/reconnect preconditions', () => {
  test('requires group to exist in DB', () => {
    const group = groups.findByTelegramGroupId(-1009999);
    expect(group).toBeNull();
  });

  test('requires spreadsheet_id to be set', () => {
    const created = groups.create({ telegram_group_id: -1001234 });
    expect(created.spreadsheet_id).toBeNull();
  });

  test('proceeds when group has spreadsheet_id', () => {
    groups.create({ telegram_group_id: -1001234 });
    groups.update(-1001234, {
      spreadsheet_id: 'sheet-abc',
      google_refresh_token: 'old-token',
    });

    const updated = groups.findByTelegramGroupId(-1001234);
    expect(updated?.spreadsheet_id).toBe('sheet-abc');
    expect(updated?.google_refresh_token).toBe('old-token');
  });

  test('token can be updated without losing spreadsheet_id', () => {
    groups.create({ telegram_group_id: -1001234 });
    groups.update(-1001234, {
      spreadsheet_id: 'sheet-abc',
      google_refresh_token: 'old-token',
      default_currency: 'EUR',
      enabled_currencies: ['EUR', 'USD'],
    });

    groups.update(-1001234, { google_refresh_token: 'new-token' });

    const updated = groups.findByTelegramGroupId(-1001234);
    expect(updated?.spreadsheet_id).toBe('sheet-abc');
    expect(updated?.google_refresh_token).toBe('new-token');
    expect(updated?.default_currency).toBe('EUR');
    expect(updated?.enabled_currencies).toEqual(['EUR', 'USD']);
  });

  test('year-specific spreadsheets are preserved after token update', () => {
    const group = groups.create({ telegram_group_id: -1001234 });
    groups.update(-1001234, {
      spreadsheet_id: 'sheet-2026',
      google_refresh_token: 'old-token',
    });
    spreadsheets.setYear(group.id, 2026, 'sheet-2026');

    groups.update(-1001234, { google_refresh_token: 'new-token' });

    const sheets = spreadsheets.listAll(group.id);
    expect(sheets).toHaveLength(1);
    const [first] = sheets;
    expect(first?.spreadsheetId).toBe('sheet-2026');
    expect(first?.year).toBe(2026);
  });
});

describe('/reconnect year spreadsheet resolution', () => {
  test('detects missing year spreadsheet', () => {
    const group = groups.create({ telegram_group_id: -1001234 });
    groups.update(-1001234, {
      spreadsheet_id: 'sheet-old',
      google_refresh_token: 'token',
    });
    // Only 2025 registered, 2027 is absent
    spreadsheets.setYear(group.id, 2025, 'sheet-old');

    expect(spreadsheets.getByYear(group.id, 2025)).toBe('sheet-old');
    expect(spreadsheets.getByYear(group.id, 2027)).toBeNull();
  });

  test('registers new year spreadsheet correctly', () => {
    const group = groups.create({ telegram_group_id: -1001234 });
    const currentYear = new Date().getFullYear();

    spreadsheets.setYear(group.id, currentYear, 'new-sheet-id');

    expect(spreadsheets.getByYear(group.id, currentYear)).toBe('new-sheet-id');
    expect(spreadsheets.listAll(group.id)).toHaveLength(1);
  });

  test('multiple years coexist', () => {
    const group = groups.create({ telegram_group_id: -1001234 });

    spreadsheets.setYear(group.id, 2025, 'sheet-2025');
    spreadsheets.setYear(group.id, 2026, 'sheet-2026');

    expect(spreadsheets.getByYear(group.id, 2025)).toBe('sheet-2025');
    expect(spreadsheets.getByYear(group.id, 2026)).toBe('sheet-2026');
    expect(spreadsheets.listAll(group.id)).toHaveLength(2);
  });
});

describe('/reconnect expense push detection', () => {
  test('identifies DB expenses missing from sheet by key', () => {
    const group = groups.create({ telegram_group_id: -1001234 });
    const user = users.create({ telegram_id: 111, group_id: group.id });

    expenses.create({
      group_id: group.id,
      user_id: user.id,
      date: '2026-03-01',
      category: 'Food',
      comment: 'lunch',
      amount: 100,
      currency: 'EUR',
      eur_amount: 100,
    });
    expenses.create({
      group_id: group.id,
      user_id: user.id,
      date: '2026-03-02',
      category: 'Transport',
      comment: 'taxi',
      amount: 50,
      currency: 'EUR',
      eur_amount: 50,
    });

    const dbExpenses = expenses.findByGroupId(group.id, 100);
    expect(dbExpenses).toHaveLength(2);

    // Simulate sheet having only one of them
    const sheetKeys = new Set(['2026-03-01|Food|100|EUR']);
    const missing = dbExpenses.filter((e) => {
      const key = `${e.date}|${e.category}|${e.amount}|${e.currency}`;
      return !sheetKeys.has(key);
    });

    expect(missing).toHaveLength(1);
    expect(missing[0]?.category).toBe('Transport');
  });
});

describe('/reconnect budget sync to sheet', () => {
  test('groups budgets by month correctly', () => {
    const group = groups.create({ telegram_group_id: -1001234 });

    budgets.setBudget({
      group_id: group.id,
      category: 'Food',
      month: '2026-01',
      limit_amount: 500,
      currency: 'EUR',
    });
    budgets.setBudget({
      group_id: group.id,
      category: 'Transport',
      month: '2026-01',
      limit_amount: 200,
      currency: 'EUR',
    });
    budgets.setBudget({
      group_id: group.id,
      category: 'Food',
      month: '2026-03',
      limit_amount: 600,
      currency: 'EUR',
    });

    const allBudgets = budgets.findByGroupId(group.id);
    const yearBudgets = allBudgets.filter((b) => b.month.startsWith('2026-'));

    // Group by month
    const byMonth = new Map<string, typeof yearBudgets>();
    for (const budget of yearBudgets) {
      const month = budget.month.slice(0, 7);
      const arr = byMonth.get(month);
      if (arr) arr.push(budget);
      else byMonth.set(month, [budget]);
    }

    expect(byMonth.get('2026-01')).toHaveLength(2);
    expect(byMonth.get('2026-03')).toHaveLength(1);
    expect(byMonth.has('2026-02')).toBe(false);
  });

  test('budgets from multiple years are filtered correctly', () => {
    const group = groups.create({ telegram_group_id: -1001234 });

    budgets.setBudget({
      group_id: group.id,
      category: 'Food',
      month: '2025-12',
      limit_amount: 500,
      currency: 'EUR',
    });
    budgets.setBudget({
      group_id: group.id,
      category: 'Food',
      month: '2026-01',
      limit_amount: 600,
      currency: 'EUR',
    });

    const allBudgets = budgets.findByGroupId(group.id);
    const only2026 = allBudgets.filter((b) => b.month.startsWith('2026-'));

    expect(only2026).toHaveLength(1);
    expect(only2026[0]?.month).toBe('2026-01');
  });
});

describe('/reconnect budget import from sheet', () => {
  test('MONTH_ABBREVS maps to correct month strings', () => {
    // Verify the mapping used in importBudgetsFromSheet
    const pairs = MONTH_ABBREVS.map((abbr, idx) => ({
      abbr,
      monthStr: `2026-${String(idx + 1).padStart(2, '0')}`,
    }));

    expect(pairs[0]?.abbr).toBe('Jan');
    expect(pairs[0]?.monthStr).toBe('2026-01');
    expect(pairs[11]?.abbr).toBe('Dec');
    expect(pairs[11]?.monthStr).toBe('2026-12');
  });

  test('imports new budget from sheet data into DB', () => {
    const group = groups.create({ telegram_group_id: -1001234 });

    // Simulate what importBudgetsFromSheet does: read budget from sheet, create in DB
    const sheetBudget = { category: 'Food', limit: 500, currency: 'EUR' as CurrencyCode };
    const monthStr = '2026-03';

    // No existing budget
    const existing = budgets.findByGroupCategoryMonth(group.id, sheetBudget.category, monthStr);
    expect(existing).toBeNull();

    // Create category if missing
    if (!categories.exists(group.id, sheetBudget.category)) {
      categories.create({ group_id: group.id, name: sheetBudget.category });
    }

    // Import budget
    budgets.setBudget({
      group_id: group.id,
      category: sheetBudget.category,
      month: monthStr,
      limit_amount: sheetBudget.limit,
      currency: sheetBudget.currency,
    });

    const imported = budgets.findByGroupCategoryMonth(group.id, 'Food', '2026-03');
    expect(imported?.limit_amount).toBe(500);
    expect(imported?.currency).toBe('EUR');
  });

  test('updates existing budget when sheet has different values', () => {
    const group = groups.create({ telegram_group_id: -1001234 });

    // Existing budget in DB
    budgets.setBudget({
      group_id: group.id,
      category: 'Food',
      month: '2026-03',
      limit_amount: 300,
      currency: 'EUR',
    });

    // Sheet has updated value
    const sheetBudget = { category: 'Food', limit: 500, currency: 'USD' as CurrencyCode };
    const existing = budgets.findByGroupCategoryMonth(group.id, 'Food', '2026-03');
    const hasChanged =
      !existing ||
      existing.limit_amount !== sheetBudget.limit ||
      existing.currency !== sheetBudget.currency;
    expect(hasChanged).toBe(true);

    // Upsert with new values
    budgets.setBudget({
      group_id: group.id,
      category: sheetBudget.category,
      month: '2026-03',
      limit_amount: sheetBudget.limit,
      currency: sheetBudget.currency,
    });

    const updated = budgets.findByGroupCategoryMonth(group.id, 'Food', '2026-03');
    expect(updated?.limit_amount).toBe(500);
    expect(updated?.currency).toBe('USD');
  });

  test('skips unchanged budgets', () => {
    const group = groups.create({ telegram_group_id: -1001234 });

    budgets.setBudget({
      group_id: group.id,
      category: 'Food',
      month: '2026-03',
      limit_amount: 500,
      currency: 'EUR',
    });

    const existing = budgets.findByGroupCategoryMonth(group.id, 'Food', '2026-03');
    const hasChanged = !existing || existing.limit_amount !== 500 || existing.currency !== 'EUR';
    expect(hasChanged).toBe(false);
  });
});
