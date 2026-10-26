/**
 * Tool execution routing and implementation
 * Maps tool calls to database operations and services
 */
import type Big from 'big.js';
import { format } from 'date-fns';
import { marked } from 'marked';
import { BASE_CURRENCY, type CurrencyCode, SUPPORTED_CURRENCIES } from '../../config/constants';
import { database } from '../../database';
import type { BankTransaction, BankTransactionFilters } from '../../database/types';
import { getErrorMessage } from '../../utils/error';
import { createLogger } from '../../utils/logger.ts';
import { normalizeArrayParam, resolvePeriodDates } from '../../utils/period';
import { pluralize } from '../../utils/pluralize';
import { getBudgetManager } from '../budget-manager';
import { evaluateCurrencyExpression } from '../currency/calculator';
import { formatAmount, formatExchangeRatesForAI } from '../currency/converter';
import { googleConn } from '../google/sheets';
import { renderTableToPng } from '../render/table-renderer.ts';
import {
  applyGroupSetting,
  GROUP_SETTINGS,
  isEditableGroupSettingKey,
} from '../settings/group-settings-registry';
import { executeBatchItems, isBatchInput } from './batch';
import { executeGetBudgets } from './tool-executor/budgets-report';
import { executeGetExpenses } from './tool-executor/expenses-report';
import { executeGetTechnicalAnalysis } from './tool-executor/technical-analysis';
import type { AgentContext, ToolResult } from './types';

const logger = createLogger('tool-executor');

interface ToolCall {
  input: Record<string, unknown>;
  ctx: AgentContext;
}

type ToolHandler = (call: ToolCall) => ToolResult | Promise<ToolResult>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_expenses: ({ input, ctx }) => executeGetExpenses(input, ctx),
  get_budgets: ({ input, ctx }) => executeGetBudgets(input, ctx),
  get_categories: ({ ctx }) => executeGetCategories(ctx),
  get_group_settings: ({ ctx }) => executeGetGroupSettings(ctx),
  get_exchange_rates: () => executeGetExchangeRates(),
  set_budget: ({ input, ctx }) => executeSetBudget(input, ctx),
  delete_budget: ({ input, ctx }) => executeDeleteBudget(input, ctx),
  add_expense: ({ input, ctx }) => executeAddExpense(input, ctx),
  delete_expense: ({ input, ctx }) => executeDeleteExpense(input, ctx),
  sync_from_sheets: ({ ctx }) => executeSyncFromSheets(ctx),
  sync_budgets: ({ ctx }) => executeSyncBudgets(ctx),
  set_custom_prompt: ({ input, ctx }) => executeSetCustomPrompt(input, ctx),
  update_group_setting: ({ input, ctx }) => executeUpdateGroupSetting(input, ctx),
  manage_category: ({ input, ctx }) => executeManageCategory(input, ctx),
  calculate: ({ input, ctx }) => executeCalculate(input, ctx),
  get_bank_transactions: ({ input, ctx }) => executeGetBankTransactions(input, ctx),
  get_bank_balances: ({ input, ctx }) => executeGetBankBalances(input, ctx),
  get_technical_analysis: ({ input, ctx }) => executeGetTechnicalAnalysis(input, ctx),
  get_recurring_patterns: ({ ctx }) => executeGetRecurringPatterns(ctx),
  manage_recurring_pattern: ({ input, ctx }) => executeManageRecurringPattern(input, ctx),
  find_missing_expenses: ({ input, ctx }) => executeFindMissingExpenses(input, ctx),
  render_table: ({ input, ctx }) => executeRenderTable(input, ctx),
  send_feedback: ({ input, ctx }) => executeSendFeedback(input, ctx),
};

/** Tools that read or write expense/budget data first pull the latest state from the sheet. */
const EXPENSE_SYNC_TOOLS = ['get_expenses', 'add_expense', 'delete_expense'];
const BUDGET_SYNC_TOOLS = ['get_budgets', 'set_budget', 'delete_budget'];

// The sync modules are imported lazily so the bot command layer stays out of this module's
// static import graph.
async function syncBeforeTool(name: string, groupId: number): Promise<void> {
  if (EXPENSE_SYNC_TOOLS.includes(name)) {
    const { ensureFreshExpenses } = await import('../../bot/commands/sync');
    await ensureFreshExpenses(groupId);
  }
  if (BUDGET_SYNC_TOOLS.includes(name)) {
    const { ensureFreshBudgets } = await import('../../bot/services/budget-sync');
    await ensureFreshBudgets(groupId);
  }
}

