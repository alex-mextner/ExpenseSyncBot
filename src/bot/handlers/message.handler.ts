import type { Ctx } from '../types';
import type { ReceiptItem } from '../../database/types';
import { format } from "date-fns";
import { MESSAGES } from "../../config/constants";
import { database } from "../../database";
import {
  parseExpenseMessage,
  validateParsedExpense,
} from "../../services/currency/parser";
import { createCategoryConfirmKeyboard } from "../keyboards";
import { silentSyncBudgets } from "../commands/budget";
import { maybeSendDailyAdvice } from "../commands/ask";
import { extractURLsFromText, processPaymentLinks } from "../../services/receipt/link-analyzer";

/**
 * Handle expense message
 */
export async function handleExpenseMessage(ctx: Ctx["Message"], bot: any): Promise<void> {
  const telegramId = ctx.from.id;
  const messageId = ctx.id;
  const text = ctx.text;
  const username = ctx.from.username || ctx.from.firstName || 'Unknown';

  console.log(`[MSG] Received message from user ${username} (${telegramId}): "${text}"`);

  if (!telegramId || !messageId || !text) {
    console.log(`[MSG] Ignoring: missing telegramId, messageId or text`);
    return;
  }

  // Check if message is from group/supergroup
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

  if (!isGroup) {
    console.log(`[MSG] Message from private chat (user ${telegramId})`);

    // Check if user has associated group
    const user = database.users.findByTelegramId(telegramId);

    if (user && user.group_id) {
      const group = database.groups.findById(user.group_id);

      if (group?.telegram_group_id) {
        // Create inline keyboard with link to group
        // For supergroups: remove -100 prefix, for regular groups: just remove minus
        const groupIdStr = group.telegram_group_id.toString();
        const chatId = groupIdStr.startsWith("-100")
          ? groupIdStr.slice(4)
          : groupIdStr.slice(1);

        const keyboard = {
          inline_keyboard: [[
            {
              text: "🔗 Перейти в группу",
              url: `https://t.me/c/${chatId}`,
            }
          ]]
        };

        await ctx.send(
          "💬 Бот работает только в группах.\n\nДля учета расходов используй команды в группе:",
          { reply_markup: keyboard }
        );
      } else {
        await ctx.send(
          "💬 Бот работает только в группах.\n\nДобавь бота в группу и используй команду /connect для настройки."
        );
      }
    } else {
      await ctx.send(
        "💬 Бот работает только в группах.\n\nДобавь бота в группу и используй команду /connect для настройки."
      );
    }

    return;
  }

  const telegramGroupId = ctx.chat.id;
  const groupTitle = ctx.chat.title || `Group ${telegramGroupId}`;

  console.log(`[MSG] Message from group "${groupTitle}" (${telegramGroupId})`);


  // Get or create group
  const group = database.groups.findByTelegramGroupId(telegramGroupId);

  if (!group) {
    // Group not set up yet
    console.log(`[MSG] Ignoring: group ${telegramGroupId} not found in database`);
    await ctx.send(
      `Группа не настроена. Для настройки используй команду /connect`
    );
    return;
  }

  // Check if group has completed setup
  if (!database.groups.hasCompletedSetup(telegramGroupId)) {
    console.log(`[MSG] Ignoring: group ${telegramGroupId} setup not completed`);
    await ctx.send("Завершите настройку группы: /connect");
    return;
  }

  console.log(`[MSG] Group ${group.id} found, default currency: ${group.default_currency}`);

  // Get or create user
  let user = database.users.findByTelegramId(telegramId);

  if (!user) {
    console.log(`[MSG] Creating new user ${telegramId} in group ${group.id}`);
    user = database.users.create({
      telegram_id: telegramId,
      group_id: group.id,
    });
  } else if (user.group_id !== group.id) {
    // Update user's group_id if changed
    console.log(`[MSG] Updating user ${telegramId} group_id: ${user.group_id} → ${group.id}`);
    database.users.update(telegramId, { group_id: group.id });
    user = database.users.findByTelegramId(telegramId);
    if (!user) return;
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

  // Check for URLs in message
  const urls = extractURLsFromText(text);
  if (urls.length > 0) {
    const hasPayment = await processPaymentLinks(bot, telegramGroupId, messageId, urls, group, user);
    if (hasPayment) return;
  }

  // Split message by lines and process each line
  const lines = text.split('\n').map(line => line.trim()).filter(line => line);

  console.log(`[MSG] Processing ${lines.length} line(s)`);

  let successCount = 0;
  const newCategories: string[] = [];

  for (const [index, line] of lines.entries()) {
    console.log(`[MSG] Processing line ${index + 1}/${lines.length}: "${line}"`);

    // Parse expense
    const parsed = parseExpenseMessage(line, group.default_currency);

    if (!parsed) {
      console.log(`[MSG] ❌ Line ${index + 1}: failed to parse`);
      continue;
    }

    console.log(`[MSG] Line ${index + 1} parsed:`, {
      amount: parsed.amount,
      currency: parsed.currency,
      category: parsed.category,
      comment: parsed.comment,
    });

    if (!validateParsedExpense(parsed)) {
      console.log(`[MSG] ❌ Line ${index + 1}: validation failed`);
      continue;
    }

    // Check if category exists
    const categoryExists = parsed.category
      ? database.categories.exists(group.id, parsed.category)
      : false;

    console.log(`[MSG] Line ${index + 1}: category "${parsed.category}" exists: ${categoryExists}`);

    // Create pending expense
    const pendingExpense = database.pendingExpenses.create({
      user_id: user.id,
      message_id: messageId,
      parsed_amount: parsed.amount,
      parsed_currency: parsed.currency,
      detected_category: parsed.category,
      comment: parsed.comment,
      status:
        categoryExists || !parsed.category ? "confirmed" : "pending_category",
    });

    console.log(`[MSG] Line ${index + 1}: created pending expense ${pendingExpense.id}`);

    // If category doesn't exist, track it for confirmation
    if (!categoryExists && parsed.category && !newCategories.includes(parsed.category)) {
      newCategories.push(parsed.category);
    }

    // If category exists, save directly
    if (categoryExists || !parsed.category) {
      console.log(`[MSG] Line ${index + 1}: saving to sheet`);
      await saveExpenseToSheet(user.id, group.id, pendingExpense.id, telegramGroupId, bot);
      successCount++;
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
        reaction: [{ type: "emoji", emoji: "👍" }],
      });
    } catch (error) {
      console.error(`[MSG] Failed to set reaction:`, error);
    }
  }

  // If there are new categories, ask for confirmation
  if (newCategories.length > 0) {
    console.log(`[MSG] Asking for confirmation of ${newCategories.length} new categories`);
    for (const category of newCategories) {
      const keyboard = createCategoryConfirmKeyboard(category);
      await ctx.send(
        MESSAGES.newCategoryDetected.replace("{category}", category),
        { reply_markup: keyboard }
      );
    }
    return;
  }

  // Success - no need to send message, reaction is enough

  console.log(`[MSG] ✅ Processed ${successCount}/${lines.length} expenses successfully`);

  // Maybe send daily advice (20% probability)
  if (hasProcessedExpenses) {
    await maybeSendDailyAdvice(ctx, group.id);
  }
}

