import { endOfMonth, format, startOfMonth } from 'date-fns';
import { getCategoryEmoji } from '../../config/category-emojis';
import { CURRENCY_ALIASES, type CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import type { Group } from '../../database/types';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import {
  createBudgetSheet,
  hasBudgetSheet,
  readBudgetData,
  writeBudgetRow,
} from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import { createAddCategoryWithBudgetKeyboard } from '../keyboards';
import type { BotInstance, Ctx } from '../types';
import { maybeSmartAdvice } from './ask';

const logger = createLogger('budget');

// ── Auto-sync budgets with cooldown ──

const lastBudgetSyncByGroup = new Map<number, number>();
const BUDGET_SYNC_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export interface BudgetSyncResult {
  unchanged: number;
  added: Array<{ month: string; category: string; limit: number; currency: CurrencyCode }>;
  updated: Array<{
    month: string;
    category: string;
    limit: number;
    currency: CurrencyCode;
    oldLimit: number;
  }>;
  deleted: Array<{ month: string; category: string; limit: number; currency: CurrencyCode }>;
  createdCategories: string[];
}

/**
 * Diff-based budget sync — compare sheet budgets with DB and apply changes.
 */
export async function syncBudgetsDiff(groupId: number): Promise<BudgetSyncResult> {
  const group = database.groups.findById(groupId);
  if (!group?.spreadsheet_id || !group?.google_refresh_token) {
    throw new Error('Group not configured for Google Sheets');
  }

  const hasSheet = await hasBudgetSheet(group.google_refresh_token, group.spreadsheet_id);
  if (!hasSheet) {
    return { unchanged: 0, added: [], updated: [], deleted: [], createdCategories: [] };
  }

  const sheetBudgets = await readBudgetData(group.google_refresh_token, group.spreadsheet_id);

  const result: BudgetSyncResult = {
    unchanged: 0,
    added: [],
    updated: [],
    deleted: [],
    createdCategories: [],
  };

  // Build set of sheet budget keys
  const sheetKeys = new Set<string>();
  for (const b of sheetBudgets) {
    sheetKeys.add(`${b.month}|${b.category}`);
  }

  // Process sheet budgets
  for (const b of sheetBudgets) {
    if (!database.categories.exists(groupId, b.category)) {
      database.categories.create({ group_id: groupId, name: b.category });
      result.createdCategories.push(b.category);
    }

    const existing = database.budgets.findByGroupCategoryMonth(groupId, b.category, b.month);

    if (!existing) {
      database.budgets.setBudget({
        group_id: groupId,
        category: b.category,
        month: b.month,
        limit_amount: b.limit,
        currency: b.currency,
      });
      result.added.push(b);
    } else if (existing.limit_amount !== b.limit || existing.currency !== b.currency) {
      database.budgets.setBudget({
        group_id: groupId,
        category: b.category,
        month: b.month,
        limit_amount: b.limit,
        currency: b.currency,
      });
      result.updated.push({ ...b, oldLimit: existing.limit_amount });
    } else {
      result.unchanged++;
    }
  }

  // Find deleted (in DB but not in sheet) — only for current month
  const currentMonth = format(new Date(), 'yyyy-MM');
  const dbBudgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);
  for (const db of dbBudgets) {
    const key = `${db.month}|${db.category}`;
    if (!sheetKeys.has(key)) {
      database.budgets.delete(db.id);
      result.deleted.push({
        month: db.month,
        category: db.category,
        limit: db.limit_amount,
        currency: db.currency,
      });
    }
  }

  logger.info(
    `[BUDGET-SYNC] +${result.added.length} -${result.deleted.length} ~${result.updated.length} =${result.unchanged}`,
  );

  return result;
}

/**
 * Sync budgets if stale. Blocking. Notifies chat only if changes detected.
 */
export async function ensureFreshBudgets(
  groupId: number,
  telegramGroupId?: number,
  bot?: BotInstance,
): Promise<void> {
  const last = lastBudgetSyncByGroup.get(groupId) || 0;
  if (Date.now() - last < BUDGET_SYNC_COOLDOWN_MS) return;

  try {
    lastBudgetSyncByGroup.set(groupId, Date.now());
    const result = await syncBudgetsDiff(groupId);
    const hasChanges =
      result.added.length > 0 || result.deleted.length > 0 || result.updated.length > 0;

    if (hasChanges && telegramGroupId && bot) {
      const parts: string[] = [];
      if (result.added.length > 0) parts.push(`+${result.added.length}`);
      if (result.deleted.length > 0) parts.push(`-${result.deleted.length}`);
      if (result.updated.length > 0) parts.push(`~${result.updated.length}`);
      await bot.api.sendMessage({
        chat_id: telegramGroupId,
        text: `🔄 Авто-синк бюджетов: ${parts.join(', ')}`,
      });
    }
  } catch (err) {
    logger.error({ err }, `[AUTO-SYNC] Budgets failed for group ${groupId}`);
  }
}

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
 * Get currency symbol for display
 */
