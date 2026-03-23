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
🆕 <b>Что нового в боте</b>

<b>📸 Фото чеков</b>
Отправь фото чека — бот разберёт все позиции и предложит подтвердить каждую. Нужно чтобы был чётко виден QR-код или текст с суммами.

<b>🧮 AI-калькулятор</b>
ChatGPT, Claude и другие нейронки регулярно считают неправильно — это известная проблема. У нашего бота настоящий калькулятор — спроси через <code>@${bot}</code>:
<i>«сколько мы потратили на еду в евро?»</i>
<i>«100$ + 70€ + 2000 RSD — сколько в евро?»</i>
<i>«раздели ужин на троих»</i>
<i>«500€ минус 10% скидка»</i>

<b>🤖 AI точнее и надёжнее</b>
Бот стал лучше отвечать на вопросы — перепроверяет себя и реже ошибается.

<b>💡 /help</b>
Добавили полную справку — /help покажет все возможности бота.`;
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
  // Run at 12:00 on March 24 only — stops after execution
  const task = cron.schedule('0 12 24 3 *', () => {
    logger.info('[BROADCAST] Cron triggered — March 24 12:00');
    broadcastToAllGroups(bot).then(() => {
      task.stop();
      logger.info('[BROADCAST] Cron task stopped after execution');
    });
  });

  logger.info('📢 News broadcast scheduled for March 24 at 12:00');
}
