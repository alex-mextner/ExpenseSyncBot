/**
 * Tool execution routing and implementation
 * Maps tool calls to database operations and services
 */
import type Big from 'big.js';
import { endOfMonth, format, startOfMonth, subMonths } from 'date-fns';
import { marked } from 'marked';
import { BASE_CURRENCY, type CurrencyCode, SUPPORTED_CURRENCIES } from '../../config/constants';
import { env } from '../../config/env';
import { database } from '../../database';
import type { BankTransaction, BankTransactionFilters } from '../../database/types';
import { createLogger } from '../../utils/logger.ts';
import { sendMessage } from '../bank/telegram-sender';
import { evaluateCurrencyExpression } from '../currency/calculator';
import { convertCurrency, formatAmount, formatExchangeRatesForAI } from '../currency/converter';
import { renderTableToPng } from '../render/table-renderer.ts';
import type { AgentContext, ToolResult } from './types';

const logger = createLogger('tool-executor');

/**
 * Execute a tool by name with given input
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  try {
    // Pre-sync for tools that read expense/budget data
    const needsExpenseSync = ['get_expenses', 'add_expense', 'delete_expense'].includes(name);
    const needsBudgetSync = ['get_budgets', 'set_budget', 'delete_budget'].includes(name);

    if (needsExpenseSync) {
      const { ensureFreshExpenses } = await import('../../bot/commands/sync');
      await ensureFreshExpenses(ctx.groupId);
    }
    if (needsBudgetSync) {
      const { ensureFreshBudgets } = await import('../../bot/commands/budget');
      await ensureFreshBudgets(ctx.groupId);
    }

    switch (name) {
      case 'get_expenses':
        return await executeGetExpenses(input, ctx);
      case 'get_budgets':
        return await executeGetBudgets(input, ctx);
      case 'get_categories':
        return executeGetCategories(ctx);
      case 'get_group_settings':
        return executeGetGroupSettings(ctx);
      case 'get_exchange_rates':
        return executeGetExchangeRates();
      case 'set_budget':
        return await executeSetBudget(input, ctx);
      case 'delete_budget':
        return executeDeleteBudget(input, ctx);
      case 'add_expense':
        return await executeAddExpense(input, ctx);
      case 'delete_expense':
        return executeDeleteExpense(input, ctx);
      case 'sync_from_sheets':
        return await executeSyncFromSheets(ctx);
      case 'sync_budgets':
        return await executeSyncBudgets(ctx);
      case 'set_custom_prompt':
        return executeSetCustomPrompt(input, ctx);
      case 'manage_category':
        return executeManageCategory(input, ctx);
      case 'calculate':
        return executeCalculate(input, ctx);
      case 'get_bank_transactions':
        return executeGetBankTransactions(input, ctx);
      case 'get_bank_balances':
        return executeGetBankBalances(input, ctx);
      case 'find_missing_expenses':
        return await executeFindMissingExpenses(input, ctx);
      case 'render_table':
        return executeRenderTable(input, ctx);
      case 'send_feedback':
        return await executeSendFeedback(input, ctx);
      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (error) {
    logger.error({ err: error }, `[TOOL] Error executing ${name}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// === Read tools ===

async function executeGetExpenses(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const period = (input['period'] as string) || 'current_month';
  const category = input['category'] as string | undefined;
  const pageSize = Math.min(Math.max((input['page_size'] as number) || 100, 1), 500);
  const page = Math.max((input['page'] as number) || 1, 1);
  const summaryOnly = (input['summary_only'] as boolean) || false;

  const now = new Date();
  let startDate: string;
  let endDate: string = format(now, 'yyyy-MM-dd');

  switch (period) {
    case 'current_month':
      startDate = format(startOfMonth(now), 'yyyy-MM-dd');
      endDate = format(endOfMonth(now), 'yyyy-MM-dd');
      break;
    case 'last_month': {
      const lastMonth = subMonths(now, 1);
      startDate = format(startOfMonth(lastMonth), 'yyyy-MM-dd');
      endDate = format(endOfMonth(lastMonth), 'yyyy-MM-dd');
      break;
    }
    case 'last_3_months':
      startDate = format(startOfMonth(subMonths(now, 2)), 'yyyy-MM-dd');
      break;
    case 'last_6_months':
      startDate = format(startOfMonth(subMonths(now, 5)), 'yyyy-MM-dd');
      break;
    case 'all':
      startDate = '2000-01-01';
      break;
    default:
      // Specific month "YYYY-MM"
      if (/^\d{4}-\d{2}$/.test(period)) {
        startDate = `${period}-01`;
        const monthDate = new Date(`${period}-01`);
        endDate = format(endOfMonth(monthDate), 'yyyy-MM-dd');
      } else {
        startDate = format(startOfMonth(now), 'yyyy-MM-dd');
        endDate = format(endOfMonth(now), 'yyyy-MM-dd');
      }
  }

  let expenses = database.expenses.findByDateRange(ctx.groupId, startDate, endDate);

  // Filter by category (case-insensitive)
  if (category) {
    const categoryLower = category.toLowerCase();
    expenses = expenses.filter((e) => e.category.toLowerCase() === categoryLower);
  }

  const totalPages = summaryOnly ? 1 : Math.max(1, Math.ceil(expenses.length / pageSize));

  logger.info(
    `[TOOL] get_expenses: period=${period} (${startDate}–${endDate}), category=${category || 'all'}, found=${expenses.length}, page=${page}/${totalPages}, page_size=${pageSize}, summary=${summaryOnly}`,
  );

  if (summaryOnly) {
    // Aggregate by category
    const totals: Record<
      string,
      { count: number; eur_total: number; amounts: Record<string, number> }
    > = {};
    for (const e of expenses) {
      const existing = totals[e.category];
      const cat = existing ?? { count: 0, eur_total: 0, amounts: {} };
      totals[e.category] = cat;
      cat.count++;
      cat.eur_total += e.eur_amount;
      cat.amounts[e.currency] = (cat.amounts[e.currency] || 0) + e.amount;
    }

    const totalEur = Object.values(totals).reduce((s, c) => s + c.eur_total, 0);
    const group = database.groups.findById(ctx.groupId);
    const displayCurrency = group?.default_currency ?? BASE_CURRENCY;
    const totalDisplay = convertCurrency(totalEur, BASE_CURRENCY, displayCurrency);

    const lines = [
      `Period: ${startDate} to ${endDate}`,
      `Total: ${formatAmount(totalDisplay, displayCurrency, true)}`,
      '',
    ];
    const sorted = Object.entries(totals).sort((a, b) => b[1].eur_total - a[1].eur_total);
    for (const [cat, data] of sorted) {
      const amountParts = Object.entries(data.amounts)
        .map(([c, a]) => formatAmount(a, c as CurrencyCode, true))
        .join(', ');
      const catDisplay = convertCurrency(data.eur_total, BASE_CURRENCY, displayCurrency);
      lines.push(
        `${cat}: ${formatAmount(catDisplay, displayCurrency, true)} (${data.count} ops) [${amountParts}]`,
      );
    }

    const output = lines.join('\n');
    logger.info(`[TOOL] get_expenses summary output:\n${output}`);
    return { success: true, output };
  }

  // Return individual expenses (paginated)
  const offset = (page - 1) * pageSize;
  const pageItems = expenses.slice(offset, offset + pageSize);
  const group = database.groups.findById(ctx.groupId);
  const displayCurrency = group?.default_currency ?? BASE_CURRENCY;
  const totalEur = expenses.reduce((s, e) => s + e.eur_amount, 0);
  const totalDisplay = convertCurrency(totalEur, BASE_CURRENCY, displayCurrency);
  const lines = [
    `Period: ${startDate} to ${endDate}`,
    `Total: ${expenses.length} expenses | Grand total: ${formatAmount(totalDisplay, displayCurrency, true)} | Page ${page}/${totalPages}`,
    '',
  ];
  for (const e of pageItems) {
    lines.push(
      `[id:${e.id}] ${e.date} | ${e.category} | ${formatAmount(e.amount, e.currency, true)} (EUR ${formatAmount(e.eur_amount, BASE_CURRENCY, true)}) | ${e.comment.trim() || '(no comment)'}`,
    );
  }

  const output = lines.join('\n');
  logger.info(`[TOOL] get_expenses output (first 5 lines):\n${lines.slice(0, 5).join('\n')}`);
  return { success: true, output };
}

async function executeGetBudgets(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const month = (input['month'] as string) || format(new Date(), 'yyyy-MM');
  const categoryFilter = input['category'] as string | undefined;

  let budgets = database.budgets.getAllBudgetsForMonth(ctx.groupId, month);

  if (categoryFilter) {
    const filterLower = categoryFilter.toLowerCase();
    budgets = budgets.filter((b) => b.category.toLowerCase() === filterLower);
  }

  if (budgets.length === 0) {
    return { success: true, output: `No budgets set for ${month}.` };
  }

  // Calculate spending for each budget category
  const monthStart = `${month}-01`;
  const monthEnd = format(endOfMonth(new Date(`${month}-01`)), 'yyyy-MM-dd');
  const expenses = database.expenses.findByDateRange(ctx.groupId, monthStart, monthEnd);

  const spendingByCategory: Record<string, number> = {};
  for (const e of expenses) {
    spendingByCategory[e.category] = (spendingByCategory[e.category] || 0) + e.eur_amount;
  }

  const lines = [`Budgets for ${month}:`, ''];
  const totalsByCurrency: Record<string, { spent: number; limit: number }> = {};

  for (const budget of budgets) {
    const spentEur = spendingByCategory[budget.category] || 0;
    const spentInCurrency = convertCurrency(spentEur, BASE_CURRENCY, budget.currency);
    const remaining = budget.limit_amount - spentInCurrency;
    const percent =
      budget.limit_amount > 0 ? Math.round((spentInCurrency / budget.limit_amount) * 100) : 0;
    const status = remaining < 0 ? 'EXCEEDED' : percent >= 90 ? 'WARNING' : 'OK';

    lines.push(
      `${budget.category}: ${formatAmount(spentInCurrency, budget.currency, true)}/${formatAmount(budget.limit_amount, budget.currency, true)} (${percent}%) [${status}]`,
    );

    const existing = totalsByCurrency[budget.currency];
    if (existing) {
      existing.spent += spentInCurrency;
      existing.limit += budget.limit_amount;
    } else {
      totalsByCurrency[budget.currency] = { spent: spentInCurrency, limit: budget.limit_amount };
    }
  }

  // Grand total in display currency
  const group = database.groups.findById(ctx.groupId);
  const displayCurrency = group?.default_currency ?? BASE_CURRENCY;
  let grandSpentEur = 0;
  let grandLimitEur = 0;
  for (const budget of budgets) {
    const spentEur = spendingByCategory[budget.category] || 0;
    grandSpentEur += spentEur;
    grandLimitEur += convertCurrency(
      budget.limit_amount,
      budget.currency as CurrencyCode,
      BASE_CURRENCY,
    );
  }
  const grandSpentDisplay = convertCurrency(grandSpentEur, BASE_CURRENCY, displayCurrency);
  const grandLimitDisplay = convertCurrency(grandLimitEur, BASE_CURRENCY, displayCurrency);
  const grandPct =
    grandLimitDisplay > 0 ? Math.round((grandSpentDisplay / grandLimitDisplay) * 100) : 0;

  lines.push('');
  lines.push(
    `Grand Total: ${formatAmount(grandSpentDisplay, displayCurrency, true)}/${formatAmount(grandLimitDisplay, displayCurrency, true)} (${grandPct}%)`,
  );

  return { success: true, output: lines.join('\n') };
}

function executeGetCategories(ctx: AgentContext): ToolResult {
  const categories = database.categories.findByGroupId(ctx.groupId);
  if (categories.length === 0) {
    return { success: true, output: 'No categories defined.' };
  }
  return {
    success: true,
    output: categories.map((c) => c.name).join(', '),
  };
}

function executeGetGroupSettings(ctx: AgentContext): ToolResult {
  const group = database.groups.findById(ctx.groupId);
  if (!group) {
    return { success: false, error: 'Group not found' };
  }

  const lines = [
    `Default currency: ${group.default_currency}`,
    `Enabled currencies: ${group.enabled_currencies.join(', ')}`,
    `Spreadsheet: ${group.spreadsheet_id ? 'connected' : 'not connected'}`,
    `Custom prompt: ${group.custom_prompt ? 'set' : 'not set'}`,
  ];

  if (group.custom_prompt) {
    lines.push(`Custom prompt text: ${group.custom_prompt}`);
  }

  return { success: true, output: lines.join('\n') };
}

function executeGetExchangeRates(): ToolResult {
  return { success: true, output: formatExchangeRatesForAI() };
}

// === Write tools ===

async function executeSetBudget(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const category = input['category'] as string;
  const amount = input['amount'] as number;
  const month = (input['month'] as string) || format(new Date(), 'yyyy-MM');

  if (!category) {
    return { success: false, error: 'category is required' };
  }
  if (amount === undefined || amount === null || amount < 0 || Number.isNaN(amount)) {
    return {
      success: false,
      error: `Invalid amount "${amount}" — must be a non-negative number (0 to disable a budget category)`,
    };
  }

  const group = database.groups.findById(ctx.groupId);
  if (!group) {
    return { success: false, error: 'Group not found' };
  }

  const currency = (input['currency'] as CurrencyCode) || group.default_currency;

  // Ensure category exists
  if (!database.categories.exists(ctx.groupId, category)) {
    database.categories.create({ group_id: ctx.groupId, name: category });
  }

  // Save budget
  database.budgets.setBudget({
    group_id: ctx.groupId,
    category,
    month,
    limit_amount: amount,
    currency,
  });

  return {
    success: true,
    output: `Budget set: ${category} = ${formatAmount(amount, currency, true)} for ${month}`,
  };
}

function executeDeleteBudget(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const category = input['category'] as string;
  const month = (input['month'] as string) || format(new Date(), 'yyyy-MM');

  if (!category) {
    return { success: false, error: 'category is required' };
  }

  database.budgets.deleteByGroupCategoryMonth(ctx.groupId, category, month);

  return {
    success: true,
    output: `Budget deleted for ${category} in ${month}`,
  };
}

async function executeAddExpense(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const amount = input['amount'] as number;
  const category = input['category'] as string;
  const comment = (input['comment'] as string) || '';
  const date = (input['date'] as string) || format(new Date(), 'yyyy-MM-dd');

  if (!amount || amount <= 0 || !category) {
    return { success: false, error: 'Invalid amount or category' };
  }

  const group = database.groups.findById(ctx.groupId);
  if (!group) {
    return { success: false, error: 'Group not found' };
  }

  const currency = (input['currency'] as CurrencyCode) || group.default_currency;

  // Ensure category exists
  if (!database.categories.exists(ctx.groupId, category)) {
    database.categories.create({ group_id: ctx.groupId, name: category });
  }

  // Record via ExpenseRecorder (handles sheet write, EUR conversion, rate storage, DB insert)
  const { getExpenseRecorder } = await import('../expense-recorder');
  const recorder = getExpenseRecorder();

  try {
    const { expense, eurAmount } = await recorder.record(ctx.groupId, ctx.userId, {
      date,
      category,
      comment,
      amount,
      currency,
    });

    return {
      success: true,
      output: `Expense added: ${formatAmount(amount, currency, true)} (EUR ${formatAmount(eurAmount, BASE_CURRENCY, true)}) in ${category} on ${date}. ID: ${expense.id}`,
    };
  } catch (err) {
    logger.error({ err: err }, '[TOOL] Failed to add expense');
    return {
      success: false,
      error: `Failed to add expense: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }
}

function executeDeleteExpense(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const expenseId = input['expense_id'] as number;

  if (!expenseId) {
    return { success: false, error: 'expense_id is required' };
  }

  // SECURITY: Verify expense belongs to this group
  const expense = database.expenses.findById(expenseId);
  if (!expense) {
    return { success: false, error: `Expense with ID ${expenseId} not found` };
  }

  if (expense.group_id !== ctx.groupId) {
    return { success: false, error: 'Access denied: expense belongs to a different group' };
  }

  database.expenses.delete(expenseId);

  return {
    success: true,
    output: `Expense ${expenseId} deleted (${expense.date} | ${expense.category} | ${expense.amount} ${expense.currency}). Note: run /sync to update Google Sheets.`,
  };
}

// === Sync tools ===

async function executeSyncFromSheets(ctx: AgentContext): Promise<ToolResult> {
  try {
    const { syncExpenses } = await import('../../bot/commands/sync');
    const result = await syncExpenses(ctx.groupId);

    if (result.errors.length > 0) {
      const lines = result.errors.map(
        (e) => `Row ${e.row}: ${e.date} ${e.category} — currencies: ${e.currencies.join(', ')}`,
      );
      return {
        success: false,
        error: `Found ${result.errors.length} rows with amounts in multiple currency columns:\n${lines.join('\n')}`,
      };
    }

    return {
      success: true,
      output: `Sync complete. Added: ${result.added.length}, Deleted: ${result.deleted.length}, Updated: ${result.updated.length}, Unchanged: ${result.unchanged}, New categories: ${result.createdCategories.length}`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Sync failed: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }
}

async function executeSyncBudgets(ctx: AgentContext): Promise<ToolResult> {
  const group = database.groups.findById(ctx.groupId);
  if (!group || !group.google_refresh_token || !group.spreadsheet_id) {
    return { success: false, error: 'Google Sheets not connected' };
  }

  try {
    const { silentSyncBudgets } = await import('../../bot/commands/budget');
    await silentSyncBudgets(group.google_refresh_token, ctx.groupId);
    return { success: true, output: 'Budgets synced to Google Sheets.' };
  } catch (err) {
    logger.error({ err }, '[TOOL] executeSyncBudgets failed');
    return { success: false, error: 'Sync failed' };
  }
}

// === Settings tools ===

function executeSetCustomPrompt(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const prompt = input['prompt'] as string;
  const mode = (input['mode'] as string) ?? 'set';

  if (prompt === undefined) {
    return { success: false, error: 'prompt is required' };
  }

  let newPrompt: string | null;
  if (mode === 'append') {
    const existing = ctx.customPrompt ?? '';
    newPrompt = existing ? `${existing}\n\n${prompt}` : prompt || null;
  } else {
    newPrompt = prompt || null;
  }

  database.groups.update(ctx.telegramGroupId, { custom_prompt: newPrompt });

  return {
    success: true,
    output: newPrompt
      ? `Custom prompt updated (${newPrompt.length} chars total)`
      : 'Custom prompt cleared',
  };
}

function executeManageCategory(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const action = input['action'] as string;
  const name = input['name'] as string;

  if (!action || !name) {
    return { success: false, error: 'action and name are required' };
  }

  if (action === 'create') {
    const existing = database.categories.findByName(ctx.groupId, name);
    if (existing) {
      return { success: true, output: `Category "${existing.name}" already exists.` };
    }
    const created = database.categories.create({ group_id: ctx.groupId, name });
    return { success: true, output: `Category "${created.name}" created.` };
  }

  if (action === 'delete') {
    const existing = database.categories.findByName(ctx.groupId, name);
    if (!existing) {
      return { success: false, error: `Category "${name}" not found.` };
    }
    database.categories.delete(existing.id);
    return { success: true, output: `Category "${existing.name}" deleted.` };
  }

  return { success: false, error: `Unknown action: ${action}` };
}

/**
 * Format a calculator result.
 * Values >= 1,000,000 use scientific notation (e.g. 1.26e8).
 * Smaller values are rounded to 2 decimal places with trailing zeros stripped.
 */
