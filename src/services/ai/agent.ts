/**
 * ExpenseBotAgent - Anthropic Claude agent with tool calling for expense management
 *
 * Streams text to Telegram, executes tools, and manages the conversation loop.
 * Only final text responses are saved to chat history (not intermediate tool_use rounds).
 */
import Anthropic from '@anthropic-ai/sdk';
import { format } from 'date-fns';
import type { Bot } from 'gramio';
import { env } from '../../config/env';
import type { ChatMessage } from '../../database/types';
import { AnthropicError, NetworkError } from '../../errors';
import { createLogger } from '../../utils/logger.ts';
import { AiDebugLogger, type AiDebugRunContext } from './debug-logger';
import { validateResponse } from './response-validator';
import { TelegramStreamWriter } from './telegram-stream';
import { executeTool } from './tool-executor';
import { TOOL_DEFINITIONS } from './tools';
import type { AgentContext, ToolCallResult } from './types';

const logger = createLogger('agent');

/** Singleton debug logger — writes full AI conversations to logs/chats/ when enabled */
export const aiDebugLogger = new AiDebugLogger(env.AI_DEBUG_LOGS, 'logs');

const MAX_TOOL_ROUNDS = 10;
const AGENT_TIMEOUT_MS = 60_000;
export const AI_MODEL = process.env['AI_MODEL'] || 'glm-5';
export const AI_BASE_URL = process.env['AI_BASE_URL'] || 'https://api.z.ai/api/anthropic';

export class ExpenseBotAgent {
  private anthropic: Anthropic;
  private apiKey: string;
  private ctx: AgentContext;

  constructor(apiKey: string, ctx: AgentContext) {
    this.anthropic = new Anthropic({
      apiKey,
      baseURL: AI_BASE_URL || undefined,
    });
    this.apiKey = apiKey;
    this.ctx = ctx;
  }

