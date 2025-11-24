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

  // Get user for storing chat history
  const userId = ctx.from.id;
  let user = database.users.findByTelegramId(userId);
  if (!user) {
    user = database.users.create({
      telegram_id: userId,
      group_id: group.id,
    });
  }

  // Get user info
  const userName = ctx.from.username || ctx.from.firstName || "User";
  const userFirstName = ctx.from.firstName || "";
  const userLastName = ctx.from.lastName || "";
  const userFullName = [userFirstName, userLastName].filter(Boolean).join(" ");

  // Save user question to chat history
  database.chatMessages.create({
    group_id: group.id,
    user_id: user.id,
    role: "user",
    content: `${userName}: ${question}`,
  });

  // Get recent chat history (last 5 messages)
  const recentMessages = database.chatMessages.getRecentMessages(group.id, 10); // 5 pairs

  // Get all expenses
  const allExpenses = database.expenses.findByGroupId(group.id, 100000);

  // Get all budgets
  const allBudgets = database.budgets.findByGroupId(group.id);

  // Build context from expenses and budgets
  const expensesContext = buildExpensesContext(allExpenses);
  const budgetsContext = buildBudgetsContext(allBudgets);

  // Get unique categories from expenses
  const uniqueCategories = Array.from(
    new Set(allExpenses.map((e) => e.category))
  ).sort();

  const systemPrompt = `Ты - ассистент для анализа финансов.
Отвечай на вопросы пользователя на основе этих данных. Будь точным и конкретным. Используй цифры из предоставленных данных.

ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ:
- Username: @${userName}
- Полное имя: ${userFullName || "не указано"}

ДОСТУПНЫЕ КАТЕГОРИИ РАСХОДОВ (${uniqueCategories.length} категорий):
${uniqueCategories.map((cat) => `- ${cat}`).join("\n")}

ВАЖНО: Если пользователь спрашивает про СВОИ расходы (например "мои расходы", "я потратил", "на что я тратил"),
отвечай только про расходы в категории с именем этого пользователя.
Попробуй найти категорию которая содержит одно из: "${userName}", "${userFirstName}", "${userLastName}", "${userFullName}".
Если такой категории нет - сообщи об этом и перечисли доступные категории.

ФОРМАТИРОВАНИЕ: Используй HTML теги для форматирования ответов:
- <b>жирный текст</b> для важных сумм и категорий
- <i>курсив</i> для дополнительной информации
- <code>код</code> для точных чисел и дат
- <a href="url">текст ссылки</a> для ссылок
- <u>подчеркнутый</u> для акцентов
- <blockquote>цитата</blockquote> для цитирования
НЕ используй другие теги. Экранируй символы < > & как &lt; &gt; &amp;

У тебя есть доступ к следующим данным:

Expenses Data:
${expensesContext}

Budget items Data:
${budgetsContext}`;

  // Build messages array with history
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Add recent chat history (excluding current question)
  for (const msg of recentMessages.slice(0, -1)) {
    messages.push({
      role: msg.role,
      content: msg.content,
    });
  }

  // Add current question with username (for context)
  messages.push({
    role: "user",
    content: `${userName}: ${question}`,
  });

  try {
    // Create streaming response
    const stream = client.chatCompletionStream({
      provider: "novita",
      model: "deepseek-ai/DeepSeek-R1-0528",
      messages: messages as any,
      max_tokens: 4000,
      temperature: 0.7,
    });

    let fullResponse = "";
    let lastMessageText = "";
    let sentMessageId: number | null = null;
    let lastUpdateTime = 0;
    let lastErrorTime = 0;
    const UPDATE_INTERVAL_MS = 5000; // Update every 5 seconds
    const ERROR_COOLDOWN_MS = 10000; // Wait 10 seconds after error

    // Stream the response with controlled updates
    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          fullResponse += delta.content;

          const now = Date.now();
          const timeSinceLastUpdate = now - lastUpdateTime;
          const timeSinceLastError = now - lastErrorTime;

          // Update message only if enough time has passed
          if (
            timeSinceLastUpdate >= UPDATE_INTERVAL_MS &&
            timeSinceLastError >= ERROR_COOLDOWN_MS &&
            fullResponse.length - lastMessageText.length > 10
          ) {
            // Truncate to fit Telegram limit (4096 chars) for intermediate updates
            const MAX_INTERMEDIATE_LENGTH = 4000;
            let textToSend = processThinkTags(fullResponse);
            let isTruncated = false;

            if (textToSend.length > MAX_INTERMEDIATE_LENGTH) {
              textToSend =
                textToSend.substring(0, MAX_INTERMEDIATE_LENGTH) + "...";
              isTruncated = true;
            }

            if (sentMessageId) {
              // Edit existing message
              try {
                await bot.api.editMessageText({
                  chat_id: chatId,
                  message_id: sentMessageId,
                  text: textToSend,
                  parse_mode: "HTML",
                });
                lastMessageText = textToSend;
                lastUpdateTime = now;
              } catch (err: any) {
                // If rate limited, wait longer
                if (err?.code === 429) {
                  console.error("[ASK] Rate limited, waiting...");
                  lastErrorTime = now;
                  // Wait the cooldown period
                  await new Promise((resolve) =>
                    setTimeout(resolve, ERROR_COOLDOWN_MS)
                  );
                } else if (err?.description?.includes("message is not modified")) {
                  // If message content is the same, delete and send new
                  console.log("[ASK] Message not modified, deleting and resending...");
                  try {
                    await bot.api.deleteMessage({
                      chat_id: chatId,
                      message_id: sentMessageId,
                    });
                    const sent = await ctx.send(textToSend, { parse_mode: "HTML" });
                    sentMessageId = sent.id;
                    lastMessageText = textToSend;
                    lastUpdateTime = now;
                  } catch (deleteErr) {
                    console.error("[ASK] Failed to delete/resend message:", deleteErr);
                  }
                } else {
                  console.error("[ASK] Failed to edit message:", err);
                }
              }
            } else if (!isTruncated) {
              // Send initial message only if not truncated
              // (if truncated, wait for final version)
              try {
                const sent = await ctx.send(textToSend, { parse_mode: "HTML" });
                sentMessageId = sent.id;
                lastMessageText = textToSend;
                lastUpdateTime = now;
              } catch (err) {
                console.error("[ASK] Failed to send message:", err);
              }
            }
          }
        }
      }
    }

    // Send final response
    if (!sentMessageId && fullResponse) {
      // No intermediate messages were sent, send final
      const chunks = splitIntoChunks(fullResponse, 4000);
      for (const chunk of chunks) {
        await ctx.send(chunk, { parse_mode: "HTML" });
      }
    } else if (sentMessageId && fullResponse !== lastMessageText) {
      // Update with final response
      const chunks = splitIntoChunks(fullResponse, 4000);

      if (chunks.length > 0 && chunks[0]) {
        // Edit first message with final version
        try {
          await bot.api.editMessageText({
            chat_id: chatId,
            message_id: sentMessageId,
            text: chunks[0],
            parse_mode: "HTML",
          });
        } catch (err: any) {
          if (err?.description?.includes("message is not modified")) {
            // If message content is the same, delete and send new
            console.log("[ASK] Final message not modified, deleting and resending...");
            try {
              await bot.api.deleteMessage({
                chat_id: chatId,
                message_id: sentMessageId,
              });
              await ctx.send(chunks[0], { parse_mode: "HTML" });
            } catch (deleteErr) {
              console.error("[ASK] Failed to delete/resend final message:", deleteErr);
            }
          } else {
            console.error("[ASK] Failed to edit final message:", err);
            // If edit failed for other reason, send as new message
            await ctx.send(chunks[0], { parse_mode: "HTML" });
          }
        }

        // Send remaining chunks as new messages
        for (let i = 1; i < chunks.length; i++) {
          const chunk = chunks[i];
          if (chunk) {
            await ctx.send(chunk, { parse_mode: "HTML" });
          }
        }
      }
    }

    // Save assistant response to chat history
    database.chatMessages.create({
      group_id: group.id,
      user_id: user.id,
      role: "assistant",
      content: fullResponse,
    });

    // Prune old messages (keep last 50)
    database.chatMessages.pruneOldMessages(group.id, 50);
  } catch (error) {
    console.error("[ASK] Error:", error);
    await ctx.send("❌ Ошибка при обработке вопроса. Попробуй еще раз.");
  }
}