function formatCalculatorResult(n: Big): string {
  if (n.abs().gte(1_000_000)) {
    // 4 significant figures, strip trailing zeros and normalize exponent sign
    return n
      .toExponential(3)
      .replace(/\.?0+(e)/, '$1')
      .replace('e+', 'e');
  }
  return n.toFixed(2).replace(/\.?0+$/, '');
}

function executeCalculate(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const expression = input['expression'] as string;
  if (!expression) {
    return { success: false, error: 'expression is required' };
  }

  const group = database.groups.findById(ctx.groupId);
  if (!group) {
    return { success: false, error: 'Group not found' };
  }
  const rawCurrency =
    (input['target_currency'] as string | undefined) || group.default_currency || BASE_CURRENCY;
  if (!SUPPORTED_CURRENCIES.includes(rawCurrency as CurrencyCode)) {
    return { success: false, error: `Unknown currency: "${rawCurrency}"` };
  }
  const targetCurrency = rawCurrency as CurrencyCode;

  const result = evaluateCurrencyExpression(expression, targetCurrency);
  if (result === null) {
    const cleaned = expression.replace(/\s+/g, '');
    let hint: string;
    if (cleaned.length > 500) {
      hint = 'expression too long (max 500 chars)';
    } else if (!/\d/.test(expression)) {
      hint = 'no numbers found in expression';
    } else if (!/[+\-*/×]/.test(expression) && !/\d\s+\d/.test(expression)) {
      // Single number with optional currency — might just need no operator
      hint =
        'single value with no operator; if this is a currency conversion (e.g. "90000 RSD"), it should work — check currency spelling';
    } else if (/[^0-9+\-*/×÷.,% A-Za-zА-Яа-яёЁ$€£¥₽₸₴₼฿]/.test(expression)) {
      hint = 'expression contains unsupported characters';
    } else {
      hint =
        'check that operators (+−×÷) are between numbers, no parentheses, currency codes are correct';
    }
    return { success: false, error: `Cannot evaluate: "${expression}" — ${hint}` };
  }

  const formatted = formatCalculatorResult(result.value);
  const output = result.hasCurrency ? `${formatted} ${targetCurrency}` : formatted;
  return { success: true, output };
}

