import type { Ctx } from '../types';
import { database } from '../../database';
import { MESSAGES } from '../../config/constants';

/**
 * /start command handler
 */
export async function handleStartCommand(ctx: Ctx["Command"]): Promise<void> {
  const telegramId = ctx.from?.id;

  if (!telegramId) {
    await ctx.send('Error: Unable to identify user');
    return;
  }

  // Check if this is private chat
  const isPrivateChat = ctx.chat?.type === 'private';

  if (!isPrivateChat) {
    const botInfo = await ctx.bot.api.getMe();
    const botUsername = botInfo.username;
    await ctx.send(
      `👋 Привет! Я помогу вести учет расходов.\n\n` +
      `Для настройки напиши мне в личку:\n` +
      `👉 https://t.me/${botUsername}?start=setup`
    );
    return;
  }

  // Check if user exists
  let user = database.users.findByTelegramId(telegramId);

  // Create user if doesn't exist
  if (!user) {
    user = database.users.create({ telegram_id: telegramId });
    console.log(`✓ New user created: ${telegramId}`);
  }

  // Check if user has completed setup
  const hasCompletedSetup = database.users.hasCompletedSetup(telegramId);

  if (hasCompletedSetup) {
    await ctx.send(
      `👋 С возвращением!\n\n` +
      `Отправь расход в формате:\n` +
      `190 евро Алекс кулёма\n` +
      `100$ еда обед\n\n` +
      `Команды:\n` +
      `/stats - статистика\n` +
      `/categories - управление категориями\n` +
      `/settings - настройки\n` +
      `/reconnect - переподключить Google`
    );
  } else {
    await ctx.send(MESSAGES.welcome);
  }
}
