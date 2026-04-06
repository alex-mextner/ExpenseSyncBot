/**
 * Tool execution routing and implementation
 * Maps tool calls to database operations and services
 */
import type Big from 'big.js';
import { endOfMonth, format } from 'date-fns';
import { marked } from 'marked';
import { BASE_CURRENCY, type CurrencyCode, SUPPORTED_CURRENCIES } from '../../config/constants';
import { database } from '../../database';
import type { BankTransaction, BankTransactionFilters, Expense } from '../../database/types';
import { getErrorMessage } from '../../utils/error';
import { createLogger } from '../../utils/logger.ts';
import { normalizeArrayParam, resolvePeriodDates } from '../../utils/period';
import { pluralize } from '../../utils/pluralize';
import { getBudgetManager } from '../budget-manager';
import { evaluateCurrencyExpression } from '../currency/calculator';
import { convertCurrency, formatAmount, formatExchangeRatesForAI } from '../currency/converter';
import { googleConn } from '../google/sheets';
import { renderTableToPng } from '../render/table-renderer.ts';
import {
  computeExpenseStats,
  type ExpenseStats,
  formatStats,
  formatStatsDiff,
  formatStatsTrend,
  type TrendEntry,
} from './stats';
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
      const { ensureFreshBudgets } = await import('../../bot/services/budget-sync');
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
        return await executeDeleteBudget(input, ctx);
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
      case 'get_technical_analysis':
        return executeGetTechnicalAnalysis(input, ctx);
      case 'get_recurring_patterns':
        return executeGetRecurringPatterns(ctx);
      case 'manage_recurring_pattern':
        return executeManageRecurringPattern(input, ctx);
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
      error: getErrorMessage(error),
    };
  }
}

// === Read tools ===

async function executeGetExpenses(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const periods = normalizeArrayParam(input['period'], 'current_month');
  const categories = normalizeArrayParam(input['category']);
  const pageSize = Math.min(Math.max((input['page_size'] as number) || 100, 1), 500);
  const page = Math.max((input['page'] as number) || 1, 1);
  const summaryOnly = (input['summary_only'] as boolean) || false;

  const group = database.groups.findById(ctx.groupId);
  const displayCurrency = (group?.default_currency ?? BASE_CURRENCY) as CurrencyCode;

  // Resolve all periods and fetch expenses
  const periodData: { label: string; startDate: string; endDate: string; expenses: Expense[] }[] =
    [];

  for (const period of periods) {
    const { startDate, endDate } = resolvePeriodDates(period);
    let expenses = database.expenses.findByDateRange(ctx.groupId, startDate, endDate);

    if (categories.length > 0) {
      const lowerCategories = categories.map((c) => c.toLowerCase());
      expenses = expenses.filter((e) => lowerCategories.includes(e.category.toLowerCase()));
    }

    periodData.push({ label: period, startDate, endDate, expenses });
  }

  const isBatch = periods.length > 1;
  const allExpenses = periodData.flatMap((p) => p.expenses);

  if (summaryOnly) {
    return buildSummaryOutput(periodData, allExpenses, displayCurrency, isBatch);
  }

  return buildDetailOutput(periodData, allExpenses, displayCurrency, isBatch, page, pageSize);
}

