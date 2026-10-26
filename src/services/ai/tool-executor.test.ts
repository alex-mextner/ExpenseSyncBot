/**
 * Routing, error handling and the small read/settings tools (categories, exchange rates, group settings, custom prompt, calculate, bank reads, recurring patterns).
 * Shared mocks live in tool-executor.test-support.ts.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { Category } from '../../database/types';
import { makeExpense } from '../../test-utils/fixtures';
import {
  ctx,
  executeTool,
  mockBankTransactions,
  mockBudgetManagerSet,
  mockBudgets,
  mockCategories,
  mockExpenses,
  mockGroups,
  mockRecurringPatterns,
  resetAllMocks,
} from './tool-executor.test-support';

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
    mockExpenses.findById.mockReturnValue(
      makeExpense({
        id: 10,
        user_id: 123,
        date: '2026-03-01',
        comment: 'lunch',
        amount: 15,
        eur_amount: 15,
      }),
    );
    const result = await executeTool('delete_expense', { expense_id: 10 }, ctx);
    expect(result.success).toBe(true);
    expect(mockExpenses.delete).toHaveBeenCalledWith(10);
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

  test('returns group config rendered from the settings registry', async () => {
    const result = await executeTool('get_group_settings', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('default_currency): EUR');
    expect(result.output).toContain('EUR, USD');
    expect(result.output).toContain('not connected');
    // Every registry setting must be visible, including the bank-cards toggle and topic.
    expect(result.output).toContain('bank_cards_enabled)');
    expect(result.output).toContain('active_topic_id)');
  });

  test('returns error when group not found', async () => {
    mockGroups.findById.mockReturnValue(null);

    const result = await executeTool('get_group_settings', {}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Group not found');
  });

  test('shows a short custom prompt once (preview only, no duplicate full-text line)', async () => {
    mockGroups.findById.mockReturnValue({
      id: 1,
      telegram_group_id: 456,
      title: null,
      invite_link: null,
      google_refresh_token: null,
      spreadsheet_id: null,
      default_currency: 'EUR',
      enabled_currencies: ['EUR'],
      custom_prompt: 'Be brief and speak in Russian',
      active_topic_id: null,
      oauth_client: 'legacy' as const,
      bank_panel_summary_message_id: null,
      bank_cards_enabled: 1,
      created_at: '',
      updated_at: '',
    });

    const result = await executeTool('get_group_settings', {}, ctx);
    expect(result.success).toBe(true);
    // The preview line carries the full short prompt; no separate "full text" line.
    expect(result.output).toContain('custom_prompt): Be brief and speak in Russian');
    expect(result.output).not.toContain('Custom prompt full text:');
  });

  test('appends the full text only when the prompt is long enough to be truncated', async () => {
    const longPrompt = `Always reply in Russian. ${'x'.repeat(80)}`;
    mockGroups.findById.mockReturnValue({
      id: 1,
      telegram_group_id: 456,
      title: null,
      invite_link: null,
      google_refresh_token: null,
      spreadsheet_id: null,
      default_currency: 'EUR',
      enabled_currencies: ['EUR'],
      custom_prompt: longPrompt,
      active_topic_id: null,
      oauth_client: 'legacy' as const,
      bank_panel_summary_message_id: null,
      bank_cards_enabled: 1,
      created_at: '',
      updated_at: '',
    });

    const result = await executeTool('get_group_settings', {}, ctx);
    expect(result.output).toContain(`Custom prompt full text: ${longPrompt}`);
  });
});

describe('update_group_setting', () => {
  beforeEach(resetAllMocks);

  test('changes default currency and persists, keeping it in enabled set', async () => {
    const result = await executeTool(
      'update_group_setting',
      { setting: 'default_currency', value: 'egp' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockGroups.update).toHaveBeenCalledWith(456, {
      default_currency: 'EGP',
      enabled_currencies: ['EUR', 'USD', 'EGP'],
    });
  });

  test('toggles bank cards off', async () => {
    const result = await executeTool(
      'update_group_setting',
      { setting: 'bank_cards_enabled', value: 'off' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockGroups.update).toHaveBeenCalledWith(456, { bank_cards_enabled: 0 });
  });

  test('sets a custom prompt', async () => {
    const result = await executeTool(
      'update_group_setting',
      { setting: 'custom_prompt', value: 'Speak English' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockGroups.update).toHaveBeenCalledWith(456, { custom_prompt: 'Speak English' });
  });

  test('clears the active topic', async () => {
    const result = await executeTool(
      'update_group_setting',
      { setting: 'active_topic_id', value: 'clear' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockGroups.update).toHaveBeenCalledWith(456, { active_topic_id: null });
  });

  test('replaces the enabled currency set', async () => {
    const result = await executeTool(
      'update_group_setting',
      { setting: 'enabled_currencies', value: 'usd, rsd' },
      ctx,
    );
    expect(result.success).toBe(true);
    // Default currency (EUR) is always kept in the set.
    expect(mockGroups.update).toHaveBeenCalledWith(456, {
      enabled_currencies: ['USD', 'RSD', 'EUR'],
    });
  });

  test('returns a Russian error on an invalid currency and writes nothing', async () => {
    const result = await executeTool(
      'update_group_setting',
      { setting: 'default_currency', value: 'zzz' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('ZZZ');
    expect(mockGroups.update).not.toHaveBeenCalled();
  });

  test('rejects a system field as an unknown setting', async () => {
    const result = await executeTool(
      'update_group_setting',
      { setting: 'spreadsheet_id', value: 'x' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('spreadsheet_id');
    expect(mockGroups.update).not.toHaveBeenCalled();
  });

  test('returns an error when the group is missing', async () => {
    mockGroups.findById.mockReturnValue(null);
    const result = await executeTool(
      'update_group_setting',
      { setting: 'default_currency', value: 'usd' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(mockGroups.update).not.toHaveBeenCalled();
  });

  test('rejects a missing setting key (Russian error)', async () => {
    const result = await executeTool('update_group_setting', { value: 'usd' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('настройку');
    expect(mockGroups.update).not.toHaveBeenCalled();
  });

  test('rejects a non-string value (Russian error)', async () => {
    const result = await executeTool(
      'update_group_setting',
      { setting: 'default_currency', value: 123 },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('строкой');
    expect(mockGroups.update).not.toHaveBeenCalled();
  });

  test('active_topic_id is clear-only: a numeric value is rejected and nothing persists', async () => {
    const result = await executeTool(
      'update_group_setting',
      { setting: 'active_topic_id', value: '42' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('/topic');
    expect(mockGroups.update).not.toHaveBeenCalled();
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

describe('manage_category batch', () => {
  beforeEach(resetAllMocks);

  test('batch create with name array', async () => {
    const result = await executeTool(
      'manage_category',
      { action: 'create', name: ['Еда', 'Транспорт', 'Развлечения'] },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockCategories.create).toHaveBeenCalledTimes(3);
  });

  test('batch delete with name array', async () => {
    mockCategories.findByName.mockImplementation(((_gid: number, name: string) => ({
      id: name.length,
      group_id: 1,
      name,
      created_at: '',
    })) as unknown as () => Category | null);

    const result = await executeTool(
      'manage_category',
      { action: 'delete', name: ['Еда', 'Транспорт'] },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('2/2 succeeded');
  });

  test('single manage_category still works', async () => {
    const result = await executeTool('manage_category', { action: 'create', name: 'Еда' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('created');
  });

  test('empty name array returns error', async () => {
    const result = await executeTool('manage_category', { action: 'create', name: [] }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
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

describe('manage_recurring_pattern batch', () => {
  beforeEach(resetAllMocks);

  test('batch pause with pattern_id array', async () => {
    const result = await executeTool(
      'manage_recurring_pattern',
      { pattern_id: [1, 2, 3], action: 'pause' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockRecurringPatterns.updateStatus).toHaveBeenCalledTimes(3);
  });

  test('single pattern still works', async () => {
    const result = await executeTool(
      'manage_recurring_pattern',
      { pattern_id: 1, action: 'pause' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('paused');
  });

  test('empty pattern_id array returns error', async () => {
    const result = await executeTool(
      'manage_recurring_pattern',
      { pattern_id: [], action: 'pause' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
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

describe('get_bank_balances array bank_name', () => {
  beforeEach(resetAllMocks);

  test('accepts array of bank names and filters OR-match', async () => {
    const result = await executeTool('get_bank_balances', { bank_name: ['tbc-ge', 'kaspi'] }, ctx);

    expect(result.success).toBe(true);
    // Should include TBC (2 accounts) + Kaspi (1 account), exclude Monobank
    expect(result.data).toHaveLength(3);
    const bankNames = (result.data as Array<{ bank_name: string }>).map((a) => a.bank_name);
    expect(bankNames).toContain('tbc-ge');
    expect(bankNames).toContain('kaspi');
    expect(bankNames).not.toContain('monobank');
  });

  test('single string bank_name still works (backward compat)', async () => {
    const result = await executeTool('get_bank_balances', { bank_name: 'kaspi' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
  });

  test('bank_name "all" returns all accounts', async () => {
    const result = await executeTool('get_bank_balances', { bank_name: 'all' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(4);
  });

  test('array with "all" returns all accounts', async () => {
    const result = await executeTool('get_bank_balances', { bank_name: ['tbc-ge', 'all'] }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(4);
  });

  test('no matching bank returns helpful error with available banks', async () => {
    const result = await executeTool('get_bank_balances', { bank_name: ['nonexistent'] }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.summary).toContain('tbc-ge');
  });
});
