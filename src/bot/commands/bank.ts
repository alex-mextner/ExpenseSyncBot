// /bank command — setup wizard, status panel, and confirmation flow handlers.
import { database } from '../../database';
import type { BankConnection, Group } from '../../database/types';
import {
  buildBankManageKeyboard,
  buildBankStatusText,
  timeSince,
} from '../../services/bank/panel-builder';
import type { CredentialField } from '../../services/bank/registry';
import { BANK_REGISTRY, getBankList, lookupBank } from '../../services/bank/registry';
import { activateNewConnection, triggerManualSync } from '../../services/bank/sync-service';
import { convertToEUR } from '../../services/currency/converter';
import { decryptData, encryptData } from '../../utils/crypto';
import { createLogger } from '../../utils/logger.ts';
import type { BotInstance, Ctx } from '../types';

const logger = createLogger('bank-command');

// ─── Wizard prompt tracking ───────────────────────────────────────────────────
// Maps connectionId → last sent prompt info so we can mask sensitive inputs.

type WizardPromptEntry = {
  messageId: number;
  sensitive: boolean; // whether this prompt was for a sensitive field
  fieldPrompt: string; // prompt label, e.g. "Пароль TBC"
};
const wizardPromptMessages = new Map<number, WizardPromptEntry>();

// ─── /bank command entry point ───────────────────────────────────────────────