function buildSummaryOutput(
  periodData: { label: string; startDate: string; endDate: string; expenses: Expense[] }[],
  allExpenses: Expense[],
  displayCurrency: CurrencyCode,
  isBatch: boolean,
): ToolResult {
  const lines: string[] = [];
  const perPeriodStats: ExpenseStats[] = [];

  for (const pd of periodData) {
    if (isBatch) lines.push(`=== ${pd.label} ===`);
    lines.push(`Period: ${pd.startDate} to ${pd.endDate}`);

    if (pd.expenses.length === 0) {
      perPeriodStats.push({ count: 0, total: 0, avg: 0, median: 0, min: null, max: null });
      lines.push('No expenses', '');
      continue;
    }

    // Category aggregation
    const totals: Record<
      string,
      { count: number; eur_total: number; amounts: Record<string, number> }
    > = {};
    for (const e of pd.expenses) {
      const existing = totals[e.category];
      const cat = existing ?? { count: 0, eur_total: 0, amounts: {} };
      totals[e.category] = cat;
      cat.count++;
      cat.eur_total += e.eur_amount;
      cat.amounts[e.currency] = (cat.amounts[e.currency] || 0) + e.amount;
    }

    const totalEur = Object.values(totals).reduce((s, c) => s + c.eur_total, 0);
    const totalDisplay = convertCurrency(totalEur, BASE_CURRENCY, displayCurrency);
    lines.push(`Total: ${formatAmount(totalDisplay, displayCurrency, true)}`, '');

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

    // Per-period stats
    const stats = computeExpenseStats(pd.expenses, displayCurrency);
    perPeriodStats.push(stats);
    lines.push('', `=== Stats${isBatch ? ` (${pd.label})` : ''} ===`);
    lines.push(formatStats(stats, displayCurrency));
    lines.push('');
  }

  // Overall stats for batch
  if (isBatch && allExpenses.length > 0) {
    const overallStats = computeExpenseStats(allExpenses, displayCurrency);
    const overallEur = allExpenses.reduce((s, e) => s + e.eur_amount, 0);
    const overallDisplay = convertCurrency(overallEur, BASE_CURRENCY, displayCurrency);
    lines.push('=== Overall ===');
    lines.push(`Total: ${formatAmount(overallDisplay, displayCurrency, true)}`);
    lines.push(formatStats(overallStats, displayCurrency));
    lines.push('');

    // Diff for exactly 2 periods
    if (
      periodData.length === 2 &&
      perPeriodStats[0] &&
      perPeriodStats[1] &&
      periodData[0] &&
      periodData[1]
    ) {
      lines.push(
        formatStatsDiff(
          perPeriodStats[0],
          perPeriodStats[1],
          periodData[0].label,
          periodData[1].label,
          displayCurrency,
          periodData[0].expenses,
          periodData[1].expenses,
        ),
      );
    }

    // Trend for 3+ periods
    if (periodData.length >= 3) {
      const entries: TrendEntry[] = [];
      for (let i = 0; i < periodData.length; i++) {
        const pd = periodData[i];
        const stats = perPeriodStats[i];
        if (pd && stats) entries.push({ label: pd.label, stats });
      }
      lines.push(formatStatsTrend(entries, displayCurrency));
    }
  }

  const output = lines.join('\n');
  logger.info(
    `[TOOL] get_expenses summary output (${allExpenses.length} expenses, ${periodData.length} periods)`,
  );
  return { success: true, output };
}

function buildDetailOutput(
  periodData: { label: string; startDate: string; endDate: string; expenses: Expense[] }[],
  allExpenses: Expense[],
  displayCurrency: CurrencyCode,
  isBatch: boolean,
  page: number,
  pageSize: number,
): ToolResult {
  // Sort all expenses by date desc
  allExpenses.sort((a, b) => b.date.localeCompare(a.date));

  const totalPages = Math.max(1, Math.ceil(allExpenses.length / pageSize));
  const offset = (page - 1) * pageSize;
  const pageItems = allExpenses.slice(offset, offset + pageSize);

  const totalEur = allExpenses.reduce((s, e) => s + e.eur_amount, 0);
  const totalDisplay = convertCurrency(totalEur, BASE_CURRENCY, displayCurrency);

  const firstPeriod = periodData[0];
  const lastPeriod = periodData[periodData.length - 1];
  const dateRange =
    isBatch && firstPeriod && lastPeriod
      ? `${firstPeriod.startDate} to ${lastPeriod.endDate}`
      : `${firstPeriod?.startDate ?? '?'} to ${firstPeriod?.endDate ?? '?'}`;

  const lines = [
    `Period: ${dateRange}`,
    `Total: ${allExpenses.length} expenses | Grand total: ${formatAmount(totalDisplay, displayCurrency, true)} | Page ${page}/${totalPages}`,
    '',
  ];

  // Stats for ALL expenses (not just page)
  const allStats = computeExpenseStats(allExpenses, displayCurrency);
  lines.push('=== Stats (all) ===');
  lines.push(formatStats(allStats, displayCurrency));
  lines.push('');

  // Stats for current page
  if (totalPages > 1) {
    const pageStats = computeExpenseStats(pageItems, displayCurrency);
    lines.push(`=== Stats (page ${page}) ===`);
    lines.push(formatStats(pageStats, displayCurrency));
    lines.push('');
  }

  for (const e of pageItems) {
    lines.push(
      `[id:${e.id}] ${e.date} | ${e.category} | ${formatAmount(e.amount, e.currency, true)} (EUR ${formatAmount(e.eur_amount, BASE_CURRENCY, true)}) | ${e.comment.trim() || '(no comment)'}`,
    );
  }

  const output = lines.join('\n');
  logger.info(
    `[TOOL] get_expenses detail output (page ${page}/${totalPages}, ${allExpenses.length} total)`,
  );
  return { success: true, output };
}

