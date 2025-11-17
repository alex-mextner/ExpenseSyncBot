import { MESSAGES } from "../../config/constants";
import { database } from "../../database";
import { handleCurrencyCallback, handleDefaultCurrencyCallback } from "../commands/connect";
import { createCategoriesListKeyboard } from "../keyboards";
import type { Ctx } from "../types";
import { saveExpenseToSheet } from "./message.handler";

/**
 * Handle callback queries from inline keyboards
 */
export async function handleCallbackQuery(
  ctx: Ctx["CallbackQuery"]
): Promise<void> {
  const data = ctx.data;
  const telegramId = ctx.from.id;

  if (!data) {
    return;
  }

  const [action, ...params] = data.split(":");

  switch (action) {
    case "currency": {
      const action = params[0];
      if (!action) {
        await ctx.answerCallbackQuery({ text: "Invalid parameters" });
        return;
      }
      await handleCurrencyCallback(ctx, action, telegramId);
      break;
    }

    case "default": {
      // Step 2: Default currency selection
      const currency = params[0];
      if (!currency) {
        await ctx.answerCallbackQuery({ text: "Invalid parameters" });
        return;
      }
      await handleDefaultCurrencyCallback(ctx, currency, telegramId);
      break;
    }

    case "category":
      await handleCategoryAction(ctx, params, telegramId);
      break;

    case "confirm":
      await handleConfirmAction(ctx, params, telegramId);
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

  if (!user) {
    await ctx.answerCallbackQuery({ text: "Пользователь не найден" });
    return;
  }

  switch (subAction) {
    case "add": {
      // Add new category
      const categoryName = rest.join(":");
      database.categories.create({ user_id: user.id, name: categoryName });

      await ctx.answerCallbackQuery({
        text: MESSAGES.categoryAdded.replace("{category}", categoryName),
      });
      await ctx.editText(
        MESSAGES.categoryAdded.replace("{category}", categoryName)
      );

      // Find and save pending expense
      const pendingExpenses = database.pendingExpenses.findByUserId(user.id);
      const pending = pendingExpenses.find(
        (p) =>
          p.detected_category === categoryName &&
          p.status === "pending_category"
      );

      if (pending) {
        database.pendingExpenses.update(pending.id, { status: "confirmed" });
        await saveExpenseToSheet(user.id, pending.id);
        await ctx.send(MESSAGES.expenseSaved);
      }

      break;
    }

    case "select": {
      // Show existing categories
      const categories = database.categories.getCategoryNames(user.id);

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
      await ctx.editText(`✅ Категория изменена на "${categoryName}"`);

      // Save expense
      await saveExpenseToSheet(user.id, pending.id);
      await ctx.send(MESSAGES.expenseSaved);
      break;
    }

    case "cancel": {
      await ctx.answerCallbackQuery({ text: "Отменено" });
      await ctx.editText("❌ Отменено");
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
    await ctx.editText("❌ Отменено");
  }
}
