/** /settings command — editable group settings menu driven by the settings registry. */
import { InlineKeyboard } from 'gramio';
import { database } from '../../database';
import type { Group } from '../../database/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import {
  applyGroupSetting,
  GROUP_SETTINGS,
  isEditableGroupSettingKey,
} from '../../services/settings/group-settings-registry';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import {
  createSettingsCurrencyPickKeyboard,
  createSettingsMultiCurrencyKeyboard,
} from '../keyboards';
import type { Ctx } from '../types';

const logger = createLogger('cmd-settings');

/**
 * Build the settings message text and main keyboard for a group.
 * Every registry-backed setting renders as a line; the keyboard exposes an action per setting.
 */
export function buildSettingsView(group: Group): { text: string; keyboard: InlineKeyboard } {
  let text = '⚙️ Настройки группы:\n\n';
  for (const def of Object.values(GROUP_SETTINGS)) {
    text += `${def.emoji} ${def.labelRu}: ${def.formatValue(group)}\n`;
  }
  // spreadsheet_id is a system field — show it as read-only info, no button.
  text += `📊 Таблица: ${group.spreadsheet_id ? 'настроена' : 'не настроена'}\n`;

  return { text, keyboard: buildSettingsKeyboard(group) };
}

/** Main settings keyboard: one action per editable setting. */
function buildSettingsKeyboard(group: Group): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard.text('💱 Сменить валюту по умолчанию', 'settings:edit:default_currency').row();
  keyboard.text('💵 Изменить набор валют', 'settings:medit:enabled_currencies').row();

  const cardsOn = !!group.bank_cards_enabled;
  keyboard
    .text(
      cardsOn ? '🔕 Выключить карточки банка' : '🔔 Включить карточки банка',
      `settings:set:bank_cards_enabled:${cardsOn ? 'off' : 'on'}`,
    )
    .row();

  // Free-text / topic settings: offer an in-place "clear" only when a value is set.
  if (group.custom_prompt) {
    keyboard.text('📝 Очистить AI-промпт', 'settings:set:custom_prompt:clear').row();
  }
  if (group.active_topic_id != null) {
    keyboard.text('📍 Сбросить топик', 'settings:set:active_topic_id:clear').row();
  }

  return keyboard;
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
 * Route every `settings:*` callback. Sub-actions share the registry's parse/apply path, so
 * the menu and the AI tool mutate group settings through identical code.
 */
export async function handleSettingsCallback(
  ctx: Ctx['CallbackQuery'],
  params: string[],
): Promise<void> {
  const chatId = ctx.message?.chat?.id;
  const group = chatId ? database.groups.findByTelegramGroupId(chatId) : null;
  if (!chatId || !group) {
    await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
    return;
  }

  const [sub, key, value] = params;
  try {
    switch (sub) {
      case 'edit':
        await openCurrencyPicker(ctx, group, key);
        break;
      case 'medit':
        await openMultiCurrencyPicker(ctx, group, key);
        break;
      case 'set':
        await applySetting(ctx, chatId, key, value);
        break;
      case 'mtog':
        await toggleEnabledCurrency(ctx, group, value);
        break;
      case 'back':
        await ctx.answerCallbackQuery();
        await renderMain(ctx, chatId);
        break;
      case 'bankcards':
        // Back-compat: legacy bank-cards toggle button from messages sent before this menu.
        await applySetting(
          ctx,
          chatId,
          'bank_cards_enabled',
          group.bank_cards_enabled ? 'off' : 'on',
        );
        break;
      default:
        await ctx.answerCallbackQuery({ text: 'Неизвестное действие' });
    }
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /settings callback');
    await ctx.answerCallbackQuery({ text: 'Ошибка' });
  }
}

/** Parse + apply a raw value for `key` through the registry, then re-render the main view. */
async function applySetting(
  ctx: Ctx['CallbackQuery'],
  chatId: number,
  key: string | undefined,
  value: string | undefined,
): Promise<void> {
  if (!key || value === undefined || !isEditableGroupSettingKey(key)) {
    await ctx.answerCallbackQuery({ text: 'Неверные данные' });
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
    return;
  }

  const result = await applyGroupSetting(GROUP_SETTINGS[key], group, value);
  if (!result.ok) {
    await ctx.answerCallbackQuery({ text: result.error.slice(0, 200) });
    return;
  }

  await ctx.answerCallbackQuery({ text: '✅ Сохранено' });
  await renderMain(ctx, chatId);
}

/** Toggle one currency in the enabled set (the default currency can never be removed). */
async function toggleEnabledCurrency(
  ctx: Ctx['CallbackQuery'],
  group: Group,
  code: string | undefined,
): Promise<void> {
  if (!code) {
    await ctx.answerCallbackQuery({ text: 'Неверные данные' });
    return;
  }
  if (code === group.default_currency) {
    await ctx.answerCallbackQuery({ text: 'Это валюта по умолчанию, её нельзя убрать' });
    return;
  }

  const next = new Set<string>(group.enabled_currencies);
  if (next.has(code)) next.delete(code);
  else next.add(code);

  const result = await applyGroupSetting(
    GROUP_SETTINGS.enabled_currencies,
    group,
    [...next].join(','),
  );
  if (!result.ok) {
    await ctx.answerCallbackQuery({ text: result.error.slice(0, 200) });
    return;
  }

  await ctx.answerCallbackQuery();
  const updated = database.groups.findByTelegramGroupId(group.telegram_group_id);
  if (updated) await renderMultiCurrency(ctx, updated);
}

async function openCurrencyPicker(
  ctx: Ctx['CallbackQuery'],
  group: Group,
  key: string | undefined,
): Promise<void> {
  if (key !== 'default_currency') {
    await ctx.answerCallbackQuery({ text: 'Неверные данные' });
    return;
  }
  await ctx.answerCallbackQuery();
  await editView(
    ctx,
    '💱 Выбери валюту по умолчанию:',
    createSettingsCurrencyPickKeyboard(group.default_currency),
  );
}

async function openMultiCurrencyPicker(
  ctx: Ctx['CallbackQuery'],
  group: Group,
  key: string | undefined,
): Promise<void> {
  if (key !== 'enabled_currencies') {
    await ctx.answerCallbackQuery({ text: 'Неверные данные' });
    return;
  }
  await ctx.answerCallbackQuery();
  await renderMultiCurrency(ctx, group);
}

async function renderMultiCurrency(ctx: Ctx['CallbackQuery'], group: Group): Promise<void> {
  const text = `💵 Отметь включённые валюты:\nСейчас: ${group.enabled_currencies.join(', ')}`;
  await editView(
    ctx,
    text,
    createSettingsMultiCurrencyKeyboard(group.enabled_currencies, group.default_currency),
  );
}

async function renderMain(ctx: Ctx['CallbackQuery'], chatId: number): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не настроена' });
    return;
  }
  const { text, keyboard } = buildSettingsView(group);
  await editView(ctx, text, keyboard);
}

/** Edit the settings message in place, tolerating Telegram "message not modified" errors. */
async function editView(
  ctx: Ctx['CallbackQuery'],
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editText(text, { reply_markup: keyboard });
  } catch (error) {
    logger.warn({ err: error }, '[CMD] /settings editText failed');
  }
}
