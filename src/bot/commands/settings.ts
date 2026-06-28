/** /settings command — editable group settings menu generated entirely from the registry. */
import { InlineKeyboard } from 'gramio';
import { database } from '../../database';
import type { Group } from '../../database/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import {
  applyGroupSetting,
  GROUP_SETTINGS,
  type GroupSettingDef,
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
 * Neutralize tag delimiters in user-controlled values (custom_prompt) before they go into a
 * menu message. Entity-escaping would NOT work here: every outgoing HTML message passes through
 * the global `sanitizeOutgoingMessages` hook, which decodes `&lt;`/`&gt;`/`&amp;` and restores
 * whitelisted tags — so an escaped `<b>`/`<a href>` would come back as active formatting/a link.
 *
 * We replace BOTH raw `<`/`>` AND the literal `&lt;`/`&gt;` substrings with look-alike
 * guillemets (‹ ›) so nothing the sanitizer decodes can form a tag (covers a prompt that
 * already contains pre-encoded delimiters). Numeric entities (`&#60;`) are safe: the sanitizer
 * doesn't decode them. Bare `&` needs no handling — the HTML sanitizer escapes it consistently.
 */
function neutralizeForMenu(text: string): string {
  return text.replace(/&lt;/gi, '‹').replace(/&gt;/gi, '›').replace(/</g, '‹').replace(/>/g, '›');
}

/**
 * Build the settings message text and main keyboard for a group.
 * Both are generated from GROUP_SETTINGS, so a newly-registered setting automatically gets a
 * line and a reachable button — the menu-side analogue of the registry enforcement guarantee.
 */
export function buildSettingsView(group: Group): { text: string; keyboard: InlineKeyboard } {
  let text = '⚙️ Настройки группы:\n\n';
  for (const def of Object.values(GROUP_SETTINGS)) {
    // formatValue may contain user-controlled text (custom_prompt) — neutralize tag chars.
    text += `${def.emoji} ${def.labelRu}: ${neutralizeForMenu(def.formatValue(group))}\n`;
  }
  // spreadsheet_id is a system field — show it as read-only info, no button.
  text += `📊 Таблица: ${group.spreadsheet_id ? 'настроена' : 'не настроена'}\n`;

  return { text, keyboard: buildSettingsKeyboard(group) };
}

/** Main keyboard: exactly one action button per registry setting, dispatched by def.kind. */
function buildSettingsKeyboard(group: Group): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const def of Object.values(GROUP_SETTINGS)) {
    addSettingButton(keyboard, def, group);
    keyboard.row();
  }
  return keyboard;
}

function addSettingButton(keyboard: InlineKeyboard, def: GroupSettingDef, group: Group): void {
  switch (def.kind) {
    case 'toggle': {
      const on = def.current(group) === 1;
      keyboard.text(
        `${def.emoji} ${def.labelRu}: ${on ? 'выключить' : 'включить'}`,
        `settings:set:${def.key}:${on ? 'off' : 'on'}`,
      );
      return;
    }
    case 'currency':
      keyboard.text(`${def.emoji} ${def.labelRu}`, `settings:edit:${def.key}`);
      return;
    case 'currency_multi':
      keyboard.text(`${def.emoji} ${def.labelRu}`, `settings:medit:${def.key}`);
      return;
    case 'topic':
      keyboard.text(`${def.emoji} ${def.labelRu}`, `settings:tedit:${def.key}`);
      return;
    case 'text':
      keyboard.text(`${def.emoji} ${def.labelRu}`, `settings:xedit:${def.key}`);
      return;
    default: {
      // A new kind must be handled above or this fails to compile.
      const exhaustive: never = def;
      throw new Error(`Unhandled setting kind: ${String(exhaustive)}`);
    }
  }
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
    await dispatchSettingsAction(ctx, { chatId, group, sub, key, value });
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /settings callback');
    await ctx.answerCallbackQuery({ text: 'Ошибка' });
  }
}

interface SettingsAction {
  chatId: number;
  group: Group;
  sub: string | undefined;
  key: string | undefined;
  value: string | undefined;
}