export async function handleBankCommand(ctx: Ctx['Message'], bot: BotInstance): Promise<void> {
  const chatId = ctx.chat?.id;
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

  if (!isGroup || !chatId) {
    await ctx.send('Команда /bank работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) return;

  // Clean up stale setup sessions
  for (const id of database.bankConnections.deleteStaleSetup(group.id)) {
    wizardPromptMessages.delete(id);
  }

  // Parse argument, e.g. /bank tbc
  const arg = ctx.text?.split(' ')[1]?.toLowerCase();

  if (arg === 'отмена') {
    await handleWizardCancel(ctx, group.id);
    return;
  }

  if (arg) {
    const found = lookupBank(arg);
    if (found) {
      const [bankKey] = found;
      const existing = database.bankConnections.findByGroupAndBank(group.id, bankKey);
      if (existing && existing.status !== 'setup') {
        await showBankStatus(ctx, bot, existing, group);
      } else {
        await startWizard(ctx, bankKey, bot);
      }
      return;
    }
  }

  const connections = database.bankConnections.findAllByGroupId(group.id);

  if (connections.length === 0) {
    await showNoBanksPanel(ctx);
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

async function showNoBanksPanel(ctx: Ctx['Message']): Promise<void> {
  const banks = getBankList();
  await ctx.send('Ни одного банка не подключено.\n\nВыбери букву:', {
    reply_markup: { inline_keyboard: buildLetterNavKeyboard(banks) },
  });
}

async function startWizard(ctx: Ctx['Message'], bankKey: string, bot: BotInstance): Promise<void> {
  const plugin = BANK_REGISTRY[bankKey];
  if (!plugin) return;

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Show info screen first — the user clicks "🔓 Подключить" to proceed.
  await bot.api.sendMessage({
    chat_id: chatId,
    text: buildWizardInfoText(plugin.name),
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

async function handleWizardCancel(ctx: Ctx['Message'], groupId: number): Promise<void> {
  const setupConn = database.bankConnections.findSetupByGroupId(groupId);

  if (setupConn) {
    wizardPromptMessages.delete(setupConn.id);
    database.bankConnections.deleteById(setupConn.id);
    await ctx.send('Подключение банка отменено.');
  } else {
    await ctx.send('Нет активного подключения для отмены.');
  }
}

/**
 * Called from message.handler.ts when a message arrives and a setup wizard is active.
 * Returns true if the message was consumed by the wizard.
 */
export async function handleWizardInput(
  ctx: Ctx['Message'],
  groupId: number,
  text: string,
  bot: BotInstance,
): Promise<boolean> {
  const setupConn = database.bankConnections.findSetupByGroupId(groupId);

  if (!setupConn) return false;

  const bankFound = lookupBank(setupConn.bank_name);
  if (!bankFound) return false;
  const [, plugin] = bankFound;

  // Determine which credential field we're currently collecting
  const credentials = database.bankCredentials.findByConnectionId(setupConn.id);
  const collectedFields: Record<string, string> = credentials
    ? (JSON.parse(decryptData(credentials.encrypted_data)) as Record<string, string>)
    : {};

  const remainingFields = plugin.fields.filter((f) => {
    const name = resolveFieldName(f);
    return !collectedFields[name];
  });

  if (remainingFields.length === 0) return false;

  const currentField = remainingFields[0];
  const fieldName = resolveFieldName(currentField);
  const chatId = ctx.chat?.id;

  // If this was a sensitive field, delete the user's message and mask the prompt
  const storedPrompt = wizardPromptMessages.get(setupConn.id);
  if (storedPrompt?.sensitive && chatId) {
    try {
      await bot.api.deleteMessage({ chat_id: chatId, message_id: ctx.id });
    } catch {
      // bot may lack delete permission or message already gone
    }
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: storedPrompt.messageId,
        text: `🔒 ${storedPrompt.fieldPrompt}: ${'•'.repeat(text.length)}${SECURITY_NOTE}`,
        link_preview_options: { is_disabled: true },
      });
    } catch {
      // message may be too old or already edited
    }
  }

  collectedFields[fieldName] = text;

  // Persist partial credentials
  database.bankCredentials.upsert(setupConn.id, encryptData(JSON.stringify(collectedFields)));

  // Check if all fields collected
  const nextFields = plugin.fields.filter((f) => !collectedFields[resolveFieldName(f)]);

  if (nextFields.length > 0) {
    const nextField = nextFields[0];
    if (chatId) {
      const sent = await bot.api.sendMessage({
        chat_id: chatId,
        text: buildFieldPromptText(nextField),
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'bank_wizard_cancel' }]],
        },
        link_preview_options: { is_disabled: true },
      });
      wizardPromptMessages.set(setupConn.id, {
        messageId: sent.message_id,
        sensitive: isPasswordField(nextField),
        fieldPrompt: resolveFieldPrompt(nextField),
      });
    }
    return true;
  }

  // Wizard complete — merge auto-fill defaults, then activate connection.
  if (plugin.defaults && Object.keys(plugin.defaults).length > 0) {
    const merged = { ...plugin.defaults, ...collectedFields };
    database.bankCredentials.upsert(setupConn.id, encryptData(JSON.stringify(merged)));
  }

  wizardPromptMessages.delete(setupConn.id);
  database.bankConnections.update(setupConn.id, { status: 'active' });

  // Send the "connecting" panel and store its message ID so sync-service can update it.
  const panelThreadId = (ctx.update?.message?.message_thread_id as number | undefined) ?? null;
  if (chatId) {
    if (setupConn.panel_message_id) {
      // Reconnect path: edit the existing panel.
      await bot.api
        .editMessageText({
          chat_id: chatId,
          message_id: setupConn.panel_message_id,
          text: buildConnectingText(plugin.name),
        })
        .catch(() => {});
    } else {
      // Fresh connection: send a new panel message.
      const panelMsg = await bot.api.sendMessage({
        chat_id: chatId,
        text: buildConnectingText(plugin.name),
        ...(panelThreadId !== null ? { message_thread_id: panelThreadId } : {}),
      });
      database.bankConnections.update(setupConn.id, {
        panel_message_id: panelMsg.message_id,
        panel_message_thread_id: panelThreadId,
      });
    }
  }

  activateNewConnection(setupConn.id).catch((err) =>
    logger.error({ err, connectionId: setupConn.id }, 'Background activation failed'),
  );

  logger.info({ connectionId: setupConn.id, bank: setupConn.bank_name }, 'Bank wizard completed');
  return true;
}

