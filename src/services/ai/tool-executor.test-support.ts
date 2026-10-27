/**
 * Shared mocks and fixtures for the tool-executor test files.
 *
 * tool-executor.test.ts outgrew the 1200-line limit, so its test cases now live in one file per
 * tool family (tool-executor.<family>.test.ts). They all need the same mocked database, sheet,
 * recorder, budget-manager and analytics modules; defining them once here keeps the mocks from
 * drifting between files. The name does not end in `.test.ts`, so the test runner does not pick
 * this file up as a test of its own. Test files must import `executeTool` from here: that makes
 * the `mock.module` calls below run before the real tool-executor module is loaded.
 */
import { mock } from 'bun:test';
import type { Budget, Category, Expense, Group } from '../../database/types';
import { mockDatabase } from '../../test-utils/mocks/database';
import type { AgentContext } from './types';

// ── Mock database ────────────────────────────────────────────────────

export const mockExpenses = {
  findByDateRange: mock((_groupId: number, _start: string, _end: string): Expense[] => []),
  findById: mock((): Expense | null => null),
  create: mock(() => ({ id: 42 })),
  delete: mock(() => true),
  deleteAllByGroupId: mock(() => 5),
};

export const mockBudgets = {
  getAllBudgetsForMonth: mock((_groupId: number, _month: string): Budget[] => []),
  setBudget: mock(() => ({})),
  deleteByGroupCategoryMonth: mock(() => true),
  findByGroupCategoryMonth: mock((): Budget | null => null),
};

export const mockCategories = {
  findByGroupId: mock((): Category[] => []),
  findByName: mock((): Category | null => null),
  getCategoryNames: mock(() => ['Food', 'Transport']),
  exists: mock(() => false),
  create: mock(() => ({ id: 1, group_id: 1, name: 'Food', created_at: '' })),
  delete: mock(() => true),
};

