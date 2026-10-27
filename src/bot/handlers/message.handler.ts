/** Text message handler — parses expense messages, handles receipt links, and routes AI mentions */
import { BASE_CURRENCY, type CurrencyCode } from '../../config/constants';
import { env } from '../../config/env';
import { database } from '../../database';
import { computeBudgetProgress } from '../../database/repositories/budget.repository';
import type { Group, PhotoQueueItem, ReceiptItem, User } from '../../database/types';
import { createInviteLink, sendMessage } from '../../services/bank/telegram-sender';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import {
  type ParsedExpense,
  parseExpenseMessage,
  validateParsedExpense,
} from '../../services/currency/parser';
import { DevTaskState } from '../../services/dev-pipeline/types';
import { extractURLsFromText, processPaymentLinks } from '../../services/receipt/link-analyzer';
import type { ReceiptSummary } from '../../services/receipt/receipt-summarizer';
import { digitEmoji, setExpenseReaction } from '../../utils/digit-emoji';
import { getErrorMessage } from '../../utils/error';
import { findBestCategoryMatchAsync } from '../../utils/fuzzy-search';
import { escapeHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { maybeSmartAdvice } from '../commands/ask';
import { consumePendingDesignEdit, getPipelineInstance } from '../commands/dev';
import { consumePendingFeedback, submitFeedback } from '../commands/feedback';
import { showNextPendingCategoryStep } from '../services/category-wizard';
import { saveExpenseBatch, saveReceiptExpenses } from '../services/expense-saver';
import { getSheetErrorMessage } from '../services/sheet-errors';
import type { BotInstance, Ctx } from '../types';

const logger = createLogger('message.handler');

/** Recently-seen user+group pairs — skip redundant DB upserts */
const recentMemberships = new Set<string>();

/** Track user membership in a group, skipping DB write if recently seen */
export function trackMembership(telegramId: number, groupId: number): void {
  const key = `${telegramId}:${groupId}`;
  if (recentMemberships.has(key)) return;
  database.groupMembers.upsert(telegramId, groupId);
  recentMemberships.add(key);
}

/** Build a fallback Telegram deep link (opens in browser on some platforms) */
function buildGroupDeepLink(telegramGroupId: number): string {
  const idStr = telegramGroupId.toString();
  const chatId = idStr.startsWith('-100') ? idStr.slice(4) : idStr.slice(1);
  return `https://t.me/c/${chatId}`;
}

/** In-flight invite link requests — prevents duplicate API calls for the same group */
const pendingInviteLinks = new Map<number, Promise<string | null>>();

/** Lazily fetch and cache a group's invite link via Bot API */
async function getOrFetchInviteLink(
  telegramGroupId: number,
  cachedLink: string | null,
): Promise<string | null> {
  if (cachedLink) return cachedLink;

  // Deduplicate concurrent fetches for the same group
  const pending = pendingInviteLinks.get(telegramGroupId);
  if (pending) return pending;

  const promise = createInviteLink(telegramGroupId)
    .then((link) => {
      if (link) {
        database.groups.update(telegramGroupId, { invite_link: link });
      }
      return link;
    })
    .catch((error) => {
      logger.warn({ err: error, telegramGroupId }, 'Failed to fetch invite link');
      return null;
    })
    .finally(() => {
      pendingInviteLinks.delete(telegramGroupId);
    });
  pendingInviteLinks.set(telegramGroupId, promise);
  return promise;
}

/** Send redirect message to user in private chat with buttons to their groups */
export async function sendPrivateChatRedirect(telegramId: number): Promise<void> {
  const groups = database.groupMembers.findGroupsByTelegramId(telegramId);

  if (groups.length > 0) {
    // Resolve invite links for each group (invite links open natively in Telegram)
    const buttons = await Promise.all(
      groups.map(async (g) => {
        const inviteLink = await getOrFetchInviteLink(g.telegramGroupId, g.inviteLink);
        return [
          {
            text: g.title || 'Группа',
            url: inviteLink || buildGroupDeepLink(g.telegramGroupId),
          },
        ];
      }),
    );

    await sendMessage('💬 Бот работает только в группах.\n\nДля учета расходов перейди в группу:', {
      reply_markup: { inline_keyboard: buttons },
    });
  } else {
    await sendMessage('💬 Бот работает только в группах.');
    await sendMessage(
      `<b>Как начать:</b>\n\n` +
        `1. Создай группу в Telegram\n` +
        `2. Добавь @${env.BOT_USERNAME} в группу\n` +
        `3. Набери /connect для настройки`,
    );
  }
}

/** Message in a configured group chat, resolved from the raw Telegram context */
interface GroupMessage {
  ctx: Ctx['Message'];
  bot: BotInstance;
  telegramId: number;
  messageId: number;
  text: string;
  telegramGroupId: number;
  groupTitle: string | undefined;
  group: Group;
}

/** Group message with the sender resolved to a bot user */
interface UserMessage extends GroupMessage {
  user: User;
}

/**
 * One step of the message routing pipeline. Returns the handler result when the step
 * consumed the message, or null to let the next step look at it.
 */
type MessageStage<M> = (msg: M) => Promise<boolean | null>;

/** Run stages in order; the first non-null result wins */
async function runStages<M>(stages: Array<MessageStage<M>>, msg: M): Promise<boolean | null> {
  for (const stage of stages) {
    const result = await stage(msg);
    if (result !== null) return result;
  }
  return null;
}

/** Tracks each recognized expense for the numbered summary */
interface ProcessedExpense {
  amount: number;
  currency: string;
  category: string | null;
  comment: string;
  saved: boolean;
  pendingExpenseId: number;
  categoryExists: boolean;
}

/** Result of phase 1: pending expenses created for every line plus categories to confirm */
interface PendingBatch {
  processedExpenses: ProcessedExpense[];
  newCategories: string[];
}

/** Group chat identity read from the Telegram context */
interface GroupChat {
  telegramGroupId: number;
  title: string | undefined;
}

function readGroupChat(ctx: Ctx['Message']): GroupChat | null {
  const chat = ctx.chat;
  if (chat?.type === 'group' || chat?.type === 'supergroup') {
    return { telegramGroupId: chat.id, title: chat.title };
  }
  return null;
}

/**
 * Validate the raw message, redirect private chats and look up the group.
 * Returns the resolved message, or the handler result when nothing more should happen.
 */
async function resolveGroupMessage(
  ctx: Ctx['Message'],
  bot: BotInstance,
): Promise<GroupMessage | boolean> {
  const telegramId = ctx.from.id;
  const messageId = ctx.id;
  const text = ctx.text;
  const username = ctx.from.username || ctx.from.firstName || 'Unknown';

  logger.info(`[MSG] Received message from user ${username} (${telegramId}): "${text}"`);

  if (!telegramId || !messageId || !text) {
    logger.info(`[MSG] Ignoring: missing telegramId, messageId or text`);
    return true;
  }

  // Check if message is from group/supergroup
  const chat = readGroupChat(ctx);

  if (!chat) {
    logger.info(`[MSG] Message from private chat (user ${telegramId})`);
    await sendPrivateChatRedirect(telegramId);
    return true;
  }

  const { telegramGroupId, title: groupTitle } = chat;

  logger.info(`[MSG] Message from group "${groupTitle}" (${telegramGroupId})`);

  // Get or create group
  const group = database.groups.findByTelegramGroupId(telegramGroupId);

  if (!group) {
    // Group not set up yet
    logger.info(`[MSG] Ignoring: group ${telegramGroupId} not found in database`);
    await sendMessage(`Группа не настроена. Для настройки используй команду /connect`);
    return true;
  }

  return { ctx, bot, telegramId, messageId, text, telegramGroupId, groupTitle, group };
}

/** Custom currency input during onboarding — must be checked before setup completion */
async function consumeCustomCurrencyInput(msg: GroupMessage): Promise<boolean | null> {
  if (msg.text.startsWith('/')) return null;
  const { isAwaitingCustomCurrency, handleCustomCurrencyInput } = await import(
    '../commands/connect'
  );
  if (isAwaitingCustomCurrency(msg.telegramGroupId)) {
    return await handleCustomCurrencyInput(msg.ctx, msg.telegramGroupId);
  }
  return null;
}

/** Bank setup wizard — consume credential input before other checks */
async function consumeBankWizardInput(msg: GroupMessage): Promise<boolean | null> {
  if (msg.text.startsWith('/')) return null;
  const { handleWizardInput } = await import('../commands/bank');
  const handled = await handleWizardInput(msg.ctx, msg.group.id, msg.text, msg.bot);
  return handled ? true : null;
}

/** Ignore everything until the group has completed /connect setup */
async function requireCompletedSetup(msg: GroupMessage): Promise<boolean | null> {
  if (database.groups.hasCompletedSetup(msg.telegramGroupId)) return null;
  logger.info(`[MSG] Ignoring: group ${msg.telegramGroupId} setup not completed`);
  await sendMessage('Завершите настройку группы: /connect');
  return true;
}

/**
 * Bank OTP — must be checked before topic restriction: the user may reply from any topic
 * (the OTP prompt could land in a different thread than active_topic_id).
 */
async function consumeBankOtp(msg: GroupMessage): Promise<boolean | null> {
  if (msg.text.startsWith('/')) return null;
  const { resolveOtpForGroup } = await import('../../services/bank/otp-manager');
  return resolveOtpForGroup(msg.telegramGroupId, msg.text) ? true : null;
}

/** Ignore messages outside the topic the bot listens to */
async function enforceActiveTopic(msg: GroupMessage): Promise<boolean | null> {
  const messageThreadId = msg.ctx.update?.message?.message_thread_id;
  if (!msg.group.active_topic_id || messageThreadId === msg.group.active_topic_id) return null;
  logger.info(
    `[MSG] Ignoring: message from topic ${messageThreadId || 'general'}, bot listens to topic ${msg.group.active_topic_id}`,
  );
  return true;
}

/** Steps that decide whether a group message is for the bot at all (before any user lookup) */
const GROUP_GATE_STAGES: Array<MessageStage<GroupMessage>> = [
  consumeCustomCurrencyInput,
  consumeBankWizardInput,
  requireCompletedSetup,
  consumeBankOtp,
  enforceActiveTopic,
];

/** Find the sender's user row, creating it or moving it to this group as needed */
function findOrCreateUser(telegramId: number, group: Group): User | null {
  const user = database.users.findByTelegramId(telegramId);

  if (!user) {
    logger.info(`[MSG] Creating new user ${telegramId} in group ${group.id}`);
    return database.users.create({
      telegram_id: telegramId,
      group_id: group.id,
    });
  }

  if (user.group_id === group.id) return user;

  // Update user's group_id if changed
  logger.info(`[MSG] Updating user ${telegramId} group_id: ${user.group_id} → ${group.id}`);
  database.users.update(telegramId, { group_id: group.id });
  return database.users.findByTelegramId(telegramId);
}

/** Track group title and user membership for private chat redirect buttons */
function trackGroupAndMember(msg: GroupMessage): void {
  const { telegramGroupId, groupTitle, group, telegramId } = msg;
  if (groupTitle && groupTitle !== group.title) {
    database.groups.update(telegramGroupId, { title: groupTitle });
  }
  trackMembership(telegramId, group.id);
}

/** Run a pending dev-pipeline design/code edit with the user's text */
async function applyPendingDevEdit(taskId: number, text: string): Promise<void> {
  const pipeline = getPipelineInstance();
  if (!pipeline) return;
  try {
    const pendingTask = database.devTasks.findById(taskId);
    const isCodeEdit =
      pendingTask?.state === DevTaskState.AWAITING_REVIEW ||
      pendingTask?.state === DevTaskState.AWAITING_MERGE;

    if (isCodeEdit) {
      await pipeline.editPR(taskId, text);
    } else {
      await pipeline.editDesign(taskId, text);
    }
  } catch (error) {
    await sendMessage(getErrorMessage(error));
  }
}

/** Waiting for design edit or code edit input */
async function consumeDevEditInput(msg: UserMessage): Promise<boolean | null> {
  const pendingTaskId = consumePendingDesignEdit(msg.telegramGroupId);
  if (pendingTaskId === null) return null;
  await applyPendingDevEdit(pendingTaskId, msg.text);
  return true;
}

/** Waiting for feedback text input */
async function consumeFeedbackInput(msg: UserMessage): Promise<boolean | null> {
  const feedbackPromptId = consumePendingFeedback(msg.telegramGroupId, msg.telegramId);
  if (feedbackPromptId === null) return null;
  await submitFeedback(msg.ctx, msg.group, msg.text, {
    promptMessageId: feedbackPromptId,
    bot: msg.bot,
  });
  return true;
}

/** Waiting for bulk correction text input */
async function consumeBulkCorrectionStage(msg: UserMessage): Promise<boolean | null> {
  const waitingBulkCorrection = database.photoQueue.findWaitingForBulkCorrection(msg.group.id);
  if (!waitingBulkCorrection) return null;
  await handleBulkCorrectionInput(msg.text, waitingBulkCorrection, msg.group);
  return true;
}

/** Waiting for category text input from user */
async function consumeCategoryInputStage(msg: UserMessage): Promise<boolean | null> {
  const waitingItem = database.receiptItems.findWaitingForCategoryInput(msg.group.id);
  if (!waitingItem) return null;
  await handleCategoryTextInput(msg.ctx, msg.text, waitingItem, msg.group.id);
  return true;
}

/** Bank transaction edit flow — route replies to pending edit transactions */
async function consumeBankEditReply(msg: UserMessage): Promise<boolean | null> {
  const replyToMessageId = msg.ctx.update?.message?.reply_to_message?.message_id;
  if (!replyToMessageId) return null;
  const { handleBankEditReply } = await import('../commands/bank');
  const handled = await handleBankEditReply(
    msg.ctx,
    msg.telegramGroupId,
    msg.text,
    replyToMessageId,
  );
  return handled ? true : null;
}

/** Messages containing payment links go to the receipt link analyzer */
async function consumePaymentLinks(msg: UserMessage): Promise<boolean | null> {
  const urls = extractURLsFromText(msg.text);
  if (urls.length === 0) return null;
  const hasPayment = await processPaymentLinks(
    msg.bot,
    msg.telegramGroupId,
    msg.messageId,
    urls,
    msg.group,
    msg.user,
  );
  return hasPayment ? true : null;
}

/** Inputs the bot may be waiting for from this user, in priority order */
const AWAITED_INPUT_STAGES: Array<MessageStage<UserMessage>> = [
  consumeDevEditInput,
  consumeFeedbackInput,
  consumeBulkCorrectionStage,
  consumeCategoryInputStage,
  consumeBankEditReply,
  consumePaymentLinks,
];

/**
 * Parse every non-empty line of the message as an expense.
 *
 * Direct expense entry is intentionally strict and atomic: EVERY non-empty
 * line must match the expense-entry grammar. If even one line is prose
 * (for example a budget-planning instruction followed by amount/category
 * lines), do not persist the parseable tail. Route the whole message to AI.
 * Returns null in that case.
 */
function parseStrictLines(
  text: string,
  defaultCurrency: CurrencyCode,
): { lines: string[]; parsedLines: Array<ParsedExpense | null> } | null {
  // Split message by lines and process each line
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line);

  logger.info(`[MSG] Processing ${lines.length} line(s)`);

  const parsedLines = lines.map((line) => parseExpenseMessage(line, defaultCurrency));
  if (parsedLines.length === 0 || parsedLines.some((parsed) => !validateParsedExpense(parsed))) {
    logger.info('[MSG] Mixed/non-canonical message — routing the whole message to AI');
    return null;
  }
  return { lines, parsedLines };
}

