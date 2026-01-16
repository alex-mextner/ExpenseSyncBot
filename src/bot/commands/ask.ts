import { InferenceClient } from "@huggingface/inference";
import type { Bot } from "gramio";
import { format } from "date-fns";
import { env } from "../../config/env";
import { database } from "../../database";
import { formatExchangeRatesForAI, convertCurrency } from "../../services/currency/converter";
import type { CurrencyCode } from "../../config/constants";
import type { Ctx } from "../types";

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

  // Check topic restriction
  const messageThreadId = (ctx as any).payload?.message_thread_id as number | undefined;
  if (group.active_topic_id && messageThreadId !== group.active_topic_id) {
    console.log(`[ASK] Ignoring: question from topic ${messageThreadId || 'general'}, bot listens to topic ${group.active_topic_id}`);
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

  // Get budgets for current month (with fallback to latest available)
  const currentMonthForBudgets = format(new Date(), "yyyy-MM");
  const allBudgets = database.budgets.getAllBudgetsForMonth(group.id, currentMonthForBudgets);

  // Build context from expenses and budgets
  const expensesContext = buildExpensesContext(allExpenses);
  const budgetsContext = buildBudgetsContext(allBudgets, allExpenses, currentMonthForBudgets);

  // Get unique categories from expenses
  const uniqueCategories = Array.from(
    new Set(allExpenses.map((e) => e.category))
  ).sort();

  // Get current date info
  const now = new Date();
  const currentMonth = now.toISOString().substring(0, 7); // YYYY-MM
  const currentDate = now.toISOString().split("T")[0]; // YYYY-MM-DD

  // Build current month category summary
  const currentMonthExpenses = allExpenses.filter((e) =>
    e.date.startsWith(currentMonth)
  );
  const categoryTotals: Record<string, number> = {};
  for (const expense of currentMonthExpenses) {
    categoryTotals[expense.category] =
      (categoryTotals[expense.category] || 0) + expense.eur_amount;
  }
  const sortedCategories = Object.entries(categoryTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15); // Top 15 categories

  let currentMonthSummary = `\nТРАТЫ ЗА ТЕКУЩИЙ МЕСЯЦ (${currentMonth}) ПО КАТЕГОРИЯМ:\n`;
  if (sortedCategories.length > 0) {
    const totalMonth = sortedCategories.reduce(
      (sum, [_, amount]) => sum + amount,
      0
    );
    currentMonthSummary += `Всего потрачено: €${totalMonth.toFixed(2)}\n`;
    for (const [category, amount] of sortedCategories) {
      currentMonthSummary += `- ${category}: €${amount.toFixed(2)}\n`;
    }
  } else {
    currentMonthSummary += "Нет трат за текущий месяц.\n";
  }

  const ratesContext = formatExchangeRatesForAI();

  let systemPrompt = `Ты - ассистент для анализа финансов.
Отвечай на вопросы пользователя на основе этих данных. Будь точным и конкретным. Используй цифры из предоставленных данных.

ТЕКУЩАЯ ДАТА: ${currentDate}
ВАЖНО: Бюджеты привязаны к календарным месяцам. Когда анализируешь бюджет, смотри данные за текущий месяц (${currentMonth}).
${currentMonthSummary}
${ratesContext}
ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ:
- Username: @${userName}
- Полное имя: ${userFullName || "не указано"}

ДОСТУПНЫЕ КАТЕГОРИИ РАСХОДОВ (${uniqueCategories.length} категорий):
${uniqueCategories.map((cat) => `- ${cat}`).join("\n")}

ВАЖНО: Если пользователь спрашивает про СВОИ расходы (например "мои расходы", "я потратил", "на что я тратил"),
отвечай только про расходы в категории с именем этого пользователя.
Попробуй найти категорию которая содержит одно из: "${userName}", "${userFirstName}", "${userLastName}", "${userFullName}".
Если такой категории нет - сообщи об этом и перечисли доступные категории.

ФОРМАТИРОВАНИЕ: Используй ТОЛЬКО HTML теги для форматирования ответов:
- <b>жирный текст</b> для важных сумм и категорий
- <i>курсив</i> для дополнительной информации
- <code>код</code> для точных чисел и дат
- <a href="url">текст ссылки</a> для ссылок
- <u>подчеркнутый</u> для акцентов
- <blockquote>цитата</blockquote> для цитирования

ВАЖНО: НЕ используй Markdown синтаксис (**, *, \`, ##, ###, []() и т.д.)!
ВАЖНО: НЕ используй другие HTML теги кроме перечисленных выше!
Экранируй символы < > & как &lt; &gt; &amp;
ВАЖНО: НЕ выдумывай ссылки! Если нужна ссылка - используй только реальные URL которые есть в данных.

У тебя есть доступ к следующим данным:

Expenses Data:
${expensesContext}

Budget items Data:
${budgetsContext}`;

  // Add custom prompt if set
  if (group.custom_prompt) {
    systemPrompt += `\n\n=== КАСТОМНЫЕ ИНСТРУКЦИИ ГРУППЫ ===\n${group.custom_prompt}`;
  }

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

  console.log("[ASK] System prompt:", systemPrompt);

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
              textToSend = safelyTruncateHTML(
                textToSend,
                MAX_INTERMEDIATE_LENGTH
              );
              isTruncated = true;
            }

            if (sentMessageId) {
              // Skip edit if text is actually the same after processing
              if (textToSend === lastMessageText) {
                continue;
              }
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
                } else if (
                  err?.description?.includes("message is not modified")
                ) {
                  // Shouldn't happen after the check above, but just in case
                  console.log("[ASK] Message not modified (unexpected)");
                  lastMessageText = textToSend;
                  lastUpdateTime = now;
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
    } else if (sentMessageId) {
      // Update with final response
      const chunks = splitIntoChunks(fullResponse, 4000);

      // Edit first message only if it actually differs from last sent message
      if (chunks.length > 0 && chunks[0] && chunks[0] !== lastMessageText) {
        try {
          await bot.api.editMessageText({
            chat_id: chatId,
            message_id: sentMessageId,
            text: chunks[0],
            parse_mode: "HTML",
          });
        } catch (err: any) {
          if (err?.description?.includes("message is not modified")) {
            // Shouldn't happen after the check above, but just in case
            console.log("[ASK] Final message not modified (unexpected)");
          } else {
            console.error("[ASK] Failed to edit final message:", err);
            // If edit failed for other reason, send as new message
            await ctx.send(chunks[0], { parse_mode: "HTML" });
          }
        }
      }

      // Send remaining chunks as new messages (regardless of first chunk edit)
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk) {
          await ctx.send(chunk, { parse_mode: "HTML" });
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

    // Maybe send daily advice (20% probability)
    await maybeSendDailyAdvice(ctx, group.id);
  } catch (error) {
    console.error("[ASK] Error:", error);
    await ctx.send("❌ Ошибка при обработке вопроса. Попробуй еще раз.");
  }
}

