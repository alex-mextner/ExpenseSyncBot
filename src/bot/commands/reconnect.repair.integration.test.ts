// Integration tests for auditAndRepairSpreadsheets — wires the real DB
// (in-memory SQLite + production repositories) against a fully-mocked
// googleapis client. Verifies the orchestrator end-to-end: per-year audit,
// selective recreate, DB pointer updates, year-scoped data copy.

import type { Database as SqliteDb } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { database } from '../../database';
import { BudgetRepository } from '../../database/repositories/budget.repository';
import { ExpenseRepository } from '../../database/repositories/expense.repository';
import { GroupRepository } from '../../database/repositories/group.repository';
import { GroupSpreadsheetRepository } from '../../database/repositories/group-spreadsheet.repository';
import { UserRepository } from '../../database/repositories/user.repository';
import { clearTestDb, createTestDb } from '../../test-utils/db';

// ── Mock googleapis at the network boundary ───────────────────────────────────

interface ValuesGetResponse {
  data: { values: unknown[][] };
}

const mockSpreadsheetsGet = mock(
  async (_args: { spreadsheetId: string }): Promise<{ data: unknown }> => ({ data: {} }),
);
const mockSpreadsheetsCreate = mock(
  async (_args: unknown): Promise<{ data: { spreadsheetId: string; spreadsheetUrl: string } }> => ({
    data: { spreadsheetId: 'NEW', spreadsheetUrl: 'https://docs.google.com/d/NEW' },
  }),
);
const mockSpreadsheetsBatchUpdate = mock(
  async (_args: unknown): Promise<{ data: Record<string, never> }> => ({ data: {} }),
);
const mockValuesGet = mock(
  async (_args: unknown): Promise<ValuesGetResponse> => ({ data: { values: [[]] } }),
);
const mockValuesAppend = mock(
  async (
    _args: unknown,
  ): Promise<{ data: { updates: { updatedRange: string; updatedRows: number } } }> => ({
    data: { updates: { updatedRange: 'Expenses!A2:F2', updatedRows: 1 } },
  }),
);
const mockValuesUpdate = mock(
  async (_args: unknown): Promise<{ data: Record<string, never> }> => ({ data: {} }),
);
const mockValuesBatchUpdate = mock(
  async (_args: unknown): Promise<{ data: Record<string, never> }> => ({ data: {} }),
);

const mockSheetsClient = {
  spreadsheets: {
    get: mockSpreadsheetsGet,
    create: mockSpreadsheetsCreate,
    batchUpdate: mockSpreadsheetsBatchUpdate,
    values: {
      get: mockValuesGet,
      append: mockValuesAppend,
      update: mockValuesUpdate,
      batchUpdate: mockValuesBatchUpdate,
    },
  },
};

mock.module('googleapis', () => ({
  google: {
    sheets: () => mockSheetsClient,
    // drive() — used only by backupSpreadsheet, which we don't exercise here
    drive: () => ({ files: { copy: mock(async () => ({ data: { id: 'BACKUP' } })) } }),
  },
}));

// ── Mock outbound side effects we don't care about ───────────────────────────

mock.module('./oauth', () => ({
  getAuthenticatedClient: () => ({}),
  isTokenExpiredError: () => false,
}));

mock.module('../../services/google/oauth', () => ({
  generateAuthUrl: () => 'https://oauth-fake-url',
  getAuthenticatedClient: () => ({}),
  isTokenExpiredError: () => false,
}));

mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: mock(async () => null),
  withChatContext: async <T>(_chatId: number, _threadId: number | null, fn: () => Promise<T>) =>
    fn(),
  editMessageText: mock(async () => {}),
  sendDirect: mock(async () => null),
}));

// Import after mocks are wired
const { auditAndRepairSpreadsheets } = await import('./reconnect');

// ── Test infrastructure ──────────────────────────────────────────────────────

let db: SqliteDb;
let groups: GroupRepository;
let groupSpreadsheets: GroupSpreadsheetRepository;
let expenses: ExpenseRepository;
let budgets: BudgetRepository;
let users: UserRepository;