/**
 * Save expense to Google Sheet
 */
export async function saveExpenseToSheet(
  userId: number,
  groupId: number,
  pendingExpenseId: number,
  telegramGroupId?: number,
  bot?: any
): Promise<void> {
  console.log(`[SAVE] Starting save to sheet...`);

  const user = database.users.findById(userId);
  const group = database.groups.findById(groupId);
  const pendingExpense = database.pendingExpenses.findById(pendingExpenseId);

  if (
    !user ||
    !group ||
    !pendingExpense ||
    !group.spreadsheet_id ||
    !group.google_refresh_token
  ) {
    console.error(`[SAVE] ❌ Validation failed:`, {
      user: !!user,
      group: !!group,
      pendingExpense: !!pendingExpense,
      spreadsheet_id: !!group?.spreadsheet_id,
      refresh_token: !!group?.google_refresh_token,
    });
    throw new Error("Invalid user, group or pending expense");
  }

  const { convertToEUR } = await import("../../services/currency/converter");
  const { appendExpenseRow } = await import("../../services/google/sheets");

  // Silent sync budgets from Google Sheets
  await silentSyncBudgets(
    group.google_refresh_token,
    group.spreadsheet_id,
    group.id
  );

  // Calculate EUR amount
  const eurAmount = convertToEUR(
    pendingExpense.parsed_amount,
    pendingExpense.parsed_currency
  );

  console.log(`[SAVE] Converted ${pendingExpense.parsed_amount} ${pendingExpense.parsed_currency} → ${eurAmount} EUR`);

  // Prepare amounts for each currency
  const amounts: Record<string, number | null> = {};
  for (const currency of group.enabled_currencies) {
    amounts[currency] =
      currency === pendingExpense.parsed_currency
        ? pendingExpense.parsed_amount
        : null;
  }

  // Append to sheet
  const currentDate = format(new Date(), "yyyy-MM-dd");
  const category = pendingExpense.detected_category || "Без категории";

  console.log(`[SAVE] Writing to Google Sheet:`, {
    date: currentDate,
    category,
    comment: pendingExpense.comment,
    amounts,
    eurAmount,
  });

  try {
    await appendExpenseRow(group.google_refresh_token, group.spreadsheet_id, {
      date: currentDate,
      category,
      comment: pendingExpense.comment,
      amounts,
      eurAmount,
    });

    console.log(`[SAVE] ✅ Successfully wrote to Google Sheet`);
  } catch (error) {
    console.error(`[SAVE] ❌ Failed to write to Google Sheet:`, error);
    throw error;
  }

  // Save to expenses table
  console.log(`[SAVE] Saving to local database...`);
  database.expenses.create({
    group_id: groupId,
    user_id: userId,
    date: currentDate,
    category,
    comment: pendingExpense.comment,
    amount: pendingExpense.parsed_amount,
    currency: pendingExpense.parsed_currency,
    eur_amount: eurAmount,
  });

  // Delete pending expense
  database.pendingExpenses.delete(pendingExpenseId);
  console.log(`[SAVE] ✅ Deleted pending expense ${pendingExpenseId}`);

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
  bot: any
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
    .filter(exp => exp.category === category)
    .reduce((sum, exp) => sum + exp.eur_amount, 0);

  const percentage = budget.limit_amount > 0
    ? Math.round((categorySpending / budget.limit_amount) * 100)
    : 0;

  // Check if warning or exceeded
  const isExceeded = categorySpending > budget.limit_amount;
  const isWarning = percentage >= 90 && !isExceeded;

  if (isExceeded || isWarning) {
    const emoji = getCategoryEmoji(category);
    let message = '';

    if (isExceeded) {
      message = `🔴 ПРЕВЫШЕН БЮДЖЕТ!\n`;
      message += `${emoji} ${category}: €${categorySpending.toFixed(2)} / €${budget.limit_amount.toFixed(2)} (${percentage}%)`;
    } else if (isWarning) {
      message = `⚠️ Внимание! Приближение к лимиту бюджета:\n`;
      message += `${emoji} ${category}: €${categorySpending.toFixed(2)} / €${budget.limit_amount.toFixed(2)} (${percentage}%)`;
    }

    try {
      await bot.api.sendMessage({
        chat_id: telegramGroupId,
        text: message,
      });
      console.log(`[BUDGET] Sent warning for category "${category}": ${percentage}%`);
    } catch (error) {
      console.error(`[BUDGET] Failed to send warning:`, error);
    }
  }
}

