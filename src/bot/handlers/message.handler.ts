/** Text message handler — parses expense messages, handles receipt links, and routes AI mentions */
import { BASE_CURRENCY, type CurrencyCode, MESSAGES } from '../../config/constants';
import { database } from '../../database';
import type { Group, PhotoQueueItem, ReceiptItem } from '../../database/types';
import { sendMessage } from '../../services/bank/telegram-sender';
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
import { saveExpenseToSheet, saveReceiptExpenses } from '../services/expense-saver';
import type { BotInstance, Ctx } from '../types';

const logger = createLogger('message.handler');

/** Track consecutive sheet write failures per group to suggest /reconnect */
const sheetFailuresByGroup = new Map<number, number>();

export function getSheetWriteErrorMessage(groupId: number): string {
  const count = sheetFailuresByGroup.get(groupId) ?? 0;
  sheetFailuresByGroup.set(groupId, count + 1);
  if (count >= 1) {
    return '❌ Не удалось записать расход в Google таблицу. Возможно, авторизация устарела — попробуй /reconnect';
  }
  return '❌ Не удалось записать расход в Google таблицу. Попробуй ещё раз.';
}

export function resetSheetWriteFailures(groupId: number): void {
  sheetFailuresByGroup.delete(groupId);
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

    // Check if user has associated group
    const user = database.users.findByTelegramId(telegramId);

    if (user?.group_id) {
      const group = database.groups.findById(user.group_id);

      if (group?.telegram_group_id) {
        // Create inline keyboard with link to group
        // For supergroups: remove -100 prefix, for regular groups: just remove minus
        const groupIdStr = group.telegram_group_id.toString();
        const chatId = groupIdStr.startsWith('-100') ? groupIdStr.slice(4) : groupIdStr.slice(1);

        const keyboard = {
          inline_keyboard: [
            [
              {
                text: '🔗 Перейти в группу',
                url: `https://t.me/c/${chatId}`,
              },
            ],
          ],
        };

        await sendMessage(
          '💬 Бот работает только в группах.\n\nДля учета расходов используй команды в группе:',
          { reply_markup: keyboard },
        );
      } else {
        await sendMessage(
          '💬 Бот работает только в группах.\n\nДобавь бота в группу и используй команду /connect для настройки.',
        );
      }
    } else {
      await sendMessage(
        '💬 Бот работает только в группах.\n\nДобавь бота в группу и используй команду /connect для настройки.',
      );
    }

    return true;
  }

  const telegramGroupId = ctx.chat.id;
  const groupTitle = ctx.chat.title || `Group ${telegramGroupId}`;

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

  let successCount = 0;
  const newCategories: string[] = [];
  const categoryNames = database.categories.getCategoryNames(group.id);

  /** Tracks each recognized expense for the numbered summary */
  interface ProcessedExpense {
    amount: number;
    currency: string;
    category: string | null;
    comment: string;
    saved: boolean;
  }
  const processedExpenses: ProcessedExpense[] = [];

  for (const [index, line] of lines.entries()) {
    logger.info(`[MSG] Processing line ${index + 1}/${lines.length}: "${line}"`);

    // Parse expense
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

    // Create pending expense
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

    // If category doesn't exist, track it for confirmation
    if (!categoryExists && parsed.category && !newCategories.includes(parsed.category)) {
      newCategories.push(parsed.category);
    }

    // If category exists, save directly
    if (categoryExists || !parsed.category) {
      logger.info(`[MSG] Line ${index + 1}: saving to sheet`);
      try {
        await saveExpenseToSheet(user.id, group.id, pendingExpense.id);
        successCount++;
        processedExpenses.push({
          amount: parsed.amount,
          currency: parsed.currency,
          category: parsed.category,
          comment: parsed.comment,
          saved: true,
        });
      } catch (error) {
        logger.error({ err: error }, `[MSG] Line ${index + 1}: failed to save to sheet`);
        database.pendingExpenses.delete(pendingExpense.id);
        await sendMessage(getSheetWriteErrorMessage(group.id));
      }
    } else {
      // New category — pending confirmation
      processedExpenses.push({
        amount: parsed.amount,
        currency: parsed.currency,
        category: parsed.category,
        comment: parsed.comment,
        saved: false,
      });
    }
  }

  // Only react if at least one expense was processed
  const hasProcessedExpenses = successCount > 0 || newCategories.length > 0;

  if (hasProcessedExpenses) {
    // Set ✅ reaction (+ digit count for multiple expenses), fallback to 👍 if custom emoji unsupported
    try {
      await setExpenseReaction(bot, telegramGroupId, messageId, processedExpenses.length);
    } catch (error) {
      logger.error({ err: error }, '[MSG] Failed to set reaction');
    }
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

  // Success - no need to send additional message, reaction + numbered summary is enough

  logger.info(`[MSG] ✅ Processed ${successCount}/${lines.length} expenses successfully`);

  // Maybe send daily advice (20% probability)
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
