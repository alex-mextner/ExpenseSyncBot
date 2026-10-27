// Scheduled tasks: daily exchange rate update, monthly budget tab auto-clone, AI usage retention

import cron from 'node-cron';
import { env } from '../config/env';
import { database } from '../database';
import { AI_USAGE_RETENTION_DAYS } from '../database/repositories/ai-usage-events.repository';
import type { Group } from '../database/types';
import { sendDirect, sendMessage, withChatContext } from '../services/bank/telegram-sender';
import { updateExchangeRates } from '../services/currency/converter';
import { type MonthAbbr, monthAbbrFromDate, prevMonthAbbr } from '../services/google/month-abbr';
import {
  cloneMonthTab,
  createEmptyMonthTab,
  createExpenseSpreadsheet,
  type GoogleConn,
  getSpreadsheetUrl,
  googleConn,
  monthTabExists,
  sortExpensesTab,
} from '../services/google/sheets';
import { closeUnmatchedTags } from '../utils/html';
import { createLogger } from '../utils/logger.ts';
import { formatBudgetProgressText } from './commands/budget';
import { importExpensesFromSheet } from './commands/sync';
import { silentSyncBudgets } from './services/budget-sync';

const logger = createLogger('cron');

const RATE_FETCH_MAX_RETRIES = 3;
const RATE_FETCH_BASE_DELAY_MS = 10_000; // 10s, 20s, 40s

/**
 * Fetch exchange rates with exponential backoff.
 * After all retries fail, notifies admin via Telegram.
 */
