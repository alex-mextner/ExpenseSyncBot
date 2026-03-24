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
import type { BotInstance, Ctx } from '../types';

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
 * Uses greedy matching: first exact match (including comment+EUR),
 * then partial match (key only) to detect updates.
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

  const dbExpenses = database.expenses.findByGroupId(groupId, 100000);
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
  for (const expense of sheetExpenses) {
    if (expense.category && expense.category !== 'Без категории') {
      if (!database.categories.exists(groupId, expense.category)) {
        database.categories.create({ group_id: groupId, name: expense.category });
        result.createdCategories.push(expense.category);
      }
    }
  }

  // Build multimap from DB: shortKey → [Expense]
  const dbPool = new Map<string, Expense[]>();
  for (const e of dbExpenses) {
    const key = dbExpenseToKey(e);
    const arr = dbPool.get(key);
    if (arr) {
      arr.push(e);
    } else {
      dbPool.set(key, [e]);
    }
  }

  // Full-key set for exact match tracking
  const exactMatched = new Set<number>(); // DB expense IDs that matched exactly

  // Pass 1: exact matches (key + comment + eurAmount)
  const unmatchedSheetRows: Array<{
    row: SheetRow;
    parsed: ReturnType<typeof sheetRowToKey> & {};
  }> = [];

  for (const row of sheetExpenses) {
    const parsed = sheetRowToKey(row);
    if (!parsed) continue;

    const candidates = dbPool.get(parsed.key);
    if (!candidates || candidates.length === 0) {
      unmatchedSheetRows.push({ row, parsed });
      continue;
    }

    // Find exact match
    const exactIdx = candidates.findIndex(
      (e) => e.comment === row.comment && Math.abs(e.eur_amount - row.eurAmount) <= 0.01,
    );

    if (exactIdx !== -1) {
      const matched = candidates.splice(exactIdx, 1)[0];
      if (matched) exactMatched.add(matched.id);
      result.unchanged++;
    } else {
      unmatchedSheetRows.push({ row, parsed });
    }
  }

  // Pass 2: unmatched sheet rows — try partial match (update) or add
  for (const { row, parsed } of unmatchedSheetRows) {
    const candidates = dbPool.get(parsed.key);

    if (candidates && candidates.length > 0) {
      // Partial match — this is an update
      const existing = candidates.shift();
      if (!existing) continue;

      const changes: string[] = [];
      if (Math.abs(existing.eur_amount - row.eurAmount) > 0.01) {
        changes.push(`EUR: ${existing.eur_amount}→${row.eurAmount}`);
      }
      if (existing.comment !== row.comment) {
        changes.push(`"${existing.comment || ''}"→"${row.comment || ''}"`);
      }

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
      // No match at all — new expense
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
    }
  }

  // Pass 3: remaining unmatched DB expenses — deleted from sheet
  for (const candidates of dbPool.values()) {
    for (const expense of candidates) {
      if (exactMatched.has(expense.id)) continue;
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

const lastExpenseSyncByGroup = new Map<number, number>();
const SYNC_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Sync expenses if stale. Blocking — caller awaits fresh data.
 * Sends notification to chat only if there were changes.
 */
export async function ensureFreshExpenses(
  groupId: number,
  telegramGroupId?: number,
  bot?: BotInstance,
): Promise<void> {
  const last = lastExpenseSyncByGroup.get(groupId) || 0;
  if (Date.now() - last < SYNC_COOLDOWN_MS) return;

  try {
    lastExpenseSyncByGroup.set(groupId, Date.now());
    const result = await syncExpenses(groupId);
    const hasChanges =
      result.added.length > 0 || result.deleted.length > 0 || result.updated.length > 0;

    if (hasChanges && telegramGroupId && bot) {
      const parts: string[] = [];
      if (result.added.length > 0) parts.push(`+${result.added.length}`);
      if (result.deleted.length > 0) parts.push(`-${result.deleted.length}`);
      if (result.updated.length > 0) parts.push(`~${result.updated.length}`);
      await bot.api.sendMessage({
        chat_id: telegramGroupId,
        text: `🔄 Авто-синк расходов: ${parts.join(', ')}`,
      });
    }
  } catch (err) {
    logger.error({ err }, `[AUTO-SYNC] Expenses failed for group ${groupId}`);
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
    lastExpenseSyncByGroup.set(group.id, Date.now());

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
