/** /budget command handler — create, view, and edit spending budgets per category */
import { endOfMonth, format, startOfMonth } from 'date-fns';
import { InlineKeyboard } from 'gramio';
import { getCategoryEmoji } from '../../config/category-emojis';
import {
  BASE_CURRENCY,
  CURRENCY_ALIASES,
  type CurrencyCode,
  getCurrencySymbol,
} from '../../config/constants';
import { database } from '../../database';
import { computeBudgetProgress } from '../../database/repositories/budget.repository';
import type { Budget, Expense } from '../../database/types';
import { spendingAnalytics } from '../../services/analytics/spending-analytics';
import type { CategoryTaAnalysis } from '../../services/analytics/ta/analyzer';
import type { TechnicalAnalysis } from '../../services/analytics/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import { getBudgetManager } from '../../services/budget-manager';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import { monthAbbrFromDate } from '../../services/google/month-abbr';
import {
  createEmptyMonthTab,
  googleConn,
  monthTabExists,
  readMonthBudget,
} from '../../services/google/sheets';
import { normalizeCategoryName } from '../../utils/fuzzy-search';
import { truncateForTelegram } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { buildMiniAppUrl } from '../../utils/miniapp-url';
import type { GoogleConnectedGroup } from '../guards';
import { createAddCategoryWithBudgetKeyboard } from '../keyboards';
import { silentSyncBudgets } from '../services/budget-sync';
import type { Ctx } from '../types';
import { maybeSmartAdvice } from './ask';

const logger = createLogger('budget');

function parsePositiveAmount(numStr: string): number | null {
  const amount = parseFloat(numStr.replace(/[\s,]/g, ''));
  if (Number.isNaN(amount) || amount <= 0) return null;
  return amount;
}

type ParsedBudgetAmount = { amount: number; currency: CurrencyCode };

function parseSymbolPrefixed(trimmed: string): ParsedBudgetAmount | null | undefined {
  const match = trimmed.match(/^([$€£₽¥])\s*([\d\s,.]+)$/);
  if (!match) return undefined;
  const [, currencySymbol, numStr] = match;
  if (!currencySymbol || !numStr) return null;

  const normalized = normalizeCurrency(currencySymbol);
  if (!normalized) return null;

  const amount = parsePositiveAmount(numStr);
  return amount === null ? null : { amount, currency: normalized };
}

function parseCurrencySuffixed(
  trimmed: string,
  defaultCurrency: CurrencyCode,
): ParsedBudgetAmount | null | undefined {
  const match = trimmed.match(/^([\d\s,.]+)\s*([$€£₽¥]|[a-zA-Zа-яА-Я]+)$/);
  if (!match) return undefined;
  const [, numStr, currencyStr] = match;
  if (!numStr) return null;

  const amount = parsePositiveAmount(numStr);
  if (amount === null) return null;

  const normalized = currencyStr ? normalizeCurrency(currencyStr) : null;
  return { amount, currency: normalized ?? defaultCurrency };
}

function parseBareAmount(
  trimmed: string,
  defaultCurrency: CurrencyCode,
): ParsedBudgetAmount | null | undefined {
  const match = trimmed.match(/^([\d\s,.]+)$/);
  if (!match) return undefined;
  const [, numStr] = match;
  if (!numStr) return null;

  const amount = parsePositiveAmount(numStr);
  return amount === null ? null : { amount, currency: defaultCurrency };
}

/**
 * Parse budget amount with optional currency
 * Supports: 500, 500$, $500, 500 EUR, 500 евро, etc.
 *
 * Each pattern parser returns undefined when its pattern does not match (try the
 * next one), null when it matched but the value is invalid.
 */
function parseBudgetAmount(
  amountStr: string,
  defaultCurrency: CurrencyCode,
): ParsedBudgetAmount | null {
  const trimmed = amountStr.trim();
  const symbolPrefixed = parseSymbolPrefixed(trimmed);
  if (symbolPrefixed !== undefined) return symbolPrefixed;
  const currencySuffixed = parseCurrencySuffixed(trimmed, defaultCurrency);
  if (currencySuffixed !== undefined) return currencySuffixed;
  return parseBareAmount(trimmed, defaultCurrency) ?? null;
}

/**
 * Normalize currency code from alias
 */
export function normalizeCurrency(currencyStr: string): CurrencyCode | null {
  const normalized = currencyStr.toLowerCase().trim();
  return (CURRENCY_ALIASES[normalized] as CurrencyCode) || null;
}