export const mockGroups = {
  findById: mock((): Group | null => ({
    id: 1,
    telegram_group_id: 456,
    title: null,
    invite_link: null,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR',
    enabled_currencies: ['EUR', 'USD'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'legacy' as const,
    bank_panel_summary_message_id: null,
    bank_cards_enabled: 1,
    created_at: '',
    updated_at: '',
  })),
  update: mock(() => null),
};

export const mockUsers = {
  findByGroupId: mock(() => []),
};

export const mockBankTransactions = {
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

export const BANK_ACCOUNTS_FIXTURE = [
  {
    id: 1,
    connection_id: 10,
    title: 'TBC Card',
    balance: 5000,
    currency: 'GEL',
    type: 'card',
    is_excluded: 0,
  },
  {
    id: 2,
    connection_id: 10,
    title: 'TBC Savings',
    balance: 20000,
    currency: 'GEL',
    type: 'savings',
    is_excluded: 0,
  },
  {
    id: 3,
    connection_id: 20,
    title: 'Kaspi Card',
    balance: 100000,
    currency: 'KZT',
    type: 'card',
    is_excluded: 0,
  },
  {
    id: 4,
    connection_id: 30,
    title: 'Monobank UAH',
    balance: 3000,
    currency: 'UAH',
    type: 'card',
    is_excluded: 0,
  },
];

export const BANK_CONNECTIONS_MAP: Record<
  number,
  { id: number; bank_name: string; display_name: string }
> = {
  10: { id: 10, bank_name: 'tbc-ge', display_name: 'TBC Bank' },
  20: { id: 20, bank_name: 'kaspi', display_name: 'Kaspi Bank' },
  30: { id: 30, bank_name: 'monobank', display_name: 'Monobank' },
};

export const mockBankAccounts = {
  findByGroupId: mock(() => BANK_ACCOUNTS_FIXTURE),
};

export const mockBankConnections = {
  findById: mock((id: number) => BANK_CONNECTIONS_MAP[id] ?? null),
  findActiveByGroupId: mock(() => []),
};

export const mockRecurringPatterns = {
  findById: mock((id: number) => ({
    id,
    group_id: 1,
    category: `Cat${id}`,
    expected_amount: 100,
    currency: 'EUR',
    expected_day: 1,
    next_expected_date: null,
    last_seen_date: null,
    status: 'active',
  })),
  updateStatus: mock(() => {}),
  delete: mock(() => {}),
  findAllByGroupId: mock(() => []),
};

mock.module('../../database', () => ({
  database: mockDatabase({
    expenses: mockExpenses,
    budgets: mockBudgets,
    categories: mockCategories,
    groups: mockGroups,
    users: mockUsers,
    bankTransactions: mockBankTransactions,
    bankAccounts: mockBankAccounts,
    bankConnections: mockBankConnections,
    recurringPatterns: mockRecurringPatterns,
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

// Mock ExpenseRecorder (used by add_expense / delete_expense tools)
export const mockRecord = mock(() => Promise.resolve({ expense: { id: 42 }, eurAmount: 25.5 }));
export const mockDeleteFromSheet = mock(() =>
  Promise.resolve({ deletedRowIndex: 5 as number | null }),
);
mock.module('../expense-recorder', () => ({
  getExpenseRecorder: () => ({ record: mockRecord, deleteFromSheet: mockDeleteFromSheet }),
}));

// Mock BudgetManager (used by set_budget and delete_budget tools)
export const mockBudgetManagerSet = mock(() => Promise.resolve({ sheetsSynced: false }));
export const mockBudgetManagerDelete = mock(() =>
  Promise.resolve({ deleted: true, sheetsSynced: false, resolvedCategory: undefined }),
);
mock.module('../budget-manager', () => ({
  getBudgetManager: () => ({
    set: mockBudgetManagerSet,
    delete: mockBudgetManagerDelete,
  }),
}));

// Mock budget sync — prevents dynamic import from pulling in sheets
export const mockEnsureFreshBudgets = mock(() => Promise.resolve());
export const mockSilentSyncBudgets = mock(() => Promise.resolve(0));
mock.module('../../bot/services/budget-sync', () => ({
  ensureFreshBudgets: mockEnsureFreshBudgets,
  silentSyncBudgets: mockSilentSyncBudgets,
}));

// Mock spending analytics — used by get_technical_analysis and get_budgets tools
// biome-ignore lint/suspicious/noExplicitAny: test mock returns partial FinancialSnapshot
export const mockGetFinancialSnapshot = mock((): any => ({
  technicalAnalysis: null,
  burnRates: [],
}));
mock.module('../analytics/spending-analytics', () => ({
  spendingAnalytics: {
    getFinancialSnapshot: mockGetFinancialSnapshot,
  },
}));

// Import after mocks are set up
export { executeTool } from './tool-executor';

// ── Fixtures ─────────────────────────────────────────────────────────

export const ctx: AgentContext = {
  groupId: 1,
  userId: 123,
  telegramUserId: 99,
  chatId: 456,
  userName: 'testuser',
  userFullName: 'Test User',
  customPrompt: null,
  telegramGroupId: 456,
};

// ── Helpers ──────────────────────────────────────────────────────────

export function resetAllMocks() {
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
  mockBudgetManagerDelete.mockReturnValue(
    Promise.resolve({ deleted: true, sheetsSynced: false, resolvedCategory: undefined }),
  );

  mockRecord.mockReset();
  mockRecord.mockReturnValue(Promise.resolve({ expense: { id: 42 }, eurAmount: 25.5 }));
  mockDeleteFromSheet.mockReset();
  mockDeleteFromSheet.mockReturnValue(Promise.resolve({ deletedRowIndex: 5 as number | null }));

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
    title: null,
    invite_link: null,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR',
    enabled_currencies: ['EUR', 'USD'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'legacy' as const,
    bank_panel_summary_message_id: null,
    bank_cards_enabled: 1,
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

  mockBankAccounts.findByGroupId.mockReset();
  mockBankAccounts.findByGroupId.mockReturnValue(BANK_ACCOUNTS_FIXTURE);
  mockBankConnections.findById.mockReset();
  mockBankConnections.findById.mockImplementation((id: number) => BANK_CONNECTIONS_MAP[id] ?? null);
  mockBankConnections.findActiveByGroupId.mockReset();
  mockBankConnections.findActiveByGroupId.mockReturnValue([]);

  mockRecurringPatterns.findById.mockReset();
  mockRecurringPatterns.findById.mockImplementation((id: number) => ({
    id,
    group_id: 1,
    category: `Cat${id}`,
    expected_amount: 100,
    currency: 'EUR',
    expected_day: 1,
    next_expected_date: null,
    last_seen_date: null,
    status: 'active',
  }));
  mockRecurringPatterns.updateStatus.mockReset();
  mockRecurringPatterns.delete.mockReset();
  mockRecurringPatterns.findAllByGroupId.mockReset();
  mockRecurringPatterns.findAllByGroupId.mockReturnValue([]);
}
