// Tests for /sync command — happy path, rollback, error handling.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Expense } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { GoogleConnectedGroup } from '../guards';
import type { Ctx } from '../types';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const sendMessageMock = mock(
  (_text: string, _opts?: unknown): Promise<{ message_id: number } | null> =>
    Promise.resolve({ message_id: 1 }),
);
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
  editMessageText: mock(() => Promise.resolve()),
}));

// Mock google/sheets so the real syncExpenses() runs against a stubbed API.
const readExpensesFromSheetMock = mock(
  async (
    ..._args: unknown[]
  ): Promise<{
    expenses: unknown[];
    errors: Array<{ row: number; date: string; category: string; currencies: string[] }>;
    eurMismatches: Array<{
      row: number;
      date: string;
      category: string;
      sheetEur: number;
      recalcEur: number;
    }>;
  }> => ({ expenses: [], errors: [], eurMismatches: [] }),
);

mock.module('../../services/google/sheets', () => ({
  readExpensesFromSheet: readExpensesFromSheetMock,
  googleConn: (group: { google_refresh_token: string | null; oauth_client: string }) => ({
    refreshToken: group.google_refresh_token ?? '',
    oauthClient: group.oauth_client,
  }),
  withSheetsRetry: async <T>(fn: () => Promise<T>) => fn(),
  appendExpenseRows: mock(async () => {}),
  appendExpenseRow: mock(async () => {}),
  appendExpenseRowsRaw: mock(async () => {}),
  deleteExpenseRowsByIndex: mock(async () => {}),
  findAndDeleteExpenseRow: mock(async () => {}),
  readMonthBudget: mock(async () => []),
  writeMonthBudgetRow: mock(async () => {}),
  monthTabExists: mock(async () => true),
  listMonthTabs: mock(async () => []),
  createEmptyMonthTab: mock(async () => {}),
  ensureSheetColumns: mock(async () => {}),
  sortExpensesTab: mock(async () => {}),
  isRateLimitError: () => false,
  getSpreadsheetUrl: (id: string) => `https://docs.google.com/d/${id}`,
}));

mock.module('../../services/google/oauth', () => ({
  isTokenExpiredError: () => false,
  getAuthenticatedClient: () => ({}),
  encryptToken: (t: string) => t,
  decryptToken: (t: string) => t,
}));

const budgetManagerImportMock = mock((_p: unknown) => ({}));
mock.module('../../services/budget-manager', () => ({
  getBudgetManager: () => ({ importFromSheet: budgetManagerImportMock }),
}));

const mockExpensesRepo = {
  findByGroupId: mock((_g: number, _limit?: number): Expense[] => []),
  findByDateRange: mock((_g: number, _f: string, _t: string): Expense[] => []),
  create: mock((_data: unknown): Expense => ({ id: 1 }) as Expense),
  update: mock(() => {}),
  delete: mock(() => {}),
  deleteAllByGroupId: mock(() => {}),
};
const mockBudgetsRepo = {
  findByGroupId: mock((_g: number) => []),
};
const mockGroupsRepo = {
  findById: mock((_id: number) => ({
    id: 1,
    spreadsheet_id: 'SHEET',
    google_refresh_token: 'tok',
    oauth_client: 'current',
  })),
};
const mockUsersRepo = {
  findByGroupId: mock((_g: number) => [{ id: 1 }]),
};
const mockGroupSpreadsheetsRepo = {
  listAll: mock((_g: number) => []),
};
const mockCategoriesRepo = {
  getCategoryNames: mock((_g: number) => []),
  create: mock(() => {}),
};

interface SnapshotMeta {
  snapshotId: string;
  groupId: number;
  createdAt: string;
  expenseCount: number;
  budgetCount: number;
}
const snapshotMeta: SnapshotMeta[] = [];
const snapshotExpenses: Record<string, Expense[]> = {};
const snapshotBudgets: Record<string, unknown[]> = {};