/**
 * Execute a tool by name with given input
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  try {
    await syncBeforeTool(name, ctx.groupId);

    // hasOwn: a tool named "constructor" or "toString" must stay unknown, not hit Object.prototype.
    if (!Object.hasOwn(TOOL_HANDLERS, name)) {
      return { success: false, error: `Unknown tool: ${name}` };
    }
    return await (TOOL_HANDLERS[name] as ToolHandler)({ input, ctx });
  } catch (error) {
    logger.error({ err: error }, `[TOOL] Error executing ${name}`);
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

// === Read tools ===

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

  // Render every registry-backed setting so all of them stay visible to the AI,
  // including bank_cards_enabled and active_topic_id.
  const lines = Object.values(GROUP_SETTINGS).map(
    (def) => `${def.labelRu} (${def.key}): ${def.formatValue(group)}`,
  );
  lines.push(
    `Spreadsheet (spreadsheet_id): ${group.spreadsheet_id ? 'connected' : 'not connected'}`,
  );

  // The custom_prompt line above is a preview. Only append the full text when the preview
  // actually truncated it (>60 flattened chars) — otherwise it just duplicates the line and
  // wastes tokens in every AI context.
  if (group.custom_prompt) {
    const flattened = group.custom_prompt.replace(/\s+/g, ' ').trim();
    if (flattened.length > 60) {
      lines.push(`Custom prompt full text: ${group.custom_prompt}`);
    }
  }

  return { success: true, output: lines.join('\n') };
}

/**
 * Generic group-setting writer. Looks up the registry entry, parses + applies the value
 * through the shared registry path, and returns a Russian success/error summary.
 */
async function executeUpdateGroupSetting(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const settingKey = input['setting'];
  const rawValue = input['value'];

  if (typeof settingKey !== 'string' || !settingKey) {
    return { success: false, error: 'Не указано, какую настройку менять.' };
  }
  if (typeof rawValue !== 'string') {
    return { success: false, error: 'Значение настройки должно быть строкой.' };
  }
  if (!isEditableGroupSettingKey(settingKey)) {
    return {
      success: false,
      error: `Неизвестная настройка "${settingKey}". Доступны: ${Object.keys(GROUP_SETTINGS).join(', ')}.`,
    };
  }

  const group = database.groups.findById(ctx.groupId);
  if (!group) {
    return { success: false, error: 'Группа не найдена.' };
  }

  const def = GROUP_SETTINGS[settingKey];
  const result = await applyGroupSetting(def, group, rawValue);
  if (!result.ok) {
    return { success: false, error: result.error };
  }

  const updated = database.groups.findById(ctx.groupId) ?? group;
  return {
    success: true,
    output: `Готово, поменял для тебя. ${def.emoji} ${def.labelRu}: ${def.formatValue(updated)}`,
  };
}

function executeGetExchangeRates(): ToolResult {
  return { success: true, output: formatExchangeRatesForAI() };
}

// === Write tools ===

async function executeSetBudget(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  if (isBatchInput(input['items'])) {
    const items = input['items'] as Array<Record<string, unknown>>;
    return executeBatchItems(items, 'set_budget', (item) => executeSetBudgetSingle(item, ctx));
  }

  if (Array.isArray(input['items'])) {
    return { success: false, error: 'items array is empty' };
  }

  return executeSetBudgetSingle(input, ctx);
}

async function executeSetBudgetSingle(
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
  const rawCategory = input['category'];
  const month = (input['month'] as string) || format(new Date(), 'yyyy-MM');

  if (isBatchInput(rawCategory)) {
    const categories = rawCategory as string[];
    return executeBatchItems(categories, 'delete_budget', (category) =>
      executeDeleteBudgetSingle(category, month, ctx),
    );
  }

  if (Array.isArray(rawCategory)) {
    return { success: false, error: 'category array is empty' };
  }

  const category = rawCategory as string;
  return executeDeleteBudgetSingle(category, month, ctx);
}

async function executeDeleteBudgetSingle(
  category: string,
  month: string,
  ctx: AgentContext,
): Promise<ToolResult> {
  if (!category) {
    return { success: false, error: 'category is required' };
  }

  const result = await getBudgetManager().delete({ groupId: ctx.groupId, category, month });

  if (!result.deleted) {
    return {
      success: false,
      error: `No budget found for category "${category}" in ${month}`,
    };
  }

  return {
    success: true,
    output: `Budget deleted for ${result.resolvedCategory ?? category} in ${month}`,
  };
}

async function executeAddExpense(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  if (isBatchInput(input['items'])) {
    const items = input['items'] as Array<Record<string, unknown>>;
    return executeBatchItems(items, 'add_expense', (item) => executeAddExpenseSingle(item, ctx));
  }

  if (Array.isArray(input['items'])) {
    return { success: false, error: 'items array is empty' };
  }

  return executeAddExpenseSingle(input, ctx);
}

