import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Budget, Category, Expense, Group } from '../../database/types';
import { mockDatabase } from '../../test-utils/mocks/database';
import type { AgentContext } from './types';

// ── Mock database ────────────────────────────────────────────────────

const mockExpenses = {
  findByDateRange: mock((): Expense[] => []),
  findById: mock((): Expense | null => null),
  create: mock(() => ({ id: 42 })),
  delete: mock(() => true),
  deleteAllByGroupId: mock(() => 5),
};

const mockBudgets = {
  getAllBudgetsForMonth: mock((_groupId: number, _month: string): Budget[] => []),
  setBudget: mock(() => ({})),
  deleteByGroupCategoryMonth: mock(() => true),
  findByGroupCategoryMonth: mock((): Budget | null => null),
};

const mockCategories = {
  findByGroupId: mock((): Category[] => []),
  findByName: mock((): Category | null => null),
  getCategoryNames: mock(() => ['Food', 'Transport']),
  exists: mock(() => false),
  create: mock(() => ({ id: 1, group_id: 1, name: 'Food', created_at: '' })),
  delete: mock(() => true),
};

const mockGroups = {
  findById: mock((): Group | null => ({
    id: 1,
    telegram_group_id: 456,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR',
    enabled_currencies: ['EUR', 'USD'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'legacy' as const,
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
  })),
  update: mock(() => null),
};

const mockUsers = {
  findByGroupId: mock(() => []),
};

const mockBankTransactions = {
  findByGroupId: mock(() => [
    {
      id: 1,
      date: '2026-01-05',
      amount: 500,
      currency: 'RSD',
      merchant: 'Maxi',
      merchant_normalized: 'Maxi',
      status: 'confirmed',
      sign_type: 'debit',
      connection_id: 1,
    },
    {
      id: 2,
      date: '2026-01-10',
      amount: 1200,
      currency: 'RSD',
      merchant: 'Lidl',
      merchant_normalized: 'Lidl',
      status: 'pending',
      sign_type: 'debit',
      connection_id: 1,
    },
  ]),
  findUnmatched: mock(() => [
    {
      id: 10,
      date: '2026-01-12',
      amount: 350,
      currency: 'RSD',
      merchant: 'Unknown Shop',
      merchant_normalized: null,
      status: 'pending',
      sign_type: 'debit',
      connection_id: 1,
    },
  ]),
};

mock.module('../../database', () => ({
  database: mockDatabase({
    expenses: mockExpenses,
    budgets: mockBudgets,
    categories: mockCategories,
    groups: mockGroups,
    users: mockUsers,
    bankTransactions: mockBankTransactions,
  }),
}));

// Mock Google Sheets (used by sync/write tools)
mock.module('../google/sheets', () => ({
  readExpensesFromSheet: mock(() => Promise.resolve({ expenses: [], errors: [] })),
  appendExpenseRow: mock(() => Promise.resolve()),
  hasBudgetSheet: mock(() => Promise.resolve(false)),
  createBudgetSheet: mock(() => Promise.resolve()),
  writeBudgetRow: mock(() => Promise.resolve()),
  readBudgetData: mock(() => Promise.resolve([])),
}));

// Mock ExpenseRecorder (used by add_expense tool)
const mockRecord = mock(() => Promise.resolve({ expense: { id: 42 }, eurAmount: 25.5 }));
mock.module('../expense-recorder', () => ({
  getExpenseRecorder: () => ({ record: mockRecord }),
}));

// Mock BudgetManager (used by set_budget and delete_budget tools)
const mockBudgetManagerSet = mock(() => Promise.resolve({ sheetsSynced: false }));
const mockBudgetManagerDelete = mock(() => Promise.resolve({ sheetsSynced: false }));
mock.module('../budget-manager', () => ({
  getBudgetManager: () => ({
    set: mockBudgetManagerSet,
    delete: mockBudgetManagerDelete,
  }),
}));

// Mock budget sync — prevents dynamic import from pulling in sheets
mock.module('../../bot/services/budget-sync', () => ({
  ensureFreshBudgets: mock(() => Promise.resolve()),
  silentSyncBudgets: mock(() => Promise.resolve(0)),
}));

// Mock spending analytics — used by get_technical_analysis tool
// biome-ignore lint/suspicious/noExplicitAny: test mock returns partial FinancialSnapshot
const mockGetFinancialSnapshot = mock((): any => ({ technicalAnalysis: null }));
mock.module('../analytics/spending-analytics', () => ({
  spendingAnalytics: {
    getFinancialSnapshot: mockGetFinancialSnapshot,
  },
}));

// Import after mocks are set up
import { executeTool } from './tool-executor';

// ── Fixtures ─────────────────────────────────────────────────────────

const ctx: AgentContext = {
  groupId: 1,
  userId: 123,
  chatId: 456,
  userName: 'testuser',
  userFullName: 'Test User',
  customPrompt: null,
  telegramGroupId: 456,
};

// ── Helpers ──────────────────────────────────────────────────────────

function resetAllMocks() {
  mockExpenses.findByDateRange.mockReset();
  mockExpenses.findByDateRange.mockReturnValue([]);
  mockExpenses.findById.mockReset();
  mockExpenses.findById.mockReturnValue(null);
  mockExpenses.create.mockReset();
  mockExpenses.create.mockReturnValue({ id: 42 });
  mockExpenses.delete.mockReset();
  mockExpenses.delete.mockReturnValue(true);
  mockExpenses.deleteAllByGroupId.mockReset();
  mockExpenses.deleteAllByGroupId.mockReturnValue(5);

  mockBudgets.getAllBudgetsForMonth.mockReset();
  mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);
  mockBudgets.setBudget.mockReset();
  mockBudgets.deleteByGroupCategoryMonth.mockReset();
  mockBudgets.findByGroupCategoryMonth.mockReset();
  mockBudgets.findByGroupCategoryMonth.mockReturnValue(null);

  mockBudgetManagerSet.mockReset();
  mockBudgetManagerSet.mockReturnValue(Promise.resolve({ sheetsSynced: false }));
  mockBudgetManagerDelete.mockReset();
  mockBudgetManagerDelete.mockReturnValue(Promise.resolve({ sheetsSynced: false }));

  mockCategories.findByGroupId.mockReset();
  mockCategories.findByGroupId.mockReturnValue([]);
  mockCategories.findByName.mockReset();
  mockCategories.findByName.mockReturnValue(null);
  mockCategories.getCategoryNames.mockReset();
  mockCategories.getCategoryNames.mockReturnValue(['Food', 'Transport']);
  mockCategories.exists.mockReset();
  mockCategories.exists.mockReturnValue(false);
  mockCategories.create.mockReset();
  mockCategories.create.mockReturnValue({ id: 1, group_id: 1, name: 'Food', created_at: '' });
  mockCategories.delete.mockReset();
  mockCategories.delete.mockReturnValue(true);

  mockGroups.findById.mockReset();
  mockGroups.findById.mockReturnValue({
    id: 1,
    telegram_group_id: 456,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR',
    enabled_currencies: ['EUR', 'USD'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'legacy' as const,
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
  });
  mockGroups.update.mockReset();

  mockUsers.findByGroupId.mockReset();
  mockUsers.findByGroupId.mockReturnValue([]);

  mockBankTransactions.findByGroupId.mockReset();
  mockBankTransactions.findByGroupId.mockReturnValue([
    {
      id: 1,
      date: '2026-01-05',
      amount: 500,
      currency: 'RSD',
      merchant: 'Maxi',
      merchant_normalized: 'Maxi',
      status: 'confirmed',
      sign_type: 'debit',
      connection_id: 1,
    },
    {
      id: 2,
      date: '2026-01-10',
      amount: 1200,
      currency: 'RSD',
      merchant: 'Lidl',
      merchant_normalized: 'Lidl',
      status: 'pending',
      sign_type: 'debit',
      connection_id: 1,
    },
  ]);

  mockBankTransactions.findUnmatched.mockReset();
  mockBankTransactions.findUnmatched.mockReturnValue([
    {
      id: 10,
      date: '2026-01-12',
      amount: 350,
      currency: 'RSD',
      merchant: 'Unknown Shop',
      merchant_normalized: null,
      status: 'pending',
      sign_type: 'debit',
      connection_id: 1,
    },
  ]);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('executeTool routing', () => {
  beforeEach(resetAllMocks);

  test('routes get_expenses to correct handler', async () => {
    mockExpenses.findByDateRange.mockReturnValue([]);
    const result = await executeTool('get_expenses', {}, ctx);
    expect(result.success).toBe(true);
    expect(mockExpenses.findByDateRange).toHaveBeenCalled();
  });

  test('routes get_budgets to correct handler', async () => {
    const result = await executeTool('get_budgets', {}, ctx);
    expect(result.success).toBe(true);
    expect(mockBudgets.getAllBudgetsForMonth).toHaveBeenCalled();
  });

  test('routes get_categories to correct handler', async () => {
    mockCategories.findByGroupId.mockReturnValue([
      { id: 1, group_id: 1, name: 'Food', created_at: '' },
    ]);
    const result = await executeTool('get_categories', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Food');
  });

  test('returns error for unknown tool name', async () => {
    const result = await executeTool('unknown_tool', {}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  test('routes get_group_settings to correct handler', async () => {
    const result = await executeTool('get_group_settings', {}, ctx);
    expect(result.success).toBe(true);
    expect(mockGroups.findById).toHaveBeenCalledWith(1);
  });

  test('routes get_exchange_rates to correct handler', async () => {
    const result = await executeTool('get_exchange_rates', {}, ctx);
    expect(result.success).toBe(true);
    // formatExchangeRatesForAI returns a real string with rates
    expect(result.output).toBeDefined();
  });

  test('routes set_budget to correct handler', async () => {
    const result = await executeTool('set_budget', { category: 'Food', amount: 500 }, ctx);
    expect(result.success).toBe(true);
    expect(mockBudgetManagerSet).toHaveBeenCalled();
  });

  test('routes delete_expense to correct handler', async () => {
    mockExpenses.findById.mockReturnValue({
      id: 10,
      group_id: 1,
      user_id: 123,
      date: '2026-03-01',
      category: 'Food',
      comment: 'lunch',
      amount: 15,
      currency: 'EUR',
      eur_amount: 15,
      created_at: '',
    });
    const result = await executeTool('delete_expense', { expense_id: 10 }, ctx);
    expect(result.success).toBe(true);
    expect(mockExpenses.delete).toHaveBeenCalledWith(10);
  });
});

describe('executeGetExpenses', () => {
  beforeEach(resetAllMocks);

  test('returns formatted expense list', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        user_id: 123,
        date: '2026-03-01',
        category: 'Food',
        comment: 'lunch',
        amount: 15,
        currency: 'EUR',
        eur_amount: 15,
        created_at: '',
      },
      {
        id: 2,
        group_id: 1,
        user_id: 123,
        date: '2026-03-02',
        category: 'Transport',
        comment: '',
        amount: 5,
        currency: 'EUR',
        eur_amount: 5,
        created_at: '',
      },
    ]);

    const result = await executeTool('get_expenses', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('[id:1]');
    expect(result.output).toContain('Food');
    expect(result.output).toContain('[id:2]');
    expect(result.output).toContain('Transport');
    expect(result.output).toContain('Total: 2 expenses | Grand total:');
  });

  test('expense with no comment shows (no comment) in output', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        user_id: 123,
        date: '2026-03-14',
        category: 'Путешествия',
        comment: '',
        amount: 1149.47,
        currency: 'EUR',
        eur_amount: 1149.47,
        created_at: '',
      },
    ]);

    const result = await executeTool('get_expenses', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('(no comment)');
  });

  test('expense with whitespace-only comment shows (no comment) in output', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      {
        id: 2,
        group_id: 1,
        user_id: 123,
        date: '2026-03-14',
        category: 'Лена',
        comment: '   ',
        amount: 94.37,
        currency: 'EUR',
        eur_amount: 94.37,
        created_at: '',
      },
    ]);

    const result = await executeTool('get_expenses', {}, ctx);
    expect(result.output).toContain('(no comment)');
  });

  test('expense with real comment shows the comment', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      {
        id: 3,
        group_id: 1,
        user_id: 123,
        date: '2026-03-14',
        category: 'Еда',
        comment: 'обед',
        amount: 25,
        currency: 'EUR',
        eur_amount: 25,
        created_at: '',
      },
    ]);

    const result = await executeTool('get_expenses', {}, ctx);
    expect(result.output).toContain('обед');
    expect(result.output).not.toContain('(no comment)');
  });

  test('respects category filter (case-insensitive)', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        user_id: 123,
        date: '2026-03-01',
        category: 'Food',
        comment: 'pizza',
        amount: 10,
        currency: 'EUR',
        eur_amount: 10,
        created_at: '',
      },
      {
        id: 2,
        group_id: 1,
        user_id: 123,
        date: '2026-03-02',
        category: 'Transport',
        comment: 'taxi',
        amount: 20,
        currency: 'EUR',
        eur_amount: 20,
        created_at: '',
      },
    ]);

    const result = await executeTool('get_expenses', { category: 'food' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Food');
    expect(result.output).not.toContain('Transport');
    expect(result.output).toContain('Total: 1 expenses | Grand total:');
  });

  test('respects date range via period filter', async () => {
    mockExpenses.findByDateRange.mockReturnValue([]);

    await executeTool('get_expenses', { period: '2025-12' }, ctx);

    expect(mockExpenses.findByDateRange).toHaveBeenCalledWith(1, '2025-12-01', '2025-12-31');
  });

  test('paginates results with page and page_size', async () => {
    const expenses = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      group_id: 1,
      user_id: 123,
      date: '2026-03-01',
      category: 'Food',
      comment: `item ${i + 1}`,
      amount: 10,
      currency: 'EUR' as const,
      eur_amount: 10,
      created_at: '',
    }));
    mockExpenses.findByDateRange.mockReturnValue(expenses);

    const page1 = await executeTool('get_expenses', { page: 1 }, ctx);
    expect(page1.success).toBe(true);
    expect(page1.output).toContain('Total: 150 expenses | Grand total:');
    expect(page1.output).toContain('[id:1]');
    expect(page1.output).toContain('[id:100]');
    expect(page1.output).not.toContain('[id:101]');

    const page2 = await executeTool('get_expenses', { page: 2 }, ctx);
    expect(page2.success).toBe(true);
    expect(page2.output).toContain('Total: 150 expenses | Grand total:');
    expect(page2.output).toContain('[id:101]');
    expect(page2.output).toContain('[id:150]');
    expect(page2.output).not.toContain('[id:1]');
  });

  test('custom page_size works', async () => {
    const expenses = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      group_id: 1,
      user_id: 123,
      date: '2026-03-01',
      category: 'Food',
      comment: '',
      amount: 10,
      currency: 'EUR' as const,
      eur_amount: 10,
      created_at: '',
    }));
    mockExpenses.findByDateRange.mockReturnValue(expenses);

    const result = await executeTool('get_expenses', { page: 1, page_size: 10 }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Total: 30 expenses | Grand total:');
    expect(result.output).toContain('[id:10]');
    expect(result.output).not.toContain('[id:11]');
  });
});