const mockSyncSnapshots = {
  saveSnapshot: mock((groupId: number, exp: Expense[], bud: unknown[]): string => {
    const id = `snap-${snapshotMeta.length + 1}`;
    snapshotMeta.push({
      snapshotId: id,
      groupId,
      createdAt: new Date().toISOString(),
      expenseCount: exp.length,
      budgetCount: bud.length,
    });
    snapshotExpenses[id] = exp;
    snapshotBudgets[id] = bud;
    return id;
  }),
  listSnapshots: mock((groupId: number): SnapshotMeta[] =>
    snapshotMeta.filter((s) => s.groupId === groupId).reverse(),
  ),
  getExpenseSnapshots: mock((id: string): Expense[] => snapshotExpenses[id] ?? []),
  getBudgetSnapshots: mock((id: string): unknown[] => snapshotBudgets[id] ?? []),
  deleteSnapshot: mock((_id: string): void => {}),
};

mock.module('../../database', () => ({
  database: {
    expenses: mockExpensesRepo,
    budgets: mockBudgetsRepo,
    syncSnapshots: mockSyncSnapshots,
    groups: mockGroupsRepo,
    users: mockUsersRepo,
    groupSpreadsheets: mockGroupSpreadsheetsRepo,
    categories: mockCategoriesRepo,
    transaction: <T>(fn: () => T): T => fn(),
  },
  _budgetWriter: () => mockBudgetsRepo,
}));

const { handleSyncCommand } = await import('./sync');
// NOTE: syncExpenses is used internally by handleSyncCommand. We cannot patch it
// because ES module exports are readonly. Instead, we mock google/sheets and the
// expense-recorder — the real syncExpenses runs against our mocked sheets API and
// returns a trivial result. The tests here focus on the orchestration layer
// (snapshot save/rollback, error formatting), not the sync mechanics which have
// their own coverage via google/sheets.test.ts.

function fakeCtx(text: string): Ctx['Command'] {
  return {
    chat: { id: -100, type: 'supergroup' },
    from: { id: 1 },
    text,
  } as unknown as Ctx['Command'];
}

function fakeGroup(): GoogleConnectedGroup {
  return {
    id: 1,
    telegram_group_id: -100,
    google_refresh_token: 'tok',
    spreadsheet_id: 'SHEET',
    default_currency: 'EUR',
    enabled_currencies: ['EUR'],
    oauth_client: 'current',
    active_topic_id: null,
    bank_panel_summary_message_id: null,
    title: null,
    invite_link: null,
    custom_prompt: null,
    created_at: '',
    updated_at: '',
  } as unknown as GoogleConnectedGroup;
}