/** Exact category match first, then fuzzy; a fuzzy hit rewrites parsed.category */
async function resolveLineCategory(
  parsed: ParsedExpense,
  groupId: number,
  categoryNames: string[],
  lineNumber: number,
): Promise<boolean> {
  if (!parsed.category) return false;
  if (database.categories.exists(groupId, parsed.category)) return true;

  const fuzzyMatch = await findBestCategoryMatchAsync(parsed.category, categoryNames);
  if (!fuzzyMatch) return false;

  logger.info(`[MSG] Line ${lineNumber}: fuzzy matched "${parsed.category}" → "${fuzzyMatch}"`);
  parsed.category = fuzzyMatch;
  return true;
}

/** Phase 1 for one line: resolve its category and create the pending expense */
async function createPendingExpenseForLine(
  msg: UserMessage,
  parsed: ParsedExpense,
  categoryNames: string[],
  lineNumber: number,
): Promise<ProcessedExpense> {
  logger.info(
    {
      data: {
        amount: parsed.amount,
        currency: parsed.currency,
        category: parsed.category,
        comment: parsed.comment,
      },
    },
    `[MSG] Line ${lineNumber} parsed`,
  );

  const categoryExists = await resolveLineCategory(parsed, msg.group.id, categoryNames, lineNumber);

  logger.info(`[MSG] Line ${lineNumber}: category "${parsed.category}" exists: ${categoryExists}`);

  const pendingExpense = database.pendingExpenses.create({
    user_id: msg.user.id,
    message_id: msg.messageId,
    parsed_amount: parsed.amount,
    parsed_currency: parsed.currency,
    detected_category: parsed.category,
    comment: parsed.comment,
    status: categoryExists || !parsed.category ? 'confirmed' : 'pending_category',
  });

  logger.info(`[MSG] Line ${lineNumber}: created pending expense ${pendingExpense.id}`);

  return {
    amount: parsed.amount,
    currency: parsed.currency,
    category: parsed.category,
    comment: parsed.comment,
    saved: false,
    pendingExpenseId: pendingExpense.id,
    categoryExists: categoryExists || !parsed.category,
  };
}