/**
 * /budget command handler
 *
 * Usage:
 * - /budget - show current budgets and progress
 * - /budget set <Category> <Amount> - set budget for category
 * - /budget sync - sync budgets from Google Sheets
 */
export async function handleBudgetCommand(
  ctx: Ctx['Command'],
  group: GoogleConnectedGroup,
): Promise<void> {
  // Parse command arguments
  const fullText = ctx.text || '';
  const parts = fullText
    .trim()
    .split(/\s+/)
    .filter((arg: string) => arg.length > 0);

  // Remove command if it's present (e.g., "/budget" from "/budget sync")
  const args = parts[0]?.startsWith('/') ? parts.slice(1) : parts;

  // Silent sync budgets from Google Sheets
  if (group.google_refresh_token) {
    const syncedCount = await silentSyncBudgets(googleConn(group), group.id);
    if (syncedCount > 0) {
      await sendMessage(`🔄 Синхронизировано записей бюджета: ${syncedCount}`);
    }
  }

  if (args.length === 0) {
    // Show current budgets and progress
    await showBudgetProgress(ctx, group);
    return;
  }

  const subcommand = args[0]?.toLowerCase();

  if (subcommand === 'set' && args.length >= 3) {
    // /budget set Category Amount
    const category = args[1] ?? '';
    const amountStr = args.slice(2).join(' ');

    const parsed = parseBudgetAmount(amountStr, group.default_currency);

    if (!parsed) {
      await sendMessage(
        '❌ Неверная сумма. Используй: /budget set Категория 500 или /budget set Категория $500',
      );
      return;
    }

    await setBudget(ctx, group, category, parsed.amount, parsed.currency);
    return;
  }

  if (subcommand === 'sync') {
    // Sync budgets from Google Sheets
    await syncBudgets(ctx, group);
    return;
  }

  // Invalid usage
  await sendMessage(
    '❌ Неверный формат команды.\n\n' +
      'Использование:\n' +
      '• /budget - показать бюджеты\n' +
      '• /budget set <Категория> <Сумма> - установить бюджет\n' +
      '• /budget sync - синхронизировать с Google Sheets',
  );
}

type BudgetProgressRow = {
  budget: Budget;
  spent: number;
  percentage: number;
  is_exceeded: boolean;
  is_warning: boolean;
};

function sumSpendingByCategory(expenses: Expense[]): Record<string, number> {
  const categorySpending: Record<string, number> = {};
  for (const expense of expenses) {
    categorySpending[expense.category] =
      (categorySpending[expense.category] || 0) + expense.eur_amount;
  }
  return categorySpending;
}

/** Per-currency budget/spent totals, in order of first appearance of each currency. */
function totalsByCurrency(
  budgets: Budget[],
  categorySpending: Record<string, number>,
): Record<CurrencyCode, { totalBudget: number; totalSpent: number }> {
  const budgetsByCurrency: Record<CurrencyCode, { totalBudget: number; totalSpent: number }> =
    {} as Record<CurrencyCode, { totalBudget: number; totalSpent: number }>;

  for (const budget of budgets) {
    const currency = budget.currency;
    if (!budgetsByCurrency[currency]) {
      budgetsByCurrency[currency] = { totalBudget: 0, totalSpent: 0 };
    }
    const spentEur = categorySpending[budget.category] || 0;
    const spentInCurrency = convertCurrency(spentEur, BASE_CURRENCY, currency);
    budgetsByCurrency[currency].totalBudget += budget.limit_amount;
    budgetsByCurrency[currency].totalSpent += spentInCurrency;
  }
  return budgetsByCurrency;
}

function renderCurrencyTotals(
  budgetsByCurrency: Record<CurrencyCode, { totalBudget: number; totalSpent: number }>,
): string {
  let text = '';
  for (const [currency, { totalBudget, totalSpent }] of Object.entries(budgetsByCurrency)) {
    const percentage = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
    text += `Всего (${currency}): ${formatAmount(totalSpent, currency as CurrencyCode)} / ${formatAmount(totalBudget, currency as CurrencyCode)} (${percentage}%)\n`;
  }
  return text;
}

function budgetStatusMarker(row: BudgetProgressRow): string {
  if (row.is_exceeded) return '(!)';
  if (row.is_warning) return '(~)';
  return '';
}

function renderBudgetRows(rows: BudgetProgressRow[]): string {
  let text = '';
  for (const row of rows) {
    const { budget, spent, percentage } = row;
    const emoji = getCategoryEmoji(budget.category);
    text += `${emoji} ${budget.category}: ${formatAmount(spent, budget.currency)} / ${formatAmount(budget.limit_amount, budget.currency)} (${percentage}%) ${budgetStatusMarker(row)}\n`;
  }
  return text;
}