/**
 * Handle category text input from user
 */
async function handleCategoryTextInput(
  ctx: Ctx["Message"],
  bot: any,
  categoryText: string,
  waitingItem: ReceiptItem,
  groupId: number
): Promise<void> {
  const { findBestCategoryMatch, normalizeCategoryName } = await import('../../utils/fuzzy-search');

  console.log(`[CATEGORY_INPUT] User provided category: "${categoryText}" for item ${waitingItem.id}`);

  // Normalize category name
  const normalizedCategory = normalizeCategoryName(categoryText);

  // Get all existing categories for this group
  const allCategories = database.categories.findByGroupId(groupId);
  const categoryNames = allCategories.map(c => c.name);

  // Try to find best match
  const bestMatch = findBestCategoryMatch(normalizedCategory, categoryNames);

  if (bestMatch) {
    // Check if exact match - use it automatically
    if (bestMatch.toLowerCase() === normalizedCategory.toLowerCase()) {
      console.log(`[CATEGORY_INPUT] Exact match found: "${bestMatch}", using automatically`);

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
        const { showNextItemForConfirmation } = await import('../../services/receipt/photo-processor');
        await showNextItemForConfirmation(bot, groupId, waitingItem.photo_queue_id);
      }

      return;
    }

    // Found similar but not exact match - ask user to confirm
    console.log(`[CATEGORY_INPUT] Found similar category: "${bestMatch}"`);

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
    console.log(`[CATEGORY_INPUT] No similar category found, creating new: "${normalizedCategory}"`);

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

    await ctx.send(`✅ Создана новая категория: <b>${normalizedCategory}</b>`, { parse_mode: 'HTML' });

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
      const { showNextItemForConfirmation } = await import('../../services/receipt/photo-processor');
      await showNextItemForConfirmation(bot, groupId, waitingItem.photo_queue_id);
    }
  }
}

