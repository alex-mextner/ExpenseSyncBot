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
  getAllBudgetsForMonth: mock((): Budget[] => []),
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

mock.module('../../database', () => ({
  database: mockDatabase({
    expenses: mockExpenses,
    budgets: mockBudgets,
    categories: mockCategories,
    groups: mockGroups,
    users: mockUsers,
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

// Mock budget sync — prevents dynamic import from pulling in sheets
mock.module('../../bot/services/budget-sync', () => ({
  ensureFreshBudgets: mock(() => Promise.resolve()),
  silentSyncBudgets: mock(() => Promise.resolve(0)),
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
    expect(mockBudgets.setBudget).toHaveBeenCalled();
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
    expect(mockBudgets.setBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        group_id: 1,
        category: 'Food',
        month: '2026-03',
        limit_amount: 500,
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
    expect(mockBudgets.deleteByGroupCategoryMonth).toHaveBeenCalledWith(1, 'Food', '2026-03');
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
