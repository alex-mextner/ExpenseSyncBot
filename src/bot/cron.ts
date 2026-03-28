// Monthly budget tab auto-clone — runs at 00:00 on the 1st of every month

import cron from 'node-cron';
import { database } from '../database';
import { monthAbbrFromDate, prevMonthAbbr } from '../services/google/month-abbr';
import {
  cloneMonthTab,
  createEmptyMonthTab,
  createExpenseSpreadsheet,
  monthTabExists,
  renameSpreadsheet,
  repairDateSerials,
  repairEurFormulas,
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
 * One-time startup backfill: fix date cells written as serial numbers by the year-split migration.
 * Runs silently — no chat notifications.
 */
export async function backfillSerialDates(): Promise<void> {
  const groups = database.groups.findAll();

  for (const group of groups) {
    if (!group.google_refresh_token) continue;

    const allSpreadsheets = database.groupSpreadsheets.listAll(group.id);

    for (const { year, spreadsheetId } of allSpreadsheets) {
      try {
        await renameSpreadsheet(
          group.google_refresh_token,
          spreadsheetId,
          `Expenses Tracker ${year}`,
        );
        logger.info(`[BACKFILL] Renamed spreadsheet for group ${group.id}, year ${year}`);

        const fixedDates = await repairDateSerials(group.google_refresh_token, spreadsheetId);
        if (fixedDates > 0) {
          logger.info(
            `[BACKFILL] Fixed ${fixedDates} serial date(s) in group ${group.id}, year ${year}`,
          );
        }

        const fixedFormulas = await repairEurFormulas(group.google_refresh_token, spreadsheetId);
        if (fixedFormulas > 0) {
          logger.info(
            `[BACKFILL] Restored ${fixedFormulas} EUR formula(s) in group ${group.id}, year ${year}`,
          );
        }
      } catch (err) {
        logger.error({ err }, `[BACKFILL] Failed for group ${group.id}, year ${year}`);
      }
    }
  }
}
