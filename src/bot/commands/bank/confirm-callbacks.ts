// Bank transaction confirmation flow: confirm / merge / receipt-link / new / edit / no-comment
// callbacks and the reply handler for edits. Split out of ../bank.ts (wizard and panel code
// stay there) so each file keeps one responsibility.
import type { CurrencyCode } from '../../../config/constants';
import { database } from '../../../database';
import type { BankTransaction, Expense, Receipt, User } from '../../../database/types';
import { editMessageText, sendMessage } from '../../../services/bank/telegram-sender';
import { convertAnyToEUR, formatAmount } from '../../../services/currency/converter';
import type { Ctx } from '../../types';

/** Telegram `reply_parameters` fragment that threads a message under the card's message. */
function replyParametersFor(tx: BankTransaction): { reply_parameters?: { message_id: number } } {
  const replyToMsgId = tx.telegram_message_id ?? undefined;
  return replyToMsgId !== undefined ? { reply_parameters: { message_id: replyToMsgId } } : {};
}

/** Answers the callback with "user not found" and returns null unless the sender is registered. */
async function findCallbackUser(ctx: Ctx['CallbackQuery']): Promise<User | null> {
  if (!ctx.from) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден' });
    return null;
  }

  const user = database.users.findByTelegramId(ctx.from.id);
  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден' });
    return null;
  }
  return user;
}

// ─── Confirmation flow callbacks ──────────────────────────────────────────────

/**
 * Atomically claim the transaction — prevent double-claiming.
 * null = not found, false = already processed, 'edit' = someone is editing it.
 */
function claimPendingTransaction(
  txId: number,
  groupId: number,
): BankTransaction | null | false | 'edit' {
  return database.transaction(() => {
    const freshTx = database.bankTransactions.findById(txId, groupId);
    if (!freshTx) return null;
    if (freshTx.status !== 'pending') return false;
    if (freshTx.edit_in_progress === 1) return 'edit'; // someone's editing it
    database.bankTransactions.setEditInProgress(txId, true);
    return freshTx;
  });
}

function claimFailureText(failure: null | false | 'edit'): string {
  if (failure === null) return 'Транзакция не найдена';
  if (failure === false) return 'Транзакция уже обработана';
  return 'Сначала заверши текущее исправление';
}

/** Exact duplicate: bind the bank transaction to the existing expense silently. */
async function autoLinkExactDuplicate(
  ctx: Ctx['CallbackQuery'],
  txId: number,
  claimed: BankTransaction,
  groupId: number,
  existing: Expense,
): Promise<void> {
  mergeTransactionWithExpense(claimed, groupId, existing.id);
  database.bankTransactions.setEditInProgress(txId, false);

  await ctx.answerCallbackQuery({ text: '✅ Связано с существующим расходом' });
  const messageId = ctx.message?.id;
  if (messageId) {
    await editMessageText(
      messageId,
      `✅ Связано: ${existing.category} (${formatAmount(existing.amount, existing.currency)})`,
    );
  }
}