async function executeGetBudgets(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const months = normalizeArrayParam(input['month'], format(new Date(), 'yyyy-MM'));
  const categories = normalizeArrayParam(input['category']);
  const isBatch = months.length > 1;

  const group = database.groups.findById(ctx.groupId);
  const displayCurrency = (group?.default_currency ?? BASE_CURRENCY) as CurrencyCode;

  const allLines: string[] = [];
  let grandTotalEur = 0;

  for (const month of months) {
    let budgets = database.budgets.getAllBudgetsForMonth(ctx.groupId, month);

    if (categories.length > 0) {
      const lowerCategories = categories.map((c) => c.toLowerCase());
      budgets = budgets.filter((b) => lowerCategories.includes(b.category.toLowerCase()));
    }

    if (budgets.length === 0) {
      if (isBatch) allLines.push(`=== ${month} ===`, 'No budgets set.', '');
      else allLines.push(`No budgets set for ${month}.`);
      continue;
    }

    const monthStart = `${month}-01`;
    const monthEnd = format(endOfMonth(new Date(`${month}-01`)), 'yyyy-MM-dd');
    const expenses = database.expenses.findByDateRange(ctx.groupId, monthStart, monthEnd);

    const spendingByCategory: Record<string, number> = {};
    for (const e of expenses) {
      spendingByCategory[e.category] = (spendingByCategory[e.category] || 0) + e.eur_amount;
      grandTotalEur += e.eur_amount;
    }

    if (isBatch) allLines.push(`=== ${month} ===`);
    else allLines.push(`Budgets for ${month}:`, '');

    for (const budget of budgets) {
      const spentEur = spendingByCategory[budget.category] || 0;
      const spentInCurrency = convertCurrency(spentEur, BASE_CURRENCY, budget.currency);
      const remaining = budget.limit_amount - spentInCurrency;
      const percent =
        budget.limit_amount > 0 ? Math.round((spentInCurrency / budget.limit_amount) * 100) : 0;
      const status = remaining < 0 ? 'EXCEEDED' : percent >= 90 ? 'WARNING' : 'OK';

      allLines.push(
        `${budget.category}: ${formatAmount(spentInCurrency, budget.currency, true)}/${formatAmount(budget.limit_amount, budget.currency, true)} (${percent}%) [${status}]`,
      );
    }
    allLines.push('');
  }

  // Grand total across all months for batch (uses accumulated EUR total)
  if (isBatch && grandTotalEur > 0) {
    const totalDisplay = convertCurrency(grandTotalEur, BASE_CURRENCY, displayCurrency);
    allLines.push(`=== Grand Total (${months.length} months) ===`);
    allLines.push(`${formatAmount(totalDisplay, displayCurrency, true)}`);
  }

  return { success: true, output: allLines.join('\n') };
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

  const result = await getBudgetManager().set({
    groupId: ctx.groupId,
    category,
    month,
    amount,
    currency,
  });

  const sheetsNote = result.sheetsSynced ? ' (synced to Sheets)' : '';

  // Include all other budgets for this month so AI can detect unmentioned categories
  const allBudgets = database.budgets.getAllBudgetsForMonth(ctx.groupId, month);
  const otherBudgets = allBudgets.filter((b) => b.category !== category);
  const othersLine =
    otherBudgets.length > 0
      ? `\nOther budgets for ${month}: ${otherBudgets.map((b) => `${b.category}=${formatAmount(b.limit_amount, b.currency, true)}`).join(', ')}`
      : '';

  return {
    success: true,
    output: `Budget set: ${category} = ${formatAmount(amount, currency, true)} for ${month}${sheetsNote}${othersLine}`,
  };
}