async function fetchRatesWithRetry(): Promise<void> {
  for (let attempt = 1; attempt <= RATE_FETCH_MAX_RETRIES; attempt++) {
    try {
      await updateExchangeRates();
      return;
    } catch (err) {
      logger.error({ err, attempt }, '[CRON] Exchange rate fetch failed');
      if (attempt < RATE_FETCH_MAX_RETRIES) {
        const delay = RATE_FETCH_BASE_DELAY_MS * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  logger.error('[CRON] Exchange rate fetch failed after all retries');
  if (env.BOT_ADMIN_CHAT_ID) {
    await sendDirect(
      env.BOT_ADMIN_CHAT_ID,
      `⚠️ Курсы валют не обновились после ${RATE_FETCH_MAX_RETRIES} попыток. Бот использует fallback-курсы.`,
    ).catch((sendErr) =>
      logger.error({ err: sendErr }, '[CRON] Failed to notify admin about rate failure'),
    );
  }
}

/**
 * Fetch exchange rates on startup and daily at 01:00 UTC.
 * open.er-api.com updates around 00:00 UTC — fetching at 01:00 ensures fresh data.
 */
export function registerExchangeRateCron(): void {
  fetchRatesWithRetry().catch((err) =>
    logger.error({ err }, '[CRON] Initial exchange rate fetch failed'),
  );
  cron.schedule('0 1 * * *', () => {
    fetchRatesWithRetry().catch((err) =>
      logger.error({ err }, '[CRON] Exchange rate refresh failed'),
    );
  });
  logger.info('[CRON] Exchange rate cron registered (daily 01:00 UTC, fetch on startup)');
}

/** Drop ai_usage_events rows past the retention window. A storage failure is logged, never thrown. */
function pruneAiUsageEvents(): void {
  try {
    const removed = database.aiUsageEvents.pruneOlderThan(
      Date.now() - AI_USAGE_RETENTION_DAYS * 86_400_000,
    );
    logger.info(
      `[CRON] AI usage retention: removed ${removed} rows older than ${AI_USAGE_RETENTION_DAYS} days`,
    );
  } catch (err) {
    logger.error({ err }, '[CRON] AI usage retention prune failed');
  }
}

/** Prune the AI usage events on startup and daily at 03:30 UTC. */
export function registerAiUsageRetentionCron(): void {
  pruneAiUsageEvents();
  cron.schedule('30 3 * * *', pruneAiUsageEvents);
  logger.info('[CRON] AI usage retention cron registered (daily 03:30 UTC, prune on startup)');
}

const BUDGET_EDIT_HINT = '<code>/budget set Категория Сумма</code>\n' + '<code>/budget sync</code>';

/** New-year spreadsheet (Expenses tab only) when the group has none for `year`; else the existing one. */
async function ensureYearSpreadsheet(
  group: Group,
  conn: GoogleConn,
  year: number,
): Promise<{ spreadsheetId: string; newYearUrl: string | null }> {
  const existingId = database.groupSpreadsheets.getByYear(group.id, year);
  if (existingId) return { spreadsheetId: existingId, newYearUrl: null };

  const { spreadsheetId: newId } = await createExpenseSpreadsheet(
    conn,
    group.default_currency,
    group.enabled_currencies,
  );
  database.groupSpreadsheets.setYear(group.id, year, newId);
  logger.info(`[CRON] Created new spreadsheet for group ${group.id}, year ${year}: ${newId}`);
  return { spreadsheetId: newId, newYearUrl: `https://docs.google.com/spreadsheets/d/${newId}` };
}

/** Clone the previous month's tab when it exists, otherwise create an empty one. */
async function createMonthTab(
  group: Group,
  conn: GoogleConn,
  spreadsheetId: string,
  year: number,
  month: MonthAbbr,
): Promise<void> {
  const { year: prevYear, month: prevMonth } = prevMonthAbbr(year, month);
  const prevSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, prevYear);

  if (prevSpreadsheetId && (await monthTabExists(conn, prevSpreadsheetId, prevMonth))) {
    await cloneMonthTab(conn, prevSpreadsheetId, prevMonth, spreadsheetId, month);
    logger.info(`[CRON] Cloned ${prevMonth} → ${month} for group ${group.id}`);
  } else {
    await createEmptyMonthTab(conn, spreadsheetId, month);
    logger.info(`[CRON] Created empty tab ${month} for group ${group.id}`);
  }
}

function buildMonthlyNotifyText(
  sheetUrl: string,
  newYearUrl: string | null,
  year: number,
  budget: { text: string; hasBudgets: boolean },
): string {
  const yearSuffix = newYearUrl ? ` (${year})` : '';
  if (budget.hasBudgets) {
    return (
      `Новый бюджет сформирован\n\n🔗 <a href="${sheetUrl}">Гугл таблица</a>${yearSuffix}` +
      `\n\n${budget.text}` +
      `\n\nРедактировать бюджет можно через ИИ или командами:\n${BUDGET_EDIT_HINT}`
    );
  }
  return (
    `Пора сформировать бюджет\n\n🔗 <a href="${sheetUrl}">Гугл таблица</a>${yearSuffix}` +
    `\n\nЗаполни вкладку в таблице или используй команды:\n${BUDGET_EDIT_HINT}`
  );
}

/** Telegram message limit is 4096 chars — truncate at last newline boundary, close tags. */
function truncateNotifyText(notifyText: string, sheetUrl: string): string {
  if (notifyText.length <= 4000) return notifyText;
  const cut = notifyText.lastIndexOf('\n', 3900);
  const truncated = cut > 0 ? notifyText.slice(0, cut) : notifyText.slice(0, 3900);
  return closeUnmatchedTags(`${truncated}\n...\n\n🔗 <a href="${sheetUrl}">Гугл таблица</a>`);
}

/** Create this month's tab for one group and notify it; skips when the tab already exists. */
async function cloneMonthForGroup(group: Group, year: number, month: MonthAbbr): Promise<void> {
  const conn = googleConn(group);
  const { spreadsheetId, newYearUrl } = await ensureYearSpreadsheet(group, conn, year);

  const tabAlreadyExists = await monthTabExists(conn, spreadsheetId, month);
  if (tabAlreadyExists) {
    logger.info(`[CRON] Tab ${month} already exists for group ${group.id}, skipping`);
    return;
  }

  await createMonthTab(group, conn, spreadsheetId, year, month);

  // Sync budgets from the newly created/cloned tab (silentSyncBudgets catches internally, never throws)
  await silentSyncBudgets(conn, group.id);

  const sheetUrl = newYearUrl ?? getSpreadsheetUrl(spreadsheetId);
  const notifyText = truncateNotifyText(
    buildMonthlyNotifyText(sheetUrl, newYearUrl, year, formatBudgetProgressText(group.id)),
    sheetUrl,
  );

  await withChatContext(group.telegram_group_id, group.active_topic_id, () =>
    sendMessage(notifyText),
  ).catch((err: unknown) => logger.error({ err }, `[CRON] Failed to notify group ${group.id}`));
}

export function registerMonthlyCron(): void {
  cron.schedule('0 0 1 * *', async () => {
    logger.info('[CRON] Monthly tab auto-clone started');

    const now = new Date();
    const year = now.getFullYear();
    const month = monthAbbrFromDate(now);

    const groups = database.groups.findAll();

    for (const group of groups) {
      if (!group.google_refresh_token) continue;

      // Only active groups (have at least one spreadsheet entry)
      const allSpreadsheets = database.groupSpreadsheets.listAll(group.id);
      if (allSpreadsheets.length === 0) continue;

      try {
        await cloneMonthForGroup(group, year, month);
      } catch (err) {
        logger.error({ err }, `[CRON] Failed for group ${group.id}`);
      }
    }

    logger.info('[CRON] Monthly tab auto-clone complete');
  });

  logger.info('[CRON] Monthly tab cron registered (00:00 on 1st of each month)');
}

/**
 * One-time startup backfill: sort Expenses tab by date in all groups' spreadsheets.
 */
export async function backfillSortExpensesTabs(): Promise<void> {
  const groups = database.groups.findAll();

  for (const group of groups) {
    if (!group.google_refresh_token) continue;

    for (const { year, spreadsheetId } of database.groupSpreadsheets.listAll(group.id)) {
      try {
        await sortExpensesTab(googleConn(group), spreadsheetId);
        logger.info(`[BACKFILL] Sorted Expenses tab for group ${group.id}, year ${year}`);
      } catch (err) {
        logger.error({ err }, `[BACKFILL] Sort failed for group ${group.id}, year ${year}`);
      }
    }
  }
}

/**
 * One-time startup recovery: re-import expenses from prior-year spreadsheets
 * into the DB. Only inserts rows that are missing — never deletes, never duplicates.
 * Needed after a sync bug deleted prior-year expenses from the DB (2026-03-28).
 */
export async function recoverPriorYearExpenses(): Promise<void> {
  const currentYear = new Date().getFullYear();
  const groups = database.groups.findAll();

  for (const group of groups) {
    if (!group.google_refresh_token) continue;

    const priorSheets = database.groupSpreadsheets
      .listAll(group.id)
      .filter((s) => s.year < currentYear);

    for (const { year, spreadsheetId } of priorSheets) {
      try {
        const inserted = await importExpensesFromSheet(group.id, googleConn(group), spreadsheetId);
        if (inserted > 0) {
          logger.info(
            `[RECOVER] Restored ${inserted} expense(s) for group ${group.id}, year ${year}`,
          );
        } else {
          logger.info(`[RECOVER] group ${group.id}, year ${year}: nothing missing`);
        }
      } catch (err) {
        logger.error({ err }, `[RECOVER] Failed for group ${group.id}, year ${year}`);
      }
    }
  }
}
