import type { Ctx } from '../types';
import { format } from "date-fns";
import { MESSAGES } from "../../config/constants";
import { database } from "../../database";
import {
  parseExpenseMessage,
  validateParsedExpense,
} from "../../services/currency/parser";
import { createCategoryConfirmKeyboard } from "../keyboards";

/**
 * Handle expense message
 */
export async function handleExpenseMessage(ctx: Ctx["Message"]): Promise<void> {
  const telegramId = ctx.from.id;
  const messageId = ctx.id;
  const text = ctx.text;

  if (!telegramId || !messageId || !text) {
    return;
  }

  // Get user
  const user = database.users.findByTelegramId(telegramId);

  if (!user) {
    await ctx.send("Пожалуйста, начни с команды /start");
    return;
  }

  // Check if user has completed setup
  if (!database.users.hasCompletedSetup(telegramId)) {
    await ctx.send("Пожалуйста, завершите настройку: /connect");
    return;
  }

  // Parse expense
  const parsed = parseExpenseMessage(text, user.default_currency);

  if (!validateParsedExpense(parsed)) {
    await ctx.send(MESSAGES.invalidFormat);
    return;
  }

  // Show parsed expense
  await ctx.send(
    MESSAGES.expenseParsed
      .replace("{amount}", parsed.amount.toString())
      .replace("{currency}", parsed.currency)
      .replace("{category}", parsed.category || "не указана")
      .replace("{comment}", parsed.comment)
  );

  // Check if category exists
  const categoryExists = parsed.category
    ? database.categories.exists(user.id, parsed.category)
    : false;

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

  // If category doesn't exist, ask for confirmation
  if (!categoryExists && parsed.category) {
    const keyboard = createCategoryConfirmKeyboard(parsed.category);
    await ctx.send(
      MESSAGES.newCategoryDetected.replace("{category}", parsed.category),
      { reply_markup: keyboard }
    );
    return;
  }

  // If category exists or no category, save directly
  await saveExpenseToSheet(user.id, pendingExpense.id);
  await ctx.send(MESSAGES.expenseSaved);
}

/**
 * Save expense to Google Sheet
 */
async function saveExpenseToSheet(
  userId: number,
  pendingExpenseId: number
): Promise<void> {
  const user = database.users.findById(userId);
  const pendingExpense = database.pendingExpenses.findById(pendingExpenseId);

  if (
    !user ||
    !pendingExpense ||
    !user.spreadsheet_id ||
    !user.google_refresh_token
  ) {
    throw new Error("Invalid user or pending expense");
  }

  const { convertToUSD } = await import("../../services/currency/converter");
  const { appendExpenseRow } = await import("../../services/google/sheets");

  // Calculate USD amount
  const usdAmount = convertToUSD(
    pendingExpense.parsed_amount,
    pendingExpense.parsed_currency
  );

  // Prepare amounts for each currency
  const amounts: Record<string, number | null> = {};
  for (const currency of user.enabled_currencies) {
    amounts[currency] =
      currency === pendingExpense.parsed_currency
        ? pendingExpense.parsed_amount
        : null;
  }

  // Append to sheet
  if (!user.google_refresh_token || !user.spreadsheet_id) {
    throw new Error("User not fully configured");
  }

  const currentDate = format(new Date(), "yyyy-MM-dd");

  await appendExpenseRow(user.google_refresh_token, user.spreadsheet_id, {
    date: currentDate,
    category: pendingExpense.detected_category || "Без категории",
    comment: pendingExpense.comment,
    amounts,
    usdAmount,
  });

  // Save to expenses table
  database.expenses.create({
    user_id: userId,
    date: currentDate,
    category: pendingExpense.detected_category || "Без категории",
    comment: pendingExpense.comment,
    amount: pendingExpense.parsed_amount,
    currency: pendingExpense.parsed_currency,
    usd_amount: usdAmount,
  });

  // Delete pending expense
  database.pendingExpenses.delete(pendingExpenseId);
}

/**
 * Export saveExpenseToSheet for use in other handlers
 */
export { saveExpenseToSheet };
