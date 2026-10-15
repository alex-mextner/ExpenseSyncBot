// syncExpenses and /sync against a real in-memory SQLite DB: rows that violate a foreign key
// are skipped, logged and reported instead of aborting the whole sheet → DB sync.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AgentContext } from '../../services/ai/types';
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

const sendMessageMock = mock(async (_text: string) => ({ message_id: 1 }));
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
const { executeTool } = await import('../../services/ai/tool-executor');

afterAll(() => db.close());

let nextTelegramGroupId = -1000;
function connectedGroup(): number {
  const telegramGroupId = nextTelegramGroupId--;
  const group = service.groups.create({ telegram_group_id: telegramGroupId });
  service.groups.update(telegramGroupId, { spreadsheet_id: 'SHEET', google_refresh_token: 'tok' });
  return group.id;
}

/** Inserts an expense whose user_id points at no user — stage DB state on 2026-10-14. */
function insertOrphanExpense(groupId: number, comment: string): number {
  db.exec('PRAGMA foreign_keys = OFF');
  const row = db
    .query<{ id: number }, [number, string]>(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, 999999, '2026-05-10', 'Еда', ?, 10, 'EUR', 10) RETURNING id`,
    )
    .get(groupId, comment);
  db.exec('PRAGMA foreign_keys = ON');
  if (!row) throw new Error('orphan insert returned no row');
  return row.id;
}

function sheetRow(comment: string, date = '2026-05-10'): SheetRow {
  return { date, amounts: { EUR: 10 }, eurAmount: 10, rate: null, category: 'Еда', comment };
}

beforeEach(() => {
  clearTestDb(db);
  sheetRows = [];
  logMock.warn.mockClear();
  logMock.error.mockClear();
});

describe('syncExpenses foreign-key violations', () => {
  test('an update of an expense owned by a missing user is skipped; the rest of the sheet syncs', async () => {
    const groupId = connectedGroup();
    const userId = service.users.create({ telegram_id: Date.now(), group_id: groupId }).id;
    const orphanId = insertOrphanExpense(groupId, 'old comment');
    sheetRows = [sheetRow('new comment'), sheetRow('fresh', '2026-05-11')];

    const result = await syncExpenses(groupId);

    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([
      { date: '2026-05-10', amount: 10, currency: 'EUR', category: 'Еда', comment: 'new comment' },
    ]);
    expect(result.added.map((e) => e.comment)).toEqual(['fresh']);
    // The failed re-insert rolled back with its delete: the original row is still there.
    const stored = service.expenses.findByGroupId(groupId, 100);
    expect(stored.find((e) => e.id === orphanId)?.comment).toBe('old comment');
    expect(stored.find((e) => e.comment === 'fresh')?.user_id).toBe(userId);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn.mock.calls[0]?.[1]).toContain('foreign key');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  // users.id is global and the FK does not check group_id: a fallback to user 1 would hand the
  // expense to another group's user whenever one exists.
  test("a new row in a group without users is skipped, never given another group's user 1", async () => {
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'users'");
    const otherGroupId = connectedGroup();
    const otherUser = service.users.create({ telegram_id: Date.now(), group_id: otherGroupId });
    expect(otherUser.id).toBe(1);
    const groupId = connectedGroup();
    sheetRows = [sheetRow('no owner')];

    const result = await syncExpenses(groupId);

    expect(result.added).toEqual([]);
    expect(result.skipped.map((e) => e.comment)).toEqual(['no owner']);
    expect(service.expenses.findByGroupId(groupId, 100)).toEqual([]);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe('sync reports name the skipped rows', () => {
  function groupWithOrphan(): number {
    const groupId = connectedGroup();
    service.users.create({ telegram_id: Date.now(), group_id: groupId });
    insertOrphanExpense(groupId, 'old comment');
    sendMessageMock.mockClear();
    return groupId;
  }
  const sentText = () => sendMessageMock.mock.calls.map((c) => c[0]).join('\n');

  test('/sync lists them', async () => {
    const groupId = groupWithOrphan();
    sheetRows = [sheetRow('new comment')];

    await handleSyncCommand(
      { text: '/sync' } as unknown as Ctx['Command'],
      { id: groupId } as unknown as GoogleConnectedGroup,
    );

    expect(sentText()).toContain('Пропущено (нет автора в базе): 1');
    expect(sentText()).toContain('2026-05-10 10 EUR Еда new comment');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('the auto-sync notice lists them next to the applied changes', async () => {
    const groupId = groupWithOrphan();
    sheetRows = [sheetRow('new comment'), sheetRow('fresh', '2026-05-11')];

    await ensureFreshExpenses(groupId, -100);

    expect(sentText()).toContain('➕ Добавлено: 1');
    expect(sentText()).toContain('Пропущено (нет автора в базе): 1');
    expect(sentText()).toContain('2026-05-10 10 EUR Еда new comment');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  // The orphaned row is skipped again on every auto-sync; alone it must not post a notice each time.
  test('auto-sync with only skipped rows posts nothing', async () => {
    const groupId = groupWithOrphan();
    sheetRows = [sheetRow('new comment')];

    await ensureFreshExpenses(groupId, -100);

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  test('the AI sync tool reports them instead of a plain "Sync complete"', async () => {
    const groupId = groupWithOrphan();
    sheetRows = [sheetRow('new comment')];

    const result = await executeTool('sync_from_sheets', {}, {
      groupId,
    } as unknown as AgentContext);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Skipped: 1');
    expect(result.output).toContain('2026-05-10 10 EUR Еда new comment');
  });

  test('the AI sync tool caps the skipped list (it goes into the model context)', async () => {
    const groupId = connectedGroup(); // no users → every new row is skipped
    sheetRows = Array.from({ length: 15 }, (_, i) => sheetRow(`row ${i}`, `2026-05-${10 + i}`));

    const result = await executeTool('sync_from_sheets', {}, {
      groupId,
    } as unknown as AgentContext);

    expect(result.output).toContain('Skipped: 15');
    expect(result.output).toContain('row 9');
    expect(result.output).not.toContain('row 10');
    expect(result.output).toContain('…and 5 more');
  });

  test('the AI sync tool caps each skipped row, whatever cell is long', async () => {
    const groupId = connectedGroup(); // no users → every new row is skipped
    sheetRows = [{ ...sheetRow('c'), category: 'x'.repeat(5000) }];

    const result = await executeTool('sync_from_sheets', {}, {
      groupId,
    } as unknown as AgentContext);

    expect(result.output).toContain('Skipped: 1');
    expect(result.output?.length).toBeLessThan(500);
  });
});