async function executeDeleteBudget(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const category = input['category'] as string;
  const month = (input['month'] as string) || format(new Date(), 'yyyy-MM');

  if (!category) {
    return { success: false, error: 'category is required' };
  }

  await getBudgetManager().delete({ groupId: ctx.groupId, category, month });

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
    const { silentSyncBudgets } = await import('../../bot/services/budget-sync');
    await silentSyncBudgets(googleConn(group), ctx.groupId);
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

  const periods = normalizeArrayParam(input['period']);
  if (periods.length === 1 && periods[0]) filters.period = periods[0];
  else if (periods.length > 1) filters.period = periods;

  const bankNames = normalizeArrayParam(input['bank_name']);
  const nonAllBanks = bankNames.filter((b) => b.toLowerCase() !== 'all');
  if (nonAllBanks.length === 1 && nonAllBanks[0]) filters.bank_name = nonAllBanks[0];
  else if (nonAllBanks.length > 1) filters.bank_name = nonAllBanks;

  const statuses = normalizeArrayParam(input['status']);
  if (statuses.length === 1) filters.status = statuses[0] as BankTransaction['status'];
  else if (statuses.length > 1) filters.status = statuses as BankTransaction['status'][];

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
  const rawBankName =
    typeof input['bank_name'] === 'string' ? input['bank_name'].toLowerCase() : '';
  const bankNameFilter = rawBankName === 'all' || rawBankName === '' ? undefined : rawBankName;

  const accounts = database.bankAccounts.findByGroupId(ctx.groupId, true);
  const filtered = bankNameFilter
    ? accounts.filter((a) => {
        const conn = database.bankConnections.findById(a.connection_id);
        return conn?.bank_name?.toLowerCase().includes(bankNameFilter) ?? false;
      })
    : accounts;

  if (filtered.length === 0) {
    // Check if there are accounts at all (ignoring the bank_name filter)
    if (bankNameFilter) {
      if (accounts.length > 0) {
        const availableBanks = [
          ...new Set(
            accounts
              .map((a) => database.bankConnections.findById(a.connection_id)?.bank_name)
              .filter((n): n is string => Boolean(n)),
          ),
        ].join(', ');
        return {
          success: true,
          data: [],
          summary: `No accounts found matching bank_name filter "${bankNameFilter}". Available bank keys: ${availableBanks}. Retry with bank_name: "all" to see all accounts.`,
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
      hidden: a.is_excluded === 1,
    })),
  };
}

async function executeFindMissingExpenses(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const periods = normalizeArrayParam(input['period'], 'current_month');
  const isBatch = periods.length > 1;

  const allMissing: Array<{
    tx_id: number;
    date: string;
    amount: number;
    currency: string;
    merchant: string;
    status: string;
    probable_expense_id: number | null;
  }> = [];
  const summaryParts: string[] = [];

  for (const period of periods) {
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

      if (exactMatch) return null;

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
    allMissing.push(...(missing as typeof allMissing));

    const label = isBatch ? `${period} (${startDate}–${endDate})` : `${startDate}–${endDate}`;
    summaryParts.push(
      `${label}: ${missing.length} ${pluralize(missing.length, 'транзакция', 'транзакции', 'транзакций')}`,
    );
  }

  return {
    success: true,
    data: allMissing,
    summary: isBatch
      ? `${allMissing.length} ${pluralize(allMissing.length, 'транзакция', 'транзакции', 'транзакций')} без записи:\n${summaryParts.join('\n')}`
      : (summaryParts[0] ?? '0 транзакций без записи'),
  };
}

// === Technical Analysis tool ===