/** Phase 1: parse all lines and create pending expenses (no network) */
async function createPendingExpenses(
  msg: UserMessage,
  lines: string[],
  parsedLines: Array<ParsedExpense | null>,
): Promise<PendingBatch | null> {
  const newCategories: string[] = [];
  const categoryNames = database.categories.getCategoryNames(msg.group.id);
  const processedExpenses: ProcessedExpense[] = [];

  for (const [index, line] of lines.entries()) {
    logger.info(`[MSG] Processing line ${index + 1}/${lines.length}: "${line}"`);

    const parsed = parsedLines[index];
    if (!parsed) {
      // Indexed-access guard; all-lines validation makes this unreachable.
      return null;
    }

    const processed = await createPendingExpenseForLine(msg, parsed, categoryNames, index + 1);
    processedExpenses.push(processed);

    if (
      !processed.categoryExists &&
      processed.category &&
      !newCategories.includes(processed.category)
    ) {
      newCategories.push(processed.category);
    }
  }

  return { processedExpenses, newCategories };
}

/** Phase 2: set 👀 reaction immediately (fire-and-forget, no await) */
function reactReceived(msg: GroupMessage): void {
  msg.bot.api
    .setMessageReaction({
      chat_id: msg.telegramGroupId,
      message_id: msg.messageId,
      reaction: [{ type: 'emoji', emoji: '👀' }],
    })
    .catch((error) => {
      logger.error({ err: error }, '[MSG] Failed to set 👀 reaction');
    });
}

