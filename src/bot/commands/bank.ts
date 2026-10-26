// /bank command — status panel, account/settings/disconnect callbacks and letter navigation.
// The setup wizard (./bank/wizard-*.ts) and the transaction confirmation flow
// (./bank/confirm-callbacks.ts) were split out; they are re-exported here so existing
// importers and `mock.module('../commands/bank')` seams keep working.
import { database } from '../../database';
import type { BankConnection, Group } from '../../database/types';
import {
  buildBankManageKeyboard,
  buildBankStatusText,
  buildCombinedBankKeyboard,
  buildCombinedBankStatusText,
  timeSince,
} from '../../services/bank/panel-builder';
import { getBankList, lookupBank } from '../../services/bank/registry';
import { triggerManualSync } from '../../services/bank/sync-service';
import { sendMessage } from '../../services/bank/telegram-sender';
import { convertAnyToEUR } from '../../services/currency/converter';
import { createLogger } from '../../utils/logger.ts';
import type { BotInstance, Ctx } from '../types';
import { clearStaleSetupSessions, handleWizardCancel, startWizard } from './bank/wizard-callbacks';

export {
  handleBankConfirmCallback,
  handleBankEditCallback,
  handleBankEditReply,
  handleBankMergeCallback,
  handleBankNewCallback,
  handleBankNoCommentCallback,
  handleBankReceiptCallback,
} from './bank/confirm-callbacks';
export {
  handleBankReconnectCallback,
  handleBankSetupCallback,
  handleBankWizardCancelCallback,
  handleBankWizardStartCallback,
} from './bank/wizard-callbacks';
export { handleWizardInput } from './bank/wizard-input';

const logger = createLogger('bank-command');

// ─── /bank command entry point ───────────────────────────────────────────────

export async function handleBankCommand(
  ctx: Ctx['Command'],
  group: Group,
  bot: BotInstance,
): Promise<void> {
  // Clean up stale setup sessions
  clearStaleSetupSessions(group.id);

  // Parse argument, e.g. /bank tbc or /bank tbc-ge
  const arg = ctx.text?.split(' ')[1]?.trim().toLowerCase();

  if (arg === 'отмена') {
    await handleWizardCancel(group.id);
    return;
  }

  if (arg) {
    const found = lookupBank(arg);
    if (!found) {
      await sendMessage(`Банк «${arg}» не найден. Используй /bank для выбора из списка.`);
      return;
    }
    const [bankKey] = found;
    const existing = database.bankConnections.findByGroupAndBank(group.id, bankKey);
    if (existing && existing.status !== 'setup') {
      await showBankStatus(ctx, bot, existing, group, true);
    } else {
      await startWizard(bankKey);
    }
    return;
  }

  const connections = database.bankConnections.findAllByGroupId(group.id);

  if (connections.length === 0) {
    await showNoBanksPanel();
    return;
  }

  await showBanksPanel(ctx, bot, connections, group);
}

// ─── Wizard ──────────────────────────────────────────────────────────────────

function buildLetterNavKeyboard(
  banks: { key: string; name: string }[],
): { text: string; callback_data: string }[][] {
  const letters = [...new Set(banks.map((b) => b.name.charAt(0).toUpperCase()))].sort();
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < letters.length; i += 5) {
    rows.push(letters.slice(i, i + 5).map((l) => ({ text: l, callback_data: `bank_letter:${l}` })));
  }
  return rows;
}

async function showNoBanksPanel(): Promise<void> {
  const banks = getBankList();
  await sendMessage('Ни одного банка не подключено.\n\nВыбери букву:', {
    reply_markup: { inline_keyboard: buildLetterNavKeyboard(banks) },
  });
}

// ─── Status panel ─────────────────────────────────────────────────────────────

async function deleteMessageQuietly(
  bot: BotInstance,
  chatId: number,
  messageId: number,
): Promise<void> {
  try {
    await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
  } catch {
    // silently ignore if already gone
  }
}

/** Delete old panel messages (each connection's and the group's summary) before resending. */
async function deleteOldPanelMessages(
  bot: BotInstance,
  connections: BankConnection[],
  group: Group,
): Promise<void> {
  const seenMessageIds = new Set<number>();
  for (const conn of connections) {
    if (conn.panel_message_id && !seenMessageIds.has(conn.panel_message_id)) {
      seenMessageIds.add(conn.panel_message_id);
      await deleteMessageQuietly(bot, group.telegram_group_id, conn.panel_message_id);
    }
  }

  if (
    group.bank_panel_summary_message_id &&
    !seenMessageIds.has(group.bank_panel_summary_message_id)
  ) {
    await deleteMessageQuietly(bot, group.telegram_group_id, group.bank_panel_summary_message_id);
  }
}

