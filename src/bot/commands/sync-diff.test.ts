// syncExpenses diff classification and the /sync + auto-sync report text, against a real
// in-memory SQLite DB. Pins matching rules (exact / partial / delete), the EUR tolerance,
// year scoping, category creation, list caps and the notice buttons.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SheetRow } from '../../services/google/sheets';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { GoogleConnectedGroup } from '../guards';
import type { Ctx } from '../types';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

let sheetRows: SheetRow[] = [];
mock.module('../../services/google/sheets', () => ({
  readExpensesFromSheet: async () => ({ expenses: sheetRows, errors: [], eurMismatches: [] }),
  googleConn: () => ({ refreshToken: 'tok', oauthClient: 'current' }),
}));

const sendMessageMock = mock(async (_text: string, _opts?: unknown) => ({ message_id: 1 }));
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
}));

mock.module('../../services/budget-manager', () => ({
  getBudgetManager: () => ({ importFromSheet: mock(() => ({})) }),
}));

// Dynamic imports: they must load after the mock.module() calls above (static imports hoist).
const db = createTestDb();
const { DatabaseService } = await import('../../database/index');
const service = new DatabaseService(db);
mock.module('../../database', () => ({ database: service, _budgetWriter: () => service.budgets }));

const { ensureFreshExpenses, handleSyncCommand, syncExpenses } = await import('./sync');

afterAll(() => db.close());

let nextTelegramGroupId = -5000;
function connectedGroup(): { groupId: number; userId: number } {
  const telegramGroupId = nextTelegramGroupId--;
  const group = service.groups.create({ telegram_group_id: telegramGroupId });
  service.groups.update(telegramGroupId, { spreadsheet_id: 'SHEET', google_refresh_token: 'tok' });
  const user = service.users.create({
    telegram_id: Date.now() + nextTelegramGroupId,
    group_id: group.id,
  });
  // Report-text tests assume the usual category already exists (no "new categories" line).
  service.categories.create({ group_id: group.id, name: 'Еда' });
  return { groupId: group.id, userId: user.id };
}

function dbExpense(
  groupId: number,
  userId: number,
  date: string,
  comment: string,
  eur = 10,
  category = 'Еда',
): number {
  return service.expenses.create({
    group_id: groupId,
    user_id: userId,
    date,
    category,
    comment,
    amount: 10,
    currency: 'EUR',
    eur_amount: eur,
  }).id;
}

function sheetRow(date: string, comment: string, eur = 10, category = 'Еда'): SheetRow {
  return { date, amounts: { EUR: 10 }, eurAmount: eur, rate: null, category, comment };
}

beforeEach(() => {
  clearTestDb(db);
  sheetRows = [];
  sendMessageMock.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
});