/**
 * Handle bulk correction text input from user
 */
async function handleBulkCorrectionInput(
  ctx: Ctx["Message"],
  bot: any,
  correctionText: string,
  queueItem: any,
  group: any
): Promise<void> {
  const {
    buildSummaryFromItems,
    formatSummaryMessage,
    applyCorrectionWithAI,
    validateSummaryTotals,
  } = await import('../../services/receipt/receipt-summarizer');
  const { createBulkEditKeyboard } = await import('../keyboards');

  console.log(`[BULK_CORRECTION] User correction: "${correctionText}" for queue ${queueItem.id}`);

  // Immediately respond that we're processing
  await ctx.send("⏳ Корректирую...");

  // Get receipt items
  const items = database.receiptItems.findByPhotoQueueId(queueItem.id);

  if (items.length === 0) {
    await ctx.send("❌ Товары не найдены");
    return;
  }

  // Build current summary (from AI summary if exists, otherwise from items)
  let currentSummary: any;
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
  const categoryNames = allCategories.map(c => c.name);

  // Also add suggested categories from items
  const suggestedCategories = [...new Set(items.map(i => i.suggested_category))];
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
      correctionHistory
    );

    // Validate totals match (±1%)
    const originalTotal = items.reduce((sum, i) => sum + i.total, 0);
    if (!validateSummaryTotals(newSummary, originalTotal)) {
      await ctx.send(
        "❌ Суммы не сходятся. AI изменил суммы товаров, что недопустимо.\n\n" +
        "Попробуйте переформулировать корректировку. Например:\n" +
        "<code>перенеси салфетки в Хозтовары</code>",
        { parse_mode: 'HTML' }
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

    console.log(`[BULK_CORRECTION] Correction applied successfully`);
  } catch (error) {
    console.error('[BULK_CORRECTION] AI correction failed:', error);
    await ctx.send(
      "❌ Не удалось применить корректировку.\n\n" +
      "Попробуйте переформулировать. Например:\n" +
      "<code>перенеси салфетки в Хозтовары</code>\n" +
      "<code>объедини Еда и Напитки</code>",
      { parse_mode: 'HTML' }
    );
  }
}
