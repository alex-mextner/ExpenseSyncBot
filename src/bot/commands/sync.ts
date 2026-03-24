// /sync command — diff-based sync from Google Sheet to local database

import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import type { Expense } from '../../database/types';
import {
  type MultiCurrencyRowError,
  readExpensesFromSheet,
  type SheetRow,
} from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import type { Ctx } from '../types';

const logger = createLogger('sync');

/** Key for matching sheet rows to DB expenses */
function makeKey(date: string, category: string, amount: number, currency: string): string {
  return `${date}|${category}|${amount}|${currency}`;
}

function sheetRowToKey(
  row: SheetRow,
): { key: string; amount: number; currency: CurrencyCode } | null {
  for (const [curr, amt] of Object.entries(row.amounts) as [string, number][]) {
    return {
      key: makeKey(row.date, row.category, amt, curr),
      amount: amt,
      currency: curr as CurrencyCode,
    };
  }
  return null;
}

function dbExpenseToKey(e: Expense): string {
  return makeKey(e.date, e.category, e.amount, e.currency);
}

/** Format expense one-liner for reports */
function fmtExpense(
  date: string,
  amount: number,
  currency: string,
  category: string,
  comment: string,
): string {
  const cmnt = comment ? ` ${comment}` : '';
  return `${date} ${amount} ${currency} ${category}${cmnt}`;
}

export interface SyncResult {
  unchanged: number;
  added: Array<{
    date: string;
    amount: number;
    currency: string;
    category: string;
    comment: string;
  }>;
  deleted: Array<{
    date: string;
    amount: number;
    currency: string;
    category: string;
    comment: string;
  }>;
  updated: Array<{
    date: string;
    amount: number;
    currency: string;
    category: string;
    comment: string;
    field: string;
  }>;
  createdCategories: string[];
  errors: MultiCurrencyRowError[];
}

/**
 * Core sync logic — compare sheet with DB and apply diff.
 * Reusable for /sync command and auto-sync.
 */
export async function syncExpenses(groupId: number): Promise<SyncResult> {
  const group = database.groups.findById(groupId);
  if (!group?.spreadsheet_id || !group?.google_refresh_token) {
    throw new Error('Group not configured for Google Sheets');
  }

  const { expenses: sheetExpenses, errors } = await readExpensesFromSheet(
    group.google_refresh_token,
    group.spreadsheet_id,
  );

  logger.info(`[SYNC] Sheet: ${sheetExpenses.length} expenses, ${errors.length} errors`);

  // Get existing DB expenses
  const dbExpenses = database.expenses.findByGroupId(groupId, 100000);

  // Build lookup maps
  const dbByKey = new Map<string, Expense>();
  for (const e of dbExpenses) {
    dbByKey.set(dbExpenseToKey(e), e);
  }

  const sheetKeys = new Set<string>();

  const users = database.users.findByGroupId ? database.users.findByGroupId(groupId) : [];
  const defaultUserId = users[0]?.id ?? 1;

  const result: SyncResult = {
    unchanged: 0,
    added: [],
    deleted: [],
    updated: [],
    createdCategories: [],
    errors,
  };

  // Create missing categories
  const categoriesInSheet = new Set<string>();
  for (const expense of sheetExpenses) {
    if (expense.category && expense.category !== 'Без категории') {
      categoriesInSheet.add(expense.category);
    }
  }
  for (const name of categoriesInSheet) {
    if (!database.categories.exists(groupId, name)) {
      database.categories.create({ group_id: groupId, name });
      result.createdCategories.push(name);
    }
  }

  // Process sheet rows: find added/updated/unchanged
  for (const row of sheetExpenses) {
    const parsed = sheetRowToKey(row);
    if (!parsed) continue;

    sheetKeys.add(parsed.key);
    const existing = dbByKey.get(parsed.key);

    if (!existing) {
      // New expense — add to DB
      database.expenses.create({
        group_id: groupId,
        user_id: defaultUserId,
        date: row.date,
        category: row.category,
        comment: row.comment,
        amount: parsed.amount,
        currency: parsed.currency,
        eur_amount: row.eurAmount,
      });
      result.added.push({
        date: row.date,
        amount: parsed.amount,
        currency: parsed.currency,
        category: row.category,
        comment: row.comment,
      });
    } else {
      // Exists — check for updates
      const changes: string[] = [];
      if (Math.abs(existing.eur_amount - row.eurAmount) > 0.01) {
        changes.push(`EUR: ${existing.eur_amount}→${row.eurAmount}`);
      }
      if (existing.comment !== row.comment) {
        changes.push('комментарий');
      }

      if (changes.length > 0) {
        // Update
        database.expenses.delete(existing.id);
        database.expenses.create({
          group_id: groupId,
          user_id: existing.user_id,
          date: row.date,
          category: row.category,
          comment: row.comment,
          amount: parsed.amount,
          currency: parsed.currency,
          eur_amount: row.eurAmount,
        });
        result.updated.push({
          date: row.date,
          amount: parsed.amount,
          currency: parsed.currency,
          category: row.category,
          comment: row.comment,
          field: changes.join(', '),
        });
      } else {
        result.unchanged++;
      }
    }
  }

  // Find deleted (in DB but not in sheet)
  for (const [key, expense] of dbByKey.entries()) {
    if (!sheetKeys.has(key)) {
      database.expenses.delete(expense.id);
      result.deleted.push({
        date: expense.date,
        amount: expense.amount,
        currency: expense.currency,
        category: expense.category,
        comment: expense.comment,
      });
    }
  }

  logger.info(
    `[SYNC] Done: +${result.added.length} -${result.deleted.length} ~${result.updated.length} =${result.unchanged}`,
  );

  return result;
}