function trendArrow(direction: string): string {
  if (direction === 'rising') return '↑';
  if (direction === 'falling') return '↓';
  return '→';
}

/** Only categories approaching/exceeding budget, anomalous, or confidently rising are shown. */
function isForecastNoteworthy(cat: CategoryTaAnalysis, forecastPct: number): boolean {
  return (
    forecastPct >= 80 ||
    cat.anomaly.isAnomaly ||
    (cat.trend.direction === 'rising' && cat.trend.confidence >= 0.6)
  );
}

function buildForecastInsights(
  analysis: TechnicalAnalysis,
  budgetProgress: BudgetProgressRow[],
): string[] {
  const taInsights: string[] = [];
  for (const cat of analysis.categories) {
    const bp = budgetProgress.find((b) => b.budget.category === cat.category);
    if (!bp) continue;

    const forecast = Math.round(
      convertCurrency(cat.forecasts.ensemble, BASE_CURRENCY, bp.budget.currency),
    );
    const forecastPct =
      bp.budget.limit_amount > 0 ? Math.round((forecast / bp.budget.limit_amount) * 100) : 0;
    if (!isForecastNoteworthy(cat, forecastPct)) continue;

    let insight = `${getCategoryEmoji(cat.category)} ${cat.category}: прогноз ${formatAmount(forecast, bp.budget.currency)} ${trendArrow(cat.trend.direction)}`;
    if (cat.anomaly.isAnomaly) insight += ' ⚠️';
    taInsights.push(insight);
  }
  return taInsights;
}

/**
 * Cap at 10 lines so the full budget message stays under Telegram's 4096-char
 * limit. N+2 rule for the "и ещё N" tail.
 */
function renderForecastSection(taInsights: string[]): string {
  if (taInsights.length === 0) return '';
  const MAX_TA_INSIGHTS = 10;
  const hidden = taInsights.length - MAX_TA_INSIGHTS;
  const visibleInsights = hidden >= 3 ? taInsights.slice(0, MAX_TA_INSIGHTS) : taInsights;
  let text = `\nПрогноз на месяц:\n${visibleInsights.join('\n')}\n`;
  if (hidden >= 3) {
    text += `… и ещё ${hidden}\n`;
  }
  return text;
}

/**
 * Format budget progress text for a group (reusable by cron and /budget command)
 */
export function formatBudgetProgressText(groupId: number): { text: string; hasBudgets: boolean } {
  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');
  const currentMonthName = format(now, 'LLLL yyyy');

  const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');
  const currentMonthEnd = format(endOfMonth(now), 'yyyy-MM-dd');
  const expenses = database.expenses.findByDateRange(groupId, currentMonthStart, currentMonthEnd);
  const categorySpending = sumSpendingByCategory(expenses);

  const budgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);

  if (budgets.length === 0) {
    return { text: `Бюджет на ${currentMonthName}\n\nБюджеты не установлены.`, hasBudgets: false };
  }

  let message = `Бюджет на ${currentMonthName}\n\n`;
  message += renderCurrencyTotals(totalsByCurrency(budgets, categorySpending));
  message += '\n';

  const budgetProgress: BudgetProgressRow[] = budgets.map((budget) => {
    const spentEur = categorySpending[budget.category] || 0;
    const spent = convertCurrency(spentEur, BASE_CURRENCY, budget.currency);
    const progress = computeBudgetProgress(budget, spent);
    return { budget, spent, ...progress };
  });

  budgetProgress.sort((a, b) => b.percentage - a.percentage);
  message += renderBudgetRows(budgetProgress);

  // TA forecast insights for budgeted categories
  const snapshot = spendingAnalytics.getFinancialSnapshot(groupId);
  if (snapshot.technicalAnalysis) {
    message += renderForecastSection(
      buildForecastInsights(snapshot.technicalAnalysis, budgetProgress),
    );
  }

  return { text: truncateForTelegram(message.trim()), hasBudgets: true };
}

async function showBudgetProgress(ctx: Ctx['Command'], group: GoogleConnectedGroup): Promise<void> {
  void ctx;

  const miniAppUrl = buildMiniAppUrl('dashboard', group.telegram_group_id);
  const keyboard = miniAppUrl ? new InlineKeyboard().url('📊 Дашборд', miniAppUrl) : undefined;

  const { text, hasBudgets } = formatBudgetProgressText(group.id);

  if (!hasBudgets) {
    await sendMessage(
      `${text}\n\n` +
        `Используй:\n` +
        `• /budget set <Категория> <Сумма>\n` +
        `• /budget sync — синхронизировать с Google Sheets`,
      keyboard ? { reply_markup: keyboard } : {},
    );
    await maybeSmartAdvice(group.id);
    return;
  }

  await sendMessage(text, keyboard ? { reply_markup: keyboard } : {});
  await maybeSmartAdvice(group.id);
}

