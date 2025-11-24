import type { Ctx } from "../types";
import type { Bot } from "gramio";
import { database } from "../../database";
import { InferenceClient } from "@huggingface/inference";
import { env } from "../../config/env";

const client = new InferenceClient(env.HF_TOKEN);

/**
 * Handle questions to the bot via @botname question
 */
export async function handleAskQuestion(
  ctx: Ctx["Message"],
  question: string,
  bot: Bot
): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send("Error: Unable to identify chat");
    return;
  }

  // Only allow in groups
  const isGroup = chatType === "group" || chatType === "supergroup";

  if (!isGroup) {
    await ctx.send("❌ Эта команда работает только в группах.");
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await ctx.send("❌ Группа не настроена. Используй /connect");
    return;
  }

  // Get all expenses
  const allExpenses = database.expenses.findByGroupId(group.id, 100000);

  // Get all budgets
  const allBudgets = database.budgets.findByGroupId(group.id);

  // Build context from expenses and budgets
  const expensesContext = buildExpensesContext(allExpenses);
  const budgetsContext = buildBudgetsContext(allBudgets);

  const systemPrompt = `Ты - ассистент для анализа финансов.
Отвечай на вопросы пользователя на основе этих данных. Будь точным и конкретным. Используй цифры из предоставленных данных.
У тебя есть доступ к следующим данным:

Expenses Data:
${expensesContext}

Budget items Data:
${budgetsContext}`;

  try {
    // Create streaming response
    const stream = client.chatCompletionStream({
      provider: "novita",
      model: "deepseek-ai/DeepSeek-R1-0528",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: question,
        },
      ],
      max_tokens: 2000,
      temperature: 0.7,
    });

    let fullResponse = "";
    let lastMessageText = "";
    let sentMessageId: number | null = null;
    let lastUpdateTime = 0;
    const UPDATE_INTERVAL_MS = 2000; // Update every 2 seconds max

    // Stream the response
    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          fullResponse += delta.content;

          const now = Date.now();
          const timeSinceLastUpdate = now - lastUpdateTime;

          // Update message only if enough time has passed and we have meaningful changes
          if (
            timeSinceLastUpdate >= UPDATE_INTERVAL_MS &&
            fullResponse.length - lastMessageText.length > 10
          ) {
            if (sentMessageId) {
              // Edit existing message
              try {
                await bot.api.editMessageText({
                  chat_id: chatId,
                  message_id: sentMessageId,
                  text: fullResponse,
                });
                lastMessageText = fullResponse;
                lastUpdateTime = now;
              } catch (err) {
                // Ignore rate limit errors
                console.error("[ASK] Failed to edit message:", err);
              }
            } else {
              // Send initial message
              const sent = await ctx.send(fullResponse);
              sentMessageId = sent.id;
              lastMessageText = fullResponse;
              lastUpdateTime = now;
            }
          }
        }
      }
    }

    // Send final message if not sent yet
    if (!sentMessageId && fullResponse) {
      await ctx.send(fullResponse);
    } else if (sentMessageId && fullResponse !== lastMessageText) {
      // Final edit with complete response
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: sentMessageId,
        text: fullResponse,
      });
    }
  } catch (error) {
    console.error("[ASK] Error:", error);
    await ctx.send("❌ Ошибка при обработке вопроса. Попробуй еще раз.");
  }
}

/**
 * Build context from expenses
 */
function buildExpensesContext(
  expenses: Array<{
    date: string;
    category: string;
    amount: number;
    currency: string;
    eur_amount: number;
    comment: string;
  }>
): string {
  if (expenses.length === 0) {
    return "РАСХОДЫ: Нет данных о расходах.";
  }

  // Group by month
  const byMonth: Record<string, typeof expenses> = {};
  for (const expense of expenses) {
    const month = expense.date.substring(0, 7); // YYYY-MM
    if (!byMonth[month]) {
      byMonth[month] = [];
    }
    byMonth[month].push(expense);
  }

  let context = "РАСХОДЫ:\n\n";

  // Sort months descending
  const months = Object.keys(byMonth).sort().reverse();

  for (const month of months.slice(0, 6)) {
    // Last 6 months
    const monthExpenses = byMonth[month];
    if (!monthExpenses) continue;
    const total = monthExpenses.reduce((sum, e) => sum + e.eur_amount, 0);

    context += `${month}: €${total.toFixed(2)} всего\n`;

    // Group by category
    const byCategory: Record<string, number> = {};
    for (const expense of monthExpenses) {
      byCategory[expense.category] =
        (byCategory[expense.category] || 0) + expense.eur_amount;
    }

    // Sort categories by amount
    const categories = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10); // Top 10 categories

    for (const [category, amount] of categories) {
      context += `  - ${category}: €${amount.toFixed(2)}\n`;
    }
    context += "\n";
  }

  // Add recent expenses with details
  const recentExpenses = expenses.slice(0, 20);
  if (recentExpenses.length > 0) {
    context += "Последние 20 операций:\n";
  }
  for (const expense of recentExpenses) {
    context += `- ${expense.date}: ${
      expense.category
    } €${expense.eur_amount.toFixed(2)}`;
    if (expense.comment) {
      context += ` (${expense.comment})`;
    }
    context += "\n";
  }

  return context;
}

/**
 * Build context from budgets
 */
function buildBudgetsContext(
  budgets: Array<{
    category: string;
    month: string;
    limit_amount: number;
    currency: string;
  }>
): string {
  if (budgets.length === 0) {
    return "БЮДЖЕТЫ: Бюджеты не установлены.";
  }

  let context = "\n\nБЮДЖЕТЫ:\n\n";

  // Group by month
  const byMonth: Record<string, typeof budgets> = {};
  for (const budget of budgets) {
    const monthBudgets = byMonth[budget.month] || [];
    monthBudgets.push(budget);
    byMonth[budget.month] = monthBudgets;
  }

  // Sort months descending
  const months = Object.keys(byMonth).sort().reverse();

  for (const month of months.slice(0, 3)) {
    // Last 3 months
    const monthBudgets = byMonth[month];
    if (!monthBudgets) continue;
    const total = monthBudgets.reduce((sum, b) => sum + b.limit_amount, 0);

    context += `${month}: €${total.toFixed(2)} всего\n`;

    for (const budget of monthBudgets) {
      context += `  - ${budget.category}: €${budget.limit_amount.toFixed(2)}\n`;
    }
    context += "\n";
  }

  return context;
}