/**
 * Phase 3: save confirmed expenses atomically (all sheets → one DB transaction).
 * Returns the batch error (pending expenses are deleted then), or null on success.
 */
async function saveConfirmedBatch(
  msg: UserMessage,
  processedExpenses: ProcessedExpense[],
  confirmedIds: number[],
): Promise<unknown> {
  if (confirmedIds.length === 0) return null;

  try {
    await saveExpenseBatch(msg.user.id, msg.group.id, confirmedIds);
    for (const exp of processedExpenses) {
      if (exp.categoryExists) exp.saved = true;
    }
    return null;
  } catch (error) {
    logger.error({ err: error }, '[MSG] Batch save failed — no expenses committed');
    for (const id of confirmedIds) {
      database.pendingExpenses.delete(id);
    }
    return error;
  }
}

/** Phase 4: replace 👀 with the final reaction (digit count, or 👎 after a batch error) */
async function setFinalReaction(
  msg: GroupMessage,
  batchError: unknown,
  expenseCount: number,
): Promise<void> {
  try {
    if (!batchError) {
      await setExpenseReaction(msg.bot, msg.telegramGroupId, msg.messageId, expenseCount);
    } else {
      await msg.bot.api.setMessageReaction({
        chat_id: msg.telegramGroupId,
        message_id: msg.messageId,
        reaction: [{ type: 'emoji', emoji: '👎' }],
      });
    }
  } catch (error) {
    logger.error({ err: error }, '[MSG] Failed to set final reaction');
  }
}

