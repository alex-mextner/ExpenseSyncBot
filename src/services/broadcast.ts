import cron from "node-cron";
import type { Bot } from "gramio";
import { database } from "../database";

const NEWS_MESSAGE = `
🆕 <b>Что нового в боте</b>

<b>🧮 Математика в суммах</b>
Теперь можно писать выражения прямо в расходе:
<code>10*3$ еда</code> → запишет $30
<code>100+50€ транспорт</code> → запишет €150
Поддерживаются +, *, /

<b>🤖 AI-агент с суперсилами</b>
Бот через @mention теперь не просто отвечает на вопросы — он умеет действовать:
• Записать расход: <i>«запиши 50€ на еду за вчера»</i>
• Удалить расход: <i>«удали последний расход»</i>
• Управлять бюджетом: <i>«поставь бюджет 500€ на транспорт»</i>
• Создать/удалить категорию
• Синхронизировать с Google Sheets
• Изменить AI-промпт группы

При работе показывает что делает: «Записываю расход...», «Синхронизирую...»

<b>📊 Умные финансовые советы</b>
/advice теперь работает по-умному. Вместо случайных советов бот анализирует:
• Приближение к лимиту бюджета
• Аномальный рост трат в категории
• Резкое ускорение трат
• Еженедельные и ежемесячные тренды

Совет адаптируется по глубине — от короткой заметки до детального разбора.
`.trim();

let alreadySent = false;

/**
 * Broadcast a message to all active groups
 */
async function broadcastToAllGroups(bot: Bot): Promise<void> {
  if (alreadySent) {
    console.log("[BROADCAST] Already sent, skipping");
    return;
  }

  const groups = database.groups.getAll();
  console.log(`[BROADCAST] Sending news to ${groups.length} groups...`);

  let sent = 0;
  let failed = 0;

  for (const group of groups) {
    try {
      await bot.api.sendMessage({
        chat_id: group.telegram_group_id,
        text: NEWS_MESSAGE,
        parse_mode: "HTML",
        ...(group.active_topic_id
          ? { message_thread_id: group.active_topic_id }
          : {}),
      });
      sent++;
      console.log(`[BROADCAST] ✓ Sent to group ${group.telegram_group_id}`);
    } catch (error: any) {
      failed++;
      console.error(
        `[BROADCAST] ✗ Failed for group ${group.telegram_group_id}:`,
        error?.message || error
      );
    }
  }

  alreadySent = true;
  console.log(
    `[BROADCAST] Done. Sent: ${sent}, Failed: ${failed}, Total: ${groups.length}`
  );
}

/**
 * Schedule news broadcast for March 11 at 12:00 UTC (one-time)
 */
export function scheduleNewsBroadcast(bot: Bot): void {
  // Run at 12:00 on March 11 only — stops after execution
  const task = cron.schedule("0 12 11 3 *", () => {
    console.log("[BROADCAST] Cron triggered — March 11 12:00");
    broadcastToAllGroups(bot).then(() => {
      task.stop();
      console.log("[BROADCAST] Cron task stopped after execution");
    });
  });

  console.log("📢 News broadcast scheduled for March 11 at 12:00");
}