/** Send one combined message for all banks and remember its id for sync-service edits. */
async function sendCombinedPanel(connections: BankConnection[], group: Group): Promise<void> {
  const accounts = database.bankAccounts.findByGroupId(group.id);
  const totalEur = accounts.reduce((sum, a) => sum + convertAnyToEUR(a.balance, a.currency), 0);
  const text = buildCombinedBankStatusText(connections, totalEur);
  const keyboard = buildCombinedBankKeyboard(connections);

  const sent = await sendMessage(text, {
    reply_markup: { inline_keyboard: keyboard },
  });

  if (sent) {
    // Store the combined message ID on every connection so sync-service can edit it
    for (const conn of connections) {
      database.bankConnections.update(conn.id, { panel_message_id: sent.message_id });
    }
    database.groups.update(group.telegram_group_id, {
      bank_panel_summary_message_id: sent.message_id,
    });
  }
}

async function showBanksPanel(
  ctx: Ctx['Message'],
  bot: BotInstance,
  connections: BankConnection[],
  group: Group,
): Promise<void> {
  if (connections.length === 1 && connections[0]) {
    await showBankStatus(ctx, bot, connections[0], group);
    return;
  }

  await deleteOldPanelMessages(bot, connections, group);
  await sendCombinedPanel(connections, group);
}

async function showBankStatus(
  _ctx: Ctx['Message'],
  bot: BotInstance,
  conn: BankConnection,
  group: Group,
  explicit = false,
): Promise<void> {
  if (conn.panel_message_id) {
    try {
      await bot.api.deleteMessage({
        chat_id: group.telegram_group_id,
        message_id: conn.panel_message_id,
      });
    } catch {
      // already gone
    }
  }
  const text = buildBankStatusText(conn);
  const sent = await sendMessage(text, {
    reply_markup: {
      inline_keyboard: buildBankManageKeyboard(conn, explicit),
    },
  });
  if (sent) {
    database.bankConnections.update(conn.id, {
      panel_message_id: sent.message_id,
    });
  }
}

// ─── Account and settings callbacks ───────────────────────────────────────────

/**
 * Shows the list of accounts for a connection with exclude/include toggles.
 */
export async function handleBankAccountsCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  connectionId: number,
  chatId: number,
): Promise<void> {
  const conn = database.bankConnections.findById(connectionId);
  if (!conn) {
    await ctx.answerCallbackQuery({ text: 'Подключение не найдено' });
    return;
  }

  const accounts = database.bankAccounts.findByConnectionId(connectionId);
  if (accounts.length === 0) {
    await ctx.answerCallbackQuery({ text: 'Счета не найдены' });
    return;
  }

  await ctx.answerCallbackQuery();

  const text = `📋 <b>${conn.display_name} — счета</b>\n\nВыбери счета для получения уведомлений. Отключённые счета не будут присылать транзакции.`;
  const keyboard = {
    inline_keyboard: [
      ...accounts.map((acc) => [
        {
          text: `${acc.is_excluded ? '🔕' : '🔔'} ${acc.title} (${acc.balance.toFixed(0)} ${acc.currency})`,
          callback_data: `bank_account_toggle:${acc.id}:${connectionId}`,
        },
      ]),
      [{ text: '← Назад', callback_data: `bank_settings:${connectionId}` }],
    ],
  };

  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      return;
    } catch {
      // message too old — fall through to send new
    }
  }
  await sendMessage(text, { reply_markup: keyboard });
}

/**
 * Toggles the is_excluded flag on a bank account.
 */
export async function handleBankAccountToggleCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  accountId: number,
  connectionId: number,
  chatId: number,
): Promise<void> {
  const account = database.bankAccounts.findById(accountId);
  if (!account) {
    await ctx.answerCallbackQuery({ text: 'Счёт не найден' });
    return;
  }

  const newExcluded = account.is_excluded !== 1;
  database.bankAccounts.setExcluded(accountId, newExcluded);
  await ctx.answerCallbackQuery({
    text: newExcluded ? '🔕 Уведомления отключены' : '🔔 Уведомления включены',
  });

  // Refresh the accounts list
  await handleBankAccountsCallback(ctx, bot, connectionId, chatId);
}

// ─── New action handlers ──────────────────────────────────────────────────────

export async function handleBankSettingsCallback(
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

  await ctx.answerCallbackQuery();

  const lastSync = conn.last_sync_at
    ? `✅ Синхронизировано ${timeSince(conn.last_sync_at)} назад`
    : '⌛ Первая синхронизация ещё не завершена';
  const errorLine =
    conn.last_error && conn.consecutive_failures > 0
      ? `\n⚠️ Последняя ошибка: ${conn.last_error}`
      : '';

  const settingsText = `⚙️ ${conn.display_name}\n\n${lastSync}${errorLine}`;
  const settingsKeyboard = {
    inline_keyboard: [
      [
        {
          text: '🔄 Переподключить',
          callback_data: `bank_reconnect:${conn.id}`,
        },
      ],
      [{ text: '🔌 Отключить', callback_data: `bank_disconnect:${connId}` }],
      [{ text: '← Назад', callback_data: `bank_settings_back:${connId}` }],
    ],
  };

  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: settingsText,
        reply_markup: settingsKeyboard,
      });
      return;
    } catch {
      // message too old — fall through to send new
    }
  }
  await sendMessage(settingsText, { reply_markup: settingsKeyboard });
}