/** Numbered summary of every recognized expense; unsaved ones are flagged ❓ */
function renderExpenseSummary(processedExpenses: ProcessedExpense[]): string {
  return processedExpenses
    .map((exp, i) => {
      const num = digitEmoji(i + 1);
      const amount = formatAmount(exp.amount, exp.currency);
      const cat = escapeHtml(exp.category ?? '');
      const comment = exp.comment ? ` — ${escapeHtml(exp.comment)}` : '';
      const status = exp.saved ? '' : ' ❓';
      return `${num} ${amount} ${cat}${comment}${status}`;
    })
    .join('\n');
}

/** Create, save and report every expense line of a validated message */
async function recordExpenses(
  msg: UserMessage,
  lines: string[],
  parsedLines: Array<ParsedExpense | null>,
): Promise<boolean> {
  const batch = await createPendingExpenses(msg, lines, parsedLines);
  if (!batch) return false;
  const { processedExpenses, newCategories } = batch;

  const hasProcessedExpenses =
    processedExpenses.some((e) => e.categoryExists) || newCategories.length > 0;

  if (hasProcessedExpenses) reactReceived(msg);

  const confirmedIds = processedExpenses
    .filter((e) => e.categoryExists)
    .map((e) => e.pendingExpenseId);
  const batchError = await saveConfirmedBatch(msg, processedExpenses, confirmedIds);

  if (confirmedIds.length > 0) {
    await setFinalReaction(msg, batchError, processedExpenses.length);
  }

  if (batchError) {
    await sendMessage(getSheetErrorMessage(batchError));
  }

  // Send numbered summary when multiple expenses recognized
  if (processedExpenses.length > 1) {
    await sendMessage(renderExpenseSummary(processedExpenses));
  }

  // If there are new categories, show exactly one active wizard step. The callback
  // advances to the next pending category after add/choose/cancel.
  if (newCategories.length > 0) {
    logger.info(
      `[MSG] Starting sequential confirmation for ${newCategories.length} new categories`,
    );
    await showNextPendingCategoryStep(msg.user.id, msg.messageId);
    return true;
  }

  logger.info(`[MSG] ✅ Processed ${confirmedIds.length}/${lines.length} expenses successfully`);

  if (hasProcessedExpenses) {
    await maybeSmartAdvice(msg.group.id);
  }

  return hasProcessedExpenses;
}