// === Bank tools ===

function executeGetBankTransactions(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const filters: BankTransactionFilters = {};
  if (typeof input['period'] === 'string') filters.period = input['period'];
  if (typeof input['bank_name'] === 'string') filters.bank_name = input['bank_name'];
  if (typeof input['status'] === 'string') {
    filters.status = input['status'] as BankTransaction['status'];
  }

  const transactions = database.bankTransactions.findByGroupId(ctx.groupId, filters);

  return {
    success: true,
    data: transactions.map((tx) => ({
      id: tx.id,
      date: tx.date,
      amount: tx.amount,
      currency: tx.currency,
      merchant: tx.merchant_normalized ?? tx.merchant,
      category_suggestion: null,
      status: tx.status,
      sign_type: tx.sign_type,
    })),
  };
}

function executeGetBankBalances(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const bankNameFilter =
    typeof input['bank_name'] === 'string' ? input['bank_name'].toLowerCase() : undefined;
  const includeExcluded = input['include_excluded'] === true;

  const accounts = database.bankAccounts.findByGroupId(ctx.groupId, includeExcluded);
  const filtered = bankNameFilter
    ? accounts.filter((a) => {
        const conn = database.bankConnections.findById(a.connection_id);
        return conn?.bank_name.toLowerCase().includes(bankNameFilter);
      })
    : accounts;

  if (filtered.length === 0) {
    // Check if there are accounts at all (ignoring the bank_name filter)
    if (bankNameFilter) {
      const allAccounts = database.bankAccounts.findByGroupId(ctx.groupId, true);
      if (allAccounts.length > 0) {
        const availableBanks = [
          ...new Set(
            allAccounts
              .map((a) => database.bankConnections.findById(a.connection_id)?.bank_name)
              .filter((n): n is string => Boolean(n)),
          ),
        ].join(', ');
        return {
          success: true,
          data: [],
          summary: `No accounts found matching bank_name filter "${bankNameFilter}". Available bank keys: ${availableBanks}. Retry without bank_name to see all accounts.`,
        };
      }
    }

    const connections = database.bankConnections.findActiveByGroupId(ctx.groupId);
    if (connections.length === 0) {
      return {
        success: true,
        data: [],
        summary:
          'No bank connections configured. Use /bank to connect a bank (NOT /connect — that is for Google Sheets).',
      };
    }
    return {
      success: true,
      data: [],
      summary: `Banks are connected (${connections.map((c) => c.display_name).join(', ')}) but the first sync has not completed yet. Balances will appear after sync. Do NOT say the bank is not connected.`,
    };
  }

  return {
    success: true,
    data: filtered.map((a) => ({
      bank_name: database.bankConnections.findById(a.connection_id)?.bank_name,
      account_title: a.title,
      balance: a.balance,
      currency: a.currency,
      type: a.type,
      is_excluded: a.is_excluded === 1,
    })),
  };
}

