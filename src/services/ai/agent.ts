/**
 * ExpenseBotAgent — OpenAI SDK agent with tool calling for expense management
 *
 * Streams text to Telegram, executes tools, and manages the conversation loop.
 * Only final text responses are saved to chat history (not intermediate tool_use rounds).
 */

import { format } from 'date-fns';
import type { Bot } from 'gramio';
import type OpenAI from 'openai';
import { formatCommandsForPrompt } from '../../bot/command-descriptions';
import { env } from '../../config/env';
import type { ChatMessage } from '../../database/types';
import { AgentError } from '../../errors';
import { createLogger } from '../../utils/logger.ts';
import { AiDebugLogger, type AiDebugRunContext } from './debug-logger';
import { validateResponse } from './response-validator';
import {
  aiStreamRound,
  formatApiError,
  getBackoffDelay,
  isRetryableError,
  type StreamCallbacks,
  type StreamRoundResult,
} from './streaming';
import { isSkipSignal, TelegramStreamWriter } from './telegram-stream';
import { executeTool } from './tool-executor';
import { TOOL_DEFINITIONS } from './tools';
import type { AgentContext, ToolCallResult } from './types';

const logger = createLogger('agent');

/** Singleton debug logger — writes full AI conversations to logs/chats/ when enabled */
export const aiDebugLogger = new AiDebugLogger(env.AI_DEBUG_LOGS, 'logs');

const MAX_TOOL_ROUNDS = 10;
const AGENT_TIMEOUT_MS = 60_000;
const MAX_API_RETRIES = 2; // 3 attempts total (1 initial + 2 retries)

export class ExpenseBotAgent {
  private ctx: AgentContext;

  constructor(_apiKey: string, ctx: AgentContext) {
    this.ctx = ctx;
  }