/**
 * Handle expense message
 */
export async function handleExpenseMessage(
  ctx: Ctx['Message'],
  bot: BotInstance,
): Promise<boolean> {
  const groupMessage = await resolveGroupMessage(ctx, bot);
  if (typeof groupMessage === 'boolean') return groupMessage;

  const gated = await runStages(GROUP_GATE_STAGES, groupMessage);
  if (gated !== null) return gated;

  const { group, telegramId } = groupMessage;
  logger.info(`[MSG] Group ${group.id} found, default currency: ${group.default_currency}`);

  const user = findOrCreateUser(telegramId, group);
  if (!user) return true;

  trackGroupAndMember(groupMessage);

  const userMessage: UserMessage = { ...groupMessage, user };
  const awaited = await runStages(AWAITED_INPUT_STAGES, userMessage);
  if (awaited !== null) return awaited;

  const strict = parseStrictLines(userMessage.text, group.default_currency);
  if (!strict) return false;

  return await recordExpenses(userMessage, strict.lines, strict.parsedLines);
}

/** Save the receipt's expenses for the Telegram sender, when both user and group exist */
async function saveReceiptExpensesForSender(
  telegramId: number,
  groupId: number,
  photoQueueId: number,
): Promise<void> {
  const user = database.users.findByTelegramId(telegramId);
  if (!user) return;
  const group = database.groups.findById(groupId);
  if (!group) return;
  await saveReceiptExpenses(photoQueueId, groupId, user.id);
}

/** After an item was confirmed: save everything when all items are done, else ask about the next */
async function continueReceiptConfirmation(
  telegramId: number,
  groupId: number,
  photoQueueId: number,
): Promise<void> {
  const allItems = database.receiptItems.findByPhotoQueueId(photoQueueId);
  const allConfirmed = allItems.every((i) => i.status === 'confirmed');

  if (allConfirmed) {
    await saveReceiptExpensesForSender(telegramId, groupId, photoQueueId);
  } else {
    // Show next pending item
    const { showNextItemForConfirmation } = await import('../../services/receipt/photo-processor');
    await showNextItemForConfirmation(groupId, photoQueueId);
  }
}

