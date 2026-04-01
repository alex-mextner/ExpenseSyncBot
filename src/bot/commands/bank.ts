// /bank command — setup wizard, status panel, and confirmation flow handlers.
import { database } from '../../database';
import type { BankConnection, Group } from '../../database/types';
import {
  buildBankManageKeyboard,
  buildBankStatusText,
  buildCombinedBankKeyboard,
  buildCombinedBankStatusText,
  timeSince,
} from '../../services/bank/panel-builder';
import type { CredentialField } from '../../services/bank/registry';
import { BANK_REGISTRY, getBankList, lookupBank } from '../../services/bank/registry';
import { activateNewConnection, triggerManualSync } from '../../services/bank/sync-service';
import { sendMessage } from '../../services/bank/telegram-sender';
import { convertAnyToEUR } from '../../services/currency/converter';
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

export async function handleBankCommand(
  ctx: Ctx['Command'],
  group: Group,
  bot: BotInstance,
): Promise<void> {
  // Clean up stale setup sessions
  for (const id of database.bankConnections.deleteStaleSetup(group.id)) {
    wizardPromptMessages.delete(id);
  }

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

async function startWizard(bankKey: string): Promise<void> {
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

async function handleWizardCancel(groupId: number): Promise<void> {
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
      const sent = await sendMessage(buildFieldPromptText(nextField), {
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'bank_wizard_cancel' }]],
        },
        link_preview_options: { is_disabled: true },
      });
      if (sent) {
        wizardPromptMessages.set(setupConn.id, {
          messageId: sent.message_id,
          sensitive: isPasswordField(nextField),
          fieldPrompt: resolveFieldPrompt(nextField),
        });
      }
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
      const panelMsg = await sendMessage(buildConnectingText(plugin.name));
      if (panelMsg) {
        database.bankConnections.update(setupConn.id, {
          panel_message_id: panelMsg.message_id,
          panel_message_thread_id: panelThreadId,
        });
      }
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

  // Delete old panel messages before resending
  const seenMessageIds = new Set<number>();
  for (const conn of connections) {
    if (conn.panel_message_id && !seenMessageIds.has(conn.panel_message_id)) {
      seenMessageIds.add(conn.panel_message_id);
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

  if (
    group.bank_panel_summary_message_id &&
    !seenMessageIds.has(group.bank_panel_summary_message_id)
  ) {
    try {
      await bot.api.deleteMessage({
        chat_id: group.telegram_group_id,
        message_id: group.bank_panel_summary_message_id,
      });
    } catch {
      // ignore
    }
  }

  // Send one combined message for all banks
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

  // Atomically claim the transaction — prevent double-claiming.
  const claimed = database.transaction(() => {
    const freshTx = database.bankTransactions.findById(txId, group.id);
    if (!freshTx) return null;
    if (freshTx.status !== 'pending') return false;
    if (freshTx.edit_in_progress === 1) return 'edit'; // someone's editing it
    database.bankTransactions.setEditInProgress(txId, true);
    return freshTx;
  });

  if (claimed === null) {
    await ctx.answerCallbackQuery({ text: 'Транзакция не найдена' });
    return;
  }
  if (claimed === false) {
    await ctx.answerCallbackQuery({ text: 'Транзакция уже обработана' });
    return;
  }
  if (claimed === 'edit') {
    await ctx.answerCallbackQuery({ text: 'Сначала заверши текущее исправление' });
    return;
  }

  // Check for duplicate expenses before asking for a comment.
  const { exact, fuzzy } = database.expenses.findPotentialDuplicates(
    group.id,
    claimed.date,
    claimed.amount,
    claimed.currency,
  );

  if (exact.length > 0) {
    // Auto-link: bind the bank transaction to the existing expense silently.
    const existing = exact[0];
    if (!existing) return; // length > 0 guarantees this, but TypeScript needs it
    mergeTransactionWithExpense(claimed, group.id, existing.id);
    database.bankTransactions.setEditInProgress(txId, false);

    await ctx.answerCallbackQuery({ text: '✅ Связано с существующим расходом' });
    const messageId = ctx.message?.id;
    if (messageId) {
      try {
        await bot.api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `✅ Связано: ${existing.category} (${existing.amount} ${existing.currency})`,
        });
      } catch {
        // message may be too old to edit
      }
    }
    return;
  }

  if (fuzzy.length > 0) {
    // Show link-or-new prompt — let the user decide.
    const match = fuzzy[0];
    if (!match) return; // length > 0 guarantees this, but TypeScript needs it
    const commentPart = match.comment ? ` — ${match.comment}` : '';
    await ctx.answerCallbackQuery();

    const replyToMsgId = claimed.telegram_message_id ?? undefined;
    await sendMessage(
      `🔄 Найден похожий расход:\n📅 ${match.date} | ${match.amount} ${match.currency} | ${match.category}${commentPart}\n\nСвязать или создать новый?`,
      {
        ...(replyToMsgId !== undefined ? { reply_parameters: { message_id: replyToMsgId } } : {}),
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔗 Связать', callback_data: `bank_merge:${txId}:${match.id}` },
              { text: '➕ Новый расход', callback_data: `bank_new:${txId}` },
            ],
          ],
        },
      },
    );
    return;
  }

  // Check for matching receipts (same amount ±5%, date, currency)
  const receiptMatches = database.receipts.findPotentialMatches(
    group.id,
    claimed.date,
    claimed.amount,
    claimed.currency,
  );
  const receiptMatch = receiptMatches.exact[0] ?? receiptMatches.fuzzy[0];
  if (receiptMatch) {
    const receiptExpenses = database.receipts.findExpensesByReceiptId(receiptMatch.id);
    const categorySummary = receiptExpenses.map((e) => e.category).join(', ') || 'без категорий';
    await ctx.answerCallbackQuery();

    const replyToMsgId = claimed.telegram_message_id ?? undefined;
    await sendMessage(
      `🧾 Найден чек на ${receiptMatch.total_amount} ${receiptMatch.currency} от ${receiptMatch.date}\n📋 Категории: ${categorySummary}\n\nСвязать транзакцию с чеком или создать новый расход?`,
      {
        ...(replyToMsgId !== undefined ? { reply_parameters: { message_id: replyToMsgId } } : {}),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🧾 Связать с чеком',
                callback_data: `bank_receipt:${txId}:${receiptMatch.id}`,
              },
              { text: '➕ Новый расход', callback_data: `bank_new:${txId}` },
            ],
          ],
        },
      },
    );
    return;
  }

  // No duplicates — ask user to enter a comment or skip it.
  database.bankTransactions.setAwaitingComment(txId, true);
  await ctx.answerCallbackQuery();

  const replyToMsgId = claimed.telegram_message_id ?? undefined;
  const promptMsg = await sendMessage(
    `💬 Добавь комментарий к расходу или нажми «Без комментария».`,
    {
      ...(replyToMsgId !== undefined ? { reply_parameters: { message_id: replyToMsgId } } : {}),
      reply_markup: {
        inline_keyboard: [[{ text: 'Без комментария', callback_data: `bank_nocomment:${txId}` }]],
      },
    },
  );

  if (promptMsg?.message_id) {
    // Store prompt message id so handleBankEditReply can match the reply
    database.bankTransactions.setTelegramMessageId(txId, promptMsg.message_id);
  }
}

