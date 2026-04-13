// Tests for BudgetManager — single entry point for ALL budget operations

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CurrencyCode } from '../config/constants';
import type { Budget, Group } from '../database/types';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSetBudget = mock(() => ({}) as Budget);
const mockDeleteById = mock(() => true);
const mockDeleteByGroupCategoryMonth = mock(() => true);
const mockFindByGroupCategoryMonth = mock((): Budget | null => null);

const mockFindGroupById = mock((): Group | null => ({
  id: 1,
  telegram_group_id: 456,
  title: null,
  invite_link: null,
  google_refresh_token: 'encrypted-token',
  spreadsheet_id: 'legacy-sheet-id',
  default_currency: 'EUR' as CurrencyCode,
  enabled_currencies: ['EUR', 'USD'],
  custom_prompt: null,
  active_topic_id: null,
  oauth_client: 'legacy' as const,
  bank_panel_summary_message_id: null,
  created_at: '',
  updated_at: '',
}));

const mockGetByYear = mock((): string | null => 'year-sheet-id');

const mockWriteMonthBudgetRow = mock(() => Promise.resolve());
const mockGoogleConn = mock(() => ({ fake: 'conn' }));

const mockBudgetWriterRepo = {
  setBudget: mockSetBudget,
  delete: mockDeleteById,
  deleteByGroupCategoryMonth: mockDeleteByGroupCategoryMonth,
};

mock.module('../database', () => ({
  database: {
    budgets: {
      findByGroupCategoryMonth: mockFindByGroupCategoryMonth,
    },
    _budgetWriter: mockBudgetWriterRepo,
    groups: { findById: mockFindGroupById },
    groupSpreadsheets: { getByYear: mockGetByYear },
  },
  _budgetWriter: () => mockBudgetWriterRepo,
}));

mock.module('./google/sheets', () => ({
  googleConn: mockGoogleConn,
  writeMonthBudgetRow: mockWriteMonthBudgetRow,
}));

mock.module('../utils/logger.ts', () => ({
  createLogger: () => ({
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  }),
}));

// Import after mocks
const { BudgetManager, getBudgetManager } = await import('./budget-manager');

// ── Helpers ────────────────────────────────────────────────────────────────

