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
import { env } from '../../config/env';
import { database } from '../../database';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import { monthAbbrFromDate } from '../../services/google/month-abbr';
import {
  createEmptyMonthTab,
  type GoogleConn,
  googleConn,
  monthTabExists,
  readMonthBudget,
  writeMonthBudgetRow,
} from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import type { GoogleConnectedGroup } from '../guards';
import { createAddCategoryWithBudgetKeyboard } from '../keyboards';
import { sendToChat } from '../send';
import type { BotInstance, Ctx } from '../types';
import { maybeSmartAdvice } from './ask';

const logger = createLogger('budget');

// ── Auto-sync budgets with cooldown ──

const lastBudgetSyncByGroup = new Map<number, number>();
const BUDGET_SYNC_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ── Notify cache for pagination buttons ──

const BUDGET_NOTIFY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const budgetNotifyCache = new Map<string, { result: BudgetSyncResult; expires: number }>();
const BUDGET_PAGE_SIZE = 10;

function cleanBudgetCache(): void {
  const now = Date.now();
  for (const [k, v] of budgetNotifyCache) {
    if (v.expires < now) budgetNotifyCache.delete(k);
  }
}

export function getBudgetSyncCachedResult(key: string): BudgetSyncResult | null {
  const entry = budgetNotifyCache.get(key);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.result;
}

function fmtBudgetItem(e: {
  category: string;
  limit: number;
  currency: CurrencyCode;
  oldLimit?: number;
}): string {
  const change = e.oldLimit !== undefined ? ` (было ${e.oldLimit})` : '';
  return `${e.category}: ${e.limit} ${e.currency}${change}`;
}

type BudgetNotifyMessage = {
  text: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
};

