import { MESSAGES, type CurrencyCode } from "../../config/constants";
import { database } from "../../database";
import {
  handleCurrencyCallback,
  handleDefaultCurrencyCallback,
} from "../commands/connect";
import { normalizeCurrency, getCurrencySymbol } from "../commands/budget";
import {
  createCategoriesListKeyboard,
  createBudgetPromptKeyboard,
} from "../keyboards";
import type { Ctx } from "../types";
import { saveExpenseToSheet } from "./message.handler";
import { deleteMessage, sendMessage } from "../telegram-api";
import { format } from "date-fns";
import {
  writeBudgetRow,
  hasBudgetSheet,
  createBudgetSheet,
} from "../../services/google/sheets";

/**
 * Handle callback queries from inline keyboards
 */
export async function handleCallbackQuery(
  ctx: Ctx["CallbackQuery"]
): Promise<void> {
  const data = ctx.data;
  const telegramId = ctx.from.id;
  const chatId = ctx.message?.chat?.id;

  if (!data) {
    return;
  }

  const [action, ...params] = data.split(":");

  switch (action) {
    case "currency": {
      const currencyAction = params[0];
      if (!currencyAction || !chatId) {
        await ctx.answerCallbackQuery({ text: "Invalid parameters" });
        return;
      }
      await handleCurrencyCallback(ctx, currencyAction, chatId);
      break;
    }

    case "default": {
      // Step 2: Default currency selection
      const currency = params[0];
      if (!currency || !chatId) {
        await ctx.answerCallbackQuery({ text: "Invalid parameters" });
        return;
      }
      await handleDefaultCurrencyCallback(ctx, currency, chatId);
      break;
    }

    case "category":
      await handleCategoryAction(ctx, params, telegramId);
      break;

    case "confirm":
      await handleConfirmAction(ctx, params, telegramId);
      break;

    case "budget":
      await handleBudgetAction(ctx, params, telegramId);
      break;

    default:
      await ctx.answerCallbackQuery({ text: "Unknown action" });
  }
}

/**
 * Handle category-related callbacks
 */
async function handleCategoryAction(
  ctx: Ctx["CallbackQuery"],
  params: string[],
  telegramId: number
): Promise<void> {
  const [subAction, ...rest] = params;
  const user = database.users.findByTelegramId(telegramId);

  if (!user || !user.group_id) {
    await ctx.answerCallbackQuery({
      text: "Пользователь не найден или не привязан к группе",
    });
    return;
  }

  const group = database.groups.findById(user.group_id);

  if (!group) {
    await ctx.answerCallbackQuery({ text: "Группа не найдена" });
    return;
  }

  switch (subAction) {
    case "add": {
      // Add new category
      const categoryName = rest.join(":");
      database.categories.create({ group_id: group.id, name: categoryName });

      await ctx.answerCallbackQuery({
        text: MESSAGES.categoryAdded.replace("{category}", categoryName),
      });

      // Delete the button message
      const messageId = ctx.message?.id;
      const chatId = ctx.message?.chat?.id;
      if (messageId && chatId) {
        await deleteMessage(chatId, messageId);
      }

      // Find and save pending expense
      const pendingExpenses = database.pendingExpenses.findByUserId(user.id);
      const pending = pendingExpenses.find(
        (p) =>
          p.detected_category === categoryName &&
          p.status === "pending_category"
      );

      if (pending) {
        database.pendingExpenses.update(pending.id, { status: "confirmed" });
        await saveExpenseToSheet(
          user.id,
          group.id,
          pending.id,
          chatId || undefined
        );
      }

      // Prompt for budget setup
      if (chatId) {
        const keyboard = createBudgetPromptKeyboard(
          categoryName,
          group.default_currency
        );
        await sendMessage(
          chatId,
          `💰 Хочешь установить бюджет для категории "${categoryName}"?`,
          { reply_markup: keyboard.build() }
        );
      }

      break;
    }

    case "select": {
      // Show existing categories
      const categories = database.categories.getCategoryNames(group.id);

      if (categories.length === 0) {
        await ctx.answerCallbackQuery({ text: "Нет сохраненных категорий" });
        return;
      }

      const keyboard = createCategoriesListKeyboard(categories);
      await ctx.editReplyMarkup({
        inline_keyboard: keyboard.build().inline_keyboard,
      });
      await ctx.answerCallbackQuery({ text: "Выбери категорию" });
      break;
    }

    case "choose": {
      // Choose existing category
      const categoryName = rest.join(":");

      // Find pending expense for this user
      const pendingExpenses = database.pendingExpenses.findByUserId(user.id);
      const pending = pendingExpenses.find(
        (p) => p.status === "pending_category"
      );

      if (!pending) {
        await ctx.answerCallbackQuery({ text: "Расход не найден" });
        return;
      }

      // Update category
      database.pendingExpenses.update(pending.id, {
        detected_category: categoryName,
        status: "confirmed",
      });

      await ctx.answerCallbackQuery({ text: `Категория: ${categoryName}` });

      // Delete the button message
      const messageId = ctx.message?.id;
      const chatId = ctx.message?.chat?.id;
      if (messageId && chatId) {
        await deleteMessage(chatId, messageId);
      }

      // Save expense
      await saveExpenseToSheet(
        user.id,
        group.id,
        pending.id,
        chatId || undefined
      );
      break;
    }

    case "cancel": {
      await ctx.answerCallbackQuery({ text: "Отменено" });

      // Delete the button message
      const messageId = ctx.message?.id;
      const chatId = ctx.message?.chat?.id;
      if (messageId && chatId) {
        await deleteMessage(chatId, messageId);
      }
      break;
    }
  }
}

