// /bank command — setup wizard, status panel, and confirmation flow handlers.
import { database } from '../../database';
import type { BankConnection, Group } from '../../database/types';
import type { CredentialField } from '../../services/bank/registry';
import { BANK_REGISTRY, getBankList } from '../../services/bank/registry';
import { decryptData, encryptData } from '../../utils/crypto';
import { createLogger } from '../../utils/logger.ts';
import type { BotInstance, Ctx } from '../types';

const logger = createLogger('bank-command');

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
  database.bankConnections.deleteStaleSetup(group.id);

  // Parse argument, e.g. /bank tbc
  const arg = ctx.text?.split(' ')[1]?.toLowerCase();

  if (arg === 'отмена') {
    await handleWizardCancel(ctx, group.id);
    return;
  }

  if (arg && BANK_REGISTRY[arg]) {
    // Jump straight to setup wizard or show bank status
    const existing = database.bankConnections.findByGroupAndBank(group.id, arg);
    if (existing && existing.status !== 'setup') {
      await showBankStatus(ctx, bot, existing, group);
    } else {
      await startWizard(ctx, group.id, arg);
    }
    return;
  }

  const connections = database.bankConnections.findAllByGroupId(group.id);

  if (connections.length === 0) {
    await showNoBanksPanel(ctx);
    return;
  }

  await showBanksPanel(ctx, bot, connections, group);
}

// ─── Wizard ──────────────────────────────────────────────────────────────────