function resetAll() {
  mockSetBudget.mockReset();
  mockDeleteById.mockReset();
  mockDeleteById.mockReturnValue(true);
  mockDeleteByGroupCategoryMonth.mockReset();
  mockDeleteByGroupCategoryMonth.mockReturnValue(true);
  mockFindByGroupCategoryMonth.mockReset();
  // Default: a matching budget exists. Tests that exercise "no budget" or
  // fuzzy resolution override this explicitly.
  mockFindByGroupCategoryMonth.mockReturnValue({
    id: 1,
    group_id: 1,
    category: 'Food',
    month: '2026-04',
    limit_amount: 500,
    currency: 'EUR',
    created_at: '',
    updated_at: '',
  });
  mockFindGroupById.mockReset();
  mockFindGroupById.mockReturnValue({
    id: 1,
    telegram_group_id: 456,
    title: null,
    invite_link: null,
    google_refresh_token: 'encrypted-token',
    spreadsheet_id: 'legacy-sheet-id',
    default_currency: 'EUR' as CurrencyCode,
    enabled_currencies: ['EUR', 'USD'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'legacy' as const,
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
  });
  mockGetByYear.mockReset();
  mockGetByYear.mockReturnValue('year-sheet-id');
  mockWriteMonthBudgetRow.mockReset();
  mockGoogleConn.mockReset();
  mockGoogleConn.mockReturnValue({ fake: 'conn' });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('BudgetManager.set', () => {
  beforeEach(resetAll);

  test('saves to DB and syncs to Sheets', async () => {
    const mgr = new BudgetManager();
    const result = await mgr.set({
      groupId: 1,
      category: 'Food',
      month: '2026-04',
      amount: 700,
      currency: 'EUR',
    });

    expect(result.sheetsSynced).toBe(true);
    expect(mockSetBudget).toHaveBeenCalledWith({
      group_id: 1,
      category: 'Food',
      month: '2026-04',
      limit_amount: 700,
      currency: 'EUR',
    });
    expect(mockWriteMonthBudgetRow).toHaveBeenCalledWith({ fake: 'conn' }, 'year-sheet-id', 'Apr', {
      category: 'Food',
      limit: 700,
      currency: 'EUR',
    });
  });

  test('uses groupSpreadsheets.getByYear over group.spreadsheet_id', async () => {
    mockGetByYear.mockReturnValue('correct-sheet');

    const mgr = new BudgetManager();
    await mgr.set({
      groupId: 1,
      category: 'Food',
      month: '2026-04',
      amount: 500,
      currency: 'EUR',
    });

    expect(mockWriteMonthBudgetRow).toHaveBeenCalledWith(
      expect.anything(),
      'correct-sheet',
      expect.anything(),
      expect.anything(),
    );
  });

  test('falls back to group.spreadsheet_id when getByYear returns null', async () => {
    mockGetByYear.mockReturnValue(null);

    const mgr = new BudgetManager();
    await mgr.set({
      groupId: 1,
      category: 'Food',
      month: '2026-04',
      amount: 500,
      currency: 'EUR',
    });

    expect(mockWriteMonthBudgetRow).toHaveBeenCalledWith(
      expect.anything(),
      'legacy-sheet-id',
      expect.anything(),
      expect.anything(),
    );
  });

  test('skips Sheets sync when group has no Sheets connected', async () => {
    mockFindGroupById.mockReturnValue({
      id: 1,
      telegram_group_id: 456,
      title: null,
      invite_link: null,
      google_refresh_token: null,
      spreadsheet_id: null,
      default_currency: 'EUR' as CurrencyCode,
      enabled_currencies: ['EUR'],
      custom_prompt: null,
      active_topic_id: null,
      oauth_client: 'legacy' as const,
      bank_panel_summary_message_id: null,
      created_at: '',
      updated_at: '',
    });

    const mgr = new BudgetManager();
    const result = await mgr.set({
      groupId: 1,
      category: 'Food',
      month: '2026-04',
      amount: 700,
      currency: 'EUR',
    });

    expect(result.sheetsSynced).toBe(false);
    expect(mockSetBudget).toHaveBeenCalled();
    expect(mockWriteMonthBudgetRow).not.toHaveBeenCalled();
  });

  test('saves to DB even when Sheets sync fails', async () => {
    mockWriteMonthBudgetRow.mockRejectedValue(new Error('Sheets API down'));

    const mgr = new BudgetManager();
    const result = await mgr.set({
      groupId: 1,
      category: 'Food',
      month: '2026-04',
      amount: 700,
      currency: 'EUR',
    });

    expect(result.sheetsSynced).toBe(false);
    expect(mockSetBudget).toHaveBeenCalled();
  });

  test('resolves correct MonthAbbr from YYYY-MM string', async () => {
    const mgr = new BudgetManager();

    await mgr.set({ groupId: 1, category: 'A', month: '2026-01', amount: 100, currency: 'EUR' });
    expect(mockWriteMonthBudgetRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'Jan',
      expect.anything(),
    );

    mockWriteMonthBudgetRow.mockReset();
    await mgr.set({ groupId: 1, category: 'A', month: '2026-12', amount: 100, currency: 'EUR' });
    expect(mockWriteMonthBudgetRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'Dec',
      expect.anything(),
    );
  });

  test('extracts year from month string for spreadsheet lookup', async () => {
    const mgr = new BudgetManager();
    await mgr.set({ groupId: 1, category: 'A', month: '2027-06', amount: 100, currency: 'EUR' });

    expect(mockGetByYear).toHaveBeenCalledWith(1, 2027);
  });

  test('skips Sheets when no spreadsheet ID available at all', async () => {
    mockGetByYear.mockReturnValue(null);
    mockFindGroupById.mockReturnValue({
      id: 1,
      telegram_group_id: 456,
      title: null,
      invite_link: null,
      google_refresh_token: 'token',
      spreadsheet_id: null,
      default_currency: 'EUR' as CurrencyCode,
      enabled_currencies: ['EUR'],
      custom_prompt: null,
      active_topic_id: null,
      oauth_client: 'legacy' as const,
      bank_panel_summary_message_id: null,
      created_at: '',
      updated_at: '',
    });

    const mgr = new BudgetManager();
    const result = await mgr.set({
      groupId: 1,
      category: 'Food',
      month: '2026-04',
      amount: 700,
      currency: 'EUR',
    });

    expect(result.sheetsSynced).toBe(false);
    expect(mockSetBudget).toHaveBeenCalled();
    expect(mockWriteMonthBudgetRow).not.toHaveBeenCalled();
  });
});

describe('BudgetManager.delete', () => {
  beforeEach(resetAll);

  test('deletes from DB and sets amount to 0 in Sheets', async () => {
    const mgr = new BudgetManager();
    const result = await mgr.delete({
      groupId: 1,
      category: 'Food',
      month: '2026-04',
    });

    expect(result.sheetsSynced).toBe(true);
    expect(mockDeleteByGroupCategoryMonth).toHaveBeenCalledWith(1, 'Food', '2026-04');
    // Delete = write 0 to Sheets (row stays, budget zeroed)
    expect(mockWriteMonthBudgetRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'Apr',
      { category: 'Food', limit: 0, currency: 'EUR' },
    );
  });

  test('uses group default_currency for Sheets zero-out', async () => {
    mockFindGroupById.mockReturnValue({
      id: 1,
      telegram_group_id: 456,
      title: null,
      invite_link: null,
      google_refresh_token: 'token',
      spreadsheet_id: 'sheet',
      default_currency: 'USD' as CurrencyCode,
      enabled_currencies: ['USD'],
      custom_prompt: null,
      active_topic_id: null,
      oauth_client: 'legacy' as const,
      bank_panel_summary_message_id: null,
      created_at: '',
      updated_at: '',
    });

    const mgr = new BudgetManager();
    await mgr.delete({ groupId: 1, category: 'Food', month: '2026-04' });

    expect(mockWriteMonthBudgetRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'Apr',
      { category: 'Food', limit: 0, currency: 'USD' },
    );
  });

  test('skips Sheets when not connected', async () => {
    mockFindGroupById.mockReturnValue({
      id: 1,
      telegram_group_id: 456,
      title: null,
      invite_link: null,
      google_refresh_token: null,
      spreadsheet_id: null,
      default_currency: 'EUR' as CurrencyCode,
      enabled_currencies: ['EUR'],
      custom_prompt: null,
      active_topic_id: null,
      oauth_client: 'legacy' as const,
      bank_panel_summary_message_id: null,
      created_at: '',
      updated_at: '',
    });

    const mgr = new BudgetManager();
    const result = await mgr.delete({ groupId: 1, category: 'Food', month: '2026-04' });

    expect(result.sheetsSynced).toBe(false);
    expect(mockDeleteByGroupCategoryMonth).toHaveBeenCalled();
    expect(mockWriteMonthBudgetRow).not.toHaveBeenCalled();
  });

  test('deletes from DB even when Sheets sync fails', async () => {
    mockWriteMonthBudgetRow.mockRejectedValue(new Error('Network error'));

    const mgr = new BudgetManager();
    const result = await mgr.delete({ groupId: 1, category: 'Food', month: '2026-04' });

    expect(result.sheetsSynced).toBe(false);
    expect(mockDeleteByGroupCategoryMonth).toHaveBeenCalled();
  });

  test('returns deleted=false when no matching budget exists', async () => {
    mockFindByGroupCategoryMonth.mockReturnValue(null);

    const mgr = new BudgetManager();
    const result = await mgr.delete({ groupId: 1, category: 'Nonexistent', month: '2026-04' });

    expect(result.deleted).toBe(false);
    expect(result.sheetsSynced).toBe(false);
    // Must NOT attempt destructive DB write when nothing was found
    expect(mockDeleteByGroupCategoryMonth).not.toHaveBeenCalled();
    expect(mockWriteMonthBudgetRow).not.toHaveBeenCalled();
  });

  test('fuzzy-resolves category name before exact delete', async () => {
    // User types "food" but the stored category is "Food" — findByGroupCategoryMonth
    // (fuzzy read) resolves it, and the repo-level delete receives the exact stored name.
    mockFindByGroupCategoryMonth.mockReturnValue({
      id: 42,
      group_id: 1,
      category: 'Food',
      month: '2026-04',
      limit_amount: 500,
      currency: 'EUR',
      created_at: '',
      updated_at: '',
    });

    const mgr = new BudgetManager();
    const result = await mgr.delete({ groupId: 1, category: 'food', month: '2026-04' });

    expect(result.deleted).toBe(true);
    expect(result.resolvedCategory).toBe('Food');
    // Delete must use the exact stored name, not the user input
    expect(mockDeleteByGroupCategoryMonth).toHaveBeenCalledWith(1, 'Food', '2026-04');
  });
});

describe('BudgetManager.importFromSheet (DB-only, no Sheets write-back)', () => {
  beforeEach(resetAll);

  test('writes to DB without touching Sheets', () => {
    const mgr = new BudgetManager();
    mgr.importFromSheet({
      groupId: 1,
      category: 'Food',
      month: '2026-04',
      amount: 700,
      currency: 'EUR',
    });

    expect(mockSetBudget).toHaveBeenCalledWith({
      group_id: 1,
      category: 'Food',
      month: '2026-04',
      limit_amount: 700,
      currency: 'EUR',
    });
    expect(mockWriteMonthBudgetRow).not.toHaveBeenCalled();
    expect(mockGoogleConn).not.toHaveBeenCalled();
  });
});

describe('BudgetManager.deleteLocal (DB-only delete by id)', () => {
  beforeEach(resetAll);

  test('deletes by id without touching Sheets', () => {
    const mgr = new BudgetManager();
    mgr.deleteLocal(42);

    expect(mockDeleteById).toHaveBeenCalledWith(42);
    expect(mockWriteMonthBudgetRow).not.toHaveBeenCalled();
  });
});

describe('getBudgetManager singleton', () => {
  test('returns a BudgetManager instance', () => {
    const mgr = getBudgetManager();
    expect(mgr).toBeInstanceOf(BudgetManager);
  });
});
