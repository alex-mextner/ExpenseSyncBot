// Button and command entry points that start, restart or cancel the /bank setup wizard.
// Split out of ../bank.ts; credential entry itself lives in ./wizard-input.ts.
import { database } from '../../../database';
import type { BankConnection } from '../../../database/types';
import type { BankPlugin } from '../../../services/bank/registry';
import { BANK_REGISTRY, lookupBank } from '../../../services/bank/registry';
import { activateNewConnection } from '../../../services/bank/sync-service';
import { sendMessage } from '../../../services/bank/telegram-sender';
import { encryptData } from '../../../utils/crypto';
import { createLogger } from '../../../utils/logger.ts';
import type { BotInstance, Ctx } from '../../types';
import {
  buildConnectingText,
  buildWizardInfoText,
  buildWizardStartText,
  rememberWizardPrompt,
  wizardPromptMessages,
} from './wizard-prompts';

const logger = createLogger('bank-command');

const WIZARD_CANCEL_BUTTON_ROW = [{ text: '❌ Отмена', callback_data: 'bank_wizard_cancel' }];

/** Drop abandoned setup sessions of the group together with their prompt tracking. */
export function clearStaleSetupSessions(groupId: number): void {
  for (const id of database.bankConnections.deleteStaleSetup(groupId)) {
    wizardPromptMessages.delete(id);
  }
}

export async function startWizard(bankKey: string): Promise<void> {
  const plugin = BANK_REGISTRY[bankKey];
  if (!plugin) return;

  // Show info screen first — the user clicks "🔓 Подключить" to proceed.
  await sendMessage(buildWizardInfoText(plugin.name), {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🔓 Подключить',
            callback_data: `bank_wizard_start:${bankKey}`,
          },
        ],
      ],
    },
    link_preview_options: { is_disabled: true },
  });
}

export async function handleWizardCancel(groupId: number): Promise<void> {
  const setupConn = database.bankConnections.findSetupByGroupId(groupId);

  if (setupConn) {
    wizardPromptMessages.delete(setupConn.id);
    database.bankConnections.deleteById(setupConn.id);
    await sendMessage('Подключение банка отменено.');
  } else {
    await sendMessage('Нет активного подключения для отмены.');
  }
}

/**
 * Called when user clicks a bank_setup button from the "no banks" panel.
 * Starts the setup wizard for the selected bank.
 */
export async function handleBankSetupCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  bankKey: string,
  chatId: number,
): Promise<void> {
  const plugin = BANK_REGISTRY[bankKey];
  if (!plugin) {
    await ctx.answerCallbackQuery({ text: 'Банк не найден' });
    return;
  }

  await ctx.answerCallbackQuery();

  // Show info screen — the user clicks "🔓 Подключить" to actually start the wizard.
  const infoText = buildWizardInfoText(plugin.name);
  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '🔓 Подключить',
          callback_data: `bank_wizard_start:${bankKey}`,
        },
        { text: '← Назад', callback_data: 'bank_letter_nav' },
      ],
    ],
  };

  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: infoText,
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
      return;
    } catch {
      // fall through
    }
  }
  await sendMessage(infoText, { reply_markup: keyboard });
}

/** Store the plugin's auto-fill credentials (date, checkbox, ListPreference defaults), if any. */
function storeDefaultCredentials(connectionId: number, plugin: BankPlugin): void {
  if (plugin.defaults && Object.keys(plugin.defaults).length > 0) {
    database.bankCredentials.upsert(connectionId, encryptData(JSON.stringify(plugin.defaults)));
  }
}

/**
 * Turn the clicked message into the "connecting" panel; falls back to a new message when the
 * edit fails. Returns the panel's message id, or null when nothing could be shown.
 */
async function showConnectingPanelInPlace(
  bot: BotInstance,
  chatId: number,
  messageId: number | undefined,
  bankName: string,
): Promise<number | null> {
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: buildConnectingText(bankName),
      });
      return messageId;
    } catch {
      // fall through
    }
  }
  const sent = await sendMessage(buildConnectingText(bankName));
  return sent ? sent.message_id : null;
}

/** A bank without credential fields connects immediately. */
async function connectBankWithoutCredentials(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  conn: BankConnection,
  plugin: BankPlugin,
  chatId: number,
): Promise<void> {
  storeDefaultCredentials(conn.id, plugin);
  database.bankConnections.update(conn.id, { status: 'active' });

  const threadId =
    (ctx.update?.callback_query?.message as { message_thread_id?: number } | undefined)
      ?.message_thread_id ?? null;
  const panelMsgId = await showConnectingPanelInPlace(bot, chatId, ctx.message?.id, plugin.name);

  database.bankConnections.update(conn.id, {
    panel_message_id: panelMsgId,
    panel_message_thread_id: threadId,
  });

  activateNewConnection(conn.id).catch((err) =>
    logger.error({ err, connectionId: conn.id }, 'Background activation failed'),
  );
}