/**
 * Process think tags - replace them with human-readable text
 */
function processThinkTags(text: string): string {
  // Replace <think> with start marker
  text = text.replace(/<think>/g, "🤔 <i>Бот начал размышление</i>\n\n");
  // Replace </think> with end marker
  text = text.replace(/<\/think>/g, "\n\n💬 <i>Бот начал формулировать ответ</i>");
  return text;
}

/**
 * Split text into chunks respecting Telegram message limit
 */
function splitIntoChunks(text: string, maxLength: number): string[] {
  // Process think tags first
  text = processThinkTags(text);

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = "";

  // Split by paragraphs first
  const paragraphs = text.split("\n\n");

  for (const paragraph of paragraphs) {
    if ((currentChunk + paragraph).length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }

      // If single paragraph is too long, split by sentences
      if (paragraph.length > maxLength) {
        const sentences = paragraph.split(/([.!?]\s+)/);
        for (const sentence of sentences) {
          if ((currentChunk + sentence).length > maxLength) {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
              currentChunk = sentence;
            } else {
              // Single sentence too long, split by words
              const words = sentence.split(" ");
              for (const word of words) {
                if ((currentChunk + " " + word).length > maxLength) {
                  chunks.push(currentChunk.trim());
                  currentChunk = word;
                } else {
                  currentChunk += " " + word;
                }
              }
            }
          } else {
            currentChunk += sentence;
          }
        }
      } else {
        currentChunk = paragraph;
      }
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
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

  // Add ALL expenses with details (not just last 20!)
  context += `\nВсе операции (всего: ${expenses.length}):\n`;
  for (const expense of expenses) {
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