/** The typed category exactly matches an existing one — use it automatically */
async function useExactCategory(
  ctx: Ctx['Message'],
  waitingItem: ReceiptItem,
  groupId: number,
  category: string,
): Promise<void> {
  logger.info(`[CATEGORY_INPUT] Exact match found: "${category}", using automatically`);

  // Update item with found category
  database.receiptItems.update(waitingItem.id, {
    status: 'confirmed',
    confirmed_category: category,
    waiting_for_category_input: 0,
  });

  await sendMessage(`✅ Используется категория: <b>${category}</b>`);

  await continueReceiptConfirmation(ctx.from.id, groupId, waitingItem.photo_queue_id);
}

/** Found a similar but not identical category — let the user pick */
async function offerSimilarCategory(
  waitingItem: ReceiptItem,
  similarCategory: string,
  typedCategory: string,
): Promise<void> {
  logger.info(`[CATEGORY_INPUT] Found similar category: "${similarCategory}"`);

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: `✅ Использовать "${similarCategory}"`,
          callback_data: `use_found_category:${waitingItem.id}:${similarCategory}`,
        },
      ],
      [
        {
          text: `❌ Создать новую "${typedCategory}"`,
          callback_data: `create_new_category:${waitingItem.id}:${typedCategory}`,
        },
      ],
    ],
  };

  await sendMessage(`Найдена похожая категория: <b>${similarCategory}</b>\n\nВыберите действие:`, {
    reply_markup: keyboard,
  });
}

/** No similar category exists — create the typed one and use it */
async function createCategoryFromInput(
  ctx: Ctx['Message'],
  waitingItem: ReceiptItem,
  groupId: number,
  category: string,
): Promise<void> {
  // No match found - create new category directly
  logger.info(`[CATEGORY_INPUT] No similar category found, creating new: "${category}"`);

  // Reset waiting flag
  database.receiptItems.update(waitingItem.id, {
    status: 'confirmed',
    confirmed_category: category,
    waiting_for_category_input: 0,
  });

  // Create category if doesn't exist
  if (!database.categories.exists(groupId, category)) {
    database.categories.create({
      group_id: groupId,
      name: category,
    });
  }

  await sendMessage(`✅ Создана новая категория: <b>${category}</b>`);

  // Categories are collected dynamically in showNextItemForConfirmation
  await continueReceiptConfirmation(ctx.from.id, groupId, waitingItem.photo_queue_id);
}

/**
 * Handle category text input from user
 */
async function handleCategoryTextInput(
  ctx: Ctx['Message'],
  categoryText: string,
  waitingItem: ReceiptItem,
  groupId: number,
): Promise<void> {
  const { findBestCategoryMatchAsync, normalizeCategoryName } = await import(
    '../../utils/fuzzy-search'
  );

  logger.info(
    `[CATEGORY_INPUT] User provided category: "${categoryText}" for item ${waitingItem.id}`,
  );

  // Normalize category name
  const normalizedCategory = normalizeCategoryName(categoryText);

  // Get all existing categories for this group
  const allCategories = database.categories.findByGroupId(groupId);
  const categoryNames = allCategories.map((c) => c.name);

  // Try to find best match
  const bestMatch = await findBestCategoryMatchAsync(normalizedCategory, categoryNames);

  if (!bestMatch) {
    await createCategoryFromInput(ctx, waitingItem, groupId, normalizedCategory);
    return;
  }

  // Check if exact match - use it automatically
  if (bestMatch.toLowerCase() === normalizedCategory.toLowerCase()) {
    await useExactCategory(ctx, waitingItem, groupId, bestMatch);
    return;
  }

  await offerSimilarCategory(waitingItem, bestMatch, normalizedCategory);
}

/**
 * Handle bulk correction text input from user
 */
