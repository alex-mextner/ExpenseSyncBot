import type { Ctx } from '../types';
import { format } from "date-fns";
import { MESSAGES } from "../../config/constants";
import { database } from "../../database";
import {
  parseExpenseMessage,
  validateParsedExpense,
} from "../../services/currency/parser";
import { createCategoryConfirmKeyboard } from "../keyboards";
import { setMessageReaction, deleteMessage } from "../telegram-api";
import { silentSyncBudgets } from "../commands/budget";
import { maybeSendDailyAdvice } from "../commands/ask";

/**
 * Handle expense message
 */
export async function handleExpenseMessage(ctx: Ctx["Message"]): Promise<void> {
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

    if (user) {
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
      await saveExpenseToSheet(user.id, group.id, pendingExpense.id, telegramGroupId);
      successCount++;
    }
  }

  // Only react if at least one expense was processed
  const hasProcessedExpenses = successCount > 0 || newCategories.length > 0;

  if (hasProcessedExpenses) {
    // Set reaction on user message
    try {
      await setMessageReaction(telegramGroupId, messageId, "👍");
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
  telegramGroupId?: number
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
  if (telegramGroupId) {
    await checkBudgetLimit(groupId, category, currentDate, telegramGroupId);
  }
}

/**
 * Check if budget limit is exceeded or approaching for a category
 */
async function checkBudgetLimit(
  groupId: number,
  category: string,
  currentDate: string,
  telegramGroupId: number
): Promise<void> {
  const { startOfMonth, endOfMonth, format } = await import('date-fns');
  const { getCategoryEmoji } = await import('../../config/category-emojis');
  const { sendMessage } = await import('../telegram-api');

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
      await sendMessage(telegramGroupId, message);
      console.log(`[BUDGET] Sent warning for category "${category}": ${percentage}%`);
    } catch (error) {
      console.error(`[BUDGET] Failed to send warning:`, error);
    }
  }
}