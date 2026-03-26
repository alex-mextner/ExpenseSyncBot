/**
 * Tool execution routing and implementation
 * Maps tool calls to database operations and services
 */
import type Big from 'big.js';
import { endOfMonth, format, startOfMonth, subMonths } from 'date-fns';
import { type CurrencyCode, SUPPORTED_CURRENCIES } from '../../config/constants';
import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';
import { evaluateCurrencyExpression } from '../currency/calculator';
import { convertCurrency, formatExchangeRatesForAI } from '../currency/converter';
import {
  createBudgetSheet,
  hasBudgetSheet,
  readBudgetData,
  writeBudgetRow,
} from '../google/sheets';
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

    const lines = [`Period: ${startDate} to ${endDate}`, `Total: EUR ${totalEur.toFixed(2)}`, ''];
    const sorted = Object.entries(totals).sort((a, b) => b[1].eur_total - a[1].eur_total);
    for (const [cat, data] of sorted) {
      const amountParts = Object.entries(data.amounts)
        .map(([c, a]) => `${a.toFixed(2)} ${c}`)
        .join(', ');
      lines.push(`${cat}: EUR ${data.eur_total.toFixed(2)} (${data.count} ops) [${amountParts}]`);
    }

    const output = lines.join('\n');
    logger.info(`[TOOL] get_expenses summary output:\n${output}`);
    return { success: true, output };
  }

  // Return individual expenses (paginated)
  const offset = (page - 1) * pageSize;
  const pageItems = expenses.slice(offset, offset + pageSize);
  const lines = [
    `Period: ${startDate} to ${endDate}`,
    `Total: ${expenses.length} expenses | Page ${page}/${totalPages}`,
    '',
  ];
  for (const e of pageItems) {
    lines.push(
      `[id:${e.id}] ${e.date} | ${e.category} | ${e.amount} ${e.currency} (EUR ${e.eur_amount.toFixed(2)}) | ${e.comment.trim() || '(no comment)'}`,
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
  let totalLimit = 0;
  let totalSpent = 0;

  for (const budget of budgets) {
    const spentEur = spendingByCategory[budget.category] || 0;
    const spentInCurrency = convertCurrency(spentEur, 'EUR', budget.currency);
    const remaining = budget.limit_amount - spentInCurrency;
    const percent =
      budget.limit_amount > 0 ? Math.round((spentInCurrency / budget.limit_amount) * 100) : 0;
    const status = remaining < 0 ? 'EXCEEDED' : percent >= 90 ? 'WARNING' : 'OK';

    lines.push(
      `${budget.category}: ${spentInCurrency.toFixed(2)}/${budget.limit_amount.toFixed(2)} ${budget.currency} (${percent}%) [${status}]`,
    );

    totalLimit += budget.limit_amount;
    totalSpent += spentInCurrency;
  }

  lines.push('');
  lines.push(
    `Total: ${totalSpent.toFixed(2)}/${totalLimit.toFixed(2)} (${Math.round((totalSpent / totalLimit) * 100)}%)`,
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

  if (!category || !amount || amount <= 0) {
    return { success: false, error: 'Invalid category or amount' };
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

  // Sync to Google Sheets
  if (group.google_refresh_token && group.spreadsheet_id) {
    try {
      const hasSheet = await hasBudgetSheet(group.google_refresh_token, group.spreadsheet_id);
      if (!hasSheet) {
        const categories = database.categories.getCategoryNames(ctx.groupId);
        await createBudgetSheet(
          group.google_refresh_token,
          group.spreadsheet_id,
          categories,
          100,
          currency,
        );
      }
      await writeBudgetRow(group.google_refresh_token, group.spreadsheet_id, {
        month,
        category,
        limit: amount,
        currency,
      });
    } catch (err) {
      logger.error({ err: err }, '[TOOL] Failed to write budget to Google Sheets');
      // Non-fatal: budget is saved in DB
    }
  }

  return {
    success: true,
    output: `Budget set: ${category} = ${amount.toFixed(2)} ${currency} for ${month}`,
  };
}

function executeDeleteBudget(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const category = input['category'] as string;
  const month = (input['month'] as string) || format(new Date(), 'yyyy-MM');

  if (!category) {
    return { success: false, error: 'Category is required' };
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
      output: `Expense added: ${amount.toFixed(2)} ${currency} (EUR ${eurAmount.toFixed(2)}) in ${category} on ${date}. ID: ${expense.id}`,
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

  const hasSheet = await hasBudgetSheet(group.google_refresh_token, group.spreadsheet_id);
  if (!hasSheet) {
    return { success: false, error: 'Budget sheet not found in Google Sheets' };
  }

  const budgetsFromSheet = await readBudgetData(group.google_refresh_token, group.spreadsheet_id);
  if (budgetsFromSheet.length === 0) {
    return { success: true, output: 'No budgets found in Google Sheets.' };
  }

  let syncedCount = 0;
  for (const budgetData of budgetsFromSheet) {
    if (!database.categories.exists(ctx.groupId, budgetData.category)) {
      database.categories.create({ group_id: ctx.groupId, name: budgetData.category });
    }

    const existing = database.budgets.findByGroupCategoryMonth(
      ctx.groupId,
      budgetData.category,
      budgetData.month,
    );

    const hasChanged =
      !existing ||
      existing.limit_amount !== budgetData.limit ||
      existing.currency !== budgetData.currency;

    if (hasChanged) {
      database.budgets.setBudget({
        group_id: ctx.groupId,
        category: budgetData.category,
        month: budgetData.month,
        limit_amount: budgetData.limit,
        currency: budgetData.currency,
      });
      syncedCount++;
    }
  }

  return {
    success: true,
    output: `Synced ${syncedCount} budget entries from Google Sheets.`,
  };
}

// === Settings tools ===

function executeSetCustomPrompt(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const prompt = input['prompt'] as string;

  if (prompt === undefined) {
    return { success: false, error: 'prompt is required' };
  }

  database.groups.update(ctx.telegramGroupId, {
    custom_prompt: prompt || null,
  });

  return {
    success: true,
    output: prompt ? `Custom prompt set (${prompt.length} chars)` : 'Custom prompt cleared',
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
    (input['target_currency'] as string | undefined) || group.default_currency || 'EUR';
  if (!SUPPORTED_CURRENCIES.includes(rawCurrency as CurrencyCode)) {
    return { success: false, error: `Unknown currency: "${rawCurrency}"` };
  }
  const targetCurrency = rawCurrency as CurrencyCode;

  const result = evaluateCurrencyExpression(expression, targetCurrency);
  if (result === null) {
    return { success: false, error: `Cannot evaluate expression: "${expression}"` };
  }

  const formatted = formatCalculatorResult(result.value);
  const output = result.hasCurrency ? `${formatted} ${targetCurrency}` : formatted;
  return { success: true, output };
}