export async function handleBankSyncCallback(
  ctx: Ctx['CallbackQuery'],
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

  if (conn.status !== 'active') {
    await ctx.answerCallbackQuery({ text: 'Банк не активен' });
    return;
  }

  await ctx.answerCallbackQuery({ text: '🔄 Синхронизация запущена' });

  triggerManualSync(connId).catch((err) => logger.error({ err, connId }, 'Manual sync failed'));
}

export async function handleBankSyncAllCallback(
  ctx: Ctx['CallbackQuery'],
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  const connections = database.bankConnections.findAllByGroupId(group.id);
  const syncable = connections.filter(
    (c) => c.status === 'active' && c.last_sync_at && c.consecutive_failures === 0,
  );

  if (syncable.length === 0) {
    await ctx.answerCallbackQuery({ text: 'Нет активных банков' });
    return;
  }

  await ctx.answerCallbackQuery({ text: `🔄 Синхронизация запущена (${syncable.length})` });

  for (const conn of syncable) {
    triggerManualSync(conn.id).catch((err) =>
      logger.error({ err, connId: conn.id }, 'Manual sync failed'),
    );
  }
}

export async function handleBankDisconnectCallback(
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

  await ctx.answerCallbackQuery();

  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `⚠️ Отключить ${conn.display_name}?\n\nВсе данные (транзакции, счета, учётные данные) будут удалены.`,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Да, отключить',
                callback_data: `bank_disconnect_confirm:${connId}`,
              },
              {
                text: '❌ Отмена',
                callback_data: `bank_disconnect_cancel:${connId}`,
              },
            ],
          ],
        },
      });
    } catch {
      // Edit failed (message too old or permissions) — send a new confirmation message
      await sendMessage(`⚠️ Отключить ${conn.display_name}?\n\nВсе данные будут удалены.`, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Да, отключить',
                callback_data: `bank_disconnect_confirm:${connId}`,
              },
              {
                text: '❌ Отмена',
                callback_data: `bank_disconnect_cancel:${connId}`,
              },
            ],
          ],
        },
      });
    }
  }
}

export async function handleBankDisconnectConfirmCallback(
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

  const displayName = conn.display_name;
  database.bankConnections.deleteById(connId);
  await ctx.answerCallbackQuery({ text: `${displayName} отключён` });

  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
    } catch {
      // message may be too old
    }
  }
}

export async function handleBankDisconnectCancelCallback(
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

  await ctx.answerCallbackQuery();

  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: buildBankStatusText(conn),
        reply_markup: { inline_keyboard: buildBankManageKeyboard(conn) },
      });
    } catch {
      // ignore
    }
  }
}

/** Restore the status panel after navigating into settings. */
export async function handleBankSettingsBackCallback(
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

  await ctx.answerCallbackQuery();

  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: buildBankStatusText(conn),
        reply_markup: { inline_keyboard: buildBankManageKeyboard(conn) },
      });
    } catch {
      // ignore
    }
  }
}

export async function handleBankAddCallback(
  ctx: Ctx['CallbackQuery'],
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  await ctx.answerCallbackQuery();
  const keyboard = buildLetterNavKeyboard(getBankList());
  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await ctx.editText('Выбери букву:', {
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    } catch {
      // fall through
    }
  }
  await sendMessage('Выбери букву:', {
    reply_markup: { inline_keyboard: keyboard },
  });
}

/** Shows banks whose display name starts with the given letter. */
export async function handleBankLetterCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  letter: string,
  chatId: number,
): Promise<void> {
  const banks = getBankList().filter((b) => b.name.charAt(0).toUpperCase() === letter);

  if (banks.length === 0) {
    await ctx.answerCallbackQuery({ text: 'Нет банков на эту букву' });
    return;
  }

  const bankButtons = banks.map((b) => [{ text: b.name, callback_data: `bank_setup:${b.key}` }]);
  bankButtons.push([{ text: '← Назад', callback_data: 'bank_letter_nav' }]);

  await ctx.answerCallbackQuery();

  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `Банки на букву ${letter}:`,
        reply_markup: { inline_keyboard: bankButtons },
      });
      return;
    } catch {
      // fall through
    }
  }
  await sendMessage(`Банки на букву ${letter}:`, {
    reply_markup: { inline_keyboard: bankButtons },
  });
}

/** Restores the letter navigator (used by the ← Назад button in bank letter view). */
export async function handleBankLetterNavCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  chatId: number,
): Promise<void> {
  await ctx.answerCallbackQuery();
  const keyboard = buildLetterNavKeyboard(getBankList());
  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: 'Выбери букву:',
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    } catch {
      // fall through
    }
  }
  await sendMessage('Выбери букву:', {
    reply_markup: { inline_keyboard: keyboard },
  });
}
