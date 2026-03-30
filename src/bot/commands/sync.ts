/** /sync command handler — imports expenses from Google Sheets into the local database */
import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import type { Expense } from '../../database/types';
import {
  type MultiCurrencyRowError,
  readExpensesFromSheet,
  type SheetRow,
} from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import type { GoogleConnectedGroup } from '../guards';
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

  // Snapshot current state before destructive sync (deletes + updates)
  const allExpenses = database.expenses.findByGroupId(groupId, 100000);
  const allBudgets = database.budgets.findByGroupId(groupId);
  database.syncSnapshots.saveSnapshot(groupId, allExpenses, allBudgets);

  // Determine the year this spreadsheet covers so we only compare DB expenses
  // from that year. Without this, syncing a 2026-only sheet would delete all
  // prior-year DB expenses that don't appear in it.
  const spreadsheetYear =
    database.groupSpreadsheets
      .listAll(groupId)
      .find((s) => s.spreadsheetId === group.spreadsheet_id)?.year ?? null;

  const allDbExpenses = database.expenses.findByGroupId(groupId, 100000);
  const dbExpenses = spreadsheetYear
    ? allDbExpenses.filter((e) => e.date.startsWith(`${spreadsheetYear}-`))
    : allDbExpenses;
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

/**
 * One-directional import: read expenses from an arbitrary spreadsheet and add any
 * that are missing from the DB. Never deletes. Returns the number of inserted rows.
 * Safe to call repeatedly — deduplicates by date|category|amount|currency key.
 */
export async function importExpensesFromSheet(
  groupId: number,
  refreshToken: string,
  spreadsheetId: string,
): Promise<number> {
  const { expenses: sheetExpenses } = await readExpensesFromSheet(refreshToken, spreadsheetId);
  if (sheetExpenses.length === 0) return 0;

  const dbExpenses = database.expenses.findByGroupId(groupId, 100000);
  const existingKeys = new Set(dbExpenses.map((e) => dbExpenseToKey(e)));

  const users = database.users.findByGroupId ? database.users.findByGroupId(groupId) : [];
  const defaultUserId = users[0]?.id ?? 1;

  let inserted = 0;
  for (const row of sheetExpenses) {
    const parsed = sheetRowToKey(row);
    if (!parsed) continue;
    if (existingKeys.has(parsed.key)) continue;

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
    existingKeys.add(parsed.key); // guard against within-loop duplicates
    inserted++;
  }
  return inserted;
}

// ── Auto-sync with cooldown ──

const lastExpenseSyncByGroup = new Map<number, number>();
const SYNC_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ── Notify cache for pagination buttons ──

const NOTIFY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const syncNotifyCache = new Map<string, { result: SyncResult; expires: number }>();
const SYNC_PAGE_SIZE = 10;

function cleanSyncCache(): void {
  const now = Date.now();
  for (const [k, v] of syncNotifyCache) {
    if (v.expires < now) syncNotifyCache.delete(k);
  }
}

export function getSyncCachedResult(key: string): SyncResult | null {
  const entry = syncNotifyCache.get(key);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.result;
}

function fmtSyncItem(e: {
  date: string;
  amount: number;
  currency: string;
  category: string;
  comment: string;
}): string {
  return `${e.date} ${e.amount} ${e.currency} ${e.category}${e.comment ? ` ${e.comment}` : ''}`;
}

type SyncNotifyMessage = {
  text: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
};

function buildAutoSyncExpensesMessage(result: SyncResult, cacheKey: string): SyncNotifyMessage {
  const counts: string[] = [];
  if (result.added.length > 0) counts.push(`+${result.added.length}`);
  if (result.deleted.length > 0) counts.push(`-${result.deleted.length}`);
  if (result.updated.length > 0) counts.push(`~${result.updated.length}`);

  const lines: string[] = [`🔄 Авто-синк расходов: ${counts.join(', ')}`];
  const buttons: Array<{ text: string; callback_data: string }> = [];

  if (result.added.length > 0) {
    lines.push(`\n➕ Добавлено: ${result.added.length}`);
    for (const e of result.added.slice(0, SYNC_PAGE_SIZE)) {
      lines.push(`  ${fmtSyncItem(e)}`);
    }
    if (result.added.length > SYNC_PAGE_SIZE) {
      buttons.push({
        text: `➕ ещё ${result.added.length - SYNC_PAGE_SIZE} добавлено`,
        callback_data: `sync_more:${cacheKey}:a`,
      });
    }
  }

  if (result.deleted.length > 0) {
    lines.push(`\n🗑 Удалено: ${result.deleted.length}`);
    for (const e of result.deleted.slice(0, SYNC_PAGE_SIZE)) {
      lines.push(`  ${fmtSyncItem(e)}`);
    }
    if (result.deleted.length > SYNC_PAGE_SIZE) {
      buttons.push({
        text: `🗑 ещё ${result.deleted.length - SYNC_PAGE_SIZE} удалено`,
        callback_data: `sync_more:${cacheKey}:d`,
      });
    }
  }

  if (result.updated.length > 0) {
    lines.push(`\n✏️ Обновлено: ${result.updated.length}`);
    for (const e of result.updated.slice(0, SYNC_PAGE_SIZE)) {
      lines.push(`  ${fmtSyncItem(e)}${e.field ? ` (${e.field})` : ''}`);
    }
    if (result.updated.length > SYNC_PAGE_SIZE) {
      buttons.push({
        text: `✏️ ещё ${result.updated.length - SYNC_PAGE_SIZE} обновлено`,
        callback_data: `sync_more:${cacheKey}:u`,
      });
    }
  }

  const text = lines.join('\n');
  if (buttons.length > 0) {
    return { text, reply_markup: { inline_keyboard: buttons.map((b) => [b]) } };
  }
  return { text };
}

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
      cleanSyncCache();
      const cacheKey = Math.random().toString(36).slice(2, 10);
      syncNotifyCache.set(cacheKey, { result, expires: Date.now() + NOTIFY_CACHE_TTL_MS });
      const msgData = buildAutoSyncExpensesMessage(result, cacheKey);
      await bot.api.sendMessage({
        chat_id: telegramGroupId,
        ...msgData,
      });
    }
  } catch (err) {
    logger.error({ err }, `[AUTO-SYNC] Expenses failed for group ${groupId}`);
  }
}