  /**
   * Run the full agent loop: stream text, execute tools, update Telegram message
   *
   * @param userMessage - The user's question or command
   * @param conversationHistory - Recent chat messages for context
   * @param bot - GramIO bot instance for Telegram API calls
   * @param messageThreadId - Optional forum topic thread ID
   * @returns Final text response (for saving to chat history)
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

    const messages: Anthropic.MessageParam[] = [
      ...this.buildHistoryMessages(conversationHistory),
      { role: 'user', content: userMessage },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

    logger.info(`[AGENT] Starting: model=${AI_MODEL} base=${AI_BASE_URL}`);
    logger.info(`[AGENT] Question: "${userMessage.substring(0, 150)}"`);

    const systemPrompt = this.buildSystemPrompt();
    debugCtx?.logSystemPrompt(systemPrompt);
    debugCtx?.logHistory(conversationHistory.map((m) => ({ role: m.role, content: m.content })));

    const toolCallNames: string[] = [];

    try {
      const result = await this.runAgentLoop(
        messages,
        systemPrompt,
        writer,
        debugCtx,
        controller.signal,
        toolCallNames,
      );
      let { text: finalText } = result;
      let { toolCount: totalToolCalls } = result;

      // --- Validation pass (only when no tools were called) ---
      if (toolCallNames.length === 0) {
        const validation = await validateResponse(this.apiKey, {
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
              systemPrompt,
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
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutMsg = '\u23f3 Время ожидания истекло. Попробуйте ещё раз.';
        try {
          await bot.api.sendMessage({
            chat_id: this.ctx.chatId,
            text: timeoutMsg,
          });
        } catch {}
        return timeoutMsg;
      }

      if (error instanceof Anthropic.APIError) {
        let errorMsg: string;
        if (error.status === 429) {
          errorMsg = '\u23f3 Слишком много запросов к AI. Подождите минуту.';
        } else if (error.status === 529) {
          errorMsg = '\u26a1 AI сервер перегружен. Попробуйте позже.';
        } else {
          errorMsg = '\u274c Ошибка AI. Попробуйте позже.';
          logger.error('[AGENT] Anthropic API error:', error.status, error.message);
        }

        try {
          await bot.api.sendMessage({
            chat_id: this.ctx.chatId,
            text: errorMsg,
          });
        } catch {}
        return errorMsg;
      }

      // Wrap unknown errors in typed classes for callers to handle uniformly
      const networkCodes = ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH'];
      const errCode = (error as NodeJS.ErrnoException).code;
      if (errCode && networkCodes.includes(errCode)) {
        throw new NetworkError((error as Error).message, errCode, error);
      }
      const errStatus = (error as { status?: number }).status;
      if (typeof errStatus === 'number') {
        throw new AnthropicError((error as Error).message, `HTTP_${errStatus}`, error);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Execute the streaming agent loop: stream text, call tools, repeat until done.
   * Returns the final text response.
   */
  private async runAgentLoop(
    messages: Anthropic.MessageParam[],
    systemPrompt: string,
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

      const stream = this.anthropic.messages.stream(
        {
          model: AI_MODEL,
          max_tokens: 4096,
          system: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages,
          tools: TOOL_DEFINITIONS,
        },
        { signal },
      );

      let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
      const toolResults: ToolCallResult[] = [];

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          writer.appendText(event.delta.text);
        }

        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            currentToolUse = {
              id: event.content_block.id,
              name: event.content_block.name,
              inputJson: '',
            };
          }
        }

        if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          if (currentToolUse) {
            currentToolUse.inputJson += event.delta.partial_json;
          }
        }

        if (event.type === 'content_block_stop') {
          if (currentToolUse) {
            const input = JSON.parse(currentToolUse.inputJson || '{}');

            logger.info(`[AGENT] Tool call: ${currentToolUse.name} ${JSON.stringify(input)}`);
            debugCtx?.logToolCall(currentToolUse.name, input);

            writer.setToolLabel(currentToolUse.name, input);
            await writer.flush(true);

            const result = await executeTool(currentToolUse.name, input, this.ctx);

            if (result.success) {
              const preview = result.output ? result.output.substring(0, 300) : '(no output)';
              const total = result.output?.length ?? 0;
              logger.info(
                `[AGENT] Tool result: ${currentToolUse.name} OK (${total} chars) preview: ${preview}${total > 300 ? '...' : ''}`,
              );
            } else {
              logger.info(`[AGENT] Tool result: ${currentToolUse.name} ERR: ${result.error}`);
            }

            debugCtx?.logToolResult(
              currentToolUse.name,
              result.success,
              result.output,
              result.error,
            );
            totalToolCalls++;
            toolCallNames.push(currentToolUse.name);

            writer.markToolResult(result.success);

            toolResults.push({ id: currentToolUse.id, result });

            currentToolUse = null;
          }
        }
      }

      const finalMessage = await stream.finalMessage();
      const fullAssistantContent = finalMessage.content;

      if (toolResults.length > 0) {
        writer.commitIntermediate();

        messages.push({ role: 'assistant', content: fullAssistantContent });
        messages.push({
          role: 'user',
          content: toolResults.map((tr) => ({
            type: 'tool_result' as const,
            tool_use_id: tr.id,
            content: tr.result.success
              ? tr.result.output || 'Success'
              : `Error: ${tr.result.error}`,
          })),
        });
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
6. If you need totals by category → use summary_only: true in get_expenses.
7. Arithmetic or currency conversion → call calculate. NEVER do math in your head. Reply with only the result number and currency code, nothing else. The tool uses live exchange rates.

## FORMATTING
Use ONLY these HTML tags (no Markdown, no ** or *):
- <b>bold</b> for amounts and categories
- <i>italic</i> for secondary info
- <code>code</code> for exact numbers and IDs
Escape < > & as &lt; &gt; &amp;
Do NOT use <blockquote>, <u>, or any other tags — they are reserved for system UI.
Do NOT invent links.

Respond in Russian if the user writes in Russian, otherwise in English.`;

    if (this.ctx.customPrompt) {
      prompt += `\n\n=== CUSTOM GROUP INSTRUCTIONS ===\n${this.ctx.customPrompt}`;
    }

    return prompt;
  }

  /**
   * Convert stored chat messages to Anthropic message format
   * Only handles plain text messages (tool_use rounds are not stored)
   */
  private buildHistoryMessages(history: ChatMessage[]): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];

    for (const msg of history) {
      // Try parsing as JSON (future-proofing), fall back to plain text
      let content: string | Anthropic.ContentBlockParam[];
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) {
          content = parsed;
        } else {
          content = msg.content;
        }
      } catch {
        content = msg.content;
      }

      messages.push({
        role: msg.role as 'user' | 'assistant',
        content,
      });
    }

    return messages;
  }
}