// ─── Status panel ─────────────────────────────────────────────────────────────

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

  // Multiple banks — delete old panel messages, resend
  for (const conn of connections) {
    if (conn.panel_message_id) {
      try {
        await bot.api.deleteMessage({
          chat_id: group.telegram_group_id,
          message_id: conn.panel_message_id,
        });
      } catch {
        // silently ignore if already gone
      }
    }
  }

  if (group.bank_panel_summary_message_id) {
    try {
      await bot.api.deleteMessage({
        chat_id: group.telegram_group_id,
        message_id: group.bank_panel_summary_message_id,
      });
    } catch {
      // ignore
    }
  }

  // Send one message per bank
  for (const conn of connections) {
    const text = buildBankStatusText(conn);
    const sent = await bot.api.sendMessage({
      chat_id: group.telegram_group_id,
      text,
      reply_markup: {
        inline_keyboard: buildBankManageKeyboard(conn),
      },
    });
    database.bankConnections.update(conn.id, {
      panel_message_id: sent.message_id,
    });
  }

  // Summary message
  const accounts = database.bankAccounts.findByGroupId(group.id);
  const totalEur = accounts.reduce(
    (sum, a) =>
      sum + convertToEUR(a.balance, a.currency as import('../../config/constants').CurrencyCode),
    0,
  );

  const summary = `Итого: ~${totalEur.toFixed(0)} EUR`;
  const summarySent = await bot.api.sendMessage({
    chat_id: group.telegram_group_id,
    text: summary,
    reply_markup: {
      inline_keyboard: [[{ text: '➕ Добавить банк', callback_data: 'bank_add' }]],
    },
  });

  database.groups.update(group.telegram_group_id, {
    bank_panel_summary_message_id: summarySent.message_id,
  });
}

async function showBankStatus(
  _ctx: Ctx['Message'],
  bot: BotInstance,
  conn: BankConnection,
  group: Group,
): Promise<void> {
  const text = buildBankStatusText(conn);
  const sent = await bot.api.sendMessage({
    chat_id: group.telegram_group_id,
    text,
    reply_markup: {
      inline_keyboard: buildBankManageKeyboard(conn),
    },
  });
  database.bankConnections.update(conn.id, {
    panel_message_id: sent.message_id,
  });
}

// ─── Confirmation flow callbacks ──────────────────────────────────────────────

export async function handleBankConfirmCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  txId: number,
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  if (!ctx.from) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден' });
    return;
  }

  const user = database.users.findByTelegramId(ctx.from.id);
  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден' });
    return;
  }

  // Atomically claim the transaction: check+update in one transaction to prevent duplicate expenses.
  const confirmed = database.db.transaction(() => {
    const freshTx = database.bankTransactions.findById(txId, group.id);
    if (!freshTx) return null;
    if (freshTx.status !== 'pending') return false;
    database.bankTransactions.updateStatus(txId, group.id, 'confirmed');
    return freshTx;
  })();

  if (confirmed === null) {
    await ctx.answerCallbackQuery({ text: 'Транзакция не найдена' });
    return;
  }
  if (confirmed === false) {
    await ctx.answerCallbackQuery({ text: 'Транзакция уже обработана' });
    return;
  }

  const tx = confirmed;

  // Use AI pre-filled category/comment if available (persisted during sync)
  const category = tx.prefill_category ?? tx.merchant_normalized ?? tx.merchant ?? 'прочее';
  const comment = tx.prefill_comment ?? tx.merchant_normalized ?? tx.merchant ?? '';

  const txCurrency = tx.currency as import('../../config/constants').CurrencyCode;
  const expense = database.expenses.create({
    group_id: group.id,
    user_id: user.id,
    date: tx.date,
    category,
    comment,
    amount: tx.amount,
    currency: txCurrency,
    eur_amount: convertToEUR(tx.amount, txCurrency),
  });

  database.bankTransactions.setMatchedExpense(txId, group.id, expense.id);

  // Only create rule request if there's a meaningful merchant string to normalize
  if (tx.merchant) {
    database.merchantRules.insertRuleRequest({
      merchant_raw: tx.merchant,
      mcc: tx.mcc,
      group_id: group.id,
      user_category: category,
      user_comment: comment,
    });
  }

  await ctx.answerCallbackQuery({ text: '✅ Расход записан' });

  const messageId = ctx.message?.id;
  const originalText = ctx.message?.text ?? '';
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `${originalText}\n\n✅ Записано`,
      });
    } catch {
      // message may be too old to edit
    }
  }
}

export async function handleBankEditCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  txId: number,
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  const tx = database.bankTransactions.findById(txId, group.id);
  if (!tx) {
    await ctx.answerCallbackQuery({ text: 'Транзакция не найдена' });
    return;
  }

  if (!ctx.from) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден' });
    return;
  }

  // Check if another edit is in progress
  const pendingTxs = database.bankTransactions.findPendingByConnectionId(tx.connection_id);
  const otherEdit = pendingTxs.find((t) => t.id !== txId && t.edit_in_progress === 1);
  if (otherEdit) {
    await ctx.answerCallbackQuery({
      text: 'Сначала заверши текущее исправление',
    });
    return;
  }

  database.bankTransactions.setEditInProgress(txId, true);
  await ctx.answerCallbackQuery();

  const replyToMsgId = tx.telegram_message_id ?? undefined;
  const promptMsg = await bot.api.sendMessage({
    chat_id: chatId,
    text: `✏️ Ответь на это сообщение и напиши что исправить.\n\nФормат: категория — комментарий\nИли только категория.`,
    ...(replyToMsgId !== undefined ? { reply_to_message_id: replyToMsgId } : {}),
  });
  // Store the prompt's message_id so handleBankEditReply can verify the reply is to this message
  if (promptMsg?.message_id) {
    database.bankTransactions.setTelegramMessageId(txId, promptMsg.message_id);
  }
}

