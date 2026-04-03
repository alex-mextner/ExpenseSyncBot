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
import { createLogger } from '../../utils/logger.ts';
import { buildMiniAppUrl } from '../../utils/miniapp-url';
import type { GoogleConnectedGroup } from '../guards';
import { createAddCategoryWithBudgetKeyboard } from '../keyboards';
import { silentSyncBudgets } from '../services/budget-sync';
import type { Ctx } from '../types';
import { maybeSmartAdvice } from './ask';

const logger = createLogger('budget');

/**
 * Parse budget amount with optional currency
 * Supports: 500, 500$, $500, 500 EUR, 500 евро, etc.
 */
function parseBudgetAmount(
  amountStr: string,
  defaultCurrency: CurrencyCode,
): { amount: number; currency: CurrencyCode } | null {
  const trimmed = amountStr.trim();

  // Pattern 1: Currency symbol before amount ($500, €100, ₽500)
  const pattern1 = /^([$€£₽¥])\s*([\d\s,.]+)$/;
  const match1 = trimmed.match(pattern1);

  if (match1) {
    const [, currencySymbol, numStr] = match1;
    if (!currencySymbol || !numStr) return null;

    const normalized = normalizeCurrency(currencySymbol);
    if (!normalized) return null;

    const amount = parseFloat(numStr.replace(/[\s,]/g, ''));
    if (Number.isNaN(amount) || amount <= 0) return null;

    return { amount, currency: normalized };
  }

  // Pattern 2: Amount with currency after (500$, 500 EUR, 500 евро)
  const pattern2 = /^([\d\s,.]+)\s*([$€£₽¥]|[a-zA-Zа-яА-Я]+)$/;
  const match2 = trimmed.match(pattern2);

  if (match2) {
    const [, numStr, currencyStr] = match2;
    if (!numStr) return null;

    const amount = parseFloat(numStr.replace(/[\s,]/g, ''));
    if (Number.isNaN(amount) || amount <= 0) return null;

    if (currencyStr) {
      const normalized = normalizeCurrency(currencyStr);
      if (normalized) {
        return { amount, currency: normalized };
      }
    }

    return { amount, currency: defaultCurrency };
  }

  // Pattern 3: Just amount (500)
  const pattern3 = /^([\d\s,.]+)$/;
  const match3 = trimmed.match(pattern3);

  if (match3) {
    const [, numStr] = match3;
    if (!numStr) return null;

    const amount = parseFloat(numStr.replace(/[\s,]/g, ''));
    if (Number.isNaN(amount) || amount <= 0) return null;

    return { amount, currency: defaultCurrency };
  }

  return null;
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

/**
 * Show budget progress for current month
 */
async function showBudgetProgress(ctx: Ctx['Command'], group: GoogleConnectedGroup): Promise<void> {
  void ctx;
  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');
  const currentMonthName = format(now, 'LLLL yyyy');

  const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');
  const currentMonthEnd = format(endOfMonth(now), 'yyyy-MM-dd');
  const expenses = database.expenses.findByDateRange(group.id, currentMonthStart, currentMonthEnd);

  const categorySpending: Record<string, number> = {};
  for (const expense of expenses) {
    categorySpending[expense.category] =
      (categorySpending[expense.category] || 0) + expense.eur_amount;
  }

  const budgets = database.budgets.getAllBudgetsForMonth(group.id, currentMonth);

  const miniAppUrl = buildMiniAppUrl('dashboard', group.telegram_group_id);
  const keyboard = miniAppUrl ? new InlineKeyboard().url('📊 Дашборд', miniAppUrl) : undefined;

  if (budgets.length === 0) {
    await sendMessage(
      `Бюджет на ${currentMonthName}\n\n` +
        `Бюджеты не установлены.\n\n` +
        `Используй:\n` +
        `• /budget set <Категория> <Сумма>\n` +
        `• /budget sync — синхронизировать с Google Sheets`,
      keyboard ? { reply_markup: keyboard } : {},
    );
    await maybeSmartAdvice(group.id);
    return;
  }

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

  let message = `Бюджет на ${currentMonthName}\n\n`;

  for (const [currency, { totalBudget, totalSpent }] of Object.entries(budgetsByCurrency)) {
    const percentage = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
    message += `Всего (${currency}): ${formatAmount(totalSpent, currency as CurrencyCode)} / ${formatAmount(totalBudget, currency as CurrencyCode)} (${percentage}%)\n`;
  }
  message += '\n';

  const budgetProgress = budgets.map((budget) => {
    const spentEur = categorySpending[budget.category] || 0;
    const spent = convertCurrency(spentEur, BASE_CURRENCY, budget.currency);
    const percentage =
      budget.limit_amount > 0 ? Math.round((spent / budget.limit_amount) * 100) : 0;
    return {
      budget,
      spent,
      percentage,
      is_exceeded: spent > budget.limit_amount,
      is_warning: percentage >= 90,
    };
  });

  budgetProgress.sort((a, b) => b.percentage - a.percentage);

  for (const { budget, spent, percentage, is_exceeded, is_warning } of budgetProgress) {
    const emoji = getCategoryEmoji(budget.category);
    const status = is_exceeded ? '(!)' : is_warning ? '(~)' : '';
    message += `${emoji} ${budget.category}: ${formatAmount(spent, budget.currency)} / ${formatAmount(budget.limit_amount, budget.currency)} (${percentage}%) ${status}\n`;
  }

  await sendMessage(message.trim(), keyboard ? { reply_markup: keyboard } : {});
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

  const normalizedCategory =
    categoryName.charAt(0).toUpperCase() + categoryName.slice(1).toLowerCase();

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
