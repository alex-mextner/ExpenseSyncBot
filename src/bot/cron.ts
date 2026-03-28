// Monthly budget tab auto-clone — runs at 00:00 on the 1st of every month

import cron from 'node-cron';
import { database } from '../database';
import { MONTH_ABBREVS, monthAbbrFromDate, prevMonthAbbr } from '../services/google/month-abbr';
import {
  cloneMonthTab,
  createEmptyMonthTab,
  createExpenseSpreadsheet,
  monthTabExists,
} from '../services/google/sheets';
import { createLogger } from '../utils/logger.ts';
import type { BotInstance } from './types';

const logger = createLogger('cron');

export function registerMonthlyCron(bot: BotInstance): void {
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
        let spreadsheetId = database.groupSpreadsheets.getByYear(group.id, year);
        let newYearUrl: string | null = null;

        if (!spreadsheetId) {
          // New year — create spreadsheet (Expenses tab only)
          const { spreadsheetId: newId } = await createExpenseSpreadsheet(
            group.google_refresh_token,
            group.default_currency,
            group.enabled_currencies,
          );
          database.groupSpreadsheets.setYear(group.id, year, newId);
          spreadsheetId = newId;
          newYearUrl = `https://docs.google.com/spreadsheets/d/${newId}`;
          logger.info(
            `[CRON] Created new spreadsheet for group ${group.id}, year ${year}: ${newId}`,
          );
        }

        const tabAlreadyExists = await monthTabExists(
          group.google_refresh_token,
          spreadsheetId,
          month,
        );
        if (tabAlreadyExists) {
          logger.info(`[CRON] Tab ${month} already exists for group ${group.id}, skipping`);
          continue;
        }

        const { year: prevYear, month: prevMonth } = prevMonthAbbr(year, month);
        const prevSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, prevYear);

        let notifyText: string;
        if (
          prevSpreadsheetId &&
          (await monthTabExists(group.google_refresh_token, prevSpreadsheetId, prevMonth))
        ) {
          await cloneMonthTab(
            group.google_refresh_token,
            prevSpreadsheetId,
            prevMonth,
            spreadsheetId,
            month,
          );
          notifyText = `Создана вкладка ${month} — скопирована из ${prevMonth}`;
          logger.info(`[CRON] Cloned ${prevMonth} → ${month} for group ${group.id}`);
        } else {
          await createEmptyMonthTab(group.google_refresh_token, spreadsheetId, month);
          notifyText = `Создана вкладка ${month}`;
          logger.info(`[CRON] Created empty tab ${month} for group ${group.id}`);
        }

        if (newYearUrl) {
          notifyText += `\n\nНовая таблица ${year}: ${newYearUrl}`;
        }

        await bot.api
          .sendMessage({
            chat_id: group.telegram_group_id,
            text: notifyText,
            ...(group.active_topic_id ? { message_thread_id: group.active_topic_id } : {}),
          })
          .catch((err: unknown) =>
            logger.error({ err }, `[CRON] Failed to notify group ${group.id}`),
          );
      } catch (err) {
        logger.error({ err }, `[CRON] Failed for group ${group.id}`);
      }
    }

    logger.info('[CRON] Monthly tab auto-clone complete');
  });

  logger.info('[CRON] Monthly tab cron registered (00:00 on 1st of each month)');
}

/**
 * Backfill any month tabs missing between January and the current month (inclusive)
 * for every active group. Runs silently at startup — no chat notifications.
 * Each missing tab is cloned from the nearest prior existing tab, or created empty.
 */
export async function backfillMissingMonthTabs(): Promise<void> {
  const now = new Date();
  const year = now.getFullYear();
  const currentMonthIdx = now.getMonth(); // 0 = Jan, 11 = Dec

  const groups = database.groups.findAll();

  for (const group of groups) {
    if (!group.google_refresh_token) continue;

    const spreadsheetId = database.groupSpreadsheets.getByYear(group.id, year);
    if (!spreadsheetId) continue;

    try {
      for (let mi = 0; mi <= currentMonthIdx; mi++) {
        const month = MONTH_ABBREVS[mi];
        if (!month) continue;

        if (await monthTabExists(group.google_refresh_token, spreadsheetId, month)) continue;

        // Find nearest prior tab to clone from, searching backwards
        let cloned = false;
        for (let pi = mi - 1; pi >= -11; pi--) {
          let srcSpreadsheetId: string | null;
          let srcMonth: (typeof MONTH_ABBREVS)[number];

          if (pi >= 0) {
            srcSpreadsheetId = spreadsheetId;
            srcMonth = MONTH_ABBREVS[pi] as (typeof MONTH_ABBREVS)[number];
          } else {
            // Look into the previous year's spreadsheet
            const prevYear = year - 1;
            srcSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, prevYear);
            srcMonth = MONTH_ABBREVS[12 + pi] as (typeof MONTH_ABBREVS)[number];
          }

          if (
            srcSpreadsheetId &&
            srcMonth &&
            (await monthTabExists(group.google_refresh_token, srcSpreadsheetId, srcMonth))
          ) {
            await cloneMonthTab(
              group.google_refresh_token,
              srcSpreadsheetId,
              srcMonth,
              spreadsheetId,
              month,
            );
            logger.info(`[BACKFILL] Cloned ${srcMonth} → ${month} for group ${group.id}`);
            cloned = true;
            break;
          }
        }

        if (!cloned) {
          await createEmptyMonthTab(group.google_refresh_token, spreadsheetId, month);
          logger.info(`[BACKFILL] Created empty tab ${month} for group ${group.id}`);
        }
      }
    } catch (err) {
      logger.error({ err }, `[BACKFILL] Failed for group ${group.id}`);
    }
  }

  logger.info('[BACKFILL] Missing month tabs backfill complete');
}