  /**
   * Run the full agent loop: stream text, execute tools, update Telegram message
   */
  async run(userMessage: string, conversationHistory: ChatMessage[], bot: Bot): Promise<string> {
    const writer = new TelegramStreamWriter(bot, this.ctx.chatId);
    const debugCtx = aiDebugLogger.createRunContext(
      this.ctx.userId,
      this.ctx.chatId,
      this.ctx.userName,
      this.ctx.userFullName,
      userMessage,
    );

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.buildSystemPrompt() },
      ...this.buildHistoryMessages(conversationHistory),
      { role: 'user', content: userMessage },
    ];

    logger.info(`[AGENT] Starting: model=${env.AI_MODEL}`);
    logger.info(`[AGENT] Question: "${userMessage.substring(0, 150)}"`);

    debugCtx?.logSystemPrompt(messages[0]?.content as string);
    debugCtx?.logHistory(conversationHistory.map((m) => ({ role: m.role, content: m.content })));

    const toolCallNames: string[] = [];

    try {
      const result = await this.runWithRetry(messages, writer, debugCtx, toolCallNames);
      let { text: finalText } = result;
      let { toolCount: totalToolCalls } = result;

      // Skip signal — bot chose to stay silent
      if (isSkipSignal(finalText) && !this.ctx.isMention) {
        logger.info('[AGENT] Skip signal — staying silent');
        await writer.deleteSentMessage();
        return '';
      }

      // --- Validation pass (only when no tools were called) ---
      if (toolCallNames.length === 0) {
        const validation = await validateResponse(env.ANTHROPIC_API_KEY, {
          userMessage,
          toolCalls: toolCallNames,
          response: finalText,
        });

        if (!validation.approved) {
          logger.info(`[AGENT] Validation REJECTED: ${validation.reason}`);

          writer.reset();
          toolCallNames.length = 0;

          const retryController = new AbortController();
          const retryTimeout = setTimeout(() => retryController.abort(), AGENT_TIMEOUT_MS);

          messages.push({ role: 'assistant', content: finalText });
          messages.push({
            role: 'user',
            content: `[SYSTEM] Your previous response was rejected by the quality validator. Reason: ${validation.reason}. You MUST call the appropriate tools and re-answer the question properly. Do NOT repeat the same mistake.`,
          });

          try {
            const retry = await this.runAgentLoop(
              messages,
              writer,
              debugCtx,
              retryController.signal,
              toolCallNames,
            );
            finalText = retry.text;
            totalToolCalls = retry.toolCount;

            logger.info(
              `[AGENT] Retry response (${finalText.length} chars): "${finalText.substring(0, 200)}${finalText.length > 200 ? '...' : ''}"`,
            );
          } finally {
            clearTimeout(retryTimeout);
          }
        } else {
          logger.info('[AGENT] Validation APPROVED');
        }
      }

      debugCtx?.logAiText(finalText);
      debugCtx?.logFinal(finalText, totalToolCalls);
      debugCtx?.flush();

      await writer.sendRemainingChunks();
      return finalText;
    } catch (error) {
      await writer.deleteSentMessage();

      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutMsg = '\u23f3 Время ожидания истекло. Попробуйте ещё раз.';
        await this.sendErrorToUser(bot, timeoutMsg);
        throw new AgentError(timeoutMsg);
      }

      if (error instanceof Error && 'status' in error) {
        const errorMsg = formatApiError(error);
        await this.sendErrorToUser(bot, errorMsg);
        throw new AgentError(errorMsg);
      }

      const networkCodes = ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH'];
      const errCode = (error as NodeJS.ErrnoException).code;
      if (errCode && networkCodes.includes(errCode)) {
        const msg = '\u274c Ошибка сети. Попробуйте позже.';
        await this.sendErrorToUser(bot, msg);
        throw new AgentError(msg);
      }
      const errStatus = (error as { status?: number }).status;
      if (typeof errStatus === 'number') {
        const msg = '\u274c Ошибка AI. Попробуйте позже.';
        await this.sendErrorToUser(bot, msg);
        throw new AgentError(msg);
      }
      throw error;
    }
  }

  /**
   * Retry wrapper: runs runAgentLoop with exponential backoff for transient API errors.
   */
  private async runWithRetry(
    messages: OpenAI.ChatCompletionMessageParam[],
    writer: TelegramStreamWriter,
    debugCtx: AiDebugRunContext | null,
    toolCallNames: string[],
  ): Promise<{ text: string; toolCount: number }> {
    for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

      try {
        return await this.runAgentLoop(
          messages,
          writer,
          debugCtx,
          controller.signal,
          toolCallNames,
        );
      } catch (error) {
        if (attempt < MAX_API_RETRIES && isRetryableError(error)) {
          const delay = getBackoffDelay(attempt, error);
          const errName = error instanceof Error ? error.message : String(error);
          logger.warn(
            `[AGENT] Attempt ${attempt + 1}/${MAX_API_RETRIES + 1} failed (${errName}), retrying in ${delay}ms`,
          );
          writer.reset();
          toolCallNames.length = 0;
          await this.sleep(delay);
          continue;
        }

        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error('[AGENT] Retry loop exhausted');
  }

  protected async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async sendErrorToUser(bot: Bot, message: string): Promise<void> {
    try {
      await bot.api.sendMessage({ chat_id: this.ctx.chatId, text: message });
    } catch {
      // Best-effort error notification
    }
  }

  /**
   * Execute the streaming agent loop: stream text, call tools, repeat until done.
   */
  private async runAgentLoop(
    messages: OpenAI.ChatCompletionMessageParam[],
    writer: TelegramStreamWriter,
    debugCtx: AiDebugRunContext | null,
    signal: AbortSignal,
    toolCallNames: string[],
  ): Promise<{ text: string; toolCount: number }> {
    let totalToolCalls = 0;
    let continueLoop = true;
    let round = 0;

    while (continueLoop && round < MAX_TOOL_ROUNDS) {
      round++;
      debugCtx?.logRound(round);

      const callbacks: StreamCallbacks = {
        onTextDelta: (text) => writer.appendText(text),
        onToolCallStart: (name) => writer.setToolLabel(name, {}),
      };

      const result: StreamRoundResult = await aiStreamRound(
        { messages, tools: TOOL_DEFINITIONS, maxTokens: 4096, temperature: 0.3, signal },
        callbacks,
      );

      // Execute tool calls
      const toolResults: ToolCallResult[] = [];

      for (const tc of result.toolCalls) {
        const input = JSON.parse(tc.arguments || '{}');

        logger.info(`[AGENT] Tool call: ${tc.name} ${JSON.stringify(input)}`);
        debugCtx?.logToolCall(tc.name, input);

        writer.setToolLabel(tc.name, input);
        await writer.flush(true);

        const toolResult = await executeTool(tc.name, input, this.ctx);

        if (toolResult.success) {
          const preview = toolResult.output ? toolResult.output.substring(0, 300) : '(no output)';
          const total = toolResult.output?.length ?? 0;
          logger.info(
            `[AGENT] Tool result: ${tc.name} OK (${total} chars) preview: ${preview}${total > 300 ? '...' : ''}`,
          );
        } else {
          logger.info(`[AGENT] Tool result: ${tc.name} ERR: ${toolResult.error}`);
        }

        debugCtx?.logToolResult(
          tc.name,
          toolResult.success,
          toolResult.output,
          toolResult.error,
          toolResult.data,
          toolResult.summary,
        );
        totalToolCalls++;
        toolCallNames.push(tc.name);

        writer.markToolResult(toolResult.success);

        toolResults.push({ id: tc.id, result: toolResult });
      }

      if (toolResults.length > 0) {
        writer.commitIntermediate();

        // Add assistant message with tool calls to history
        messages.push(result.assistantMessage);

        // Add tool results (OpenAI format: role=tool)
        for (const tr of toolResults) {
          const content = tr.result.success
            ? tr.result.data !== undefined
              ? `${tr.result.summary ? `${tr.result.summary}\n` : ''}${JSON.stringify(tr.result.data)}`
              : tr.result.output || 'Success'
            : `Error: ${tr.result.error}`;

          messages.push({ role: 'tool', tool_call_id: tr.id, content });
        }
        continueLoop = true;
      } else {
        continueLoop = false;
      }
    }

    await writer.finalize();

    const finalText = writer.getText();
    logger.info(
      `[AGENT] Final response (${finalText.length} chars): "${finalText.substring(0, 200)}${finalText.length > 200 ? '...' : ''}"`,
    );

    return { text: finalText, toolCount: totalToolCalls };
  }

  /**
   * Build compact system prompt (no data dumps -- data comes from tools)
   */
  private buildSystemPrompt(): string {
    const now = new Date();
    const currentDate = format(now, 'yyyy-MM-dd');
    const currentMonth = format(now, 'yyyy-MM');

    let prompt = `You are a financial assistant for a Telegram expense tracking group.

CURRENT DATE: ${currentDate}
CURRENT MONTH: ${currentMonth}

CURRENT USER:
- Username: @${this.ctx.userName}
- Full name: ${this.ctx.userFullName}

## DATA INTEGRITY — CRITICAL
You MUST call the appropriate tool before answering any question about expenses or budgets.
You MUST use ONLY the exact numbers, dates, categories, and comments returned by the tool.
You MUST NEVER invent, assume, or extrapolate any expense data.
If the tool returns no data for a period — say so. Do NOT fill in plausible-sounding entries.
When listing individual expenses, copy the exact amount, date, and comment from the tool result. Do NOT paraphrase or round.
If an expense has no comment in the tool result, show nothing — do NOT invent a comment.

## TOOL USAGE
1. Expense questions → call get_expenses with the relevant period/category filter. Results are paginated (100/page). Check total_pages in the response — if > 1, fetch remaining pages.
2. Budget questions → call get_budgets.
3. Adding an expense → call add_expense. NEVER say "done" without calling the tool.
4. Deleting an expense → call get_expenses first (to find the ID), confirm with the user, then call delete_expense.
5. User asks about "their" expenses → filter by a category matching their name.
6. For ANY aggregation question (total for a period, breakdown by category, "what did X spend", "how much in total", "по итогам", "сводка по месяцам") → ALWAYS use summary_only: true in get_expenses. The tool returns pre-calculated totals per category WITH stats (count, total, avg, median, min, max). For multi-period comparison, pass an array of periods — e.g. period: ["2025-11", "2025-12", "2026-01"]. NEVER call get_expenses multiple times for different periods — use a single call with an array. Same for get_budgets: pass month as array for multi-month comparison.
7. ANY arithmetic whatsoever → ALWAYS call calculate. EXCEPTION: stats already computed by get_expenses (count, total, avg, median, min, max) do NOT need recalculation — use them directly from the tool response. The calculate tool uses live exchange rates for currency conversion.
7a. When referring to "average" or "typical" spending → use MEDIAN from the stats, not avg. Median better represents the typical expense because it's not skewed by outliers. Avg is available for context but median should be the default "average" in your replies.
8. After calling set_budget or delete_budget → ALWAYS call get_budgets immediately to get fresh data before writing the response. Never use values from a previous get_budgets call after modifying budgets.
8a. BULK BUDGET SETTING: when the user asks to set budgets for multiple categories at once, FIRST call get_budgets to see which categories already have budgets this month. After setting all requested budgets, compare the list of existing budget categories with the ones you just set. If there are categories with existing budgets that were NOT mentioned by the user → ask whether they should be zeroed out (set to 0) or left unchanged. List those categories with their current limits. Do NOT silently leave old budgets in place — the user may have intended to replace the entire budget plan.
9. Bank balance questions → call get_bank_balances WITHOUT bank_name filter (omit it). If result data is empty, check the summary field and relay it to the user exactly — do NOT say the bank is not connected if the summary says otherwise. NEVER suggest /connect for bank issues — /connect is for Google Sheets only. For bank issues use /bank. If the user asks about disabled/excluded accounts → add include_excluded: true.
10. Bank transaction history → call get_bank_transactions.
11. Missing/unmatched bank expenses → call find_missing_expenses.
12. User asks you to remember, note, or save ANYTHING — a fact about a person, an account, a rule, a preference, any context — → call set_custom_prompt with mode="append". NEVER say "got it", "noted", "запомнил", or "remembered" without calling the tool first. This includes phrases like "запомни что", "note that", "keep in mind", "учти что".
13. Recurring patterns → call get_recurring_patterns. To manage (pause/resume/dismiss/delete) → call manage_recurring_pattern.

## FORMATTING
Use ONLY these HTML tags (no Markdown, no ** or *):
- <b>bold</b> for amounts and categories
- <i>italic</i> for secondary info
- <code>code</code> for exact numbers and IDs
Escape < > & as &lt; &gt; &amp;
Do NOT use <blockquote>, <u>, or any other tags — they are reserved for system UI.
Do NOT invent links.
NEVER use Markdown tables (|---|---| syntax) in chat messages — Telegram does not render them.
When you have tabular data: ALWAYS call render_table with the full Markdown table AND present the same data as a bullet list in your text reply. Both actions are mandatory — never skip either.
When displaying large amounts (≥ 1 million): prefer the suffix form — "1.5 млн RSD" over "1500000.00 RSD". Tool results include both forms (e.g. "1500000.00 (1.5 млн) RSD") — use the suffix form in your reply.

## BOT CAPABILITIES — STRICTLY ONLY THESE
This bot tracks expenses and budgets. It can:
- Record, view, delete expenses (amount + currency + category + comment)
- Track budgets per category/month
- Sync with Google Sheets (/sync, /push)
- Scan receipt photos (QR and OCR)
- Give financial advice and analytics
- Detect and track recurring monthly expenses (rent, subscriptions, etc.)
- Calculate with currency conversion (calculator tool)
- Connect bank accounts (/bank) to auto-import transactions with AI categorization
- View real-time bank account balances (get_bank_balances tool)
- Find bank transactions not yet recorded as expenses (find_missing_expenses tool)

IMPORTANT: /connect is for Google Sheets integration only. /bank is for bank account integration (TBC, Kaspi, etc.).

The bot CANNOT:
- Create events, reminders, or calendar entries
- Schedule tasks or appointments
- Send notifications at specific times
- Manage contacts, notes, or to-do lists
- Process voice messages
- Do anything unrelated to expense tracking

NEVER mention, suggest, or describe features that are NOT listed above. If a user asks for something outside these capabilities — say directly that the bot doesn't support it.

When a user asks "что ты умеешь?", "what can you do?", or similar — list your capabilities in plain language without mentioning tool names or technical details. Example:
- Записывать и удалять расходы (сумма, валюта, категория, комментарий)
- Вести бюджеты по категориям и месяцам
- Сканировать чеки по фото (просто скинь фотку)
- Показывать статистику и аналитику расходов
- Синхронизировать данные с Google Sheets (в обе стороны)
- Подключать банки и автоматически импортировать транзакции
- Показывать балансы банковских счетов
- Находить банковские транзакции, которые ещё не записаны как расходы
- Конвертировать валюты и считать любые выражения
- Отслеживать повторяющиеся расходы (аренда, подписки и т.д.)
- Давать финансовые советы и отвечать на вопросы о тратах
- Запоминать заметки и правила для группы
- Отправлять фидбек и баг-репорты администратору

## AVAILABLE COMMANDS
${formatCommandsForPrompt()}

## WHEN TO STAY SILENT
CRITICAL: The skip marker is EXACTLY the 6-character string [SKIP]. Not [ПРОПУСК], not [skip], not (skip), not any variation. ALWAYS output [SKIP] in English, in square brackets, uppercase. This is a machine-parsed token — do not translate it.
When you decide to stay silent, output [SKIP] and NOTHING ELSE — no reasoning, no emoji, no "Готово", no commentary before or after.
Stay silent ([SKIP]) when:
- Someone makes a statement, shares a thought, or talks about plans ("надо будет обсудить", "хочу разобраться", "интересно было бы", "мог бы", "было бы хорошо")
- Casual acknowledgements: "ok", "thanks", "понял", "окей", "хорошо", "+1", "ок"
- People discussing something between themselves, even if the topic is about finances or this bot
- Someone expresses an opinion or suggestion without asking you to do something right now
Respond only when:
- There is a direct question ("сколько?", "покажи", "что такое X?")
- There is a direct command ("добавь", "удали", "покажи бюджет")
- Someone explicitly addresses you by name or @mention

Respond in Russian if the user writes in Russian, otherwise in English.`;

    if (this.ctx.isForumWithoutTopic) {
      prompt += `\n\nЭта группа использует топики (форум), но команда /topic ещё не настроена — бот слушает все топики.
Если пользователь жалуется, что бот отвечает не там или реагирует когда не нужно — посоветуй перейти в топик для финансов и написать /topic, чтобы бот работал только в этом топике.`;
    }

    if (this.ctx.customPrompt) {
      prompt += `\n\n=== CUSTOM GROUP INSTRUCTIONS ===\n${this.ctx.customPrompt}`;
    }

    return prompt;
  }

  /**
   * Convert stored chat messages to OpenAI message format
   */
  private buildHistoryMessages(history: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
    return history.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));
  }
}