function executeGetTechnicalAnalysis(
  input: Record<string, unknown>,
  ctx: AgentContext,
): ToolResult {
  const group = database.groups.findById(ctx.groupId);
  if (!group) return { success: false, error: 'Group not found' };

  const { spendingAnalytics } = require('../analytics/spending-analytics') as {
    spendingAnalytics: {
      getFinancialSnapshot: (groupId: number) => {
        technicalAnalysis: import('../analytics/types').TechnicalAnalysis | null;
      };
    };
  };
  const snapshot = spendingAnalytics.getFinancialSnapshot(ctx.groupId);

  if (!snapshot.technicalAnalysis) {
    return {
      success: true,
      output: 'Недостаточно данных для технического анализа (нужно ≥3 месяцев истории).',
    };
  }

  const ta = snapshot.technicalAnalysis;
  const categoryFilter = input['category'] as string | undefined;

  const categories = categoryFilter
    ? ta.categories.filter((c) => c.category.toLowerCase() === categoryFilter.toLowerCase())
    : ta.categories;

  if (categories.length === 0) {
    return {
      success: true,
      output: categoryFilter
        ? `Нет данных для категории "${categoryFilter}". Доступные: ${ta.categories.map((c) => c.category).join(', ')}`
        : 'Нет категорий с достаточной историей для анализа.',
    };
  }

  const lines: string[] = [];

  for (const cat of categories) {
    const trendRu =
      cat.trend.direction === 'rising'
        ? 'растут'
        : cat.trend.direction === 'falling'
          ? 'снижаются'
          : 'стабильны';
    const confidencePct = Math.round(cat.trend.confidence * 100);
    const q = cat.forecasts.quantiles;
    const bb = cat.volatility.bollingerBands;

    const catLines: string[] = [
      `## ${cat.category} (данные за ${cat.monthsOfData} мес.)`,
      `Тренд: расходы ${trendRu} (уверенность ${confidencePct}%)`,
      `Прогноз на следующий месяц: ~${Math.round(cat.forecasts.ensemble)}`,
      `Ожидаемый диапазон: от ${Math.round(bb.lower)} до ${Math.round(q.p75)}`,
      `В худшем случае (5% вероятность): до ${Math.round(q.p95)}`,
    ];

    // Monthly change direction
    if (cat.forecasts.holt.trend !== 0) {
      const changePerMonth = Math.abs(cat.forecasts.holt.trend);
      const changeDir = cat.forecasts.holt.trend > 0 ? 'растут' : 'снижаются';
      catLines.push(
        `Динамика: расходы ${changeDir} примерно на ${Math.round(changePerMonth)}/мес.`,
      );
    }

    // Normal range (Bollinger bands in user terms)
    catLines.push(`Обычный коридор расходов: ${Math.round(bb.lower)}–${Math.round(bb.upper)}`);

    // Anomaly
    if (cat.anomaly.isAnomaly) {
      const zAbs = Math.abs(cat.anomaly.zScore.zScore);
      const severity = zAbs > 3 ? 'сильно' : 'заметно';
      catLines.push(`⚠️ Необычный расход: текущий месяц ${severity} выбивается из нормы`);
    }

    // Momentum signals (MACD in user terms)
    if (cat.trend.macd.crossover === 'bullish') {
      catLines.push('📈 Расходы начали расти после периода снижения');
    } else if (cat.trend.macd.crossover === 'bearish') {
      catLines.push('📉 Расходы начали снижаться после периода роста');
    }

    // Overheated/oversold (RSI in user terms)
    if (cat.trend.rsi.signal === 'overbought') {
      catLines.push('🔴 Расходы на аномально высоком уровне — вероятен откат вниз');
    } else if (cat.trend.rsi.signal === 'oversold') {
      catLines.push('🟢 Расходы на аномально низком уровне — могут вырасти');
    }

    // Predictability (Hurst in user terms)
    if (cat.trend.hurst.type === 'trending') {
      catLines.push('Паттерн: расходы ведут себя предсказуемо (тренд сохранится)');
    } else if (cat.trend.hurst.type === 'mean_reverting') {
      catLines.push('Паттерн: расходы возвращаются к среднему (всплески временны)');
    } else {
      catLines.push('Паттерн: расходы непредсказуемы (нет выраженного тренда)');
    }

    // Regime changes (change points in user terms)
    if (cat.trend.changePoints.length > 0) {
      catLines.push(`Обнаружено ${cat.trend.changePoints.length} резких смен уровня расходов`);
    }

    // Support/resistance (pivot points in user terms)
    const pp = cat.trend.pivotPoints;
    catLines.push(
      `Уровни расходов: вряд ли ниже ${Math.round(pp.support1)}, вряд ли выше ${Math.round(pp.resistance1)}`,
    );

    // Intermittent spending (Croston in user terms)
    if (cat.forecasts.croston) {
      const cr = cat.forecasts.croston;
      catLines.push(
        `Нерегулярные расходы: ~${Math.round(cr.expectedAmount)} примерно раз в ${cr.expectedInterval.toFixed(1)} мес.`,
      );
    }

    // Record high (Donchian in user terms)
    if (cat.volatility.donchian.isBreakoutHigh) {
      catLines.push('🚨 Расходы достигли исторического максимума!');
    }

    lines.push(catLines.join('\n'));
  }

  // Correlations (in user terms)
  if (ta.correlations.length > 0) {
    const corrLines = ['## Связи между категориями'];
    for (const corr of ta.correlations.slice(0, 10)) {
      const direction = corr.correlation > 0 ? 'растут вместе' : 'одна растёт — другая падает';
      const strengthRu =
        corr.strength === 'strong_positive' || corr.strength === 'strong_negative'
          ? 'сильная'
          : corr.strength === 'moderate_positive' || corr.strength === 'moderate_negative'
            ? 'заметная'
            : 'слабая';
      corrLines.push(`${corr.category1} ↔ ${corr.category2}: ${direction} (${strengthRu} связь)`);
    }
    lines.push(corrLines.join('\n'));
  }

  return { success: true, output: lines.join('\n\n') };
}

