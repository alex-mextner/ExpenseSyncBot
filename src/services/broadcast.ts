/** Scheduled news broadcasts to all active groups */
import type { Bot } from 'gramio';
import cron from 'node-cron';
import { env } from '../config/env';
import { database } from '../database';
import { createLogger } from '../utils/logger.ts';

const logger = createLogger('broadcast');

function buildNewsMessage(): string {
  const bot = env.BOT_USERNAME;
  return `\
🆕 <b>Что нового в финансовом боте</b>

<b>🤖 AI без упоминания бота</b>
Теперь можно задавать вопросы прямо в чат — без <code>@${bot}</code>. Бот отвечает на все сообщения, кроме переписки людей между собой.

<b>🏦 Подключение банков (/bank)</b>
Через команду /bank можно подключить свой банк и автоматически тянуть транзакции. Проверено на TBC — поддерживаются все банки, куда добрались наши эмигранты.

<b>💸 Удобное отображение сумм</b>
Большие числа теперь форматируются читаемо: 1 500 вместо 1500, миллионы — с сокращением.

<b>📊 Бюджеты по месяцам</b>
Бюджеты теперь разнесены по отдельным вкладкам — каждый месяц на своём листе. Ручная синхронизация после правок в таблице больше не нужна. Каждый год будет создаваться новая таблица.

<b>🏷 Гибкое распознавание категорий</b>
Бот лучше распознаёт категорию трат — работает даже при опечатках и сокращениях.`;
}

let alreadySent = false;

/**
 * Broadcast a message to all active groups
 */
async function broadcastToAllGroups(bot: Bot): Promise<void> {
  if (alreadySent) {
    logger.info('[BROADCAST] Already sent, skipping');
    return;
  }

  const newsMessage = buildNewsMessage();
  const groups = database.groups.getAll();
  logger.info(`[BROADCAST] Sending news to ${groups.length} groups...`);

  let sent = 0;
  let failed = 0;

  for (const group of groups) {
    try {
      await bot.api.sendMessage({
        chat_id: group.telegram_group_id,
        text: newsMessage,
        parse_mode: 'HTML',
        ...(group.active_topic_id ? { message_thread_id: group.active_topic_id } : {}),
      });
      sent++;
      logger.info(`[BROADCAST] ✓ Sent to group ${group.telegram_group_id}`);
    } catch (error: unknown) {
      failed++;
      logger.error({ err: error }, `[BROADCAST] ✗ Failed for group ${group.telegram_group_id}`);
    }
  }

  alreadySent = true;
  logger.info(`[BROADCAST] Done. Sent: ${sent}, Failed: ${failed}, Total: ${groups.length}`);
}

/**
 * Schedule news broadcast for March 24 at 12:00 UTC (one-time)
 */
export function scheduleNewsBroadcast(bot: Bot): void {
  // Run at 12:00 on March 29 only — stops after execution
  const task = cron.schedule('0 12 29 3 *', () => {
    logger.info('[BROADCAST] Cron triggered — March 29 12:00');
    broadcastToAllGroups(bot).then(() => {
      task.stop();
      logger.info('[BROADCAST] Cron task stopped after execution');
    });
  });

  logger.info('📢 News broadcast scheduled for March 29 at 12:00');
}