/**
 * Set budget for category in current month
 */
async function setBudget(
  ctx: Ctx['Command'],
  group: GoogleConnectedGroup,
  categoryName: string,
  amount: number,
  currency: CurrencyCode,
): Promise<void> {
  void ctx;
  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');

  const normalizedCategory = normalizeCategoryName(categoryName);

  const categoryExists = database.categories.exists(group.id, normalizedCategory);

  if (!categoryExists) {
    const existingCategories = database.categories.getCategoryNames(group.id);
    const keyboard = createAddCategoryWithBudgetKeyboard(normalizedCategory, amount, currency);
    const currencySymbol = getCurrencySymbol(currency);

    await sendMessage(
      `Категория "${normalizedCategory}" не существует.\n\n` +
        `Хочешь добавить новую категорию "${normalizedCategory}" с бюджетом ${currencySymbol}${amount}?\n\n` +
        `Или выбери из существующих:\n${existingCategories.join(', ')}`,
      { reply_markup: keyboard },
    );
    return;
  }

  const result = await getBudgetManager().set({
    groupId: group.id,
    category: normalizedCategory,
    month: currentMonth,
    amount,
    currency,
  });

  const emoji = getCategoryEmoji(normalizedCategory);
  if (!result.sheetsSynced && group.google_refresh_token) {
    await sendMessage(
      `Бюджет установлен: ${emoji} ${normalizedCategory} = ${formatAmount(amount, currency)}\n\n` +
        'Не удалось записать в Google Sheets. Используй /budget sync позже.',
    );
  } else if (!result.sheetsSynced) {
    await sendMessage(
      `Бюджет установлен: ${emoji} ${normalizedCategory} = ${formatAmount(amount, currency)}\n\n` +
        'Подключи Google Sheets (/connect) чтобы синхронизировать бюджеты.',
    );
  } else {
    await sendMessage(
      `Бюджет установлен: ${emoji} ${normalizedCategory} = ${formatAmount(amount, currency)}`,
    );
  }

  await maybeSmartAdvice(group.id);
}

/**
 * Sync budgets from Google Sheets monthly tab to database
 */
async function syncBudgets(ctx: Ctx['Command'], group: GoogleConnectedGroup): Promise<void> {
  void ctx;
  try {
    const conn = googleConn(group);
    const now = new Date();
    const currentMonthAbbr = monthAbbrFromDate(now);
    const currentMonth = format(now, 'yyyy-MM');

    const tabExists = await monthTabExists(conn, group.spreadsheet_id, currentMonthAbbr);

    if (!tabExists) {
      await createEmptyMonthTab(conn, group.spreadsheet_id, currentMonthAbbr);
      await sendMessage(
        `Вкладка ${currentMonthAbbr} создана в таблице.\n\n` +
          `Добавь бюджеты через:\n/budget set <Категория> <Сумма>`,
      );
      return;
    }

    const budgetsFromSheet = await readMonthBudget(conn, group.spreadsheet_id, currentMonthAbbr);

    if (budgetsFromSheet.length === 0) {
      await sendMessage(`В вкладке ${currentMonthAbbr} нет бюджетов для синхронизации.`);
      return;
    }

    let syncedCount = 0;
    let createdCategoriesCount = 0;

    for (const b of budgetsFromSheet) {
      if (!database.categories.exists(group.id, b.category)) {
        database.categories.create({ group_id: group.id, name: b.category });
        createdCategoriesCount++;
      }
      getBudgetManager().importFromSheet({
        groupId: group.id,
        category: b.category,
        month: currentMonth,
        amount: b.limit,
        currency: b.currency,
      });
      syncedCount++;
    }

    let message = `Синхронизировано записей бюджета: ${syncedCount}`;
    if (createdCategoriesCount > 0) {
      message += `\nСоздано новых категорий: ${createdCategoriesCount}`;
    }
    await sendMessage(message);
    await maybeSmartAdvice(group.id);
  } catch (err) {
    logger.error({ err }, '[BUDGET] Failed to sync budgets');
    await sendMessage('Не удалось синхронизировать бюджеты. Проверь доступ к Google Sheets.');
  }
}