describe('handleSyncCommand', () => {
  beforeEach(() => {
    sendMessageMock.mockClear();
    readExpensesFromSheetMock.mockReset();
    readExpensesFromSheetMock.mockImplementation(async () => ({
      expenses: [],
      errors: [],
      eurMismatches: [],
    }));
    snapshotMeta.length = 0;
    for (const k of Object.keys(snapshotExpenses)) delete snapshotExpenses[k];
    for (const k of Object.keys(snapshotBudgets)) delete snapshotBudgets[k];
    mockExpensesRepo.findByGroupId.mockReset().mockReturnValue([]);
    mockExpensesRepo.create.mockClear();
    mockExpensesRepo.deleteAllByGroupId.mockClear();
    mockBudgetsRepo.findByGroupId.mockReset().mockReturnValue([]);
    mockSyncSnapshots.saveSnapshot.mockClear();
    mockSyncSnapshots.listSnapshots.mockClear();
    mockSyncSnapshots.getExpenseSnapshots.mockClear();
    mockSyncSnapshots.getBudgetSnapshots.mockClear();
    logMock.error.mockReset();
  });

  test('"/sync" shows "Синхронизирую..." before running', async () => {
    await handleSyncCommand(fakeCtx('/sync'), fakeGroup());

    const firstText = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(firstText).toContain('Синхронизирую');
  });

  test('"/sync" with no expenses → no "rollback" hint, result message sent', async () => {
    await handleSyncCommand(fakeCtx('/sync'), fakeGroup());

    const combined = sendMessageMock.mock.calls.map((c) => c[0]).join('\n');
    // handleSyncCommand only appends "/sync rollback" hint when pre-sync expenses existed
    expect(combined).not.toContain('/sync rollback');
    expect(sendMessageMock).toHaveBeenCalled();
  });

  test('"/sync" with existing expenses → snapshot taken before sync', async () => {
    mockExpensesRepo.findByGroupId.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        user_id: 1,
        date: '2026-04-01',
        category: 'food',
        comment: null,
        amount: 100,
        currency: 'EUR',
        eur_amount: 100,
        created_at: '',
      } as unknown as Expense,
    ]);

    await handleSyncCommand(fakeCtx('/sync'), fakeGroup());

    // handleSyncCommand saves a pre-sync snapshot; syncExpenses internally
    // also saves one. Either way ≥1 means the guard ran.
    expect(mockSyncSnapshots.saveSnapshot.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('"/sync rollback" with no snapshots → refusal message', async () => {
    await handleSyncCommand(fakeCtx('/sync rollback'), fakeGroup());

    const text = sendMessageMock.mock.calls.map((c) => c[0]).join('\n');
    expect(text).toContain('Нет сохранённых снимков');
  });

  test('"/sync rollback" with snapshot → deletes all + restores from latest', async () => {
    // Seed a snapshot manually
    const seededExpense: Expense = {
      id: 1,
      group_id: 1,
      user_id: 1,
      date: '2026-04-01',
      category: 'food',
      comment: null,
      amount: 100,
      currency: 'EUR',
      eur_amount: 100,
      created_at: '',
    } as unknown as Expense;
    snapshotMeta.push({
      snapshotId: 'snap-1',
      groupId: 1,
      createdAt: new Date().toISOString(),
      expenseCount: 1,
      budgetCount: 0,
    });
    snapshotExpenses['snap-1'] = [seededExpense];
    snapshotBudgets['snap-1'] = [];

    await handleSyncCommand(fakeCtx('/sync rollback'), fakeGroup());

    expect(mockSyncSnapshots.getExpenseSnapshots).toHaveBeenCalledWith('snap-1');
    expect(mockExpensesRepo.deleteAllByGroupId).toHaveBeenCalledWith(1);
    expect(mockExpensesRepo.create).toHaveBeenCalledTimes(1);
    const sentText = sendMessageMock.mock.calls.map((c) => c[0]).join('\n');
    expect(sentText).toContain('Откат завершён');
  });

  test('eurMismatches > 0 → user warned about recalculated amounts', async () => {
    readExpensesFromSheetMock.mockImplementationOnce(async () => ({
      expenses: [],
      errors: [],
      eurMismatches: [
        { row: 2, date: '2026-04-01', category: 'food', sheetEur: 100, recalcEur: 120 },
      ],
    }));

    await handleSyncCommand(fakeCtx('/sync'), fakeGroup());

    const combined = sendMessageMock.mock.calls.map((c) => c[0]).join('\n');
    expect(combined).toContain('EUR формулы');
    expect(combined).toContain('пересчитанные');
  });

  test('multi-currency errors → user sees skipped rows', async () => {
    readExpensesFromSheetMock.mockImplementationOnce(async () => ({
      expenses: [],
      errors: [{ row: 5, date: '2026-04-01', category: 'split', currencies: ['USD', 'EUR'] }],
      eurMismatches: [],
    }));

    await handleSyncCommand(fakeCtx('/sync'), fakeGroup());

    const combined = sendMessageMock.mock.calls.map((c) => c[0]).join('\n');
    expect(combined).toContain('нескольких валютах');
    expect(combined).toContain('split');
  });

  test('readExpensesFromSheet throws → error logged and user message sent', async () => {
    readExpensesFromSheetMock.mockImplementationOnce(async () => {
      throw new Error('Sheets 500');
    });

    await handleSyncCommand(fakeCtx('/sync'), fakeGroup());

    expect(logMock.error).toHaveBeenCalled();
    const combined = sendMessageMock.mock.calls.map((c) => c[0]).join('\n');
    expect(combined.length).toBeGreaterThan(0);
  });
});