export async function handleBankEditReply(
  ctx: Ctx['Message'],
  chatId: number,
  text: string,
  replyToMessageId: number,
): Promise<boolean> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) return false;

  if (!ctx.from) return false;

  // Find the transaction with edit_in_progress=1 that the user is replying to
  const connections = database.bankConnections.findActiveByGroupId(group.id);
  let editTx: import('../../database/types').BankTransaction | null = null;

  for (const conn of connections) {
    const pending = database.bankTransactions.findPendingByConnectionId(conn.id);
    editTx =
      pending.find((t) => t.edit_in_progress === 1 && t.telegram_message_id === replyToMessageId) ??
      null;
    if (editTx) break;
  }

  if (!editTx) return false;

  const parts = text.split('—').map((s) => s.trim());
  const category = parts[0] ?? 'прочее';
  const comment = parts[1] ?? editTx.merchant_normalized ?? editTx.merchant ?? '';

  const user = database.users.findByTelegramId(ctx.from.id);
  if (!user) {
    database.bankTransactions.setEditInProgress(editTx.id, false);
    return false;
  }

  const editCurrency = editTx.currency as import('../../config/constants').CurrencyCode;
  const expense = database.expenses.create({
    group_id: group.id,
    user_id: user.id,
    date: editTx.date,
    category,
    comment,
    amount: editTx.amount,
    currency: editCurrency,
    eur_amount: convertToEUR(editTx.amount, editCurrency),
  });

  database.bankTransactions.updateStatus(editTx.id, group.id, 'confirmed');
  database.bankTransactions.setMatchedExpense(editTx.id, group.id, expense.id);
  database.bankTransactions.setEditInProgress(editTx.id, false);

  if (editTx.merchant) {
    database.merchantRules.insertRuleRequest({
      merchant_raw: editTx.merchant,
      mcc: editTx.mcc,
      group_id: group.id,
      user_category: category,
      user_comment: comment,
    });
  }

  await ctx.send(
    `✅ Расход записан: ${category} — ${comment} (${editTx.amount} ${editTx.currency})`,
  );
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveFieldName(field: CredentialField | undefined): string {
  if (!field) return '';
  return typeof field === 'string' ? field : field.name;
}

function resolveFieldPrompt(field: CredentialField | undefined): string {
  if (!field) return '';
  if (typeof field === 'string') return field;
  return field.prompt ?? field.name;
}

function isPasswordField(field: CredentialField | undefined): boolean {
  return (
    typeof field !== 'string' && !!field && (field.type === 'password' || field.type === 'otp')
  );
}

const SECURITY_NOTE =
  '\n\n🔒 Пароль шифруется алгоритмом AES-256-GCM и хранится только на сервере бота — никуда не передаётся. Транзакции получаем через открытую библиотеку ZenPlugins: github.com/zenmoney/ZenPlugins';

function buildFieldPromptText(field: CredentialField | undefined): string {
  const prompt = resolveFieldPrompt(field);
  return `${prompt}:${isPasswordField(field) ? SECURITY_NOTE : ''}`;
}

function buildWizardInfoText(bankName: string): string {
  return (
    `🏦 ${bankName}\n\n` +
    `После подключения бот будет автоматически:\n` +
    `• Получать транзакции каждые 30 минут\n` +
    `• Предлагать категорию через ИИ\n` +
    `• Ждать твоего подтверждения перед записью\n` +
    `• Синхронизировать с Google Sheets\n\n` +
    `Транзакции получаем через ZenPlugins — open-source: github.com/zenmoney/ZenPlugins`
  );
}

function buildWizardStartText(bankName: string, firstField: CredentialField | undefined): string {
  return `🏦 ${bankName} — данные для входа\n\n${buildFieldPromptText(firstField)}`;
}

