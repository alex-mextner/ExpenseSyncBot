/** Text message handler — parses expense messages, handles receipt links, and routes AI mentions */
import { BASE_CURRENCY, type CurrencyCode, MESSAGES } from '../../config/constants';
import { env } from '../../config/env';
import { database } from '../../database';
import type { Group, PhotoQueueItem, ReceiptItem } from '../../database/types';
import { createInviteLink, sendMessage } from '../../services/bank/telegram-sender';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import { parseExpenseMessage, validateParsedExpense } from '../../services/currency/parser';
import { DevTaskState } from '../../services/dev-pipeline/types';
import { extractURLsFromText, processPaymentLinks } from '../../services/receipt/link-analyzer';
import type { ReceiptSummary } from '../../services/receipt/receipt-summarizer';
import { digitEmoji, setExpenseReaction } from '../../utils/digit-emoji';
import { getErrorMessage } from '../../utils/error';
import { findBestCategoryMatch } from '../../utils/fuzzy-search';
import { escapeHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { maybeSmartAdvice } from '../commands/ask';
import { consumePendingDesignEdit, getPipelineInstance } from '../commands/dev';
import { consumePendingFeedback, submitFeedback } from '../commands/feedback';
import { createCategoryConfirmKeyboard } from '../keyboards';
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

/**
 * Handle expense message
 */
export async function handleExpenseMessage(
  ctx: Ctx['Message'],
  bot: BotInstance,
): Promise<boolean> {
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
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

  if (!isGroup) {
    logger.info(`[MSG] Message from private chat (user ${telegramId})`);
    await sendPrivateChatRedirect(telegramId);
    return true;
  }

  const telegramGroupId = ctx.chat.id;
  const groupTitle = ctx.chat.title;

  logger.info(`[MSG] Message from group "${groupTitle}" (${telegramGroupId})`);

  // Get or create group
  const group = database.groups.findByTelegramGroupId(telegramGroupId);

  if (!group) {
    // Group not set up yet
    logger.info(`[MSG] Ignoring: group ${telegramGroupId} not found in database`);
    await sendMessage(`Группа не настроена. Для настройки используй команду /connect`);
    return true;
  }

  // Custom currency input during onboarding — must be checked before setup completion
  if (text && !text.startsWith('/')) {
    const { isAwaitingCustomCurrency, handleCustomCurrencyInput } = await import(
      '../commands/connect'
    );
    if (isAwaitingCustomCurrency(telegramGroupId)) {
      return await handleCustomCurrencyInput(ctx, telegramGroupId);
    }
  }

  // Bank setup wizard — consume credential input before other checks
  if (text && !text.startsWith('/')) {
    const { handleWizardInput } = await import('../commands/bank');
    const handled = await handleWizardInput(ctx, group.id, text, bot);
    if (handled) return true;
  }

  // Check if group has completed setup
  if (!database.groups.hasCompletedSetup(telegramGroupId)) {
    logger.info(`[MSG] Ignoring: group ${telegramGroupId} setup not completed`);
    await sendMessage('Завершите настройку группы: /connect');
    return true;
  }

  // Bank OTP — must be checked before topic restriction: the user may reply from any topic
  // (the OTP prompt could land in a different thread than active_topic_id).
  if (text && !text.startsWith('/')) {
    const { resolveOtpForGroup } = await import('../../services/bank/otp-manager');
    if (resolveOtpForGroup(telegramGroupId, text)) return true;
  }

  // Check topic restriction
  const messageThreadId = ctx.update?.message?.message_thread_id;
  if (group.active_topic_id && messageThreadId !== group.active_topic_id) {
    logger.info(
      `[MSG] Ignoring: message from topic ${messageThreadId || 'general'}, bot listens to topic ${group.active_topic_id}`,
    );
    return true;
  }

  logger.info(`[MSG] Group ${group.id} found, default currency: ${group.default_currency}`);

  // Get or create user
  let user = database.users.findByTelegramId(telegramId);

  if (!user) {
    logger.info(`[MSG] Creating new user ${telegramId} in group ${group.id}`);
    user = database.users.create({
      telegram_id: telegramId,
      group_id: group.id,
    });
  } else if (user.group_id !== group.id) {
    // Update user's group_id if changed
    logger.info(`[MSG] Updating user ${telegramId} group_id: ${user.group_id} → ${group.id}`);
    database.users.update(telegramId, { group_id: group.id });
    user = database.users.findByTelegramId(telegramId);
    if (!user) return true;
  }

  // Track group title and user membership for private chat redirect buttons
  if (groupTitle && groupTitle !== group.title) {
    database.groups.update(telegramGroupId, { title: groupTitle });
  }
  trackMembership(telegramId, group.id);

  // Check if we're waiting for design edit or code edit input
  const pendingTaskId = consumePendingDesignEdit(telegramGroupId);
  if (pendingTaskId !== null) {
    const pl = getPipelineInstance();
    if (pl) {
      try {
        const pendingTask = database.devTasks.findById(pendingTaskId);
        const isCodeEdit =
          pendingTask?.state === DevTaskState.AWAITING_REVIEW ||
          pendingTask?.state === DevTaskState.AWAITING_MERGE;

        if (isCodeEdit) {
          await pl.editPR(pendingTaskId, text);
        } else {
          await pl.editDesign(pendingTaskId, text);
        }
      } catch (error) {
        await sendMessage(getErrorMessage(error));
      }
    }
    return true;
  }

  // Check if we're waiting for feedback text input
  const feedbackPromptId = consumePendingFeedback(telegramGroupId, telegramId);
  if (feedbackPromptId !== null) {
    await submitFeedback(ctx, group, text, { promptMessageId: feedbackPromptId, bot });
    return true;
  }

  // Check if we're waiting for bulk correction text input
  const waitingBulkCorrection = database.photoQueue.findWaitingForBulkCorrection(group.id);
  if (waitingBulkCorrection) {
    await handleBulkCorrectionInput(text, waitingBulkCorrection, group);
    return true;
  }

  // Check if we're waiting for category text input from user
  const waitingItem = database.receiptItems.findWaitingForCategoryInput(group.id);
  if (waitingItem) {
    await handleCategoryTextInput(ctx, text, waitingItem, group.id);
    return true;
  }

  // Bank transaction edit flow — route replies to pending edit transactions
  const replyToMessageId = ctx.update?.message?.reply_to_message?.message_id;
  if (replyToMessageId && text) {
    const { handleBankEditReply } = await import('../commands/bank');
    const handled = await handleBankEditReply(ctx, telegramGroupId, text, replyToMessageId);
    if (handled) return true;
  }

  // Check for URLs in message
  const urls = extractURLsFromText(text);
  if (urls.length > 0) {
    const hasPayment = await processPaymentLinks(
      bot,
      telegramGroupId,
      messageId,
      urls,
      group,
      user,
    );
    if (hasPayment) return true;
  }

  // Split message by lines and process each line
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line);

  logger.info(`[MSG] Processing ${lines.length} line(s)`);

  const newCategories: string[] = [];
  const categoryNames = database.categories.getCategoryNames(group.id);

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
  const processedExpenses: ProcessedExpense[] = [];

  // ── Phase 1: parse all lines and create pending expenses (no network) ──

  for (const [index, line] of lines.entries()) {
    logger.info(`[MSG] Processing line ${index + 1}/${lines.length}: "${line}"`);

    const parsed = parseExpenseMessage(line, group.default_currency);

    if (!parsed) {
      logger.info(`[MSG] ❌ Line ${index + 1}: failed to parse`);
      continue;
    }

    logger.info(
      {
        data: {
          amount: parsed.amount,
          currency: parsed.currency,
          category: parsed.category,
          comment: parsed.comment,
        },
      },
      `[MSG] Line ${index + 1} parsed`,
    );

    if (!validateParsedExpense(parsed)) {
      logger.info(`[MSG] ❌ Line ${index + 1}: validation failed`);
      continue;
    }

    // Check if category exists: exact match first, then fuzzy
    let categoryExists = parsed.category
      ? database.categories.exists(group.id, parsed.category)
      : false;

    if (!categoryExists && parsed.category) {
      const fuzzyMatch = findBestCategoryMatch(parsed.category, categoryNames);
      if (fuzzyMatch) {
        logger.info(
          `[MSG] Line ${index + 1}: fuzzy matched "${parsed.category}" → "${fuzzyMatch}"`,
        );
        parsed.category = fuzzyMatch;
        categoryExists = true;
      }
    }

    logger.info(`[MSG] Line ${index + 1}: category "${parsed.category}" exists: ${categoryExists}`);

    const pendingExpense = database.pendingExpenses.create({
      user_id: user.id,
      message_id: messageId,
      parsed_amount: parsed.amount,
      parsed_currency: parsed.currency,
      detected_category: parsed.category,
      comment: parsed.comment,
      status: categoryExists || !parsed.category ? 'confirmed' : 'pending_category',
    });

    logger.info(`[MSG] Line ${index + 1}: created pending expense ${pendingExpense.id}`);

    if (!categoryExists && parsed.category && !newCategories.includes(parsed.category)) {
      newCategories.push(parsed.category);
    }

    processedExpenses.push({
      amount: parsed.amount,
      currency: parsed.currency,
      category: parsed.category,
      comment: parsed.comment,
      saved: false,
      pendingExpenseId: pendingExpense.id,
      categoryExists: categoryExists || !parsed.category,
    });
  }

  // ── Phase 2: set 👀 reaction immediately (fire-and-forget, no await) ──

  const hasProcessedExpenses =
    processedExpenses.some((e) => e.categoryExists) || newCategories.length > 0;

  if (hasProcessedExpenses) {
    bot.api
      .setMessageReaction({
        chat_id: telegramGroupId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji: '👀' }],
      })
      .catch((error) => {
        logger.error({ err: error }, '[MSG] Failed to set 👀 reaction');
      });
  }

  // ── Phase 3: save confirmed expenses atomically (all sheets → one DB transaction) ──

  const confirmedIds = processedExpenses
    .filter((e) => e.categoryExists)
    .map((e) => e.pendingExpenseId);
  let batchError: unknown = null;

  if (confirmedIds.length > 0) {
    try {
      await saveExpenseBatch(user.id, group.id, confirmedIds);
      for (const exp of processedExpenses) {
        if (exp.categoryExists) exp.saved = true;
      }
    } catch (error) {
      logger.error({ err: error }, '[MSG] Batch save failed — no expenses committed');
      for (const id of confirmedIds) {
        database.pendingExpenses.delete(id);
      }
      batchError = error;
    }
  }

  // ── Phase 4: replace 👀 with final reaction ──

  if (confirmedIds.length > 0) {
    try {
      if (!batchError) {
        await setExpenseReaction(bot, telegramGroupId, messageId, processedExpenses.length);
      } else {
        await bot.api.setMessageReaction({
          chat_id: telegramGroupId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji: '👎' }],
        });
      }
    } catch (error) {
      logger.error({ err: error }, '[MSG] Failed to set final reaction');
    }
  }

  if (batchError) {
    await sendMessage(getSheetErrorMessage(batchError));
  }

  // Send numbered summary when multiple expenses recognized
  if (processedExpenses.length > 1) {
    const summaryLines = processedExpenses.map((exp, i) => {
      const num = digitEmoji(i + 1);
      const amount = formatAmount(exp.amount, exp.currency);
      const cat = escapeHtml(exp.category ?? '');
      const comment = exp.comment ? ` — ${escapeHtml(exp.comment)}` : '';
      const status = exp.saved ? '' : ' ❓';
      return `${num} ${amount} ${cat}${comment}${status}`;
    });
    await sendMessage(summaryLines.join('\n'));
  }

  // If there are new categories, ask for confirmation
  if (newCategories.length > 0) {
    logger.info(`[MSG] Asking for confirmation of ${newCategories.length} new categories`);
    for (const category of newCategories) {
      const keyboard = createCategoryConfirmKeyboard(category);
      await sendMessage(MESSAGES.newCategoryDetected.replace('{category}', category), {
        reply_markup: keyboard,
      });
    }
    return true;
  }

  logger.info(`[MSG] ✅ Processed ${confirmedIds.length}/${lines.length} expenses successfully`);

  if (hasProcessedExpenses) {
    await maybeSmartAdvice(group.id);
  }

  return hasProcessedExpenses;
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
  const { findBestCategoryMatch, normalizeCategoryName } = await import('../../utils/fuzzy-search');

  logger.info(
    `[CATEGORY_INPUT] User provided category: "${categoryText}" for item ${waitingItem.id}`,
  );

  // Normalize category name
  const normalizedCategory = normalizeCategoryName(categoryText);

  // Get all existing categories for this group
  const allCategories = database.categories.findByGroupId(groupId);
  const categoryNames = allCategories.map((c) => c.name);

  // Try to find best match
  const bestMatch = findBestCategoryMatch(normalizedCategory, categoryNames);

  if (bestMatch) {
    // Check if exact match - use it automatically
    if (bestMatch.toLowerCase() === normalizedCategory.toLowerCase()) {
      logger.info(`[CATEGORY_INPUT] Exact match found: "${bestMatch}", using automatically`);

      // Update item with found category
      database.receiptItems.update(waitingItem.id, {
        status: 'confirmed',
        confirmed_category: bestMatch,
        waiting_for_category_input: 0,
      });

      await sendMessage(`✅ Используется категория: <b>${bestMatch}</b>`);

      // Check if all items are confirmed
      const allItems = database.receiptItems.findByPhotoQueueId(waitingItem.photo_queue_id);
      const allConfirmed = allItems.every((i) => i.status === 'confirmed');

      if (allConfirmed) {
        // Save all items

        const user = database.users.findByTelegramId(ctx.from.id);
        if (user) {
          const group = database.groups.findById(groupId);
          if (group) {
            await saveReceiptExpenses(waitingItem.photo_queue_id, groupId, user.id);
          }
        }
      } else {
        // Show next pending item
        const { showNextItemForConfirmation } = await import(
          '../../services/receipt/photo-processor'
        );
        await showNextItemForConfirmation(groupId, waitingItem.photo_queue_id);
      }

      return;
    }

    // Found similar but not exact match - ask user to confirm
    logger.info(`[CATEGORY_INPUT] Found similar category: "${bestMatch}"`);

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: `✅ Использовать "${bestMatch}"`,
            callback_data: `use_found_category:${waitingItem.id}:${bestMatch}`,
          },
        ],
        [
          {
            text: `❌ Создать новую "${normalizedCategory}"`,
            callback_data: `create_new_category:${waitingItem.id}:${normalizedCategory}`,
          },
        ],
      ],
    };

    await sendMessage(`Найдена похожая категория: <b>${bestMatch}</b>\n\nВыберите действие:`, {
      reply_markup: keyboard,
    });
  } else {
    // No match found - create new category directly
    logger.info(
      `[CATEGORY_INPUT] No similar category found, creating new: "${normalizedCategory}"`,
    );

    // Reset waiting flag
    database.receiptItems.update(waitingItem.id, {
      status: 'confirmed',
      confirmed_category: normalizedCategory,
      waiting_for_category_input: 0,
    });

    // Create category if doesn't exist
    if (!database.categories.exists(groupId, normalizedCategory)) {
      database.categories.create({
        group_id: groupId,
        name: normalizedCategory,
      });
    }

    await sendMessage(`✅ Создана новая категория: <b>${normalizedCategory}</b>`);

    // Check if all items are confirmed (categories will be collected dynamically in showNextItemForConfirmation)
    const allItems = database.receiptItems.findByPhotoQueueId(waitingItem.photo_queue_id);
    const allConfirmed = allItems.every((i) => i.status === 'confirmed');

    if (allConfirmed) {
      // Save all items
      const user = database.users.findByTelegramId(ctx.from.id);
      if (user) {
        const group = database.groups.findById(groupId);
        if (group) {
          await saveReceiptExpenses(waitingItem.photo_queue_id, groupId, user.id);
        }
      }
    } else {
      // Show next pending item
      const { showNextItemForConfirmation } = await import(
        '../../services/receipt/photo-processor'
      );
      await showNextItemForConfirmation(groupId, waitingItem.photo_queue_id);
    }
  }
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

  logger.info(`[BULK_CORRECTION] User correction: "${correctionText}" for queue ${queueItem.id}`);

  // Immediately respond that we're processing
  await sendMessage('⏳ Корректирую...');

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
    // Apply correction using AI
    const newSummary = await applyCorrectionWithAI(
      currentSummary,
      correctionText,
      availableCategories,
      correctionHistory,
    );

    // Validate totals match (±1%)
    const originalTotal = items.reduce((sum, i) => sum + i.total, 0);
    if (!validateSummaryTotals(newSummary, originalTotal)) {
      await sendMessage(
        '❌ Суммы не сходятся. AI изменил суммы товаров, что недопустимо.\n\n' +
          'Попробуйте переформулировать корректировку. Например:\n' +
          '<code>перенеси салфетки в Хозтовары</code>',
      );
      return;
    }

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
    await sendMessage(
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
  budget: { limit_amount: number; currency: string },
): { spentInCurrency: number; percentage: number; isExceeded: boolean; isWarning: boolean } {
  const spentInCurrency = convertCurrency(spentEur, BASE_CURRENCY, budget.currency as CurrencyCode);
  const percentage =
    budget.limit_amount > 0 ? Math.round((spentInCurrency / budget.limit_amount) * 100) : 0;
  const isExceeded = spentInCurrency > budget.limit_amount;
  const isWarning = percentage >= 90 && !isExceeded;
  return { spentInCurrency, percentage, isExceeded, isWarning };
}