beforeAll(() => {
  db = createTestDb();
  groups = new GroupRepository(db);
  groupSpreadsheets = new GroupSpreadsheetRepository(db);
  expenses = new ExpenseRepository(db);
  budgets = new BudgetRepository(db);
  users = new UserRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);

  // Reset all googleapis mocks to default OK behavior.
  mockSpreadsheetsGet.mockReset().mockResolvedValue({ data: {} });
  mockSpreadsheetsCreate.mockReset();
  mockSpreadsheetsBatchUpdate.mockReset().mockResolvedValue({ data: {} });
  mockValuesGet.mockReset().mockResolvedValue({ data: { values: [[]] } });
  mockValuesAppend.mockReset().mockResolvedValue({
    data: { updates: { updatedRange: 'Expenses!A2:F2', updatedRows: 1 } },
  });
  mockValuesUpdate.mockReset().mockResolvedValue({ data: {} });
  mockValuesBatchUpdate.mockReset().mockResolvedValue({ data: {} });

  // Wire the global `database` singleton through our in-memory repos. The
  // production code uses `database.X` everywhere; spyOn forwards each call
  // to our test repos so production code stays unmodified.
  spyOn(database.groups, 'findById').mockImplementation((id) => groups.findById(id));
  spyOn(database.groupSpreadsheets, 'listAll').mockImplementation((id) =>
    groupSpreadsheets.listAll(id),
  );
  spyOn(database.groupSpreadsheets, 'setYear').mockImplementation((g, y, s) =>
    groupSpreadsheets.setYear(g, y, s),
  );
  spyOn(database.groupSpreadsheets, 'getByYear').mockImplementation((g, y) =>
    groupSpreadsheets.getByYear(g, y),
  );
  spyOn(database.expenses, 'findByGroupId').mockImplementation((id, limit) =>
    expenses.findByGroupId(id, limit),
  );
  spyOn(database.budgets, 'findByGroupId').mockImplementation((id) => budgets.findByGroupId(id));
});

// Default Expenses-tab headers used when the "new spreadsheet" is read by
// appendExpenseRows to discover its column order.
const DEFAULT_HEADERS = [
  'Дата',
  'Категория',
  'Комментарий',
  'EUR (calc)',
  'RSD (дин.)',
  'EUR (€)',
  'Rate (→EUR)',
];

function seedGroupWithSpreadsheets(spec: {
  telegramId: number;
  spreadsheets: { year: number; id: string }[];
}): { group: ReturnType<GroupRepository['findById']>; userId: number } {
  const group = groups.create({ telegram_group_id: spec.telegramId });
  groups.update(spec.telegramId, {
    google_refresh_token: 'enc:test-token',
    enabled_currencies: ['RSD', 'EUR'],
  });
  // expenses.create() requires a real user_id (FK constraint)
  const user = users.create({ telegram_id: 1000 + spec.telegramId, group_id: group.id });
  for (const s of spec.spreadsheets) {
    groupSpreadsheets.setYear(group.id, s.year, s.id);
  }
  return { group: groups.findById(group.id), userId: user.id };
}

function makeNotFoundError(id: string) {
  return {
    code: 404,
    response: {
      data: {
        error: {
          code: 404,
          errors: [{ reason: 'notFound', message: `File not found: ${id}.` }],
        },
      },
    },
  };
}

