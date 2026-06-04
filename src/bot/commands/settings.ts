/** /settings command — shows current group config and a per-group bank-cards toggle */
import { InlineKeyboard } from 'gramio';
import { database } from '../../database';
import type { Group } from '../../database/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import type { Ctx } from '../types';

const logger = createLogger('cmd-settings');

/** Callback data for the bank-cards toggle button (kept short for the 64-byte limit) */
const SETTINGS_BANK_CARDS_CALLBACK = 'settings:bankcards';

/**
 * Build the settings message text and keyboard for a group.
 * Shared by the /settings command and its toggle callback so both render identically.
 */
export function buildSettingsView(group: Group): { text: string; keyboard: InlineKeyboard } {
  const cardsOn = !!group.bank_cards_enabled;

  let text = '⚙️ Настройки группы:\n\n';
  text += `💱 Валюта по умолчанию: ${group.default_currency}\n`;
  text += `💵 Включенные валюты: ${group.enabled_currencies.join(', ')}\n`;
  text += `📊 Таблица: ${group.spreadsheet_id ? 'настроена' : 'не настроена'}\n`;
  text += `🔔 Карточки банковских транзакций: ${cardsOn ? 'вкл' : 'выкл'}\n`;

  const keyboard = new InlineKeyboard().text(
    cardsOn ? '🔕 Выключить карточки банка' : '🔔 Включить карточки банка',
    SETTINGS_BANK_CARDS_CALLBACK,
  );

  return { text, keyboard };
}

/**
 * /settings command handler
 */
export async function handleSettingsCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  void ctx;
  try {
    const { text, keyboard } = buildSettingsView(group);
    await sendMessage(text, { reply_markup: keyboard });
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /settings');
    await sendMessage(formatErrorForUser(error));
  }
}

/**
 * Toggle the per-group bank_cards_enabled setting from the /settings keyboard,
 * then re-render the settings view in place.
 */
export async function handleSettingsBankCardsToggle(ctx: Ctx['CallbackQuery']): Promise<void> {
  try {
    const chatId = ctx.message?.chat?.id;
    if (!chatId) {
      await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
      return;
    }

    const group = database.groups.findByTelegramGroupId(chatId);
    if (!group) {
      await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
      return;
    }

    const next = group.bank_cards_enabled ? 0 : 1;
    const updated = database.groups.update(group.telegram_group_id, { bank_cards_enabled: next });
    if (!updated) {
      await ctx.answerCallbackQuery({ text: 'Не удалось сохранить' });
      return;
    }

    await ctx.answerCallbackQuery({
      text: next ? '🔔 Карточки банка включены' : '🔕 Карточки банка выключены',
    });

    const { text, keyboard } = buildSettingsView(updated);
    await ctx.editText(text, { reply_markup: keyboard });
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error toggling bank cards in /settings');
    await ctx.answerCallbackQuery({ text: 'Ошибка' });
  }
}