async function showNoBanksPanel(ctx: Ctx['Message']): Promise<void> {
  const banks = getBankList();
  const buttons = banks.map((b) => [{ text: b.name, callback_data: `bank_setup:${b.key}` }]);
  await ctx.send('Ни одного банка не подключено.\n\nВыбери банк:', {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function startWizard(ctx: Ctx['Message'], groupId: number, bankKey: string): Promise<void> {
  const plugin = BANK_REGISTRY[bankKey];
  if (!plugin) return;

  // Check if there's already an active/disconnected connection for this bank
  const existing = database.bankConnections.findByGroupAndBank(groupId, bankKey);
  if (existing) {
    database.bankConnections.deleteById(existing.id);
  }

  database.bankConnections.create({
    group_id: groupId,
    bank_name: bankKey,
    display_name: plugin.name,
    status: 'setup',
  });

  const firstField = plugin.fields[0];
  const prompt = resolveFieldPrompt(firstField);
  await ctx.send(`🏦 Подключение ${plugin.name}\n\n${prompt}:\n\n(Для отмены: /bank отмена)`);
}

async function handleWizardCancel(ctx: Ctx['Message'], groupId: number): Promise<void> {
  const setupConn = database.bankConnections.findSetupByGroupId(groupId);

  if (setupConn) {
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
): Promise<boolean> {
  const setupConn = database.bankConnections.findSetupByGroupId(groupId);

  if (!setupConn) return false;

  const plugin = BANK_REGISTRY[setupConn.bank_name];
  if (!plugin) return false;

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

  collectedFields[fieldName] = text;

  // Persist partial credentials
  database.bankCredentials.upsert(setupConn.id, encryptData(JSON.stringify(collectedFields)));

  // Check if all fields collected
  const nextFields = plugin.fields.filter((f) => !collectedFields[resolveFieldName(f)]);

  if (nextFields.length > 0) {
    const nextField = nextFields[0];
    await ctx.send(`${resolveFieldPrompt(nextField)}:`);
    return true;
  }

  // Wizard complete — activate connection
  database.bankConnections.update(setupConn.id, { status: 'active' });
  await ctx.send(
    `✅ ${plugin.name} подключён!\n\nПервая синхронизация начнётся в течение нескольких минут.`,
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
  const totalEur = accounts.reduce((sum, a) => {
    // Simplified — full conversion would use currency converter
    return sum + (a.currency === 'EUR' ? a.balance : 0);
  }, 0);

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

function buildBankStatusText(conn: BankConnection): string {
  const accounts = database.bankAccounts.findByConnectionId(conn.id);
  const lastSync = conn.last_sync_at
    ? `${timeSince(conn.last_sync_at)} назад`
    : 'не синхронизировано';
  const statusEmoji = conn.status === 'active' ? '✅' : '⚠️';

  const balanceLine =
    accounts.length > 0
      ? accounts.map((a) => `${a.balance.toFixed(2)} ${a.currency}`).join(', ')
      : 'балансы загружаются…';

  const pendingTxs = database.bankTransactions.findPendingByConnectionId(conn.id).slice(0, 3);
  const txLines =
    pendingTxs.length > 0
      ? '\n\nПоследние операции:\n' +
        pendingTxs
          .map(
            (tx) =>
              `• ${tx.amount.toFixed(2)} ${tx.currency} — ${tx.merchant_normalized ?? tx.merchant ?? '—'} · ⏳ ожидает`,
          )
          .join('\n')
      : '';

  return `🏦 ${conn.display_name} · ${lastSync} · ${statusEmoji}\nБаланс: ${balanceLine}${txLines}`;
}

function buildBankManageKeyboard(
  conn: BankConnection,
): { text: string; callback_data: string }[][] {
  return [
    [{ text: `⚙️ ${conn.display_name}`, callback_data: `bank_settings:${conn.id}` }],
    [
      { text: '🔄 Синхронизировать', callback_data: `bank_sync:${conn.id}` },
      { text: '🔌 Отключить', callback_data: `bank_disconnect:${conn.id}` },
    ],
  ];
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

  const tx = database.bankTransactions.findById(txId, group.id);
  if (!tx) {
    await ctx.answerCallbackQuery({ text: 'Транзакция не найдена' });
    return;
  }
  if (tx.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: 'Транзакция уже обработана' });
    return;
  }

  const category = tx.merchant_normalized ?? tx.merchant ?? 'прочее';
  const comment = tx.merchant_normalized ?? tx.merchant ?? '';

  const user = database.users.findByTelegramId(ctx.from.id);
  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден' });
    return;
  }

  const expense = database.expenses.create({
    group_id: group.id,
    user_id: user.id,
    date: tx.date,
    category,
    comment,
    amount: tx.amount,
    currency: tx.currency as import('../../config/constants').CurrencyCode,
    eur_amount: 0,
  });

  database.bankTransactions.updateStatus(txId, group.id, 'confirmed');
  database.bankTransactions.setMatchedExpense(txId, group.id, expense.id);

  database.merchantRules.insertRuleRequest({
    merchant_raw: tx.merchant ?? '',
    mcc: tx.mcc,
    group_id: group.id,
    user_category: category,
    user_comment: comment,
  });

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

  // Check if another edit is in progress
  const pendingTxs = database.bankTransactions.findPendingByConnectionId(tx.connection_id);
  const otherEdit = pendingTxs.find((t) => t.id !== txId && t.edit_in_progress === 1);
  if (otherEdit) {
    await ctx.answerCallbackQuery({ text: 'Сначала заверши текущее исправление' });
    return;
  }

  database.bankTransactions.setEditInProgress(txId, true);
  await ctx.answerCallbackQuery();

  const replyToMsgId = tx.telegram_message_id ?? undefined;
  await bot.api.sendMessage({
    chat_id: chatId,
    text: `✏️ Ответь на это сообщение и напиши что исправить.\n\nФормат: категория — комментарий\nИли только категория.`,
    ...(replyToMsgId !== undefined ? { reply_to_message_id: replyToMsgId } : {}),
  });
}

export async function handleBankEditReply(
  ctx: Ctx['Message'],
  replyToMessageId: number,
  chatId: number,
  text: string,
): Promise<boolean> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) return false;

  // Find a transaction with edit_in_progress=1 whose telegram_message_id matches
  const connections = database.bankConnections.findActiveByGroupId(group.id);
  let editTx: import('../../database/types').BankTransaction | null = null;

  for (const conn of connections) {
    const pending = database.bankTransactions.findPendingByConnectionId(conn.id);
    editTx =
      pending.find((t) => t.telegram_message_id === replyToMessageId && t.edit_in_progress === 1) ??
      null;
    if (editTx) break;
  }

  if (!editTx) return false;

  const parts = text.split('—').map((s) => s.trim());
  const category = parts[0] ?? 'прочее';
  const comment = parts[1] ?? editTx.merchant_normalized ?? editTx.merchant ?? '';

  const user = database.users.findByTelegramId(ctx.from.id);
  if (!user) return false;

  const expense = database.expenses.create({
    group_id: group.id,
    user_id: user.id,
    date: editTx.date,
    category,
    comment,
    amount: editTx.amount,
    currency: editTx.currency as import('../../config/constants').CurrencyCode,
    eur_amount: 0,
  });

  database.bankTransactions.updateStatus(editTx.id, group.id, 'confirmed');
  database.bankTransactions.setMatchedExpense(editTx.id, group.id, expense.id);
  database.bankTransactions.setEditInProgress(editTx.id, false);

  database.merchantRules.insertRuleRequest({
    merchant_raw: editTx.merchant ?? '',
    mcc: editTx.mcc,
    group_id: group.id,
    user_category: category,
    user_comment: comment,
  });

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

function timeSince(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} мин`;
  return `${Math.floor(mins / 60)} ч`;
}