/** Fuzzy duplicate: show a link-or-new prompt — let the user decide. */
async function promptFuzzyDuplicate(
  ctx: Ctx['CallbackQuery'],
  txId: number,
  claimed: BankTransaction,
  match: Expense,
): Promise<void> {
  const commentPart = match.comment ? ` — ${match.comment}` : '';
  await ctx.answerCallbackQuery();

  await sendMessage(
    `🔄 Найден похожий расход:\n📅 ${match.date} | ${match.amount} ${match.currency} | ${match.category}${commentPart}\n\nСвязать или создать новый?`,
    {
      ...replyParametersFor(claimed),
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
}

/** Matching receipt (same amount ±5%, date, currency): offer to link the receipt instead. */
async function promptReceiptMatch(
  ctx: Ctx['CallbackQuery'],
  txId: number,
  claimed: BankTransaction,
  receiptMatch: Receipt,
): Promise<void> {
  const receiptExpenses = database.receipts.findExpensesByReceiptId(receiptMatch.id);
  const categorySummary = receiptExpenses.map((e) => e.category).join(', ') || 'без категорий';
  await ctx.answerCallbackQuery();

  await sendMessage(
    `🧾 Найден чек на ${formatAmount(receiptMatch.total_amount, receiptMatch.currency)} от ${receiptMatch.date}\n📋 Категории: ${categorySummary}\n\nСвязать транзакцию с чеком или создать новый расход?`,
    {
      ...replyParametersFor(claimed),
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
}

/** No duplicates — ask the user to enter a comment or skip it. */
async function askForComment(
  ctx: Ctx['CallbackQuery'],
  txId: number,
  tx: BankTransaction,
): Promise<void> {
  database.bankTransactions.setAwaitingComment(txId, true);
  await ctx.answerCallbackQuery();

  const promptMsg = await sendMessage(
    `💬 Добавь комментарий к расходу или нажми «Без комментария».`,
    {
      ...replyParametersFor(tx),
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

export async function handleBankConfirmCallback(
  ctx: Ctx['CallbackQuery'],
  txId: number,
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  if (!(await findCallbackUser(ctx))) return;

  const claimed = claimPendingTransaction(txId, group.id);
  if (claimed === null || claimed === false || claimed === 'edit') {
    await ctx.answerCallbackQuery({ text: claimFailureText(claimed) });
    return;
  }

  // Check for duplicate expenses before asking for a comment.
  const { exact, fuzzy } = database.expenses.findPotentialDuplicates(
    group.id,
    claimed.date,
    claimed.amount,
    claimed.currency,
  );

  const exactMatch = exact[0];
  if (exactMatch) {
    await autoLinkExactDuplicate(ctx, txId, claimed, group.id, exactMatch);
    return;
  }

  const fuzzyMatch = fuzzy[0];
  if (fuzzyMatch) {
    await promptFuzzyDuplicate(ctx, txId, claimed, fuzzyMatch);
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
    await promptReceiptMatch(ctx, txId, claimed, receiptMatch);
    return;
  }

  await askForComment(ctx, txId, claimed);
}

/**
 * Handles "Связать" button — links bank transaction to an existing expense.
 */
export async function handleBankMergeCallback(
  ctx: Ctx['CallbackQuery'],
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

    // Block if another bank_tx already claims this expense directly,
    // or via the expense's parent receipt (Variant A: receipt-linked txs only
    // set matched_receipt_id, so we must check that path too).
    const alreadyLinked = database.queryOne<{ n: number }>(
      `SELECT COUNT(*) as n FROM bank_transactions
       WHERE matched_expense_id = ?
          OR (matched_receipt_id IS NOT NULL AND matched_receipt_id = ?)`,
      expenseId,
      expense.receipt_id ?? -1,
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
    await editMessageText(
      messageId,
      `✅ Связано: ${expense.category} (${formatAmount(expense.amount, expense.currency)})`,
    );
  }
}

/**
 * Handles "Связать с чеком" button — links bank transaction to all expenses from a receipt.
 */
export async function handleBankReceiptCallback(
  ctx: Ctx['CallbackQuery'],
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

    const receiptExpenses = database.receipts.findExpensesByReceiptId(receiptId);
    if (receiptExpenses.length === 0) return 'no_expenses' as const;

    // 1:N link — bank_tx → receipt → N expenses (via expenses.receipt_id).
    // We set matched_receipt_id only; matched_expense_id stays null because
    // a single FK cannot express the receipt's multi-expense relationship.
    database.bankTransactions.updateStatus(tx.id, group.id, 'confirmed');
    database.bankTransactions.setMatchedReceipt(tx.id, group.id, receiptId);
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
    await editMessageText(
      messageId,
      `✅ Связано с чеком: ${formatAmount(receipt.total_amount, receipt.currency)} (${categorySummary})`,
    );
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

  await askForComment(ctx, txId, tx);
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

  const promptMsg = await sendMessage(
    `✏️ Ответь на это сообщение и напиши что исправить.\n\nФормат: категория — комментарий\nИли только категория.`,
    replyParametersFor(tx),
  );
  // Store the prompt's message_id so handleBankEditReply can verify the reply is to this message
  if (promptMsg?.message_id) {
    database.bankTransactions.setTelegramMessageId(txId, promptMsg.message_id);
  }
}

/** Find the transaction with edit_in_progress=1 that the user is replying to. */
function findTransactionBeingEdited(
  groupId: number,
  replyToMessageId: number,
): BankTransaction | null {
  for (const conn of database.bankConnections.findActiveByGroupId(groupId)) {
    const pending = database.bankTransactions.findPendingByConnectionId(conn.id);
    const editTx = pending.find(
      (t) => t.edit_in_progress === 1 && t.telegram_message_id === replyToMessageId,
    );
    if (editTx) return editTx;
  }
  return null;
}

/** Split the user's reply into category and comment depending on which flow asked for it. */
function parseEditReply(
  editTx: BankTransaction,
  text: string,
): { category: string; comment: string } {
  if (editTx.awaiting_comment === 1) {
    // "Принять" flow: user types a comment; category comes from pre-fill
    return {
      category:
        editTx.prefill_category ?? editTx.merchant_normalized ?? editTx.merchant ?? 'прочее',
      comment: text.trim(),
    };
  }
  // "Исправить" flow: user types "категория — комментарий"
  const parts = text.split('—').map((s) => s.trim());
  return {
    category: parts[0] ?? 'прочее',
    comment: parts[1] ?? editTx.merchant_normalized ?? editTx.merchant ?? '',
  };
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

  const editTx = findTransactionBeingEdited(group.id, replyToMessageId);
  if (!editTx) return false;

  const user = database.users.findByTelegramId(ctx.from.id);
  if (!user) {
    database.bankTransactions.setEditInProgress(editTx.id, false);
    database.bankTransactions.setAwaitingComment(editTx.id, false);
    return false;
  }

  const { category, comment } = parseEditReply(editTx, text);

  saveConfirmedTransaction(editTx, group.id, user.id, category, comment);
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
  txId: number,
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  const user = await findCallbackUser(ctx);
  if (!user) return;

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
    await editMessageText(
      messageId,
      `✅ Записано: ${category} (${formatAmount(tx.amount, tx.currency)})`,
    );
  }
}

/**
 * Link a bank transaction to an existing expense without creating a new one.
 */
function mergeTransactionWithExpense(
  tx: BankTransaction,
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
  tx: BankTransaction,
  groupId: number,
  userId: number,
  category: string,
  comment: string,
): void {
  const txCurrency = tx.currency as CurrencyCode;
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