function buildConnectingText(bankName: string): string {
  return `⏳ ${bankName} — подключаем...\n\nПервая синхронизация запущена. Статус появится здесь.`;
}

// ─── Callback entry points ────────────────────────────────────────────────────

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
  await ctx.send(infoText, { reply_markup: keyboard });
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
  for (const id of database.bankConnections.deleteStaleSetup(group.id)) {
    wizardPromptMessages.delete(id);
  }

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

  const messageId = ctx.message?.id;
  const threadId =
    (ctx.update?.callback_query?.message as { message_thread_id?: number } | undefined)
      ?.message_thread_id ?? null;

  if (plugin.fields.length === 0) {
    // No credential fields — activate immediately and show connecting panel.
    if (plugin.defaults && Object.keys(plugin.defaults).length > 0) {
      database.bankCredentials.upsert(newConn.id, encryptData(JSON.stringify(plugin.defaults)));
    }
    database.bankConnections.update(newConn.id, { status: 'active' });

    let panelMsgId: number | null = null;
    if (messageId) {
      try {
        await bot.api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: buildConnectingText(plugin.name),
        });
        panelMsgId = messageId;
      } catch {
        // fall through
      }
    }
    if (panelMsgId === null) {
      const sent = await bot.api.sendMessage({
        chat_id: chatId,
        text: buildConnectingText(plugin.name),
        ...(threadId !== null ? { message_thread_id: threadId } : {}),
      });
      panelMsgId = sent.message_id;
    }

    database.bankConnections.update(newConn.id, {
      panel_message_id: panelMsgId,
      panel_message_thread_id: threadId,
    });

    activateNewConnection(newConn.id).catch((err) =>
      logger.error({ err, connectionId: newConn.id }, 'Background activation failed'),
    );
    return;
  }

  // Has credential fields — edit info screen to show the first field prompt.
  const firstField = plugin.fields[0];
  const firstFieldText = buildWizardStartText(plugin.name, firstField);

  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: firstFieldText,
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'bank_wizard_cancel' }]],
        },
        link_preview_options: { is_disabled: true },
      });
      wizardPromptMessages.set(newConn.id, {
        messageId,
        sensitive: isPasswordField(firstField),
        fieldPrompt: resolveFieldPrompt(firstField),
      });
      return;
    } catch {
      // fall through
    }
  }

  // Fallback: send new message
  const sent = await bot.api.sendMessage({
    chat_id: chatId,
    text: firstFieldText,
    reply_markup: {
      inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'bank_wizard_cancel' }]],
    },
    link_preview_options: { is_disabled: true },
  });
  wizardPromptMessages.set(newConn.id, {
    messageId: sent.message_id,
    sensitive: isPasswordField(firstField),
    fieldPrompt: resolveFieldPrompt(firstField),
  });
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
    ? `синхронизировано ${timeSince(conn.last_sync_at)} назад`
    : 'первая синхронизация ещё не завершена';
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
  await ctx.send(settingsText, { reply_markup: settingsKeyboard });
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
      await ctx.send(`⚠️ Отключить ${conn.display_name}?\n\nВсе данные будут удалены.`, {
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
  wizardPromptMessages.delete(conn.id);
  database.bankCredentials.deleteByConnectionId(conn.id);
  database.bankConnections.update(conn.id, {
    status: 'setup',
    consecutive_failures: 0,
    last_error: null,
  });

  if (plugin.fields.length === 0) {
    if (plugin.defaults && Object.keys(plugin.defaults).length > 0) {
      database.bankCredentials.upsert(conn.id, encryptData(JSON.stringify(plugin.defaults)));
    }
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
    return;
  }

  const firstField = plugin.fields[0];
  const sent = await bot.api.sendMessage({
    chat_id: chatId,
    text: buildWizardStartText(plugin.name, firstField),
    reply_markup: {
      inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'bank_wizard_cancel' }]],
    },
    link_preview_options: { is_disabled: true },
  });
  wizardPromptMessages.set(conn.id, {
    messageId: sent.message_id,
    sensitive: isPasswordField(firstField),
    fieldPrompt: resolveFieldPrompt(firstField),
  });
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
  await ctx.send('Выбери букву:', {
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
  await ctx.send(`Банки на букву ${letter}:`, {
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
  await ctx.send('Выбери букву:', {
    reply_markup: { inline_keyboard: keyboard },
  });
}