describe('executeGetBudgets', () => {
  beforeEach(resetAllMocks);

  test('returns budget list for current month', async () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        category: 'Food',
        month: '2026-03',
        limit_amount: 500,
        currency: 'EUR',
        created_at: '',
        updated_at: '',
      },
    ]);
    // Expenses for spending calculation
    mockExpenses.findByDateRange.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        user_id: 123,
        date: '2026-03-05',
        category: 'Food',
        comment: '',
        amount: 100,
        currency: 'EUR',
        eur_amount: 100,
        created_at: '',
      },
    ]);

    const result = await executeTool('get_budgets', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Food');
    expect(result.output).toContain('500.00');
    expect(result.output).toContain('EUR');
  });

  test('returns message when no budgets', async () => {
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);

    const result = await executeTool('get_budgets', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('No budgets set');
  });
});

describe('get_budgets batch', () => {
  beforeEach(() => {
    resetAllMocks();
    mockBudgets.getAllBudgetsForMonth.mockImplementation((_groupId: number, month: string) => [
      {
        id: 1,
        group_id: 1,
        category: 'Еда',
        month,
        limit_amount: 50000,
        currency: 'RSD',
        created_at: '',
        updated_at: '',
      },
      {
        id: 2,
        group_id: 1,
        category: 'Развлечения',
        month,
        limit_amount: 30000,
        currency: 'RSD',
        created_at: '',
        updated_at: '',
      },
    ]);
  });

  test('single month works as before', async () => {
    const result = await executeTool('get_budgets', { month: '2026-01' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Budgets for 2026-01');
  });

  test('multiple months shows per-month breakdown', async () => {
    const result = await executeTool(
      'get_budgets',
      { month: ['2026-01', '2026-02', '2026-03'] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== 2026-01 ===');
    expect(result.output).toContain('=== 2026-02 ===');
    expect(result.output).toContain('=== 2026-03 ===');
  });

  test('category array filters multiple categories', async () => {
    const result = await executeTool(
      'get_budgets',
      { month: '2026-01', category: ['Еда', 'Развлечения'] },
      ctx,
    );
    expect(result.success).toBe(true);
  });
});

describe('executeAddExpense', () => {
  beforeEach(resetAllMocks);

  test('creates expense with correct fields via ExpenseRecorder', async () => {
    mockRecord.mockResolvedValue({ expense: { id: 42 }, eurAmount: 25.5 });

    const result = await executeTool(
      'add_expense',
      { amount: 25.5, category: 'Food', comment: 'lunch', date: '2026-03-09' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith(1, 123, {
      date: '2026-03-09',
      category: 'Food',
      comment: 'lunch',
      amount: 25.5,
      currency: 'EUR',
    });
  });

  test('returns confirmation with amount and currency', async () => {
    mockRecord.mockResolvedValue({ expense: { id: 99 }, eurAmount: 43 });

    const result = await executeTool(
      'add_expense',
      { amount: 50, category: 'Transport', currency: 'USD' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('50.00 USD');
    expect(result.output).toContain('Transport');
    expect(result.output).toContain('ID: 99');
  });

  test('rejects invalid amount', async () => {
    const result = await executeTool('add_expense', { amount: 0, category: 'Food' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid');
  });

  test('rejects missing category', async () => {
    const result = await executeTool('add_expense', { amount: 100 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid');
  });
});

describe('executeDeleteExpense', () => {
  beforeEach(resetAllMocks);

  test('deletes expense belonging to this group', async () => {
    mockExpenses.findById.mockReturnValue({
      id: 10,
      group_id: 1,
      user_id: 123,
      date: '2026-03-01',
      category: 'Food',
      comment: 'pizza',
      amount: 12,
      currency: 'EUR',
      eur_amount: 12,
      created_at: '',
    });

    const result = await executeTool('delete_expense', { expense_id: 10 }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Expense 10 deleted');
    expect(mockExpenses.delete).toHaveBeenCalledWith(10);
  });

  test('rejects deletion of expense from different group', async () => {
    mockExpenses.findById.mockReturnValue({
      id: 10,
      group_id: 999,
      user_id: 456,
      date: '2026-03-01',
      category: 'Food',
      comment: '',
      amount: 12,
      currency: 'EUR',
      eur_amount: 12,
      created_at: '',
    });

    const result = await executeTool('delete_expense', { expense_id: 10 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied');
    expect(mockExpenses.delete).not.toHaveBeenCalled();
  });

  test('returns error when expense not found', async () => {
    mockExpenses.findById.mockReturnValue(null);

    const result = await executeTool('delete_expense', { expense_id: 999 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('executeSetBudget', () => {
  beforeEach(resetAllMocks);

  test('creates budget with correct limit and currency', async () => {
    const result = await executeTool(
      'set_budget',
      { category: 'Food', amount: 500, currency: 'USD', month: '2026-03' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Food');
    expect(result.output).toContain('500.00 USD');
    expect(result.output).toContain('2026-03');
    expect(mockBudgetManagerSet).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 1,
        category: 'Food',
        month: '2026-03',
        amount: 500,
        currency: 'USD',
      }),
    );
  });

  test('rejects invalid amount', async () => {
    const result = await executeTool('set_budget', { category: 'Food', amount: -10 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid');
  });
});

describe('executeGetCategories', () => {
  beforeEach(resetAllMocks);

  test('returns list of category names', async () => {
    mockCategories.findByGroupId.mockReturnValue([
      { id: 1, group_id: 1, name: 'Food', created_at: '' },
      { id: 2, group_id: 1, name: 'Transport', created_at: '' },
    ]);

    const result = await executeTool('get_categories', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBe('Food, Transport');
  });

  test('returns message when no categories', async () => {
    mockCategories.findByGroupId.mockReturnValue([]);

    const result = await executeTool('get_categories', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('No categories');
  });
});

describe('executeGetExchangeRates', () => {
  beforeEach(resetAllMocks);

  test('returns rate map with currencies', async () => {
    const result = await executeTool('get_exchange_rates', {}, ctx);
    expect(result.success).toBe(true);
    // formatExchangeRatesForAI returns real rates from the converter module
    expect(result.output).toContain('USD');
    expect(result.output).toContain('EUR');
  });
});

describe('executeGetGroupSettings', () => {
  beforeEach(resetAllMocks);

  test('returns group config', async () => {
    const result = await executeTool('get_group_settings', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Default currency: EUR');
    expect(result.output).toContain('EUR, USD');
    expect(result.output).toContain('not connected');
  });

  test('returns error when group not found', async () => {
    mockGroups.findById.mockReturnValue(null);

    const result = await executeTool('get_group_settings', {}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Group not found');
  });

  test('shows custom prompt when set', async () => {
    mockGroups.findById.mockReturnValue({
      id: 1,
      telegram_group_id: 456,
      google_refresh_token: null,
      spreadsheet_id: null,
      default_currency: 'EUR',
      enabled_currencies: ['EUR'],
      custom_prompt: 'Be brief and speak in Russian',
      active_topic_id: null,
      oauth_client: 'legacy' as const,
      bank_panel_summary_message_id: null,
      created_at: '',
      updated_at: '',
    });

    const result = await executeTool('get_group_settings', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Custom prompt text: Be brief and speak in Russian');
  });
});

describe('executeManageCategory', () => {
  beforeEach(resetAllMocks);

  test('creates new category', async () => {
    mockCategories.findByName.mockReturnValue(null);
    mockCategories.create.mockReturnValue({ id: 5, group_id: 1, name: 'Coffee', created_at: '' });

    const result = await executeTool('manage_category', { action: 'create', name: 'Coffee' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Coffee');
    expect(result.output).toContain('created');
  });

  test('reports already existing category', async () => {
    mockCategories.findByName.mockReturnValue({
      id: 5,
      group_id: 1,
      name: 'Coffee',
      created_at: '',
    });

    const result = await executeTool('manage_category', { action: 'create', name: 'Coffee' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('already exists');
  });

  test('rejects unknown action', async () => {
    const result = await executeTool('manage_category', { action: 'rename', name: 'Coffee' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown action');
  });
});

describe('executeDeleteBudget', () => {
  beforeEach(resetAllMocks);

  test('deletes budget for category/month', async () => {
    const result = await executeTool('delete_budget', { category: 'Food', month: '2026-03' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Budget deleted');
    expect(result.output).toContain('Food');
    expect(mockBudgetManagerDelete).toHaveBeenCalledWith({
      groupId: 1,
      category: 'Food',
      month: '2026-03',
    });
  });

  test('rejects missing category', async () => {
    const result = await executeTool('delete_budget', {}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('category is required');
  });
});

describe('executeSetCustomPrompt', () => {
  beforeEach(resetAllMocks);

  test('sets custom prompt', async () => {
    const result = await executeTool(
      'set_custom_prompt',
      { prompt: 'Always respond in Russian' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('Custom prompt updated');
    expect(mockGroups.update).toHaveBeenCalledWith(456, {
      custom_prompt: 'Always respond in Russian',
    });
  });

  test('clears prompt when empty string', async () => {
    const result = await executeTool('set_custom_prompt', { prompt: '' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Custom prompt cleared');
    expect(mockGroups.update).toHaveBeenCalledWith(456, { custom_prompt: null });
  });
});

describe('calculate tool', () => {
  beforeEach(resetAllMocks);

  test('evaluates simple expression', async () => {
    const result = await executeTool('calculate', { expression: '100 - 70' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('30');
  });

  test('result is rounded to 2 decimal places', async () => {
    const result = await executeTool('calculate', { expression: '100 / 3' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBe('33.33'); // pure math — no currency suffix
  });

  test('pure math omits currency from output', async () => {
    const result = await executeTool('calculate', { expression: '50 + 50' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBe('100'); // no EUR suffix for currency-free expressions
  });

  test('returns error for unknown target_currency', async () => {
    const result = await executeTool(
      'calculate',
      { expression: '100 - 70', target_currency: 'FOOBAR' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('FOOBAR');
  });

  test('returns error for missing expression', async () => {
    const result = await executeTool('calculate', {}, ctx);
    expect(result.success).toBe(false);
  });

  test('returns error for unevaluable expression', async () => {
    const result = await executeTool('calculate', { expression: 'not math' }, ctx);
    expect(result.success).toBe(false);
  });

  test('returns error when group not found', async () => {
    mockGroups.findById.mockReturnValue(null);
    const result = await executeTool('calculate', { expression: '100 - 70' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Group not found');
  });

  test('evaluates cross-currency expression (100$ - 70EUR in EUR)', async () => {
    const result = await executeTool(
      'calculate',
      { expression: '100$ - 70EUR', target_currency: 'EUR' },
      ctx,
    );
    expect(result.success).toBe(true);
    // 100 USD converted to EUR minus 70 EUR — result is a number in EUR
    expect(result.output).toContain('EUR');
    const value = parseFloat(result.output ?? '');
    expect(value).toBeGreaterThan(-200);
    expect(value).toBeLessThan(200);
  });

  test('large pure math result uses scientific notation', async () => {
    const result = await executeTool('calculate', { expression: '63000000 / 0.5' }, ctx);
    expect(result.success).toBe(true);
    // 126000000 → 1.26e8
    expect(result.output).toMatch(/e\d+/);
    expect(result.output).not.toContain('EUR');
  });

  test('result under 1M uses decimal notation', async () => {
    const result = await executeTool('calculate', { expression: '999999 * 1' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBe('999999');
    expect(result.output).not.toMatch(/e\d+/);
  });

  test('negative large result uses scientific notation with minus sign', async () => {
    const result = await executeTool('calculate', { expression: '0 - 63000000 / 0.5' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/^-.*e\d+/);
  });
});

describe('executeGetExpenses — batch periods and stats', () => {
  beforeEach(resetAllMocks);

  test('summary_only includes stats block', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        user_id: 123,
        date: '2026-01-05',
        category: 'Еда',
        comment: 'Хлеб',
        amount: 120,
        currency: 'EUR',
        eur_amount: 1.02,
        created_at: '',
      },
      {
        id: 2,
        group_id: 1,
        user_id: 123,
        date: '2026-01-10',
        category: 'Еда',
        comment: 'Молоко',
        amount: 250,
        currency: 'EUR',
        eur_amount: 2.13,
        created_at: '',
      },
      {
        id: 3,
        group_id: 1,
        user_id: 123,
        date: '2026-01-15',
        category: 'Развлечения',
        comment: 'Кино',
        amount: 1500,
        currency: 'EUR',
        eur_amount: 12.77,
        created_at: '',
      },
    ]);

    const result = await executeTool(
      'get_expenses',
      { period: '2026-01', summary_only: true },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== Stats ===');
    expect(result.output).toContain('count: 3');
    expect(result.output).toContain('median:');
    expect(result.output).toContain('min:');
    expect(result.output).toContain('max:');
    expect(result.output).toContain('Хлеб');
    expect(result.output).toContain('Кино');
  });

  test('empty period array falls back to current_month', async () => {
    mockExpenses.findByDateRange.mockReturnValue([]);
    const result = await executeTool('get_expenses', { period: [], summary_only: true }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
  });

  test('batch periods returns per-period stats and diff', async () => {
    const januaryExpenses: Expense[] = [
      {
        id: 1,
        group_id: 1,
        user_id: 123,
        date: '2026-01-05',
        category: 'Еда',
        comment: 'Хлеб',
        amount: 120,
        currency: 'EUR',
        eur_amount: 1.02,
        created_at: '',
      },
      {
        id: 2,
        group_id: 1,
        user_id: 123,
        date: '2026-01-10',
        category: 'Еда',
        comment: 'Молоко',
        amount: 250,
        currency: 'EUR',
        eur_amount: 2.13,
        created_at: '',
      },
      {
        id: 3,
        group_id: 1,
        user_id: 123,
        date: '2026-01-15',
        category: 'Развлечения',
        comment: 'Кино',
        amount: 1500,
        currency: 'EUR',
        eur_amount: 12.77,
        created_at: '',
      },
    ];
    const februaryExpenses: Expense[] = [
      {
        id: 4,
        group_id: 1,
        user_id: 123,
        date: '2026-02-03',
        category: 'Еда',
        comment: 'Сыр',
        amount: 800,
        currency: 'EUR',
        eur_amount: 6.88,
        created_at: '',
      },
      {
        id: 5,
        group_id: 1,
        user_id: 123,
        date: '2026-02-14',
        category: 'Развлечения',
        comment: 'Ресторан',
        amount: 5000,
        currency: 'EUR',
        eur_amount: 42.5,
        created_at: '',
      },
    ];

    let callCount = 0;
    mockExpenses.findByDateRange.mockImplementation(() => {
      callCount++;
      // First call: January, second call: February
      if (callCount === 1) return januaryExpenses;
      if (callCount === 2) return februaryExpenses;
      return [];
    });

    const result = await executeTool(
      'get_expenses',
      { period: ['2026-01', '2026-02'], summary_only: true },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== 2026-01 ===');
    expect(result.output).toContain('=== 2026-02 ===');
    expect(result.output).toContain('count: 3');
    expect(result.output).toContain('count: 2');
    expect(result.output).toContain('=== Diff:');
    expect(result.output).toContain('=== Overall ===');
  });

  test('category array filters multiple categories', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        user_id: 123,
        date: '2026-01-05',
        category: 'Еда',
        comment: 'Хлеб',
        amount: 120,
        currency: 'EUR',
        eur_amount: 1.02,
        created_at: '',
      },
      {
        id: 2,
        group_id: 1,
        user_id: 123,
        date: '2026-01-15',
        category: 'Развлечения',
        comment: 'Кино',
        amount: 1500,
        currency: 'EUR',
        eur_amount: 12.77,
        created_at: '',
      },
      {
        id: 3,
        group_id: 1,
        user_id: 123,
        date: '2026-01-20',
        category: 'Транспорт',
        comment: 'Такси',
        amount: 700,
        currency: 'EUR',
        eur_amount: 5.95,
        created_at: '',
      },
    ]);

    const result = await executeTool(
      'get_expenses',
      { period: '2026-01', category: ['Еда', 'Развлечения'], summary_only: true },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('Еда');
    expect(result.output).toContain('Развлечения');
    expect(result.output).not.toContain('Транспорт');
  });

  test('detail output includes stats for all expenses', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      {
        id: 1,
        group_id: 1,
        user_id: 123,
        date: '2026-01-05',
        category: 'Еда',
        comment: 'Хлеб',
        amount: 120,
        currency: 'EUR',
        eur_amount: 1.02,
        created_at: '',
      },
      {
        id: 2,
        group_id: 1,
        user_id: 123,
        date: '2026-01-10',
        category: 'Еда',
        comment: 'Молоко',
        amount: 250,
        currency: 'EUR',
        eur_amount: 2.13,
        created_at: '',
      },
      {
        id: 3,
        group_id: 1,
        user_id: 123,
        date: '2026-01-15',
        category: 'Развлечения',
        comment: 'Кино',
        amount: 1500,
        currency: 'EUR',
        eur_amount: 12.77,
        created_at: '',
      },
    ]);

    const result = await executeTool(
      'get_expenses',
      { period: '2026-01', summary_only: false },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== Stats (all) ===');
    expect(result.output).toContain('count: 3');
    expect(result.output).toContain('[id:1]');
    expect(result.output).toContain('[id:3]');
  });

  test('3+ periods returns trend instead of diff', async () => {
    const janExpenses: Expense[] = [
      {
        id: 1,
        group_id: 1,
        user_id: 123,
        date: '2026-01-05',
        category: 'Еда',
        comment: 'Хлеб',
        amount: 120,
        currency: 'EUR',
        eur_amount: 1.02,
        created_at: '',
      },
    ];
    const febExpenses: Expense[] = [
      {
        id: 2,
        group_id: 1,
        user_id: 123,
        date: '2026-02-03',
        category: 'Еда',
        comment: 'Сыр',
        amount: 800,
        currency: 'EUR',
        eur_amount: 6.88,
        created_at: '',
      },
    ];
    const marExpenses: Expense[] = [
      {
        id: 3,
        group_id: 1,
        user_id: 123,
        date: '2026-03-01',
        category: 'Транспорт',
        comment: 'Такси',
        amount: 700,
        currency: 'EUR',
        eur_amount: 5.95,
        created_at: '',
      },
    ];

    let trendCallCount = 0;
    mockExpenses.findByDateRange.mockImplementation(() => {
      trendCallCount++;
      if (trendCallCount === 1) return janExpenses;
      if (trendCallCount === 2) return febExpenses;
      if (trendCallCount === 3) return marExpenses;
      return [];
    });

    const result = await executeTool(
      'get_expenses',
      { period: ['2026-01', '2026-02', '2026-03'], summary_only: true },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== Trend');
    expect(result.output).not.toContain('=== Diff:');
    expect(result.output).toContain('=== Overall ===');
  });
});

describe('error handling', () => {
  beforeEach(resetAllMocks);

  test('catches thrown errors and returns error result', async () => {
    mockExpenses.findByDateRange.mockImplementation(() => {
      throw new Error('DB connection lost');
    });

    const result = await executeTool('get_expenses', {}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('DB connection lost');
  });
});

describe('get_bank_transactions batch', () => {
  beforeEach(resetAllMocks);

  test('multiple periods passes array filter to repository', async () => {
    const result = await executeTool(
      'get_bank_transactions',
      { period: ['2026-01', '2026-02'], bank_name: 'all' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockBankTransactions.findByGroupId).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ period: ['2026-01', '2026-02'] }),
    );
  });

  test('multiple bank_names passes array filter (excluding "all")', async () => {
    const result = await executeTool(
      'get_bank_transactions',
      { bank_name: ['tbc', 'kaspi'], period: 'current_month' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockBankTransactions.findByGroupId).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ bank_name: ['tbc', 'kaspi'] }),
    );
  });

  test('multiple statuses passes array filter', async () => {
    const result = await executeTool(
      'get_bank_transactions',
      { status: ['pending', 'confirmed'], bank_name: 'all' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockBankTransactions.findByGroupId).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: ['pending', 'confirmed'] }),
    );
  });
});

describe('find_missing_expenses batch', () => {
  beforeEach(resetAllMocks);

  test('multiple periods calls findUnmatched per period', async () => {
    const result = await executeTool(
      'find_missing_expenses',
      { period: ['2026-01', '2026-02'] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.summary).toContain('2026-01');
    expect(mockBankTransactions.findUnmatched).toHaveBeenCalledTimes(2);
    expect(mockBankTransactions.findUnmatched).toHaveBeenCalledWith(1, '2026-01-01', '2026-01-31');
    expect(mockBankTransactions.findUnmatched).toHaveBeenCalledWith(1, '2026-02-01', '2026-02-28');
  });
});

// ── get_technical_analysis ──────────────────────────────────────────

describe('get_technical_analysis', () => {
  beforeEach(() => {
    mockGetFinancialSnapshot.mockReset();
  });

  test('returns graceful message when no TA data', async () => {
    mockGetFinancialSnapshot.mockReturnValue({ technicalAnalysis: null });
    const result = await executeTool('get_technical_analysis', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Недостаточно данных');
  });

  test('returns analysis for all categories', async () => {
    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: {
        categories: [
          {
            category: 'Food',
            monthsOfData: 6,
            trend: {
              direction: 'rising',
              confidence: 0.8,
              macd: { crossover: 'none', histogram: 0 },
              rsi: { value: 55, signal: 'neutral' },
              hurst: { value: 0.65, type: 'trending' },
              changePoints: [],
              pivotPoints: {
                support1: 200,
                support2: 150,
                pivot: 300,
                resistance1: 400,
                resistance2: 450,
              },
            },
            forecasts: {
              ensemble: 350,
              holt: { forecast: 340, trend: 10 },
              theta: { forecast: 360 },
              quantiles: { p50: 320, p75: 380, p90: 420, p95: 450 },
              croston: null,
            },
            volatility: {
              bollingerBands: {
                upper: 420,
                middle: 300,
                lower: 180,
                bandwidth: 0.8,
                percentB: 0.7,
              },
              atr: 45,
              historicalVol: 0.15,
              donchian: {
                upper: 450,
                lower: 180,
                middle: 315,
                isBreakoutHigh: false,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: false,
              anomalyCount: 0,
              zScore: { zScore: 1.2, direction: 'above' },
            },
          },
        ],
        correlations: [],
      },
    });

    const result = await executeTool('get_technical_analysis', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Food');
    expect(result.output).toContain('растут');
    expect(result.output).toContain('Прогноз на следующий месяц');
    expect(result.output).toContain('Обычный коридор');
    expect(result.output).not.toContain('MACD');
    expect(result.output).not.toContain('RSI');
    expect(result.output).not.toContain('Bollinger');
  });

  test('filters by category name', async () => {
    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: {
        categories: [
          {
            category: 'Food',
            monthsOfData: 6,
            trend: {
              direction: 'stable',
              confidence: 0.5,
              macd: { crossover: 'none', histogram: 0 },
              rsi: { value: 50, signal: 'neutral' },
              hurst: { value: 0.5, type: 'random_walk' },
              changePoints: [],
              pivotPoints: {
                support1: 100,
                support2: 80,
                pivot: 150,
                resistance1: 200,
                resistance2: 220,
              },
            },
            forecasts: {
              ensemble: 200,
              holt: { forecast: 200, trend: 0 },
              theta: { forecast: 200 },
              quantiles: { p50: 190, p75: 220, p90: 250, p95: 270 },
              croston: null,
            },
            volatility: {
              bollingerBands: {
                upper: 250,
                middle: 200,
                lower: 150,
                bandwidth: 0.5,
                percentB: 0.5,
              },
              atr: 20,
              historicalVol: 0.1,
              donchian: {
                upper: 250,
                lower: 150,
                middle: 200,
                isBreakoutHigh: false,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: false,
              anomalyCount: 0,
              zScore: { zScore: 0.5, direction: 'above' },
            },
          },
          {
            category: 'Transport',
            monthsOfData: 4,
            trend: {
              direction: 'falling',
              confidence: 0.7,
              macd: { crossover: 'bearish', histogram: -5 },
              rsi: { value: 30, signal: 'oversold' },
              hurst: { value: 0.4, type: 'mean_reverting' },
              changePoints: [],
              pivotPoints: {
                support1: 50,
                support2: 30,
                pivot: 80,
                resistance1: 110,
                resistance2: 130,
              },
            },
            forecasts: {
              ensemble: 70,
              holt: { forecast: 65, trend: -5 },
              theta: { forecast: 75 },
              quantiles: { p50: 65, p75: 85, p90: 100, p95: 110 },
              croston: null,
            },
            volatility: {
              bollingerBands: { upper: 110, middle: 80, lower: 50, bandwidth: 0.75, percentB: 0.3 },
              atr: 15,
              historicalVol: 0.2,
              donchian: {
                upper: 120,
                lower: 50,
                middle: 85,
                isBreakoutHigh: false,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: false,
              anomalyCount: 0,
              zScore: { zScore: -0.8, direction: 'below' },
            },
          },
        ],
        correlations: [],
      },
    });

    const result = await executeTool('get_technical_analysis', { category: 'Transport' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Transport');
    expect(result.output).not.toContain('Food');
    expect(result.output).toContain('снижаются');
  });

  test('returns message for unknown category', async () => {
    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: {
        categories: [
          {
            category: 'Food',
            monthsOfData: 3,
            trend: {
              direction: 'stable',
              confidence: 0.5,
              macd: { crossover: 'none', histogram: 0 },
              rsi: { value: 50, signal: 'neutral' },
              hurst: { value: 0.5, type: 'random_walk' },
              changePoints: [],
              pivotPoints: {
                support1: 100,
                support2: 80,
                pivot: 150,
                resistance1: 200,
                resistance2: 220,
              },
            },
            forecasts: {
              ensemble: 200,
              holt: { forecast: 200, trend: 0 },
              theta: { forecast: 200 },
              quantiles: { p50: 190, p75: 220, p90: 250, p95: 270 },
              croston: null,
            },
            volatility: {
              bollingerBands: {
                upper: 250,
                middle: 200,
                lower: 150,
                bandwidth: 0.5,
                percentB: 0.5,
              },
              atr: 20,
              historicalVol: 0.1,
              donchian: {
                upper: 250,
                lower: 150,
                middle: 200,
                isBreakoutHigh: false,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: false,
              anomalyCount: 0,
              zScore: { zScore: 0.5, direction: 'above' },
            },
          },
        ],
        correlations: [],
      },
    });

    const result = await executeTool('get_technical_analysis', { category: 'Unknown' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Нет данных для категории');
    expect(result.output).toContain('Food');
  });

  test('shows anomaly warning in user-friendly language', async () => {
    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: {
        categories: [
          {
            category: 'Shopping',
            monthsOfData: 8,
            trend: {
              direction: 'rising',
              confidence: 0.9,
              macd: { crossover: 'bullish', histogram: 15 },
              rsi: { value: 75, signal: 'overbought' },
              hurst: { value: 0.7, type: 'trending' },
              changePoints: [{ index: 3 }],
              pivotPoints: {
                support1: 300,
                support2: 250,
                pivot: 400,
                resistance1: 500,
                resistance2: 550,
              },
            },
            forecasts: {
              ensemble: 480,
              holt: { forecast: 500, trend: 25 },
              theta: { forecast: 460 },
              quantiles: { p50: 450, p75: 510, p90: 560, p95: 600 },
              croston: null,
            },
            volatility: {
              bollingerBands: {
                upper: 550,
                middle: 400,
                lower: 250,
                bandwidth: 0.75,
                percentB: 0.85,
              },
              atr: 60,
              historicalVol: 0.18,
              donchian: {
                upper: 580,
                lower: 250,
                middle: 415,
                isBreakoutHigh: true,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: true,
              anomalyCount: 2,
              zScore: { zScore: 2.8, direction: 'above' },
            },
          },
        ],
        correlations: [
          {
            category1: 'Shopping',
            category2: 'Food',
            correlation: 0.82,
            strength: 'strong_positive' as const,
          },
        ],
      },
    });

    const result = await executeTool('get_technical_analysis', {}, ctx);
    expect(result.success).toBe(true);
    // User-friendly anomaly message
    expect(result.output).toContain('Необычный расход');
    // User-friendly MACD message
    expect(result.output).toContain('Расходы начали расти после периода снижения');
    // User-friendly RSI message
    expect(result.output).toContain('непривычно высокие');
    // User-friendly Hurst
    expect(result.output).toContain('стабильный');
    // Record high (Donchian)
    expect(result.output).toContain('исторического максимума');
    // Change points
    expect(result.output).toContain('резких смен');
    // Correlations
    expect(result.output).toContain('Связи между категориями');
    expect(result.output).toContain('растут вместе');
    expect(result.output).toContain('сильная');
    // No TA jargon
    expect(result.output).not.toContain('MACD');
    expect(result.output).not.toContain('RSI');
    expect(result.output).not.toContain('Hurst');
    expect(result.output).not.toContain('Donchian');
    expect(result.output).not.toContain('Bollinger');
    expect(result.output).not.toContain('откат');
  });
});