async function executeFindMissingExpenses(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const period = typeof input['period'] === 'string' ? input['period'] : 'current_month';
  const { startDate, endDate } = resolvePeriodDates(period);

  const unmatched = database.bankTransactions.findUnmatched(ctx.groupId, startDate, endDate);
  const expenses = database.expenses.findByDateRange(ctx.groupId, startDate, endDate);

  const results = unmatched.map((tx) => {
    // Try exact match: same amount, currency, and within 2 days
    const exactMatch = expenses.find(
      (e) =>
        Math.abs(e.amount - tx.amount) < 0.01 &&
        e.currency === tx.currency &&
        Math.abs(new Date(e.date).getTime() - new Date(tx.date).getTime()) <= 2 * 86400 * 1000,
    );

    if (exactMatch) {
      return null; // matched
    }

    // Try probable match: same amount, currency, within 5 days
    const probableMatch = expenses.find(
      (e) =>
        Math.abs(e.amount - tx.amount) < 0.01 &&
        e.currency === tx.currency &&
        Math.abs(new Date(e.date).getTime() - new Date(tx.date).getTime()) <= 5 * 86400 * 1000,
    );

    return {
      tx_id: tx.id,
      date: tx.date,
      amount: tx.amount,
      currency: tx.currency,
      merchant: tx.merchant_normalized ?? tx.merchant,
      status: probableMatch ? 'probable_match' : 'missing',
      probable_expense_id: probableMatch?.id ?? null,
    };
  });

  const missing = results.filter(Boolean);

  return {
    success: true,
    data: missing,
    summary: `${missing.length} транзакций без записи в расходах за период ${startDate}–${endDate}`,
  };
}