/**
 * Handles "Объединить" button — links bank transaction to an existing expense.
 */
export async function handleBankMergeCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  txId: number,
  expenseId: number,
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  // Atomically claim: verify tx is still pending, expense not yet linked, then merge.
  const mergeResult = database.transaction(() => {
    const tx = database.bankTransactions.findById(txId, group.id);
    if (!tx || tx.status !== 'pending') return 'tx_done' as const;

    const expense = database.expenses.findById(expenseId);
    if (!expense || expense.group_id !== group.id) return 'expense_missing' as const;

    const alreadyLinked = database.queryOne<{ n: number }>(
      'SELECT COUNT(*) as n FROM bank_transactions WHERE matched_expense_id = ?',
      expenseId,
    );
    if (alreadyLinked && alreadyLinked.n > 0) return 'expense_taken' as const;

    mergeTransactionWithExpense(tx, group.id, expense.id);
    database.bankTransactions.setEditInProgress(txId, false);
    return expense;
  });

  if (mergeResult === 'tx_done') {
    await ctx.answerCallbackQuery({ text: 'Транзакция уже обработана' });
    return;
  }
  if (mergeResult === 'expense_missing') {
    await ctx.answerCallbackQuery({ text: 'Расход не найден' });
    return;
  }
  if (mergeResult === 'expense_taken') {
    await ctx.answerCallbackQuery({ text: 'Расход уже привязан к другой транзакции' });
    return;
  }

  const expense = mergeResult;

  await ctx.answerCallbackQuery({ text: '✅ Связано' });
  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `✅ Связано: ${expense.category} (${expense.amount} ${expense.currency})`,
      });
    } catch {
      // message may be too old to edit
    }
  }
}