describe('syncExpenses matching', () => {
  test('classifies rows as unchanged / updated / deleted / added', async () => {
    const { groupId, userId } = connectedGroup();
    dbExpense(groupId, userId, '2026-05-10', 'same');
    dbExpense(groupId, userId, '2026-05-11', 'x');
    dbExpense(groupId, userId, '2026-05-12', 'gone');
    sheetRows = [
      sheetRow('2026-05-10', 'same'),
      sheetRow('2026-05-11', 'y'),
      sheetRow('2026-05-13', 'brand new'),
    ];

    const result = await syncExpenses(groupId);

    expect(result.unchanged).toBe(1);
    expect(result.updated.map((e) => [e.date, e.comment, e.field])).toEqual([
      ['2026-05-11', 'y', '"x"→"y"'],
    ]);
    expect(result.deleted.map((e) => [e.date, e.comment])).toEqual([['2026-05-12', 'gone']]);
    expect(result.added.map((e) => [e.date, e.comment])).toEqual([['2026-05-13', 'brand new']]);
    const stored = service.expenses
      .findByGroupId(groupId, 100)
      .map((e) => e.comment)
      .sort();
    expect(stored).toEqual(['brand new', 'same', 'y']);
  });

  test('EUR difference is reported with both values; comment change appended after it', async () => {
    const { groupId, userId } = connectedGroup();
    dbExpense(groupId, userId, '2026-05-10', 'a', 5);
    dbExpense(groupId, userId, '2026-05-11', 'x', 5);
    sheetRows = [sheetRow('2026-05-10', 'a', 6), sheetRow('2026-05-11', 'y', 6)];

    const result = await syncExpenses(groupId);

    expect(result.updated.map((e) => e.field)).toEqual(['EUR: 5→6', 'EUR: 5→6, "x"→"y"']);
    expect(service.expenses.findByGroupId(groupId, 100).map((e) => e.eur_amount)).toEqual([6, 6]);
  });

  test('EUR tolerance is 0.01: 10.01 is unchanged, 10.02 is an update', async () => {
    const { groupId, userId } = connectedGroup();
    dbExpense(groupId, userId, '2026-05-10', 'a', 10);
    dbExpense(groupId, userId, '2026-05-11', 'b', 10);
    sheetRows = [sheetRow('2026-05-10', 'a', 10.01), sheetRow('2026-05-11', 'b', 10.02)];

    const result = await syncExpenses(groupId);

    expect(result.unchanged).toBe(1);
    expect(result.updated.map((e) => e.date)).toEqual(['2026-05-11']);
  });

  test('update keeps the owner of the replaced expense', async () => {
    const { groupId, userId } = connectedGroup();
    dbExpense(groupId, userId, '2026-05-10', 'old');
    sheetRows = [sheetRow('2026-05-10', 'new')];

    await syncExpenses(groupId);

    const stored = service.expenses.findByGroupId(groupId, 100);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.user_id).toBe(userId);
    expect(stored[0]?.comment).toBe('new');
  });

  test('duplicate keys: the exact comment match wins, the other duplicate is deleted', async () => {
    const { groupId, userId } = connectedGroup();
    dbExpense(groupId, userId, '2026-05-10', 'c1');
    dbExpense(groupId, userId, '2026-05-10', 'c2');
    sheetRows = [sheetRow('2026-05-10', 'c2')];

    const result = await syncExpenses(groupId);

    expect(result.unchanged).toBe(1);
    expect(result.deleted.map((e) => e.comment)).toEqual(['c1']);
    expect(result.updated).toEqual([]);
  });

  test('a surplus sheet row beyond the DB duplicates is added, not matched twice', async () => {
    const { groupId, userId } = connectedGroup();
    dbExpense(groupId, userId, '2026-05-10', 'c');
    sheetRows = [sheetRow('2026-05-10', 'c'), sheetRow('2026-05-10', 'c')];

    const result = await syncExpenses(groupId);

    expect(result.unchanged).toBe(1);
    expect(result.added).toHaveLength(1);
    expect(service.expenses.findByGroupId(groupId, 100)).toHaveLength(2);
  });

  test('only expenses of the spreadsheet year are candidates for deletion', async () => {
    const { groupId, userId } = connectedGroup();
    service.groupSpreadsheets.setYear(groupId, 2026, 'SHEET');
    dbExpense(groupId, userId, '2025-03-01', 'old year');
    dbExpense(groupId, userId, '2026-03-01', 'this year');
    sheetRows = [];

    const result = await syncExpenses(groupId);

    expect(result.deleted.map((e) => e.comment)).toEqual(['this year']);
    expect(service.expenses.findByGroupId(groupId, 100).map((e) => e.comment)).toEqual([
      'old year',
    ]);
  });

  test('creates missing categories once; skips empty and "Без категории"', async () => {
    const { groupId } = connectedGroup();
    sheetRows = [
      sheetRow('2026-05-10', 'a', 10, 'Новая'),
      sheetRow('2026-05-11', 'b', 10, 'Новая'),
      sheetRow('2026-05-12', 'c', 10, 'Без категории'),
      sheetRow('2026-05-13', 'd', 10, ''),
    ];

    const result = await syncExpenses(groupId);

    expect(result.createdCategories).toEqual(['Новая']);
    expect(service.categories.exists(groupId, 'Новая')).toBe(true);
    expect(service.categories.exists(groupId, 'Без категории')).toBe(false);
  });

  test('throws when the group has no spreadsheet or token', async () => {
    const group = service.groups.create({ telegram_group_id: -9999 });
    await expect(syncExpenses(group.id)).rejects.toThrow('Group not configured for Google Sheets');
  });
});