// === Recurring pattern tools ===

function executeGetRecurringPatterns(ctx: AgentContext): ToolResult {
  const patterns = database.recurringPatterns.findAllByGroupId(ctx.groupId);

  if (patterns.length === 0) {
    return { success: true, output: 'No recurring patterns detected yet.' };
  }

  const lines = [`Recurring patterns (${patterns.length} total):`, ''];
  for (const p of patterns) {
    const statusLabel = p.status === 'active' ? '✅' : p.status === 'paused' ? '⏸️' : '❌';
    lines.push(
      `[id:${p.id}] ${statusLabel} ${p.category} | ${formatAmount(p.expected_amount, p.currency as CurrencyCode)} | day ~${p.expected_day ?? '?'} | next: ${p.next_expected_date ?? 'unknown'} | last: ${p.last_seen_date ?? 'never'} | status: ${p.status}`,
    );
  }

  return { success: true, output: lines.join('\n') };
}

function executeManageRecurringPattern(
  input: Record<string, unknown>,
  ctx: AgentContext,
): ToolResult {
  const patternId = input['pattern_id'] as number;
  const action = input['action'] as string;

  if (!patternId || !action) {
    return { success: false, error: 'pattern_id and action are required' };
  }

  const pattern = database.recurringPatterns.findById(patternId);
  if (!pattern) {
    return { success: false, error: `Pattern with ID ${patternId} not found` };
  }

  if (pattern.group_id !== ctx.groupId) {
    return { success: false, error: 'Access denied: pattern belongs to a different group' };
  }

  switch (action) {
    case 'pause':
      database.recurringPatterns.updateStatus(patternId, 'paused');
      return { success: true, output: `Pattern "${pattern.category}" paused.` };
    case 'resume':
      database.recurringPatterns.updateStatus(patternId, 'active');
      return { success: true, output: `Pattern "${pattern.category}" resumed.` };
    case 'dismiss':
      database.recurringPatterns.updateStatus(patternId, 'dismissed');
      return { success: true, output: `Pattern "${pattern.category}" dismissed.` };
    case 'delete':
      database.recurringPatterns.delete(patternId);
      return { success: true, output: `Pattern "${pattern.category}" deleted.` };
    default:
      return {
        success: false,
        error: `Unknown action: ${action}. Use "pause", "resume", "dismiss", or "delete".`,
      };
  }
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

  const { sendFeedback } = await import('../feedback');
  const result = await sendFeedback({
    message,
    groupId: ctx.groupId,
    chatId: ctx.chatId,
    userName: ctx.userFullName ?? ctx.userName,
  });

  if (result.success) {
    return { success: true, output: 'Фидбек отправлен администратору.' };
  }
  return { success: false, error: result.error ?? 'Unknown error' };
}