async function executeAddExpenseSingle(
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

async function executeDeleteExpense(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const rawId = input['expense_id'];

  if (isBatchInput(rawId)) {
    const ids = rawId as number[];
    return executeBatchItems(ids, 'delete_expense', async (id) =>
      executeDeleteExpenseSingle(id, ctx),
    );
  }

  if (Array.isArray(rawId)) {
    return { success: false, error: 'expense_id array is empty' };
  }

  return executeDeleteExpenseSingle(rawId as number, ctx);
}

async function executeDeleteExpenseSingle(
  expenseId: number,
  ctx: AgentContext,
): Promise<ToolResult> {
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

  // Remove the matching row from Google Sheets BEFORE deleting from DB.
  // The DB delete is the LAST step: if sheet delete fails, we must NOT touch
  // the DB — the next /sync (auto-sync fires before get_expenses) would
  // re-import the still-present sheet row, silently resurrecting the expense.
  // That's the exact bug this whole fix addresses.
  const { getExpenseRecorder } = await import('../expense-recorder');
  let sheetSuffix = '';
  try {
    const sheetResult = await getExpenseRecorder().deleteFromSheet(ctx.groupId, expense);
    if (sheetResult.deletedRowIndex === null) {
      sheetSuffix = ' (not found in sheet — already removed manually?)';
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return {
      success: false,
      error: `Could not delete expense ${expenseId} from the sheet: ${msg}. DB row preserved to avoid silent resurrection on next sync. Run /repair if the sheet is inaccessible.`,
    };
  }

  database.expenses.delete(expenseId);

  return {
    success: true,
    output: `Expense ${expenseId} deleted (${expense.date} | ${expense.category} | ${expense.amount} ${expense.currency}).${sheetSuffix}`,
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

    // Capped like the Telegram report: a sheet can skip thousands of rows (and any cell can be
    // long), and the tool output goes into the model context.
    const shownSkipped = result.skipped.length <= 12 ? result.skipped : result.skipped.slice(0, 10);
    const moreSkipped = result.skipped.length - shownSkipped.length;
    const skipped =
      result.skipped.length > 0
        ? `\nSkipped: ${result.skipped.length} sheet rows NOT written — their expense's author is missing in the DB:\n${shownSkipped
            .map((e) =>
              `${e.date} ${e.amount} ${e.currency} ${e.category} ${e.comment}`.slice(0, 150).trim(),
            )
            .join('\n')}${moreSkipped > 0 ? `\n…and ${moreSkipped} more` : ''}`
        : '';
    return {
      success: true,
      output: `Sync complete. Added: ${result.added.length}, Deleted: ${result.deleted.length}, Updated: ${result.updated.length}, Unchanged: ${result.unchanged}, New categories: ${result.createdCategories.length}${skipped}`,
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

async function executeManageCategory(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const action = input['action'] as string;
  const rawName = input['name'];

  if (!action) {
    return { success: false, error: 'action is required' };
  }

  if (isBatchInput(rawName)) {
    const names = rawName as string[];
    return executeBatchItems(names, 'manage_category', async (name) =>
      executeManageCategorySingle(action, name, ctx),
    );
  }

  if (Array.isArray(rawName)) {
    return { success: false, error: 'name array is empty' };
  }

  return executeManageCategorySingle(action, rawName as string, ctx);
}

function executeManageCategorySingle(action: string, name: string, ctx: AgentContext): ToolResult {
  if (!name) {
    return { success: false, error: 'name is required' };
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
  const bankNames = normalizeArrayParam(input['bank_name']);
  const showHidden = input['show_hidden'] === true;
  const isAll = bankNames.length === 0 || bankNames.some((b) => b.toLowerCase() === 'all');
  const filters = isAll
    ? undefined
    : bankNames.map((b) => b.toLowerCase()).filter((b) => b !== 'all');

  const accounts = database.bankAccounts.findByGroupId(ctx.groupId, showHidden);
  const filtered = filters
    ? accounts.filter((a) => {
        const conn = database.bankConnections.findById(a.connection_id);
        const bankName = conn?.bank_name?.toLowerCase() ?? '';
        return filters.some((f) => bankName.includes(f));
      })
    : accounts;

  if (filtered.length === 0) {
    // Check if there are accounts at all (ignoring the bank_name filter)
    if (filters) {
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
          summary: `No accounts found matching bank_name filter "${filters.join(', ')}". Available bank keys: ${availableBanks}. Retry with bank_name: "all" to see all accounts.`,
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

async function executeManageRecurringPattern(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const rawPatternId = input['pattern_id'];
  const action = input['action'] as string;

  if (!action) {
    return { success: false, error: 'action is required' };
  }

  if (isBatchInput(rawPatternId)) {
    const ids = rawPatternId as number[];
    return executeBatchItems(ids, 'manage_recurring_pattern', async (id) =>
      executeManageRecurringPatternSingle(id, action, ctx),
    );
  }

  if (Array.isArray(rawPatternId)) {
    return { success: false, error: 'pattern_id array is empty' };
  }

  return executeManageRecurringPatternSingle(rawPatternId as number, action, ctx);
}

function executeManageRecurringPatternSingle(
  patternId: number,
  action: string,
  ctx: AgentContext,
): ToolResult {
  if (!patternId) {
    return { success: false, error: 'pattern_id is required' };
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