/**
 * Handles "Связать с чеком" button — links bank transaction to all expenses from a receipt.
 */
export async function handleBankReceiptCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  txId: number,
  receiptId: number,
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  const linkResult = database.transaction(() => {
    const tx = database.bankTransactions.findById(txId, group.id);
    if (!tx || tx.status !== 'pending') return 'tx_done' as const;

    const receipt = database.receipts.findById(receiptId);
    if (!receipt || receipt.group_id !== group.id) return 'receipt_missing' as const;

    // Find the first expense linked to this receipt and merge with it
    const receiptExpenses = database.receipts.findExpensesByReceiptId(receiptId);
    if (receiptExpenses.length === 0) return 'no_expenses' as const;

    const firstExpense = receiptExpenses[0];
    if (!firstExpense) return 'no_expenses' as const;

    mergeTransactionWithExpense(tx, group.id, firstExpense.id);
    database.bankTransactions.setEditInProgress(txId, false);
    return { receipt, expenses: receiptExpenses };
  });

  if (linkResult === 'tx_done') {
    await ctx.answerCallbackQuery({ text: 'Транзакция уже обработана' });
    return;
  }
  if (linkResult === 'receipt_missing') {
    await ctx.answerCallbackQuery({ text: 'Чек не найден' });
    return;
  }
  if (linkResult === 'no_expenses') {
    await ctx.answerCallbackQuery({ text: 'У чека нет связанных расходов' });
    return;
  }

  const { receipt, expenses } = linkResult;
  const categorySummary = expenses.map((e) => e.category).join(', ');

  await ctx.answerCallbackQuery({ text: '✅ Связано с чеком' });
  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `✅ Связано с чеком: ${receipt.total_amount} ${receipt.currency} (${categorySummary})`,
      });
    } catch {
      // message may be too old to edit
    }
  }
}

/**
 * Handles "Новый расход" button after a fuzzy-match prompt — proceeds to the comment step.
 */
export async function handleBankNewCallback(
  ctx: Ctx['CallbackQuery'],
  txId: number,
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  const tx = database.bankTransactions.findById(txId, group.id);
  if (!tx || tx.status !== 'pending' || tx.edit_in_progress !== 1) {
    await ctx.answerCallbackQuery({ text: 'Транзакция уже обработана' });
    return;
  }

  database.bankTransactions.setAwaitingComment(txId, true);
  await ctx.answerCallbackQuery();

  const replyToMsgId = tx.telegram_message_id ?? undefined;
  const promptMsg = await sendMessage(
    `💬 Добавь комментарий к расходу или нажми «Без комментария».`,
    {
      ...(replyToMsgId !== undefined ? { reply_parameters: { message_id: replyToMsgId } } : {}),
      reply_markup: {
        inline_keyboard: [[{ text: 'Без комментария', callback_data: `bank_nocomment:${txId}` }]],
      },
    },
  );

  if (promptMsg?.message_id) {
    database.bankTransactions.setTelegramMessageId(txId, promptMsg.message_id);
  }
}

export async function handleBankEditCallback(
  ctx: Ctx['CallbackQuery'],
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
  const promptMsg = await sendMessage(
    `✏️ Ответь на это сообщение и напиши что исправить.\n\nФормат: категория — комментарий\nИли только категория.`,
    {
      ...(replyToMsgId !== undefined ? { reply_parameters: { message_id: replyToMsgId } } : {}),
    },
  );
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

  const user = database.users.findByTelegramId(ctx.from.id);
  if (!user) {
    database.bankTransactions.setEditInProgress(editTx.id, false);
    database.bankTransactions.setAwaitingComment(editTx.id, false);
    return false;
  }

  let category: string;
  let comment: string;

  if (editTx.awaiting_comment === 1) {
    // "Принять" flow: user types a comment; category comes from pre-fill
    category = editTx.prefill_category ?? editTx.merchant_normalized ?? editTx.merchant ?? 'прочее';
    comment = text.trim();
  } else {
    // "Исправить" flow: user types "категория — комментарий"
    const parts = text.split('—').map((s) => s.trim());
    category = parts[0] ?? 'прочее';
    comment = parts[1] ?? editTx.merchant_normalized ?? editTx.merchant ?? '';
  }

  await saveConfirmedTransaction(editTx, group.id, user.id, category, comment);
  database.bankTransactions.setEditInProgress(editTx.id, false);
  database.bankTransactions.setAwaitingComment(editTx.id, false);

  await sendMessage(
    `✅ Расход записан: ${category}${comment ? ` — ${comment}` : ''} (${editTx.amount} ${editTx.currency})`,
  );
  return true;
}