function resolvePeriodDates(period: string): { startDate: string; endDate: string } {
  const now = new Date();
  if (period === 'current_month') {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
    return { startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${lastDay}` };
  }
  if (period === 'last_month') {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(y, d.getMonth() + 1, 0).getDate();
    return { startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${lastDay}` };
  }
  // Specific month "YYYY-MM"
  const [year, month] = period.split('-').map(Number);
  if (year && month) {
    const lastDay = new Date(year, month, 0).getDate();
    return {
      startDate: `${year}-${String(month).padStart(2, '0')}-01`,
      endDate: `${year}-${String(month).padStart(2, '0')}-${lastDay}`,
    };
  }
  return { startDate: '2000-01-01', endDate: '2099-12-31' };
}

// === Render tools ===

function executeRenderTable(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  if (!ctx.sendPhoto) {
    return { success: false, error: 'Image rendering not available in this context.' };
  }

  const title = input['title'] as string;
  const markdown = input['markdown'] as string;
  const caption = input['caption'] as string | undefined;

  if (!title || !markdown) {
    return { success: false, error: 'title and markdown are required' };
  }

  // Validate markdown table structure before firing off the render
  const hasTable = marked.lexer(markdown).some((t) => t.type === 'table');
  if (!hasTable) {
    return {
      success: false,
      error:
        'Invalid markdown table: could not parse headers. Expected format: "| Col1 | Col2 |\\n|---|---|\\n| v1 | v2 |"',
    };
  }

  const sendPhoto = ctx.sendPhoto;

  renderTableToPng({ title, markdown, caption })
    .then((buffer: Buffer) => sendPhoto(buffer))
    .catch((err: Error) => logger.error({ err }, 'render_table: failed to render or send'));

  return { success: true, output: 'Таблица отрисовывается и будет отправлена в чат.' };
}

// === Feedback tool ===

async function executeSendFeedback(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const message = input['message'] as string;
  if (!message) return { success: false, error: 'message is required' };
  if (!env.BOT_ADMIN_CHAT_ID) return { success: false, error: 'Admin feedback not configured' };

  const group = database.groups.findById(ctx.groupId);
  const groupLabel = group ? `<b>${group.telegram_group_id}</b>` : String(ctx.chatId);
  const text = `💬 Фидбек из группы ${groupLabel}:\n\n${message}`;
  await sendMessage(env.BOT_TOKEN, env.BOT_ADMIN_CHAT_ID, text);
  return { success: true, output: 'Фидбек отправлен администратору.' };
}
