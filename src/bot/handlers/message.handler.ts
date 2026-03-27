import { format } from 'date-fns';
import { BASE_CURRENCY, type CurrencyCode, MESSAGES } from '../../config/constants';
import { database } from '../../database';
import type { Group, PhotoQueueItem, ReceiptItem } from '../../database/types';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import { parseExpenseMessage, validateParsedExpense } from '../../services/currency/parser';
import { DevTaskState } from '../../services/dev-pipeline/types';
import { extractURLsFromText, processPaymentLinks } from '../../services/receipt/link-analyzer';
import type { ReceiptSummary } from '../../services/receipt/receipt-summarizer';
import { createLogger } from '../../utils/logger.ts';
import { maybeSmartAdvice } from '../commands/ask';
import { silentSyncBudgets } from '../commands/budget';
import { consumePendingDesignEdit, getPipelineInstance } from '../commands/dev';
import { createCategoryConfirmKeyboard } from '../keyboards';
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
export async function handleExpenseMessage(ctx: Ctx['Message'], bot: BotInstance): Promise<void> {
  const telegramId = ctx.from.id;
  const messageId = ctx.id;
  const text = ctx.text;
  const username = ctx.from.username || ctx.from.firstName || 'Unknown';

  logger.info(`[MSG] Received message from user ${username} (${telegramId}): "${text}"`);

  if (!telegramId || !messageId || !text) {
    logger.info(`[MSG] Ignoring: missing telegramId, messageId or text`);
    return;
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

        await ctx.send(
          '💬 Бот работает только в группах.\n\nДля учета расходов используй команды в группе:',
          { reply_markup: keyboard },
        );
      } else {
        await ctx.send(
          '💬 Бот работает только в группах.\n\nДобавь бота в группу и используй команду /connect для настройки.',
        );
      }
    } else {
      await ctx.send(
        '💬 Бот работает только в группах.\n\nДобавь бота в группу и используй команду /connect для настройки.',
      );
    }

    return;
  }

  const telegramGroupId = ctx.chat.id;
  const groupTitle = ctx.chat.title || `Group ${telegramGroupId}`;

  logger.info(`[MSG] Message from group "${groupTitle}" (${telegramGroupId})`);

  // Get or create group
  const group = database.groups.findByTelegramGroupId(telegramGroupId);

  if (!group) {
    // Group not set up yet
    logger.info(`[MSG] Ignoring: group ${telegramGroupId} not found in database`);
    await ctx.send(`Группа не настроена. Для настройки используй команду /connect`);
    return;
  }

  // Bank setup wizard — consume credential input before other checks
  if (text && !text.startsWith('/')) {
    const { handleWizardInput } = await import('../commands/bank');
    const handled = await handleWizardInput(ctx, group.id, text);
    if (handled) return;
  }

  // Check if group has completed setup
  if (!database.groups.hasCompletedSetup(telegramGroupId)) {
    logger.info(`[MSG] Ignoring: group ${telegramGroupId} setup not completed`);
    await ctx.send('Завершите настройку группы: /connect');
    return;
  }

  // Check topic restriction
  const messageThreadId = ctx.update?.message?.message_thread_id;
  if (group.active_topic_id && messageThreadId !== group.active_topic_id) {
    logger.info(
      `[MSG] Ignoring: message from topic ${messageThreadId || 'general'}, bot listens to topic ${group.active_topic_id}`,
    );
    return;
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
    if (!user) return;
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
        await ctx.send(`Failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return;
  }

  // Check if we're waiting for bulk correction text input
  const waitingBulkCorrection = database.photoQueue.findWaitingForBulkCorrection(group.id);
  if (waitingBulkCorrection) {
    await handleBulkCorrectionInput(ctx, bot, text, waitingBulkCorrection, group);
    return;
  }

  // Check if we're waiting for category text input from user
  const waitingItem = database.receiptItems.findWaitingForCategoryInput(group.id);
  if (waitingItem) {
    await handleCategoryTextInput(ctx, bot, text, waitingItem, group.id);
    return;
  }

  // Bank transaction edit flow — route replies to pending edit transactions
  const replyToMessageId = ctx.update?.message?.reply_to_message?.message_id;
  if (replyToMessageId && text) {
    const { handleBankEditReply } = await import('../commands/bank');
    const handled = await handleBankEditReply(ctx, telegramGroupId, text, replyToMessageId);
    if (handled) return;
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
    if (hasPayment) return;
  }

  // Split message by lines and process each line
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line);

  logger.info(`[MSG] Processing ${lines.length} line(s)`);

  let successCount = 0;
  const newCategories: string[] = [];

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

    // Check if category exists
    const categoryExists = parsed.category
      ? database.categories.exists(group.id, parsed.category)
      : false;

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
        await saveExpenseToSheet(user.id, group.id, pendingExpense.id, telegramGroupId, bot);
        successCount++;
      } catch (error) {
        logger.error({ err: error }, `[MSG] Line ${index + 1}: failed to save to sheet`);
        database.pendingExpenses.delete(pendingExpense.id);
        await bot.api.sendMessage({
          chat_id: telegramGroupId,
          text: getSheetWriteErrorMessage(group.id),
        });
      }
    }
  }

  // Only react if at least one expense was processed
  const hasProcessedExpenses = successCount > 0 || newCategories.length > 0;

  if (hasProcessedExpenses) {
    // Set reaction on user message
    try {
      await bot.api.setMessageReaction({
        chat_id: telegramGroupId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji: '👍' }],
      });
    } catch (error) {
      logger.error({ err: error }, '[MSG] Failed to set reaction');
    }
  }

  // If there are new categories, ask for confirmation
  if (newCategories.length > 0) {
    logger.info(`[MSG] Asking for confirmation of ${newCategories.length} new categories`);
    for (const category of newCategories) {
      const keyboard = createCategoryConfirmKeyboard(category);
      await bot.api.sendMessage({
        chat_id: telegramGroupId,
        text: MESSAGES.newCategoryDetected.replace('{category}', category),
        reply_markup: keyboard,
      });
    }
    return;
  }

  // Success - no need to send message, reaction is enough

  logger.info(`[MSG] ✅ Processed ${successCount}/${lines.length} expenses successfully`);

  // Maybe send daily advice (20% probability)
  if (hasProcessedExpenses) {
    await maybeSmartAdvice(ctx, group.id);
  }
}

/**
 * Save expense to Google Sheet and local DB via ExpenseRecorder
 */
export async function saveExpenseToSheet(
  userId: number,
  groupId: number,
  pendingExpenseId: number,
  telegramGroupId?: number,
  bot?: BotInstance,
): Promise<void> {
  logger.info(`[SAVE] Starting save to sheet...`);

  const group = database.groups.findById(groupId);
  const pendingExpense = database.pendingExpenses.findById(pendingExpenseId);

  if (!group || !pendingExpense || !group.spreadsheet_id || !group.google_refresh_token) {
    logger.error(
      {
        data: {
          group: !!group,
          pendingExpense: !!pendingExpense,
          spreadsheet_id: !!group?.spreadsheet_id,
          refresh_token: !!group?.google_refresh_token,
        },
      },
      `[SAVE] ❌ Validation failed`,
    );
    throw new Error('Invalid group or pending expense');
  }

  // Silent sync budgets from Google Sheets
  await silentSyncBudgets(group.google_refresh_token, group.spreadsheet_id, group.id);

  const { getExpenseRecorder } = await import('../../services/expense-recorder');
  const recorder = getExpenseRecorder();

  const currentDate = format(new Date(), 'yyyy-MM-dd');
  const category = pendingExpense.detected_category || 'Без категории';

  const { eurAmount } = await recorder.record(groupId, userId, {
    date: currentDate,
    category,
    comment: pendingExpense.comment,
    amount: pendingExpense.parsed_amount,
    currency: pendingExpense.parsed_currency,
  });

  resetSheetWriteFailures(groupId);

  logger.info(
    `[SAVE] ✅ Recorded ${pendingExpense.parsed_amount} ${pendingExpense.parsed_currency} → ${eurAmount} EUR`,
  );

  // Delete pending expense
  database.pendingExpenses.delete(pendingExpenseId);
  logger.info(`[SAVE] ✅ Deleted pending expense ${pendingExpenseId}`);

  // Check budget limits
  if (telegramGroupId && bot) {
    await checkBudgetLimit(groupId, category, currentDate, telegramGroupId, bot);
  }
}

/**
 * Check if budget limit is exceeded or approaching for a category
 */
async function checkBudgetLimit(
  groupId: number,
  category: string,
  currentDate: string,
  telegramGroupId: number,
  bot: BotInstance,
): Promise<void> {
  const { startOfMonth, endOfMonth, format } = await import('date-fns');
  const { getCategoryEmoji } = await import('../../config/category-emojis');

  const now = new Date(currentDate);
  const currentMonth = format(now, 'yyyy-MM');
  const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
  const monthEnd = format(endOfMonth(now), 'yyyy-MM-dd');

  // Get budget for category
  const budget = database.budgets.getBudgetForMonth(groupId, category, currentMonth);

  if (!budget) {
    // No budget set for this category
    return;
  }

  // Calculate total spending in category for current month
  const expenses = database.expenses.findByDateRange(groupId, monthStart, monthEnd);
  const categorySpending = expenses
    .filter((exp) => exp.category === category)
    .reduce((sum, exp) => sum + exp.eur_amount, 0);

  const { spentInCurrency, percentage, isExceeded, isWarning } = buildBudgetAlertStatus(
    categorySpending,
    budget,
  );

  if (isExceeded || isWarning) {
    const emoji = getCategoryEmoji(category);
    const budgetCurrency = budget.currency as CurrencyCode;
    let message = '';

    if (isExceeded) {
      message = `🔴 ПРЕВЫШЕН БЮДЖЕТ!\n`;
      message += `${emoji} ${category}: ${formatAmount(spentInCurrency, budgetCurrency)} / ${formatAmount(budget.limit_amount, budgetCurrency)} (${percentage}%)`;
    } else if (isWarning) {
      message = `⚠️ Внимание! Приближение к лимиту бюджета:\n`;
      message += `${emoji} ${category}: ${formatAmount(spentInCurrency, budgetCurrency)} / ${formatAmount(budget.limit_amount, budgetCurrency)} (${percentage}%)`;
    }

    try {
      await bot.api.sendMessage({
        chat_id: telegramGroupId,
        text: message,
      });
      logger.info(`[BUDGET] Sent warning for category "${category}": ${percentage}%`);
    } catch (error) {
      logger.error({ err: error }, '[BUDGET] Failed to send warning');
    }
  }
}

/**
 * Handle category text input from user
 */
async function handleCategoryTextInput(
  ctx: Ctx['Message'],
  bot: BotInstance,
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

      await ctx.send(`✅ Используется категория: <b>${bestMatch}</b>`, { parse_mode: 'HTML' });

      // Check if all items are confirmed
      const allItems = database.receiptItems.findByPhotoQueueId(waitingItem.photo_queue_id);
      const allConfirmed = allItems.every((i) => i.status === 'confirmed');

      if (allConfirmed) {
        // Save all items
        const { saveReceiptExpenses } = await import('./callback.handler');
        const user = database.users.findByTelegramId(ctx.from.id);
        if (user) {
          const group = database.groups.findById(groupId);
          if (group) {
            await saveReceiptExpenses(waitingItem.photo_queue_id, groupId, user.id, bot);
          }
        }
      } else {
        // Show next pending item
        const { showNextItemForConfirmation } = await import(
          '../../services/receipt/photo-processor'
        );
        await showNextItemForConfirmation(bot, groupId, waitingItem.photo_queue_id);
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

    await bot.api.sendMessage({
      chat_id: ctx.chat.id,
      text: `Найдена похожая категория: <b>${bestMatch}</b>\n\nВыберите действие:`,
      parse_mode: 'HTML',
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

    await ctx.send(`✅ Создана новая категория: <b>${normalizedCategory}</b>`, {
      parse_mode: 'HTML',
    });

    // Check if all items are confirmed (categories will be collected dynamically in showNextItemForConfirmation)
    const allItems = database.receiptItems.findByPhotoQueueId(waitingItem.photo_queue_id);
    const allConfirmed = allItems.every((i) => i.status === 'confirmed');

    if (allConfirmed) {
      // Save all items
      const { saveReceiptExpenses } = await import('./callback.handler');
      const user = database.users.findByTelegramId(ctx.from.id);
      if (user) {
        const group = database.groups.findById(groupId);
        if (group) {
          await saveReceiptExpenses(waitingItem.photo_queue_id, groupId, user.id, bot);
        }
      }
    } else {
      // Show next pending item
      const { showNextItemForConfirmation } = await import(
        '../../services/receipt/photo-processor'
      );
      await showNextItemForConfirmation(bot, groupId, waitingItem.photo_queue_id);
    }
  }
}

/**
 * Handle bulk correction text input from user
 */
async function handleBulkCorrectionInput(
  ctx: Ctx['Message'],
  bot: BotInstance,
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
  await ctx.send('⏳ Корректирую...');

  // Get receipt items
  const items = database.receiptItems.findByPhotoQueueId(queueItem.id);

  if (items.length === 0) {
    await ctx.send('❌ Товары не найдены');
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
    } catch {}
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
      await ctx.send(
        '❌ Суммы не сходятся. AI изменил суммы товаров, что недопустимо.\n\n' +
          'Попробуйте переформулировать корректировку. Например:\n' +
          '<code>перенеси салфетки в Хозтовары</code>',
        { parse_mode: 'HTML' },
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
    const sentMessage = await bot.api.sendMessage({
      chat_id: ctx.chat?.id,
      text: message,
      parse_mode: 'HTML',
      reply_markup: createBulkEditKeyboard(queueItem.id),
    });

    // Save message ID for buttons to work
    database.photoQueue.update(queueItem.id, {
      summary_message_id: sentMessage.message_id,
    });

    logger.info(`[BULK_CORRECTION] Correction applied successfully`);
  } catch (error) {
    logger.error({ err: error }, '[BULK_CORRECTION] AI correction failed');
    await ctx.send(
      '❌ Не удалось применить корректировку.\n\n' +
        'Попробуйте переформулировать. Например:\n' +
        '<code>перенеси салфетки в Хозтовары</code>\n' +
        '<code>объедини Еда и Напитки</code>',
      { parse_mode: 'HTML' },
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