describe('auditAndRepairSpreadsheets — integration', () => {
  test('returns empty audit when group has no registered spreadsheets', async () => {
    const group = groups.create({ telegram_group_id: -100100 });
    groups.update(-100100, { google_refresh_token: 'tok' });
    const fresh = groups.findById(group.id);
    if (!fresh) throw new Error('group seed failed');

    const result = await auditAndRepairSpreadsheets(fresh);

    expect(result.audit).toEqual([]);
    expect(result.recreated).toEqual([]);
    expect(mockSpreadsheetsGet).not.toHaveBeenCalled();
  });

  test('returns empty when group has no Google token (silent skip)', async () => {
    const group = groups.create({ telegram_group_id: -100200 });
    groupSpreadsheets.setYear(group.id, 2025, 'old-id');
    const fresh = groups.findById(group.id);
    if (!fresh) throw new Error('group seed failed');

    const result = await auditAndRepairSpreadsheets(fresh);

    expect(result.audit).toEqual([]);
    expect(result.recreated).toEqual([]);
    expect(mockSpreadsheetsGet).not.toHaveBeenCalled();
  });

  test('all years accessible — reports ok, recreates nothing', async () => {
    const { group } = seedGroupWithSpreadsheets({
      telegramId: -100300,
      spreadsheets: [
        { year: 2025, id: 'OK-2025' },
        { year: 2026, id: 'OK-2026' },
      ],
    });
    if (!group) throw new Error('group seed failed');

    // Default mockSpreadsheetsGet returns OK for any ID
    const result = await auditAndRepairSpreadsheets(group);

    expect(result.audit).toHaveLength(2);
    expect(result.audit.every((a) => a.status === 'ok')).toBe(true);
    expect(result.recreated).toHaveLength(0);
    expect(mockSpreadsheetsGet).toHaveBeenCalledTimes(2);
    expect(mockSpreadsheetsCreate).not.toHaveBeenCalled();
  });

  test('one year lost — only that year is recreated, the other untouched', async () => {
    const { group, userId } = seedGroupWithSpreadsheets({
      telegramId: -100400,
      spreadsheets: [
        { year: 2025, id: 'OK-2025' },
        { year: 2026, id: 'LOST-2026' },
      ],
    });
    if (!group) throw new Error('group seed failed');

    // Seed expenses: one in 2025, two in 2026 — only 2026 should be migrated
    expenses.create({
      group_id: group.id,
      user_id: userId,
      date: '2025-12-31',
      category: 'Old',
      comment: '',
      amount: 100,
      currency: 'RSD',
      eur_amount: 0.85,
    });
    expenses.create({
      group_id: group.id,
      user_id: userId,
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Ноут',
      amount: 41000,
      currency: 'RSD',
      eur_amount: 348.5,
    });
    expenses.create({
      group_id: group.id,
      user_id: userId,
      date: '2026-04-16',
      category: 'Еда',
      comment: 'Pizza',
      amount: 1000,
      currency: 'RSD',
      eur_amount: 8.5,
    });

    // googleapis: 404 for LOST-2026, OK for everyone else
    mockSpreadsheetsGet.mockImplementation(async ({ spreadsheetId }) => {
      if (spreadsheetId === 'LOST-2026') throw makeNotFoundError(spreadsheetId);
      return { data: { sheets: [{ properties: { title: 'Expenses', sheetId: 0 } }] } };
    });

    // Sheets API for the new spreadsheet creation
    mockSpreadsheetsCreate.mockResolvedValue({
      data: { spreadsheetId: 'NEW-2026', spreadsheetUrl: 'https://docs.google.com/d/NEW-2026' },
    });
    // appendExpenseRows reads Expenses!1:1 first to discover headers
    mockValuesGet.mockResolvedValue({ data: { values: [DEFAULT_HEADERS] } });

    const result = await auditAndRepairSpreadsheets(group);

    // Audit found one lost
    expect(result.audit).toHaveLength(2);
    const audit2025 = result.audit.find((a) => a.year === 2025);
    const audit2026 = result.audit.find((a) => a.year === 2026);
    expect(audit2025?.status).toBe('ok');
    expect(audit2026?.status).toBe('not_found');

    // Only the lost year was recreated
    expect(result.recreated).toHaveLength(1);
    expect(result.recreated[0]?.year).toBe(2026);
    expect(result.recreated[0]?.oldSpreadsheetId).toBe('LOST-2026');
    expect(result.recreated[0]?.newSpreadsheetId).toBe('NEW-2026');
    expect(result.recreated[0]?.expensesCopied).toBe(2); // only 2026 expenses

    // DB pointer updated for 2026, untouched for 2025
    expect(groupSpreadsheets.getByYear(group.id, 2025)).toBe('OK-2025');
    expect(groupSpreadsheets.getByYear(group.id, 2026)).toBe('NEW-2026');

    // Exactly one new spreadsheet created
    expect(mockSpreadsheetsCreate).toHaveBeenCalledTimes(1);

    // Append happened on the new spreadsheet, with only 2026 rows
    const appendCalls = mockValuesAppend.mock.calls;
    expect(appendCalls.length).toBeGreaterThan(0);
    // Find the append targeting NEW-2026
    const appendToNewSheet = appendCalls.find(
      (c) => (c[0] as { spreadsheetId?: string })?.spreadsheetId === 'NEW-2026',
    );
    expect(appendToNewSheet).toBeDefined();
    const appendArgs = appendToNewSheet?.[0] as {
      requestBody: { values: unknown[][] };
    };
    expect(appendArgs.requestBody.values).toHaveLength(2); // 2 expenses for 2026
  });

  test('all years lost — every year recreated, each with own data', async () => {
    const { group, userId } = seedGroupWithSpreadsheets({
      telegramId: -100500,
      spreadsheets: [
        { year: 2025, id: 'LOST-2025' },
        { year: 2026, id: 'LOST-2026' },
      ],
    });
    if (!group) throw new Error('group seed failed');

    expenses.create({
      group_id: group.id,
      user_id: userId,
      date: '2025-06-01',
      category: 'A',
      comment: '',
      amount: 50,
      currency: 'RSD',
      eur_amount: 0.4,
    });
    expenses.create({
      group_id: group.id,
      user_id: userId,
      date: '2026-04-15',
      category: 'B',
      comment: '',
      amount: 200,
      currency: 'RSD',
      eur_amount: 1.7,
    });

    mockSpreadsheetsGet.mockImplementation(async ({ spreadsheetId }) => {
      if (spreadsheetId.startsWith('LOST-')) throw makeNotFoundError(spreadsheetId);
      return { data: { sheets: [{ properties: { title: 'Expenses', sheetId: 0 } }] } };
    });

    let createCount = 0;
    mockSpreadsheetsCreate.mockImplementation(async () => {
      createCount++;
      return {
        data: {
          spreadsheetId: `NEW-${createCount}`,
          spreadsheetUrl: `https://docs.google.com/d/NEW-${createCount}`,
        },
      };
    });
    mockValuesGet.mockResolvedValue({ data: { values: [DEFAULT_HEADERS] } });

    const result = await auditAndRepairSpreadsheets(group);

    expect(result.recreated).toHaveLength(2);
    // Each year gets its own new spreadsheet ID
    const new2025 = result.recreated.find((r) => r.year === 2025);
    const new2026 = result.recreated.find((r) => r.year === 2026);
    expect(new2025?.expensesCopied).toBe(1);
    expect(new2026?.expensesCopied).toBe(1);
    expect(new2025?.newSpreadsheetId).not.toBe(new2026?.newSpreadsheetId);

    // Both DB pointers updated
    expect(groupSpreadsheets.getByYear(group.id, 2025)).toMatch(/^NEW-/);
    expect(groupSpreadsheets.getByYear(group.id, 2026)).toMatch(/^NEW-/);
    expect(groupSpreadsheets.getByYear(group.id, 2025)).not.toBe(
      groupSpreadsheets.getByYear(group.id, 2026),
    );

    expect(mockSpreadsheetsCreate).toHaveBeenCalledTimes(2);
  });

  test('partial failure — first year recreated, second fails, DB reflects committed work only', async () => {
    const { group } = seedGroupWithSpreadsheets({
      telegramId: -100600,
      spreadsheets: [
        { year: 2025, id: 'LOST-2025' },
        { year: 2026, id: 'LOST-2026' },
      ],
    });
    if (!group) throw new Error('group seed failed');

    mockSpreadsheetsGet.mockImplementation(async ({ spreadsheetId }) => {
      if (spreadsheetId.startsWith('LOST-')) throw makeNotFoundError(spreadsheetId);
      return { data: { sheets: [{ properties: { title: 'Expenses', sheetId: 0 } }] } };
    });

    let createCount = 0;
    mockSpreadsheetsCreate.mockImplementation(async () => {
      createCount++;
      if (createCount === 1) {
        return {
          data: {
            spreadsheetId: 'NEW-2025-ok',
            spreadsheetUrl: 'https://docs.google.com/d/NEW-2025-ok',
          },
        };
      }
      throw new Error('Drive API quota exceeded');
    });
    mockValuesGet.mockResolvedValue({ data: { values: [DEFAULT_HEADERS] } });

    await expect(auditAndRepairSpreadsheets(group)).rejects.toThrow('Drive API quota exceeded');

    // First (2025) succeeded — DB pointer updated
    // Note: audits are sorted year DESC by listAll, so 2026 is processed first
    // and 2025 second. But the deterministic detail is: when one succeeds and
    // one fails, only the successful one updates the DB.
    const updated2025 = groupSpreadsheets.getByYear(group.id, 2025);
    const updated2026 = groupSpreadsheets.getByYear(group.id, 2026);
    // Exactly one of them should still be 'LOST-...' — the one that failed
    const lostCount = [updated2025, updated2026].filter((id) => id?.startsWith('LOST-')).length;
    const newCount = [updated2025, updated2026].filter((id) => id === 'NEW-2025-ok').length;
    expect(lostCount).toBe(1);
    expect(newCount).toBe(1);
  });
});