/**
 * Escape HTML entities to prevent parsing errors
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Process think tags - replace them with human-readable text
 * Completed blocks -> expandable blockquote
 * Streaming blocks -> visible with escape
 */
function processThinkTags(text: string): string {
  // Completed think blocks -> expandable blockquote
  text = text.replace(/<think>([\s\S]*?)<\/think>/g, (_, content) => {
    const escaped = escapeHtml(content);
    return `<blockquote expandable>🤔 <b>Размышления</b>\n${escaped}</blockquote>\n`;
  });

  // Unclosed <think> (streaming) - show as-is with escape
  text = text.replace(/<think>([\s\S]*)$/, (_, content) => {
    const escaped = escapeHtml(content);
    return `🤔 <i>Бот думает...</i>\n${escaped}`;
  });

  return text;
}

/**
 * Process think tags for advice - completely remove thinking content
 */
function processThinkTagsForAdvice(text: string): string {
  // Replace entire <think>...</think> blocks with "Бот думает..."
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "<i>Бот думает...</i>\n\n");
  // Clean up extra newlines
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * Safely truncate HTML text to maxLength ensuring valid HTML
 */
function safelyTruncateHTML(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Truncate to max length
  let truncated = text.substring(0, maxLength);

  // Find last complete character (not in middle of tag)
  // If we're inside a tag, backtrack to before the tag started
  const lastTagStart = truncated.lastIndexOf("<");
  const lastTagEnd = truncated.lastIndexOf(">");

  if (lastTagStart > lastTagEnd) {
    // We're in the middle of a tag, cut before it
    truncated = truncated.substring(0, lastTagStart);
  }

  // Now close any unclosed tags
  const openTags: string[] = [];
  const tagRegex = /<\/?([a-z]+)[^>]*>/gi;
  let match: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: needed for regex iteration
  while ((match = tagRegex.exec(truncated)) !== null) {
    const fullTag = match[0];
    const tagName = match[1];

    if (!tagName) continue;

    if (fullTag.startsWith("</")) {
      // Closing tag - remove from stack
      const lastIndex = openTags.lastIndexOf(tagName);
      if (lastIndex !== -1) {
        openTags.splice(lastIndex, 1);
      }
    } else if (!fullTag.endsWith("/>")) {
      // Opening tag (not self-closing)
      openTags.push(tagName);
    }
  }

  // Close all unclosed tags in reverse order
  for (let i = openTags.length - 1; i >= 0; i--) {
    const tag = openTags[i];
    if (tag) {
      truncated += `</${tag}>`;
    }
  }

  return `${truncated}...`;
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
 * Build context from budgets with remaining calculations
 * Budgets are already resolved for current month (with fallback to latest)
 * Expenses are converted from EUR to budget currency for comparison
 */
function buildBudgetsContext(
  budgets: Array<{
    category: string;
    month: string;
    limit_amount: number;
    currency: string;
  }>,
  expenses: Array<{
    date: string;
    category: string;
    eur_amount: number;
  }>,
  currentMonth: string
): string {
  if (budgets.length === 0) {
    return "БЮДЖЕТЫ: Бюджеты не установлены.";
  }

  // Calculate expenses by category for current month (in EUR)
  const monthExpensesEur: Record<string, number> = {};
  for (const expense of expenses) {
    if (expense.date.startsWith(currentMonth)) {
      monthExpensesEur[expense.category] =
        (monthExpensesEur[expense.category] || 0) + expense.eur_amount;
    }
  }

  let context = "\n\nБЮДЖЕТЫ И ОСТАТКИ:\n\n";
  context += `${currentMonth} (ТЕКУЩИЙ МЕСЯЦ):\n\n`;

  // Group budgets by currency for totals
  const byCurrency: Record<string, { limit: number; spent: number }> = {};

  context += `  По категориям:\n`;
  for (const budget of budgets) {
    const currency = budget.currency as CurrencyCode;
    const spentEur = monthExpensesEur[budget.category] || 0;
    // Convert EUR spent to budget currency
    const spentInCurrency = convertCurrency(spentEur, "EUR", currency);
    const remaining = budget.limit_amount - spentInCurrency;
    const percent = budget.limit_amount > 0
      ? ((spentInCurrency / budget.limit_amount) * 100).toFixed(0)
      : "0";
    const status = remaining < 0
      ? "⚠️ ПРЕВЫШЕН"
      : remaining < budget.limit_amount * 0.1
        ? "⚠️ почти исчерпан"
        : "";

    context += `  - ${budget.category}: лимит ${budget.limit_amount.toFixed(2)} ${currency}, потрачено ${spentInCurrency.toFixed(2)} ${currency} (${percent}%), остаток ${remaining.toFixed(2)} ${currency} ${status}\n`;

    // Accumulate for totals by currency
    if (!byCurrency[currency]) {
      byCurrency[currency] = { limit: 0, spent: 0 };
    }
    byCurrency[currency].limit += budget.limit_amount;
    byCurrency[currency].spent += spentInCurrency;
  }

  // Add totals by currency
  context += `\n  Итого по валютам:\n`;
  for (const [currency, totals] of Object.entries(byCurrency)) {
    const remaining = totals.limit - totals.spent;
    const percent = totals.limit > 0 ? ((totals.spent / totals.limit) * 100).toFixed(1) : "0";
    context += `  - ${currency}: бюджет ${totals.limit.toFixed(2)}, потрачено ${totals.spent.toFixed(2)} (${percent}%), остаток ${remaining.toFixed(2)}\n`;
  }

  context += "\n";
  return context;
}

/**
 * /advice command handler - request financial advice explicitly
 */
export async function handleAdviceCommand(ctx: Ctx["Command"]): Promise<void> {
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

  // Generate advice without probability check
  await sendDailyAdvice(ctx, group.id);
}

/**
 * Send daily advice with 20% probability
 * Includes current spending and budget stats
 */
export async function maybeSendDailyAdvice(
  ctx: Ctx["Message"],
  groupId: number
): Promise<void> {
  // 20% probability
  if (Math.random() > 0.2) {
    return;
  }

  await sendDailyAdvice(ctx, groupId);
}

/**
 * Internal function to generate and send advice
 */
async function sendDailyAdvice(
  ctx: Ctx["Message"],
  groupId: number
): Promise<void> {
  try {
    // Get current month expenses and budgets
    const now = new Date();
    const currentMonth = now.toISOString().substring(0, 7); // YYYY-MM
    const currentDate = now.toISOString().split("T")[0]; // YYYY-MM-DD

    const allExpenses = database.expenses.findByGroupId(groupId, 1000);
    const currentMonthExpenses = allExpenses.filter((e) =>
      e.date.startsWith(currentMonth)
    );
    const totalSpent = currentMonthExpenses.reduce(
      (sum, e) => sum + e.eur_amount,
      0
    );

    const currentMonthBudget = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);

    // Group budgets by currency
    const budgetsByCurrency: Record<string, number> = {};
    for (const b of currentMonthBudget) {
      budgetsByCurrency[b.currency] = (budgetsByCurrency[b.currency] || 0) + b.limit_amount;
    }
    const budgetLines = Object.entries(budgetsByCurrency)
      .map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`)
      .join(", ");

    // Group expenses by category
    const categoryTotals: Record<string, number> = {};
    for (const expense of currentMonthExpenses) {
      categoryTotals[expense.category] =
        (categoryTotals[expense.category] || 0) + expense.eur_amount;
    }

    // Sort categories by amount descending
    const sortedCategories = Object.entries(categoryTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10); // Top 10 categories

    // Build expense details by category
    let expenseDetails = "\n\nТраты по категориям:\n";
    for (const [category, amount] of sortedCategories) {
      expenseDetails += `- ${category}: €${amount.toFixed(2)}\n`;
    }

    // Build recent expenses details (last 10 operations)
    const recentExpenses = currentMonthExpenses
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 10);

    let recentExpensesDetails = "\n\nПоследние операции:\n";
    for (const expense of recentExpenses) {
      recentExpensesDetails += `- ${expense.date}: ${
        expense.category
      } €${expense.eur_amount.toFixed(2)}`;
      if (expense.comment) {
        recentExpensesDetails += ` (${expense.comment})`;
      }
      recentExpensesDetails += "\n";
    }

    // Build stats context
    const statsContext = `
Текущая дата: ${currentDate}
Текущий месяц: ${currentMonth}
Потрачено: €${totalSpent.toFixed(2)}
Бюджет: ${budgetLines || "не установлен"}
Количество операций: ${
      currentMonthExpenses.length
    }${expenseDetails}${recentExpensesDetails}

${formatExchangeRatesForAI()}
`;

    // Get group for custom prompt
    const group = database.groups.findById(groupId);

    // Generate advice using AI
    let advicePrompt = `Ты - мудрый финансовый советник с философским взглядом на жизнь.

Дай ОДИН краткий философский совет дня (1-2 предложения), который будет уместен для людей, которые следят за своими финансами.
Совет должен быть мотивирующим, но реалистичным. Избегай банальностей типа "экономьте деньги".

Используй ТОЛЬКО HTML теги для форматирования: <b>, <i>, <code>, <blockquote>.
НЕ используй Markdown синтаксис!
НЕ выдумывай ссылки! Не используй теги <a> если нет реальных URL.

Статистика трат за текущий месяц:
${statsContext}

Дай совет который учитывает эту статистику (например, если бюджет почти исчерпан, или наоборот осталось много).`;

    // Add custom prompt if set
    if (group?.custom_prompt) {
      advicePrompt += `\n\n=== КАСТОМНЫЕ ИНСТРУКЦИИ ГРУППЫ ===\n${group.custom_prompt}`;
    }

    const response = await client.chatCompletion({
      provider: "novita",
      model: "deepseek-ai/DeepSeek-R1-0528",
      messages: [{ role: "user", content: advicePrompt }],
      max_tokens: 300,
      temperature: 0.9,
    });

    const advice = response.choices[0]?.message?.content || "";
    if (!advice) return;

    // Clean up think tags - for advice, remove thinking content completely
    const cleanAdvice = processThinkTagsForAdvice(advice);

    // Send advice with stats
    const message = `\n\n💡 <b>Совет дня</b>\n\n${cleanAdvice}`;

    await ctx.send(message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("[ADVICE] Failed to generate daily advice:", error);
    // Silently fail - advice is not critical
  }
}