export function getCurrencySymbol(currency: CurrencyCode): string {
  switch (currency) {
    case 'EUR':
      return '€';
    case 'USD':
      return '$';
    case 'RUB':
      return '₽';
    case 'GBP':
      return '£';
    case 'JPY':
      return '¥';
    case 'CNY':
      return '¥';
    default:
      return currency;
  }
}

/**
 * /budget command handler
 *
 * Usage:
 * - /budget - show current budgets and progress
 * - /budget set <Category> <Amount> - set budget for category
 * - /budget sync - sync budgets from Google Sheets
 */
export async function handleBudgetCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('Error: Unable to identify chat');
    return;
  }

  // Only allow in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isGroup) {
    await ctx.send('❌ Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await ctx.send('❌ Группа не настроена. Используй /connect');
    return;
  }

  if (!group.spreadsheet_id || !group.google_refresh_token) {
    await ctx.send('❌ Google Sheets не подключен. Используй /connect');
    return;
  }

  // Parse command arguments
  const fullText = ctx.text || '';
  const parts = fullText
    .trim()
    .split(/\s+/)
    .filter((arg: string) => arg.length > 0);

  // Remove command if it's present (e.g., "/budget" from "/budget sync")
  const args = parts[0]?.startsWith('/') ? parts.slice(1) : parts;

  logger.info(`[BUDGET] Full text: ${fullText}`);
  logger.info(`[BUDGET] Parts: ${parts}`);
  logger.info(`[BUDGET] Args: ${args}`);
  logger.info(`[BUDGET] Args length: ${args.length}`);

  // Silent sync budgets from Google Sheets
  if (group.google_refresh_token && group.spreadsheet_id) {
    const syncedCount = await silentSyncBudgets(
      group.google_refresh_token,
      group.spreadsheet_id,
      group.id,
    );
    if (syncedCount > 0) {
      await ctx.send(`🔄 Синхронизировано записей бюджета: ${syncedCount}`);
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
      await ctx.send(
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
  await ctx.send(
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
async function showBudgetProgress(ctx: Ctx['Command'], group: Group): Promise<void> {
  if (!group.google_refresh_token || !group.spreadsheet_id) {
    await ctx.send('⚠️ Сначала подключи Google Sheets с помощью /connect');
    return;
  }

  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');
  const currentMonthName = format(now, 'LLLL yyyy');

  // Ensure Budget sheet exists
  const hasSheet = await hasBudgetSheet(group.google_refresh_token, group.spreadsheet_id);
  if (!hasSheet) {
    const categories = database.categories.getCategoryNames(group.id);
    if (categories.length > 0) {
      try {
        await createBudgetSheet(
          group.google_refresh_token,
          group.spreadsheet_id,
          categories,
          100,
          group.default_currency,
        );
        await ctx.send('✅ Вкладка Budget создана в таблице!');
      } catch (err) {
        logger.error({ err: err }, '[BUDGET] Failed to create Budget sheet');
        await ctx.send('⚠️ Не удалось создать вкладку Budget. Проверь доступ к таблице.');
      }
    }
  }

  // Get current month expenses
  const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');
  const currentMonthEnd = format(endOfMonth(now), 'yyyy-MM-dd');
  const expenses = database.expenses.findByDateRange(group.id, currentMonthStart, currentMonthEnd);

  // Calculate spending by category
  const categorySpending: Record<string, number> = {};
  for (const expense of expenses) {
    categorySpending[expense.category] =
      (categorySpending[expense.category] || 0) + expense.eur_amount;
  }

  // Get budgets for current month
  const budgets = database.budgets.getAllBudgetsForMonth(group.id, currentMonth);

  if (budgets.length === 0) {
    await ctx.send(
      `📊 Бюджет на ${currentMonthName}\n\n` +
        `⚠️ Бюджеты не установлены.\n\n` +
        `Используй:\n` +
        `• /budget set <Категория> <Сумма>\n` +
        `• /budget sync - синхронизировать с Google Sheets`,
    );
    await maybeSmartAdvice(ctx, group.id);
    return;
  }

  // Group budgets by currency and calculate totals
  const budgetsByCurrency: Record<CurrencyCode, { totalBudget: number; totalSpent: number }> =
    {} as Record<CurrencyCode, { totalBudget: number; totalSpent: number }>;

  for (const budget of budgets) {
    const currency = budget.currency;
    if (!budgetsByCurrency[currency]) {
      budgetsByCurrency[currency] = { totalBudget: 0, totalSpent: 0 };
    }
    const spentEur = categorySpending[budget.category] || 0;
    const spentInCurrency = convertCurrency(spentEur, 'EUR', currency);

    budgetsByCurrency[currency].totalBudget += budget.limit_amount;
    budgetsByCurrency[currency].totalSpent += spentInCurrency;
  }

  // Build message
  let message = `📊 Бюджет на ${currentMonthName}\n\n`;

  // Display totals for each currency
  for (const [currency, { totalBudget, totalSpent }] of Object.entries(budgetsByCurrency)) {
    const percentage = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
    message += `💰 Всего (${currency}): ${formatAmount(totalSpent, currency as CurrencyCode)} / ${formatAmount(totalBudget, currency as CurrencyCode)} (${percentage}%)\n`;
  }
  message += '\n';

  // Sort budgets by percentage descending (exceeded first)
  const budgetProgress = budgets.map((budget) => {
    const spentEur = categorySpending[budget.category] || 0;
    const spent = convertCurrency(spentEur, 'EUR', budget.currency);
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

  // Display each category
  for (const { budget, spent, percentage, is_exceeded, is_warning } of budgetProgress) {
    const emoji = getCategoryEmoji(budget.category);
    const status = is_exceeded ? '🔴' : is_warning ? '⚠️' : '';

    message += `${emoji} ${budget.category}: ${formatAmount(spent, budget.currency)} / ${formatAmount(budget.limit_amount, budget.currency)} (${percentage}%) ${status}\n`;
  }

  await ctx.send(message);

  // Maybe send daily advice (20% probability)
  await maybeSmartAdvice(ctx, group.id);
}

/**
 * Set budget for category in current month
 */
async function setBudget(
  ctx: Ctx['Command'],
  group: Group,
  categoryName: string,
  amount: number,
  currency: CurrencyCode,
): Promise<void> {
  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');

  // Normalize category name (capitalize first letter)
  const normalizedCategory =
    categoryName.charAt(0).toUpperCase() + categoryName.slice(1).toLowerCase();

  // Check if category exists
  const categoryExists = database.categories.exists(group.id, normalizedCategory);

  if (!categoryExists) {
    const existingCategories = database.categories.getCategoryNames(group.id);
    const keyboard = createAddCategoryWithBudgetKeyboard(normalizedCategory, amount, currency);

    const currencySymbol = getCurrencySymbol(currency);

    await ctx.send(
      `⚠️ Категория "${normalizedCategory}" не существует.\n\n` +
        `Хочешь добавить новую категорию "${normalizedCategory}" с бюджетом ${currencySymbol}${amount}?\n\n` +
        `Или выбери из существующих:\n${existingCategories.join(', ')}`,
      { reply_markup: keyboard.build() },
    );
    return;
  }

  // Save to database
  database.budgets.setBudget({
    group_id: group.id,
    category: normalizedCategory,
    month: currentMonth,
    limit_amount: amount,
    currency: currency,
  });

  if (!group.google_refresh_token || !group.spreadsheet_id) {
    const emoji = getCategoryEmoji(normalizedCategory);
    await ctx.send(
      `✅ Бюджет установлен: ${emoji} ${normalizedCategory} = ${formatAmount(amount, currency)}\n\n` +
        '⚠️ Подключи Google Sheets (/connect) чтобы синхронизировать бюджеты.',
    );
    return;
  }

  // Ensure Budget sheet exists
  const hasSheet = await hasBudgetSheet(group.google_refresh_token, group.spreadsheet_id);

  if (!hasSheet) {
    const categories = database.categories.getCategoryNames(group.id);
    await createBudgetSheet(
      group.google_refresh_token,
      group.spreadsheet_id,
      categories,
      100,
      currency,
    );
  }

  // Write to Google Sheets
  try {
    await writeBudgetRow(group.google_refresh_token, group.spreadsheet_id, {
      month: currentMonth,
      category: normalizedCategory,
      limit: amount,
      currency: currency,
    });

    const emoji = getCategoryEmoji(normalizedCategory);
    await ctx.send(
      `✅ Бюджет установлен: ${emoji} ${normalizedCategory} = ${formatAmount(amount, currency)}`,
    );
  } catch (err) {
    logger.error({ err: err }, '[BUDGET] Failed to write to Google Sheets');
    await ctx.send(
      `⚠️ Бюджет сохранен в базу данных, но не удалось записать в Google Sheets.\n` +
        `Проверь доступ к таблице или используй /budget sync позже.`,
    );
  }

  // Maybe send daily advice (20% probability)
  await maybeSmartAdvice(ctx, group.id);
}

/**
 * Silently sync budgets from Google Sheets to database
 * Returns number of synced budgets
 */
export async function silentSyncBudgets(
  googleRefreshToken: string,
  spreadsheetId: string,
  groupId: number,
): Promise<number> {
  try {
    // Check if Budget sheet exists
    const hasSheet = await hasBudgetSheet(googleRefreshToken, spreadsheetId);
    if (!hasSheet) {
      return 0;
    }

    // Read budgets from Google Sheets
    const budgetsFromSheet = await readBudgetData(googleRefreshToken, spreadsheetId);
    if (budgetsFromSheet.length === 0) {
      return 0;
    }

    let syncedCount = 0;

    for (const budgetData of budgetsFromSheet) {
      // Check if category exists, if not - create it
      const categoryExists = database.categories.exists(groupId, budgetData.category);
      if (!categoryExists) {
        database.categories.create({
          group_id: groupId,
          name: budgetData.category,
        });
      }

      // Get existing budget to check if it changed
      const existing = database.budgets.findByGroupCategoryMonth(
        groupId,
        budgetData.category,
        budgetData.month,
      );

      const hasChanged =
        !existing ||
        existing.limit_amount !== budgetData.limit ||
        existing.currency !== budgetData.currency;

      if (hasChanged) {
        database.budgets.setBudget({
          group_id: groupId,
          category: budgetData.category,
          month: budgetData.month,
          limit_amount: budgetData.limit,
          currency: budgetData.currency,
        });
        syncedCount++;
      }
    }

    return syncedCount;
  } catch (err) {
    logger.error({ err: err }, '[BUDGET] Silent sync failed');
    return 0;
  }
}

/**
 * Sync budgets from Google Sheets to database
 */
async function syncBudgets(ctx: Ctx['Command'], group: Group): Promise<void> {
  if (!group.google_refresh_token || !group.spreadsheet_id) {
    await ctx.send('⚠️ Сначала подключи Google Sheets с помощью /connect');
    return;
  }

  try {
    // Check if Budget sheet exists
    const hasSheet = await hasBudgetSheet(group.google_refresh_token, group.spreadsheet_id);

    if (!hasSheet) {
      // Try to create Budget sheet
      const categories = database.categories.getCategoryNames(group.id);
      if (categories.length > 0) {
        try {
          await createBudgetSheet(
            group.google_refresh_token,
            group.spreadsheet_id,
            categories,
            100,
            group.default_currency,
          );
          await ctx.send(
            '✅ Вкладка Budget создана в таблице!\n\n' +
              'Теперь можешь установить бюджеты через:\n' +
              '/budget set <Категория> <Сумма>',
          );
        } catch (err) {
          logger.error({ err: err }, '[BUDGET] Failed to create Budget sheet');
          await ctx.send('⚠️ Не удалось создать вкладку Budget. Проверь доступ к таблице.');
        }
      } else {
        await ctx.send(
          `⚠️ Вкладка Budget не найдена в таблице.\n\n` +
            `Сначала добавь хотя бы один расход, чтобы создать категории.`,
        );
      }
      return;
    }

    // Read budgets from Google Sheets
    const budgetsFromSheet = await readBudgetData(group.google_refresh_token, group.spreadsheet_id);

    if (budgetsFromSheet.length === 0) {
      await ctx.send('⚠️ В Google Sheets нет бюджетов для синхронизации.');
      return;
    }

    // Save each budget to database
    let syncedCount = 0;
    let createdCategoriesCount = 0;

    for (const budgetData of budgetsFromSheet) {
      // Check if category exists, if not - create it
      const categoryExists = database.categories.exists(group.id, budgetData.category);
      if (!categoryExists) {
        database.categories.create({
          group_id: group.id,
          name: budgetData.category,
        });
        createdCategoriesCount++;
        logger.info(`[BUDGET] Created category: ${budgetData.category}`);
      }

      database.budgets.setBudget({
        group_id: group.id,
        category: budgetData.category,
        month: budgetData.month,
        limit_amount: budgetData.limit,
        currency: budgetData.currency,
      });
      syncedCount++;
    }

    let message = `✅ Синхронизировано записей бюджета: ${syncedCount}`;
    if (createdCategoriesCount > 0) {
      message += `\n✨ Создано новых категорий: ${createdCategoriesCount}`;
    }
    await ctx.send(message);

    // Maybe send daily advice (20% probability)
    await maybeSmartAdvice(ctx, group.id);
  } catch (err) {
    logger.error({ err: err }, '[BUDGET] Failed to sync budgets');
    await ctx.send('❌ Не удалось синхронизировать бюджеты. Проверь доступ к Google Sheets.');
  }
}