describe('/sync report text', () => {
  const ctx = { text: '/sync' } as unknown as Ctx['Command'];
  const lastText = () => sendMessageMock.mock.calls.at(-1)?.[0] as string;

  test('lists each section; counts total as unchanged + added + updated; ends with the rollback hint', async () => {
    const { groupId, userId } = connectedGroup();
    dbExpense(groupId, userId, '2026-05-10', 'same');
    dbExpense(groupId, userId, '2026-05-11', 'x');
    dbExpense(groupId, userId, '2026-05-12', 'gone');
    sheetRows = [
      sheetRow('2026-05-10', 'same'),
      sheetRow('2026-05-11', 'y'),
      sheetRow('2026-05-13', 'fresh', 10, 'Новая'),
    ];

    await handleSyncCommand(ctx, { id: groupId } as unknown as GoogleConnectedGroup);

    expect(lastText()).toBe(
      '✅ Синхронизация завершена!\n\n' +
        '💾 Всего в БД: 3\n' +
        '✓ Без изменений: 1\n' +
        '\n➕ Добавлено: 1\n  2026-05-13 10 EUR Новая fresh\n' +
        '\n🗑 Удалено: 1\n  2026-05-12 10 EUR Еда gone\n' +
        '\n✏️ Обновлено: 1\n  2026-05-11 10 EUR Еда y ("x"→"y")\n' +
        '\n📁 Новые категории: Новая' +
        '\n\n<i>Если что-то пошло не так — /sync rollback</i>',
    );
  });

  test('without any prior expenses there is no rollback hint and no empty sections', async () => {
    const { groupId } = connectedGroup();
    sheetRows = [sheetRow('2026-05-10', '')];

    await handleSyncCommand(ctx, { id: groupId } as unknown as GoogleConnectedGroup);

    expect(lastText()).toBe(
      '✅ Синхронизация завершена!\n\n💾 Всего в БД: 1\n✓ Без изменений: 0\n' +
        '\n➕ Добавлено: 1\n  2026-05-10 10 EUR Еда',
    );
  });

  test('each section shows 10 rows and then "...и ещё N"', async () => {
    const { groupId } = connectedGroup();
    sheetRows = Array.from({ length: 12 }, (_, i) =>
      sheetRow(`2026-05-${String(i + 1).padStart(2, '0')}`, `n${i}`),
    );

    await handleSyncCommand(ctx, { id: groupId } as unknown as GoogleConnectedGroup);

    const text = lastText();
    expect(text).toContain('➕ Добавлено: 12');
    expect(text).toContain('n9\n');
    expect(text).not.toContain('n10');
    expect(text).toEndWith('  ...и ещё 2');
  });
});

describe('auto-sync notice', () => {
  function lastNotice(): { text: string; opts: unknown } {
    const call = sendMessageMock.mock.calls.at(-1);
    return { text: call?.[0] as string, opts: call?.[1] };
  }

  test('summarises counts, shows up to 10 rows per section and adds one button per overflow', async () => {
    const { groupId, userId } = connectedGroup();
    dbExpense(groupId, userId, '2026-04-01', 'removed');
    sheetRows = Array.from({ length: 11 }, (_, i) =>
      sheetRow(`2026-05-${String(i + 1).padStart(2, '0')}`, `n${i}`),
    );

    await ensureFreshExpenses(groupId, -100);

    const { text, opts } = lastNotice();
    expect(text.split('\n')[0]).toBe('🔄 Авто-синк расходов: +11, -1');
    expect(text).toContain('\n➕ Добавлено: 11\n');
    expect(text).toContain('n9');
    expect(text).not.toContain('n10');
    expect(text).toContain('\n🗑 Удалено: 1\n  2026-04-01 10 EUR Еда removed');
    const keyboard = (opts as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup
      .inline_keyboard;
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]).toEqual([
      {
        text: '➕ ещё 1 добавлено',
        callback_data: expect.stringMatching(/^sync_more:[a-z0-9]+:a$/),
      },
    ]);
  });

  test('updated rows show the changed field; no button when nothing overflows', async () => {
    const { groupId, userId } = connectedGroup();
    dbExpense(groupId, userId, '2026-05-10', 'x');
    sheetRows = [sheetRow('2026-05-10', 'y')];

    await ensureFreshExpenses(groupId, -100);

    const { text, opts } = lastNotice();
    expect(text).toBe(
      '🔄 Авто-синк расходов: ~1\n\n✏️ Обновлено: 1\n  2026-05-10 10 EUR Еда y ("x"→"y")',
    );
    expect(opts).toEqual({});
  });
});
