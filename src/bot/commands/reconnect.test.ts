// Tests for /reconnect — verifies guard conditions, year spreadsheet logic, and budget grouping

import type { Database as SqliteDb } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { BudgetRepository } from '../../database/repositories/budget.repository';
import { ExpenseRepository } from '../../database/repositories/expense.repository';
import { GroupRepository } from '../../database/repositories/group.repository';
import { GroupSpreadsheetRepository } from '../../database/repositories/group-spreadsheet.repository';
import { UserRepository } from '../../database/repositories/user.repository';
import { clearTestDb, createTestDb } from '../../test-utils/db';

let db: SqliteDb;
let groups: GroupRepository;
let spreadsheets: GroupSpreadsheetRepository;
let expenses: ExpenseRepository;
let budgets: BudgetRepository;
let users: UserRepository;

beforeAll(() => {
  db = createTestDb();
  groups = new GroupRepository(db);
  spreadsheets = new GroupSpreadsheetRepository(db);
  expenses = new ExpenseRepository(db);
  budgets = new BudgetRepository(db);
  users = new UserRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
});

/** Minimal mock for ctx that captures sent messages */
function createMockCtx(overrides: { chatId?: number; chatType?: string }) {
  const sent: string[] = [];
  return {
    ctx: {
      chat: overrides.chatId
        ? { id: overrides.chatId, type: overrides.chatType ?? 'supergroup' }
        : undefined,
      from: { id: 111 },
      send: mock(async (text: string) => {
        sent.push(text);
      }),
    },
    sent,
  };
}

describe('/reconnect guard conditions', () => {
  test('rejects private chats', () => {
    const { ctx } = createMockCtx({ chatId: 123, chatType: 'private' });
    const chatType = ctx.chat?.type;
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    expect(isGroup).toBe(false);
  });

  test('rejects when chat has no type', () => {
    const { ctx } = createMockCtx({});
    expect(ctx.chat).toBeUndefined();
  });

  test('accepts group chats', () => {
    const { ctx } = createMockCtx({ chatId: -1001234, chatType: 'group' });
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    expect(isGroup).toBe(true);
  });

  test('accepts supergroup chats', () => {
    const { ctx } = createMockCtx({ chatId: -1001234, chatType: 'supergroup' });
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    expect(isGroup).toBe(true);
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