/**
 * Handle confirmation callbacks
 */
async function handleConfirmAction(
  ctx: Ctx["CallbackQuery"],
  params: string[],
  telegramId: number
): Promise<void> {
  const [action, answer] = params;

  if (answer === "yes") {
    await ctx.answerCallbackQuery({ text: "✅ Подтверждено" });
    // Handle specific confirmation actions here
  } else {
    await ctx.answerCallbackQuery({ text: "❌ Отменено" });

    // Delete the button message
    const messageId = ctx.message?.id;
    const chatId = ctx.message?.chat?.id;
    if (messageId && chatId) {
      await deleteMessage(chatId, messageId);
    }
  }
}

/**
 * Handle budget-related callbacks
 */
async function handleBudgetAction(
  ctx: Ctx["CallbackQuery"],
  params: string[],
  telegramId: number
): Promise<void> {
  const [subAction, category, ...rest] = params;
  const user = database.users.findByTelegramId(telegramId);

  if (!user || !user.group_id) {
    await ctx.answerCallbackQuery({ text: "Пользователь не найден" });
    return;
  }

  const group = database.groups.findById(user.group_id);

  if (!group) {
    await ctx.answerCallbackQuery({ text: "Группа не найдена" });
    return;
  }

  const chatId = ctx.message?.chat?.id;
  const messageId = ctx.message?.id;

  switch (subAction) {
    case "set": {
      // Set budget for category
      const amountStr = rest[0];
      const currencyStr = rest[1];
      const amount = amountStr ? parseFloat(amountStr) : 100;
      const currency = currencyStr
        ? normalizeCurrency(currencyStr) || group.default_currency
        : group.default_currency;

      if (Number.isNaN(amount) || amount <= 0) {
        await ctx.answerCallbackQuery({ text: "❌ Неверная сумма" });
        return;
      }

      const now = new Date();
      const currentMonth = format(now, "yyyy-MM");

      // Save to database
      database.budgets.setBudget({
        group_id: group.id,
        category,
        month: currentMonth,
        limit_amount: amount,
        currency,
      });

      // Ensure Budget sheet exists and write to Google Sheets
      if (group.google_refresh_token && group.spreadsheet_id) {
        try {
          const hasSheet = await hasBudgetSheet(
            group.google_refresh_token,
            group.spreadsheet_id
          );

          if (!hasSheet) {
            const categories = database.categories.getCategoryNames(group.id);
            await createBudgetSheet(
              group.google_refresh_token,
              group.spreadsheet_id,
              categories,
              100,
              currency
            );
          }

          await writeBudgetRow(
            group.google_refresh_token,
            group.spreadsheet_id,
            {
              month: currentMonth,
              category,
              limit: amount,
              currency: currency,
            }
          );
        } catch (err) {
          console.error("[BUDGET] Failed to write to Google Sheets:", err);
        }
      }

      const currencySymbol = getCurrencySymbol(currency);
      await ctx.answerCallbackQuery({
        text: `✅ Бюджет установлен: ${currencySymbol}${amount}`,
      });

      // Delete the button message
      if (messageId && chatId) {
        await deleteMessage(chatId, messageId);
      }

      break;
    }

    case "add-category": {
      // Add new category and set budget
      const amountStr = rest[0];
      const currencyStr = rest[1];
      const amount = amountStr ? parseFloat(amountStr) : 100;
      const currency = currencyStr
        ? normalizeCurrency(currencyStr) || group.default_currency
        : group.default_currency;

      if (Number.isNaN(amount) || amount <= 0) {
        await ctx.answerCallbackQuery({ text: "❌ Неверная сумма" });
        return;
      }

      // Create category
      database.categories.create({ group_id: group.id, name: category });

      const now = new Date();
      const currentMonth = format(now, "yyyy-MM");

      // Set budget
      database.budgets.setBudget({
        group_id: group.id,
        category,
        month: currentMonth,
        limit_amount: amount,
        currency: currency,
      });

      // Ensure Budget sheet exists and write to Google Sheets
      if (group.google_refresh_token && group.spreadsheet_id) {
        try {
          const hasSheet = await hasBudgetSheet(
            group.google_refresh_token,
            group.spreadsheet_id
          );

          if (!hasSheet) {
            const categories = database.categories.getCategoryNames(group.id);
            await createBudgetSheet(
              group.google_refresh_token,
              group.spreadsheet_id,
              categories,
              100,
              currency
            );
          }

          await writeBudgetRow(
            group.google_refresh_token,
            group.spreadsheet_id,
            {
              month: currentMonth,
              category,
              limit: amount,
              currency,
            }
          );
        } catch (err) {
          console.error("[BUDGET] Failed to write to Google Sheets:", err);
        }
      }

      const currencySymbol = getCurrencySymbol(currency);

      await ctx.answerCallbackQuery({
        text: `✅ Категория "${category}" создана, бюджет ${currencySymbol}${amount} установлен`,
      });

      // Delete the button message
      if (messageId && chatId) {
        await deleteMessage(chatId, messageId);
      }

      break;
    }

    case "skip": {
      await ctx.answerCallbackQuery({ text: "⏭️ Пропущено" });

      // Delete the button message
      if (messageId && chatId) {
        await deleteMessage(chatId, messageId);
      }

      break;
    }

    case "cancel": {
      await ctx.answerCallbackQuery({ text: "❌ Отменено" });

      // Delete the button message
      if (messageId && chatId) {
        await deleteMessage(chatId, messageId);
      }

      break;
    }

    default:
      await ctx.answerCallbackQuery({ text: "Unknown budget action" });
  }
}
