/** /budget command handler — create, view, and edit spending budgets per category */
import { format } from 'date-fns';
import { InlineKeyboard } from 'gramio';
import { CURRENCY_ALIASES, type CurrencyCode, getCurrencySymbol } from '../../config/constants';
import { database } from '../../database';

import { sendMessage } from '../../services/bank/telegram-sender';
import { getBudgetManager } from '../../services/budget-manager';
import { monthAbbrFromDate } from '../../services/google/month-abbr';
import {
  createEmptyMonthTab,
  googleConn,
  monthTabExists,
  readMonthBudget,
} from '../../services/google/sheets';
import { normalizeCategoryName } from '../../utils/fuzzy-search';
import { createLogger } from '../../utils/logger.ts';
import { buildMiniAppUrl } from '../../utils/miniapp-url';
import type { GoogleConnectedGroup } from '../guards';
import { createAddCategoryWithBudgetKeyboard, createBudgetViewKeyboard } from '../keyboards';
import { silentSyncBudgets } from '../services/budget-sync';
import type { Ctx } from '../types';
import { maybeSmartAdvice } from './ask';
import { formatBudgetProgress, formatBudgetSetMessage } from './budget-view';

const logger = createLogger('budget');

const NO_BUDGET_HINT =
  'Используй:\n• /budget set &lt;Категория&gt; &lt;Сумма&gt;\n• /budget sync — синхронизировать с Google Sheets';

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
    await sendBudgetView(group);
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

/** Send the rich budget overview — shared by /budget and the "show budget" button. */
export async function sendBudgetView(group: {
  id: number;
  telegram_group_id: number;
}): Promise<void> {
  const { messages, hasBudgets } = formatBudgetProgress(group.id);
  const miniAppUrl = buildMiniAppUrl('dashboard', group.telegram_group_id);
  const keyboard = miniAppUrl ? new InlineKeyboard().url('📊 Дашборд', miniAppUrl) : undefined;

  const lastIndex = messages.length - 1;
  for (const [index, message] of messages.entries()) {
    const isLast = index === lastIndex;
    const text = isLast && !hasBudgets ? `${message}\n\n${NO_BUDGET_HINT}` : message;
    await sendMessage(text, isLast && keyboard ? { reply_markup: keyboard } : {});
  }
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

  await sendMessage(
    formatBudgetSetMessage({
      category: normalizedCategory,
      amount,
      currency,
      sheetsSynced: result.sheetsSynced,
      sheetsConnected: Boolean(group.google_refresh_token),
    }),
    { reply_markup: createBudgetViewKeyboard() },
  );

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