/**
 * /sync command handler - sync expenses from Google Sheet to database.
 * Usage: /sync — pull from sheet, /sync rollback — restore last snapshot.
 */
export async function handleSyncCommand(
  ctx: Ctx['Command'],
  group: GoogleConnectedGroup,
): Promise<void> {
  // Check for "rollback" argument
  const commandText = ctx.text || '';
  const args = commandText.split(/\s+/).slice(1).join(' ').trim();

  if (args.toLowerCase() === 'rollback') {
    await handleSyncRollback(ctx, group.id);
    return;
  }

  await ctx.send('🔄 Синхронизирую...');

  try {
    // Save snapshot of current expenses + budgets BEFORE sync (enables rollback)
    const currentExpenses = database.expenses.findByGroupId(group.id);
    const currentBudgets = database.budgets.findByGroupId(group.id);
    let snapshotId: string | null = null;
    if (currentExpenses.length > 0 || currentBudgets.length > 0) {
      snapshotId = database.syncSnapshots.saveSnapshot(group.id, currentExpenses, currentBudgets);
      logger.info(
        `[SYNC] Saved snapshot ${snapshotId}: ${currentExpenses.length} expenses, ${currentBudgets.length} budgets`,
      );
    }

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

    const msg = formatSyncResult(result);
    const suffix =
      currentExpenses.length > 0 ? '\n\n<i>Если что-то пошло не так — /sync rollback</i>' : '';
    await ctx.send(msg + suffix, { parse_mode: 'HTML' });
  } catch (error) {
    logger.error({ err: error }, '[SYNC] Sync failed');
    await ctx.send(formatErrorForUser(error));
  }
}

/**
 * Handle /sync rollback — restore expenses from the latest snapshot
 */
async function handleSyncRollback(ctx: Ctx['Command'], groupId: number): Promise<void> {
  const snapshots = database.syncSnapshots.listSnapshots(groupId);

  if (snapshots.length === 0) {
    await ctx.send('❌ Нет сохранённых снимков для отката. Откат доступен после /sync.');
    return;
  }

  // Safe: length > 0 checked above
  const latest = snapshots[0];
  if (!latest) return;
  const snapshotDate = new Date(latest.createdAt).toLocaleString('ru-RU');

  await ctx.send(
    `🔄 Восстанавливаю ${latest.expenseCount} расходов и ${latest.budgetCount} бюджетов из снимка от ${snapshotDate}...`,
  );

  try {
    const expenses = database.syncSnapshots.getExpenseSnapshots(latest.snapshotId);
    const budgets = database.syncSnapshots.getBudgetSnapshots(latest.snapshotId);

    database.transaction(() => {
      database.expenses.deleteAllByGroupId(groupId);

      for (const expense of expenses) {
        database.expenses.create({
          group_id: expense.group_id,
          user_id: expense.user_id,
          date: expense.date,
          category: expense.category,
          comment: expense.comment || '',
          amount: expense.amount,
          currency: expense.currency,
          eur_amount: expense.eur_amount,
        });
      }

      for (const budget of budgets) {
        database.budgets.setBudget({
          group_id: budget.group_id,
          category: budget.category,
          month: budget.month,
          limit_amount: budget.limit_amount,
          currency: budget.currency,
        });
      }
    });

    await ctx.send(
      `✅ Откат завершён! Восстановлено ${expenses.length} расходов и ${budgets.length} бюджетов.`,
    );

    logger.info(
      `[SYNC] Rollback complete for group ${groupId}: ${expenses.length} expenses, ${budgets.length} budgets restored`,
    );
  } catch (error) {
    logger.error({ err: error }, '[SYNC] Rollback failed');
    await ctx.send('❌ Ошибка при откате. Попробуй ещё раз.');
  }
}