async function handleBulkCorrectionInput(
  correctionText: string,
  queueItem: PhotoQueueItem,
  group: Group,
): Promise<void> {
  const {
    buildSummaryFromItems,
    formatSummaryMessage,
    applyCorrectionWithAI,
    validateSummaryTotals,
  } = await import('../../services/receipt/receipt-summarizer');
  const { createBulkEditKeyboard } = await import('../keyboards');
  const { StatusWriter } = await import('../../services/receipt/status-writer');

  logger.info(`[BULK_CORRECTION] User correction: "${correctionText}" for queue ${queueItem.id}`);

  // Status writer — shows live AI progress while correction is applied.
  // JSON output → code mode (escape + <code> wrap).
  const statusWriter = new StatusWriter({
    header: '🤖 Корректирую сводку...',
    mode: 'code',
  });

  // Get receipt items
  const items = database.receiptItems.findByPhotoQueueId(queueItem.id);

  if (items.length === 0) {
    await sendMessage('❌ Товары не найдены');
    return;
  }

  // Build current summary (from AI summary if exists, otherwise from items)
  let currentSummary: ReceiptSummary;
  if (queueItem.ai_summary) {
    try {
      currentSummary = JSON.parse(queueItem.ai_summary);
    } catch {
      currentSummary = buildSummaryFromItems(items);
    }
  } else {
    currentSummary = buildSummaryFromItems(items);
  }

  // Get available categories
  const allCategories = database.categories.findByGroupId(group.id);
  const categoryNames = allCategories.map((c) => c.name);

  // Also add suggested categories from items
  const suggestedCategories = [...new Set(items.map((i) => i.suggested_category))];
  const availableCategories = [...new Set([...categoryNames, ...suggestedCategories])];

  // Parse existing correction history
  let correctionHistory: Array<{ user: string; result: string }> = [];
  if (queueItem.correction_history) {
    try {
      correctionHistory = JSON.parse(queueItem.correction_history);
    } catch {
      // Expected: invalid JSON means no prior corrections
    }
  }

  try {
    // Apply correction using AI — streams live JSON into the status message
    const newSummary = await applyCorrectionWithAI(
      currentSummary,
      correctionText,
      availableCategories,
      correctionHistory,
      (delta) => statusWriter.append(delta),
    );

    // Validate totals match (±1%)
    const originalTotal = items.reduce((sum, i) => sum + i.total, 0);
    if (!validateSummaryTotals(newSummary, originalTotal)) {
      await statusWriter.finalize(
        '❌ Суммы не сходятся. AI изменил суммы товаров, что недопустимо.\n\n' +
          'Попробуйте переформулировать корректировку. Например:\n' +
          '<code>перенеси салфетки в Хозтовары</code>',
      );
      return;
    }

    // Status message served its purpose — delete it, the real result follows
    await statusWriter.close();

    // Add to correction history
    correctionHistory.push({
      user: correctionText,
      result: `Применена корректировка`,
    });

    // Save updated summary and history
    database.photoQueue.update(queueItem.id, {
      ai_summary: JSON.stringify(newSummary),
      correction_history: JSON.stringify(correctionHistory),
    });

    // Format result message
    const summaryText = formatSummaryMessage(newSummary, items.length);
    const message = `${summaryText}\n\n✅ <i>Корректировка применена!</i>`;

    // Always send NEW message with result and buttons
    const sentMessage = await sendMessage(message, {
      reply_markup: createBulkEditKeyboard(queueItem.id),
    });

    // Save message ID for buttons to work
    if (sentMessage) {
      database.photoQueue.update(queueItem.id, {
        summary_message_id: sentMessage.message_id,
      });
    }

    logger.info(`[BULK_CORRECTION] Correction applied successfully`);
  } catch (error) {
    logger.error({ err: error }, '[BULK_CORRECTION] AI correction failed');
    await statusWriter.finalize(
      '❌ Не удалось применить корректировку.\n\n' +
        'Попробуйте переформулировать. Например:\n' +
        '<code>перенеси салфетки в Хозтовары</code>\n' +
        '<code>объедини Еда и Напитки</code>',
    );
  }
}

/**
 * Compute budget alert status for a category.
 * spentEur — total spending in EUR; budget — with limit in budget.currency.
 * Returns spending converted to budget currency, percentage, and alert flags.
 */
export function buildBudgetAlertStatus(
  spentEur: number,
  budget: { category: string; limit_amount: number; currency: string },
): { spentInCurrency: number; percentage: number; isExceeded: boolean; isWarning: boolean } {
  const spentInCurrency = convertCurrency(spentEur, BASE_CURRENCY, budget.currency as CurrencyCode);
  const progress = computeBudgetProgress(budget, spentInCurrency);
  return {
    spentInCurrency,
    percentage: progress.percentage,
    isExceeded: progress.is_exceeded,
    isWarning: progress.is_warning,
  };
}