async function dispatchSettingsAction(
  ctx: Ctx['CallbackQuery'],
  { chatId, group, sub, key, value }: SettingsAction,
): Promise<void> {
  switch (sub) {
    case 'edit':
      return openCurrencyPicker(ctx, group, key);
    case 'medit':
      return openMultiCurrencyPicker(ctx, group, key);
    case 'tedit':
      return openTopicEditor(ctx, group, key);
    case 'xedit':
      return openTextEditor(ctx, group, key);
    case 'set':
      return applySetting(ctx, chatId, key, value);
    case 'mtog':
      return toggleEnabledCurrency(ctx, group, key, value);
    case 'back':
      await ctx.answerCallbackQuery();
      return renderMain(ctx, chatId);
    case 'bankcards':
      // Back-compat: legacy bank-cards toggle button from messages predating this menu.
      return applySetting(
        ctx,
        chatId,
        'bank_cards_enabled',
        group.bank_cards_enabled ? 'off' : 'on',
      );
    default:
      await ctx.answerCallbackQuery({ text: 'Неизвестное действие' });
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
  key: string | undefined,
  code: string | undefined,
): Promise<void> {
  const def = key && isEditableGroupSettingKey(key) ? GROUP_SETTINGS[key] : null;
  if (!def || def.kind !== 'currency_multi' || !code) {
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

  const result = await applyGroupSetting(def, group, [...next].join(','));
  if (!result.ok) {
    await ctx.answerCallbackQuery({ text: result.error.slice(0, 200) });
    return;
  }

  await ctx.answerCallbackQuery();
  const updated = database.groups.findByTelegramGroupId(group.telegram_group_id);
  if (updated) await renderMultiCurrency(ctx, updated, def.key);
}

async function openCurrencyPicker(
  ctx: Ctx['CallbackQuery'],
  group: Group,
  key: string | undefined,
): Promise<void> {
  const def = key && isEditableGroupSettingKey(key) ? GROUP_SETTINGS[key] : null;
  if (!def || def.kind !== 'currency') {
    await ctx.answerCallbackQuery({ text: 'Неверные данные' });
    return;
  }
  await ctx.answerCallbackQuery();
  await editView(
    ctx,
    `${def.emoji} Выбери валюту по умолчанию:`,
    createSettingsCurrencyPickKeyboard(def.key, group.default_currency),
  );
}

async function openMultiCurrencyPicker(
  ctx: Ctx['CallbackQuery'],
  group: Group,
  key: string | undefined,
): Promise<void> {
  const def = key && isEditableGroupSettingKey(key) ? GROUP_SETTINGS[key] : null;
  if (!def || def.kind !== 'currency_multi') {
    await ctx.answerCallbackQuery({ text: 'Неверные данные' });
    return;
  }
  await ctx.answerCallbackQuery();
  await renderMultiCurrency(ctx, group, def.key);
}

/** Topic sub-view: binding goes through /topic; the menu can only clear. */
async function openTopicEditor(
  ctx: Ctx['CallbackQuery'],
  group: Group,
  key: string | undefined,
): Promise<void> {
  const def = key && isEditableGroupSettingKey(key) ? GROUP_SETTINGS[key] : null;
  if (!def || def.kind !== 'topic') {
    await ctx.answerCallbackQuery({ text: 'Неверные данные' });
    return;
  }
  await ctx.answerCallbackQuery();
  const text =
    `${def.emoji} ${def.labelRu}: ${neutralizeForMenu(def.formatValue(group))}\n\n` +
    'Чтобы привязать бота к топику — зайди в нужный топик и отправь там /topic. Здесь можно только сбросить привязку.';
  const keyboard = new InlineKeyboard()
    .text('📍 Сбросить топик', `settings:set:${def.key}:clear`)
    .row()
    .text('⬅️ Назад', 'settings:back');
  await editView(ctx, text, keyboard);
}

/** Text sub-view (custom_prompt): set via chat/AI; the menu shows the value and can clear. */
async function openTextEditor(
  ctx: Ctx['CallbackQuery'],
  group: Group,
  key: string | undefined,
): Promise<void> {
  const def = key && isEditableGroupSettingKey(key) ? GROUP_SETTINGS[key] : null;
  if (!def || def.kind !== 'text') {
    await ctx.answerCallbackQuery({ text: 'Неверные данные' });
    return;
  }
  await ctx.answerCallbackQuery();
  const text =
    `${def.emoji} ${def.labelRu}: ${neutralizeForMenu(def.formatValue(group))}\n\n` +
    'Промпт задаётся в чате: напиши боту «перепиши промпт: …» (заменить целиком) или «запомни, что …» (добавить заметку). Здесь можно очистить.';
  const keyboard = new InlineKeyboard()
    .text('🗑 Очистить промпт', `settings:set:${def.key}:clear`)
    .row()
    .text('⬅️ Назад', 'settings:back');
  await editView(ctx, text, keyboard);
}

async function renderMultiCurrency(
  ctx: Ctx['CallbackQuery'],
  group: Group,
  key: string,
): Promise<void> {
  const text = `💵 Отметь включённые валюты:\nСейчас: ${neutralizeForMenu(group.enabled_currencies.join(', '))}`;
  await editView(
    ctx,
    text,
    createSettingsMultiCurrencyKeyboard(key, group.enabled_currencies, group.default_currency),
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

/**
 * Edit the settings message in place. Uses HTML parse mode to match the command-path
 * `sendMessage` (also HTML), so the menu text (with user values already neutralized by
 * neutralizeForMenu) renders identically on both the initial send and every re-render.
 *
 * A "message is not modified" 400 (re-render with identical content) is benign and
 * swallowed; every other error propagates so the caller logs it and tells the user,
 * instead of silently looking like nothing happened.
 */
async function editView(
  ctx: Ctx['CallbackQuery'],
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editText(text, { reply_markup: keyboard, parse_mode: 'HTML' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/message is not modified/i.test(message)) return;
    throw error;
  }
}