/**
 * Handles "Без комментария" button — confirms transaction with empty comment.
 */
export async function handleBankNoCommentCallback(
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

  const confirmed = database.transaction(() => {
    const freshTx = database.bankTransactions.findById(txId, group.id);
    if (!freshTx) return null;
    if (freshTx.status !== 'pending') return false;
    return freshTx;
  });

  if (confirmed === null) {
    await ctx.answerCallbackQuery({ text: 'Транзакция не найдена' });
    return;
  }
  if (confirmed === false) {
    await ctx.answerCallbackQuery({ text: 'Транзакция уже обработана' });
    return;
  }

  const tx = confirmed;
  const category = tx.prefill_category ?? tx.merchant_normalized ?? tx.merchant ?? 'прочее';

  saveConfirmedTransaction(tx, group.id, user.id, category, '');
  database.bankTransactions.setEditInProgress(tx.id, false);
  database.bankTransactions.setAwaitingComment(tx.id, false);

  await ctx.answerCallbackQuery({ text: '✅ Расход записан' });

  const messageId = ctx.message?.id;
  if (messageId) {
    try {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `✅ Записано: ${category} (${tx.amount} ${tx.currency})`,
      });
    } catch {
      // message may be too old to edit
    }
  }
}

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

/**
 * Link a bank transaction to an existing expense without creating a new one.
 */
function mergeTransactionWithExpense(
  tx: import('../../database/types').BankTransaction,
  groupId: number,
  expenseId: number,
): void {
  database.bankTransactions.updateStatus(tx.id, groupId, 'confirmed');
  database.bankTransactions.setMatchedExpense(tx.id, groupId, expenseId);
}

/**
 * Confirm a bank transaction as an expense and create the corresponding merchant rule request.
 */
function saveConfirmedTransaction(
  tx: import('../../database/types').BankTransaction,
  groupId: number,
  userId: number,
  category: string,
  comment: string,
): void {
  const txCurrency = tx.currency as import('../../config/constants').CurrencyCode;
  const expense = database.expenses.create({
    group_id: groupId,
    user_id: userId,
    date: tx.date,
    category,
    comment,
    amount: tx.amount,
    currency: txCurrency,
    eur_amount: convertAnyToEUR(tx.amount, tx.currency),
  });

  database.bankTransactions.updateStatus(tx.id, groupId, 'confirmed');
  database.bankTransactions.setMatchedExpense(tx.id, groupId, expense.id);

  if (tx.merchant) {
    database.merchantRules.insertRuleRequest({
      merchant_raw: tx.merchant,
      mcc: tx.mcc,
      group_id: groupId,
      user_category: category,
      user_comment: comment,
    });
  }
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
  await sendMessage(infoText, { reply_markup: keyboard });
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
      const sent = await sendMessage(buildConnectingText(plugin.name));
      if (sent) {
        panelMsgId = sent.message_id;
      }
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
  const sent = await sendMessage(firstFieldText, {
    reply_markup: {
      inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'bank_wizard_cancel' }]],
    },
    link_preview_options: { is_disabled: true },
  });
  if (sent) {
    wizardPromptMessages.set(newConn.id, {
      messageId: sent.message_id,
      sensitive: isPasswordField(firstField),
      fieldPrompt: resolveFieldPrompt(firstField),
    });
  }
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
  const sent = await sendMessage(buildWizardStartText(plugin.name, firstField), {
    reply_markup: {
      inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'bank_wizard_cancel' }]],
    },
    link_preview_options: { is_disabled: true },
  });
  if (sent) {
    wizardPromptMessages.set(conn.id, {
      messageId: sent.message_id,
      sensitive: isPasswordField(firstField),
      fieldPrompt: resolveFieldPrompt(firstField),
    });
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