function buildAutoSyncBudgetsMessage(
  result: BudgetSyncResult,
  cacheKey: string,
): BudgetNotifyMessage {
  const counts: string[] = [];
  if (result.added.length > 0) counts.push(`+${result.added.length}`);
  if (result.deleted.length > 0) counts.push(`-${result.deleted.length}`);
  if (result.updated.length > 0) counts.push(`~${result.updated.length}`);

  const lines: string[] = [`🔄 Авто-синк бюджетов: ${counts.join(', ')}`];
  const buttons: Array<{ text: string; callback_data: string }> = [];

  if (result.added.length > 0) {
    lines.push(`\n➕ Добавлено: ${result.added.length}`);
    for (const e of result.added.slice(0, BUDGET_PAGE_SIZE)) {
      lines.push(`  ${fmtBudgetItem(e)}`);
    }
    if (result.added.length > BUDGET_PAGE_SIZE) {
      buttons.push({
        text: `➕ ещё ${result.added.length - BUDGET_PAGE_SIZE} добавлено`,
        callback_data: `bsync_more:${cacheKey}:a`,
      });
    }
  }

  if (result.deleted.length > 0) {
    lines.push(`\n🗑 Удалено: ${result.deleted.length}`);
    for (const e of result.deleted.slice(0, BUDGET_PAGE_SIZE)) {
      lines.push(`  ${fmtBudgetItem(e)}`);
    }
    if (result.deleted.length > BUDGET_PAGE_SIZE) {
      buttons.push({
        text: `🗑 ещё ${result.deleted.length - BUDGET_PAGE_SIZE} удалено`,
        callback_data: `bsync_more:${cacheKey}:d`,
      });
    }
  }

  if (result.updated.length > 0) {
    lines.push(`\n✏️ Обновлено: ${result.updated.length}`);
    for (const e of result.updated.slice(0, BUDGET_PAGE_SIZE)) {
      lines.push(`  ${fmtBudgetItem(e)}`);
    }
    if (result.updated.length > BUDGET_PAGE_SIZE) {
      buttons.push({
        text: `✏️ ещё ${result.updated.length - BUDGET_PAGE_SIZE} обновлено`,
        callback_data: `bsync_more:${cacheKey}:u`,
      });
    }
  }

  const text = lines.join('\n');
  if (buttons.length > 0) {
    return { text, reply_markup: { inline_keyboard: buttons.map((b) => [b]) } };
  }
  return { text };
}

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
  if (!group?.google_refresh_token) {
    throw new Error('Group not configured for Google Sheets');
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = format(now, 'yyyy-MM');
  const currentMonthAbbr = monthAbbrFromDate(now);

  const spreadsheetId = database.groupSpreadsheets.getByYear(groupId, currentYear);
  if (!spreadsheetId) {
    return { unchanged: 0, added: [], updated: [], deleted: [], createdCategories: [] };
  }

  const conn = googleConn(group);

  const tabExists = await monthTabExists(conn, spreadsheetId, currentMonthAbbr);
  if (!tabExists) {
    return { unchanged: 0, added: [], updated: [], deleted: [], createdCategories: [] };
  }

  const sheetBudgets = await readMonthBudget(conn, spreadsheetId, currentMonthAbbr);

  const result: BudgetSyncResult = {
    unchanged: 0,
    added: [],
    updated: [],
    deleted: [],
    createdCategories: [],
  };

  const sheetCategories = new Set<string>(sheetBudgets.map((b) => b.category));

  for (const b of sheetBudgets) {
    if (!database.categories.exists(groupId, b.category)) {
      database.categories.create({ group_id: groupId, name: b.category });
      result.createdCategories.push(b.category);
    }

    const existing = database.budgets.findByGroupCategoryMonth(groupId, b.category, currentMonth);

    if (!existing) {
      database.budgets.setBudget({
        group_id: groupId,
        category: b.category,
        month: currentMonth,
        limit_amount: b.limit,
        currency: b.currency,
      });
      result.added.push({
        month: currentMonth,
        category: b.category,
        limit: b.limit,
        currency: b.currency,
      });
    } else if (existing.limit_amount !== b.limit || existing.currency !== b.currency) {
      database.budgets.setBudget({
        group_id: groupId,
        category: b.category,
        month: currentMonth,
        limit_amount: b.limit,
        currency: b.currency,
      });
      result.updated.push({
        month: currentMonth,
        category: b.category,
        limit: b.limit,
        currency: b.currency,
        oldLimit: existing.limit_amount,
      });
    } else {
      result.unchanged++;
    }
  }

  const dbBudgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);
  for (const db of dbBudgets) {
    if (!sheetCategories.has(db.category)) {
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
      cleanBudgetCache();
      const cacheKey = Math.random().toString(36).slice(2, 10);
      budgetNotifyCache.set(cacheKey, { result, expires: Date.now() + BUDGET_NOTIFY_CACHE_TTL_MS });
      const msgData = buildAutoSyncBudgetsMessage(result, cacheKey);
      await bot.api.sendMessage({
        chat_id: telegramGroupId,
        ...msgData,
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
      await sendToChat(`🔄 Синхронизировано записей бюджета: ${syncedCount}`);
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
      await sendToChat(
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
  await sendToChat(
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

  const keyboard = env.MINIAPP_URL
    ? new InlineKeyboard().webApp(
        '📊 Дашборд',
        `${env.MINIAPP_URL}?groupId=${group.telegram_group_id}&tab=dashboard`,
      )
    : undefined;

  if (budgets.length === 0) {
    await sendToChat(
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

  await sendToChat(message.trim(), keyboard ? { reply_markup: keyboard } : {});
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
  const currentMonthAbbr = monthAbbrFromDate(now);

  const normalizedCategory =
    categoryName.charAt(0).toUpperCase() + categoryName.slice(1).toLowerCase();

  const categoryExists = database.categories.exists(group.id, normalizedCategory);

  if (!categoryExists) {
    const existingCategories = database.categories.getCategoryNames(group.id);
    const keyboard = createAddCategoryWithBudgetKeyboard(normalizedCategory, amount, currency);
    const currencySymbol = getCurrencySymbol(currency);

    await sendToChat(
      `Категория "${normalizedCategory}" не существует.\n\n` +
        `Хочешь добавить новую категорию "${normalizedCategory}" с бюджетом ${currencySymbol}${amount}?\n\n` +
        `Или выбери из существующих:\n${existingCategories.join(', ')}`,
      { reply_markup: keyboard },
    );
    return;
  }

  database.budgets.setBudget({
    group_id: group.id,
    category: normalizedCategory,
    month: currentMonth,
    limit_amount: amount,
    currency,
  });

  if (!group.google_refresh_token || !group.spreadsheet_id) {
    const emoji = getCategoryEmoji(normalizedCategory);
    await sendToChat(
      `Бюджет установлен: ${emoji} ${normalizedCategory} = ${formatAmount(amount, currency)}\n\n` +
        'Подключи Google Sheets (/connect) чтобы синхронизировать бюджеты.',
    );
    return;
  }

  try {
    const conn = googleConn(group);
    const tabExists = await monthTabExists(conn, group.spreadsheet_id, currentMonthAbbr);
    if (!tabExists) {
      await createEmptyMonthTab(conn, group.spreadsheet_id, currentMonthAbbr);
    }

    await writeMonthBudgetRow(conn, group.spreadsheet_id, currentMonthAbbr, {
      category: normalizedCategory,
      limit: amount,
      currency,
    });

    const emoji = getCategoryEmoji(normalizedCategory);
    await sendToChat(
      `Бюджет установлен: ${emoji} ${normalizedCategory} = ${formatAmount(amount, currency)}`,
    );
  } catch (err) {
    logger.error({ err }, '[BUDGET] Failed to write to Google Sheets');
    await sendToChat(
      `Бюджет сохранен в базу данных, но не удалось записать в Google Sheets.\n` +
        `Проверь доступ к таблице или используй /budget sync позже.`,
    );
  }

  await maybeSmartAdvice(group.id);
}

/**
 * Silently sync budgets from Google Sheets to database
 * Returns number of synced budgets
 */
export async function silentSyncBudgets(conn: GoogleConn, groupId: number): Promise<number> {
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = format(now, 'yyyy-MM');
    const currentMonthAbbr = monthAbbrFromDate(now);

    const spreadsheetId = database.groupSpreadsheets.getByYear(groupId, currentYear);
    if (!spreadsheetId) return 0;

    const tabExists = await monthTabExists(conn, spreadsheetId, currentMonthAbbr);
    if (!tabExists) return 0;

    const budgetsFromSheet = await readMonthBudget(conn, spreadsheetId, currentMonthAbbr);
    if (budgetsFromSheet.length === 0) return 0;

    // Wrap all DB writes in a transaction for atomicity
    const syncedCount = database.transaction(() => {
      let count = 0;

      for (const b of budgetsFromSheet) {
        if (!database.categories.exists(groupId, b.category)) {
          database.categories.create({ group_id: groupId, name: b.category });
        }

        const existing = database.budgets.findByGroupCategoryMonth(
          groupId,
          b.category,
          currentMonth,
        );
        const hasChanged =
          !existing || existing.limit_amount !== b.limit || existing.currency !== b.currency;

        if (hasChanged) {
          database.budgets.setBudget({
            group_id: groupId,
            category: b.category,
            month: currentMonth,
            limit_amount: b.limit,
            currency: b.currency,
          });
          count++;
        }
      }

      return count;
    });

    return syncedCount;
  } catch (err) {
    logger.error({ err }, '[BUDGET] Silent sync failed');
    return 0;
  }
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
      await sendToChat(
        `Вкладка ${currentMonthAbbr} создана в таблице.\n\n` +
          `Добавь бюджеты через:\n/budget set <Категория> <Сумма>`,
      );
      return;
    }

    const budgetsFromSheet = await readMonthBudget(conn, group.spreadsheet_id, currentMonthAbbr);

    if (budgetsFromSheet.length === 0) {
      await sendToChat(`В вкладке ${currentMonthAbbr} нет бюджетов для синхронизации.`);
      return;
    }

    let syncedCount = 0;
    let createdCategoriesCount = 0;

    for (const b of budgetsFromSheet) {
      if (!database.categories.exists(group.id, b.category)) {
        database.categories.create({ group_id: group.id, name: b.category });
        createdCategoriesCount++;
      }
      database.budgets.setBudget({
        group_id: group.id,
        category: b.category,
        month: currentMonth,
        limit_amount: b.limit,
        currency: b.currency,
      });
      syncedCount++;
    }

    let message = `Синхронизировано записей бюджета: ${syncedCount}`;
    if (createdCategoriesCount > 0) {
      message += `\nСоздано новых категорий: ${createdCategoriesCount}`;
    }
    await sendToChat(message);
    await maybeSmartAdvice(group.id);
  } catch (err) {
    logger.error({ err }, '[BUDGET] Failed to sync budgets');
    await sendToChat('Не удалось синхронизировать бюджеты. Проверь доступ к Google Sheets.');
  }
}