/** Edit the info screen into the first credential prompt; falls back to a new message. */
async function showFirstFieldPrompt(
  bot: BotInstance,
  conn: BankConnection,
  plugin: BankPlugin,
  chatId: number,
  messageId: number | undefined,
): Promise<void> {
  const firstField = plugin.fields[0];
  const firstFieldText = buildWizardStartText(plugin.name, firstField);

  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: firstFieldText,
        reply_markup: { inline_keyboard: [WIZARD_CANCEL_BUTTON_ROW] },
        link_preview_options: { is_disabled: true },
      });
      rememberWizardPrompt(conn.id, messageId, firstField);
      return;
    } catch {
      // fall through
    }
  }

  // Fallback: send new message
  const sent = await sendMessage(firstFieldText, {
    reply_markup: { inline_keyboard: [WIZARD_CANCEL_BUTTON_ROW] },
    link_preview_options: { is_disabled: true },
  });
  if (sent) {
    rememberWizardPrompt(conn.id, sent.message_id, firstField);
  }
}

/**
 * Called when user clicks "🔓 Подключить" on the bank info screen.
 * Creates the connection and starts credential entry.
 */
export async function handleBankWizardStartCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  bankKey: string,
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  const plugin = BANK_REGISTRY[bankKey];
  if (!plugin) {
    await ctx.answerCallbackQuery({ text: 'Банк не найден' });
    return;
  }

  // Clean up stale setup sessions before starting a new one
  clearStaleSetupSessions(group.id);

  // Only replace setup connections — active/disconnected connections require explicit disconnect
  const existing = database.bankConnections.findByGroupAndBank(group.id, bankKey);
  if (existing) {
    if (existing.status !== 'setup') {
      await ctx.answerCallbackQuery({ text: `${plugin.name} уже подключён` });
      return;
    }
    wizardPromptMessages.delete(existing.id);
    database.bankConnections.deleteById(existing.id);
  }

  await ctx.answerCallbackQuery();

  const newConn = database.bankConnections.create({
    group_id: group.id,
    bank_name: bankKey,
    display_name: plugin.name,
    status: 'setup',
  });

  if (plugin.fields.length === 0) {
    await connectBankWithoutCredentials(ctx, bot, newConn, plugin, chatId);
    return;
  }

  await showFirstFieldPrompt(bot, newConn, plugin, chatId, ctx.message?.id);
}

/** Wipe credentials and put an existing connection back into the setup state. */
function resetConnectionForReconnect(conn: BankConnection): void {
  wizardPromptMessages.delete(conn.id);
  database.bankCredentials.deleteByConnectionId(conn.id);
  database.bankConnections.update(conn.id, {
    status: 'setup',
    consecutive_failures: 0,
    last_error: null,
  });
}

/** Reconnect a bank that needs no credentials: re-activate and refresh its existing panel. */
async function reconnectBankWithoutCredentials(
  bot: BotInstance,
  conn: BankConnection,
  plugin: BankPlugin,
  chatId: number,
): Promise<void> {
  storeDefaultCredentials(conn.id, plugin);
  database.bankConnections.update(conn.id, { status: 'active' });

  // Edit the existing panel to "connecting" state — sync-service will update it on completion.
  if (conn.panel_message_id) {
    await bot.api
      .editMessageText({
        chat_id: chatId,
        message_id: conn.panel_message_id,
        text: buildConnectingText(plugin.name),
      })
      .catch(() => {});
  }

  activateNewConnection(conn.id).catch((err) =>
    logger.error({ err, connectionId: conn.id }, 'Background reconnect failed'),
  );
}

/**
 * Reconnect an existing active bank connection — resets credentials and restarts the wizard.
 * Unlike bank_setup, this always replaces the connection even if it's active.
 */
export async function handleBankReconnectCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  connId: number,
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  const conn = database.bankConnections.findById(connId);
  if (!conn || conn.group_id !== group.id) {
    await ctx.answerCallbackQuery({ text: 'Подключение не найдено' });
    return;
  }

  const reconnectFound = lookupBank(conn.bank_name);
  if (!reconnectFound) {
    await ctx.answerCallbackQuery({ text: 'Банк не найден' });
    return;
  }
  const [, plugin] = reconnectFound;

  await ctx.answerCallbackQuery();

  // Reset the connection: wipe credentials, set status back to setup
  resetConnectionForReconnect(conn);

  if (plugin.fields.length === 0) {
    await reconnectBankWithoutCredentials(bot, conn, plugin, chatId);
    return;
  }

  const firstField = plugin.fields[0];
  const sent = await sendMessage(buildWizardStartText(plugin.name, firstField), {
    reply_markup: { inline_keyboard: [WIZARD_CANCEL_BUTTON_ROW] },
    link_preview_options: { is_disabled: true },
  });
  if (sent) {
    rememberWizardPrompt(conn.id, sent.message_id, firstField);
  }
}

/** Cancel the active wizard for this group. */
export async function handleBankWizardCancelCallback(
  ctx: Ctx['CallbackQuery'],
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  const setupConn = database.bankConnections.findSetupByGroupId(group.id);
  if (setupConn) {
    wizardPromptMessages.delete(setupConn.id);
    if (setupConn.last_sync_at !== null) {
      // Was an active connection being reconnected — preserve the row and linked data,
      // just mark it disconnected (credentials already wiped by handleBankReconnectCallback).
      database.bankConnections.update(setupConn.id, { status: 'disconnected' });
    } else {
      // Fresh new connection being set up — nothing to preserve, delete entirely.
      database.bankConnections.deleteById(setupConn.id);
    }
  }

  await ctx.answerCallbackQuery({ text: 'Отменено' });

  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await ctx.editText('Подключение банка отменено.');
    } catch {
      // message too old
    }
  }
}