/** Format sync result as Telegram message */
function formatSyncResult(result: SyncResult): string {
  const lines: string[] = ['✅ Синхронизация завершена!\n'];

  const total = result.unchanged + result.added.length + result.updated.length;
  lines.push(`💾 Всего в БД: ${total}`);
  lines.push(`✓ Без изменений: ${result.unchanged}`);

  if (result.added.length > 0) {
    lines.push(`\n➕ Добавлено: ${result.added.length}`);
    for (const e of result.added.slice(0, 10)) {
      lines.push(`  ${fmtExpense(e.date, e.amount, e.currency, e.category, e.comment)}`);
    }
    if (result.added.length > 10) lines.push(`  ...и ещё ${result.added.length - 10}`);
  }

  if (result.deleted.length > 0) {
    lines.push(`\n🗑 Удалено: ${result.deleted.length}`);
    for (const e of result.deleted.slice(0, 10)) {
      lines.push(`  ${fmtExpense(e.date, e.amount, e.currency, e.category, e.comment)}`);
    }
    if (result.deleted.length > 10) lines.push(`  ...и ещё ${result.deleted.length - 10}`);
  }

  if (result.updated.length > 0) {
    lines.push(`\n✏️ Обновлено: ${result.updated.length}`);
    for (const e of result.updated.slice(0, 10)) {
      lines.push(
        `  ${fmtExpense(e.date, e.amount, e.currency, e.category, e.comment)} (${e.field})`,
      );
    }
    if (result.updated.length > 10) lines.push(`  ...и ещё ${result.updated.length - 10}`);
  }

  if (result.createdCategories.length > 0) {
    lines.push(`\n📁 Новые категории: ${result.createdCategories.join(', ')}`);
  }

  return lines.join('\n');
}

// ── Auto-sync with cooldown ──

const lastSyncByGroup = new Map<number, number>();
const SYNC_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Run sync if last sync was more than SYNC_COOLDOWN ago.
 * Non-blocking — logs errors but doesn't throw.
 */
export async function maybeSyncExpenses(groupId: number): Promise<void> {
  const last = lastSyncByGroup.get(groupId) || 0;
  if (Date.now() - last < SYNC_COOLDOWN_MS) return;

  try {
    lastSyncByGroup.set(groupId, Date.now());
    const result = await syncExpenses(groupId);
    if (result.added.length > 0 || result.deleted.length > 0 || result.updated.length > 0) {
      logger.info(
        `[AUTO-SYNC] Group ${groupId}: +${result.added.length} -${result.deleted.length} ~${result.updated.length}`,
      );
    }
  } catch (err) {
    logger.error({ err }, `[AUTO-SYNC] Failed for group ${groupId}`);
  }
}

/**
 * /sync command handler
 */
export async function handleSyncCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('Error: Unable to identify chat');
    return;
  }

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
    await ctx.send('❌ Google таблица не подключена. Используй /connect');
    return;
  }

  await ctx.send('🔄 Синхронизирую...');

  try {
    const result = await syncExpenses(group.id);
    lastSyncByGroup.set(group.id, Date.now());

    // Report multi-currency errors separately
    if (result.errors.length > 0) {
      const errorLines = result.errors.map(
        (e) => `• Строка ${e.row}: ${e.date} ${e.category} — валюты: ${e.currencies.join(', ')}`,
      );
      await ctx.send(
        `⚠️ Строки с суммами в нескольких валютах (пропущены):\n${errorLines.join('\n')}`,
      );
    }

    await ctx.send(formatSyncResult(result));
  } catch (error) {
    logger.error({ err: error }, '[SYNC] Sync failed');
    await ctx.send(
      `❌ Ошибка синхронизации: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
