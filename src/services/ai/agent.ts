/**
 * ExpenseBotAgent - Anthropic Claude agent with tool calling for expense management
 *
 * Streams text to Telegram, executes tools, and manages the conversation loop.
 * Only final text responses are saved to chat history (not intermediate tool_use rounds).
 */
import Anthropic from '@anthropic-ai/sdk';
import { format } from 'date-fns';
import { TOOL_DEFINITIONS } from './tools';
import { executeTool } from './tool-executor';
import { TelegramStreamWriter } from './telegram-stream';
import type { AgentContext, AgentEvent, ToolCallResult } from './types';
import type { Bot } from 'gramio';
import type { ChatMessage } from '../../database/types';

const MAX_TOOL_ROUNDS = 10;
const AGENT_TIMEOUT_MS = 60_000;
const AI_MODEL = process.env.AI_MODEL || 'glm-4.7';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.z.ai/api/anthropic';

export class ExpenseBotAgent {
  private anthropic: Anthropic;
  private ctx: AgentContext;

  constructor(apiKey: string, ctx: AgentContext) {
    this.anthropic = new Anthropic({
      apiKey,
      baseURL: AI_BASE_URL || undefined,
    });
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
  async run(
    userMessage: string,
    conversationHistory: ChatMessage[],
    bot: Bot,
    messageThreadId?: number
  ): Promise<string> {
    const writer = new TelegramStreamWriter(bot, this.ctx.chatId, messageThreadId);

    const messages: Anthropic.MessageParam[] = [
      ...this.buildHistoryMessages(conversationHistory),
      { role: 'user', content: userMessage },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

    try {
      let continueLoop = true;
      let round = 0;

      while (continueLoop && round < MAX_TOOL_ROUNDS) {
        round++;

        const stream = this.anthropic.messages.stream(
          {
            model: AI_MODEL,
            max_tokens: 4096,
            system: [
              {
                type: 'text',
                text: this.buildSystemPrompt(),
                cache_control: { type: 'ephemeral' },
              },
            ],
            messages,
            tools: TOOL_DEFINITIONS,
          },
          {
            signal: controller.signal,
          }
        );

        // Track current tool_use block for JSON accumulation
        let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
        const toolResults: ToolCallResult[] = [];

        for await (const event of stream) {
          // Text delta -- stream to Telegram
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            await writer.onTextDelta(event.delta.text);
          }

          // Start of a new content block
          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              currentToolUse = {
                id: event.content_block.id,
                name: event.content_block.name,
                inputJson: '',
              };
            }
          }

          // Input JSON delta for tool_use (arrives in fragments)
          if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
            if (currentToolUse) {
              currentToolUse.inputJson += event.delta.partial_json;
            }
          }

          // Content block finished
          if (event.type === 'content_block_stop') {
            if (currentToolUse) {
              const input = JSON.parse(currentToolUse.inputJson || '{}');

              await writer.onToolStart(currentToolUse.name, input);

              const result = await executeTool(currentToolUse.name, input, this.ctx);

              writer.onToolResult(currentToolUse.name, input, result);

              toolResults.push({ id: currentToolUse.id, result });

              currentToolUse = null;
            }
          }
        }

        // Get full assistant message for conversation continuity
        const finalMessage = await stream.finalMessage();
        const fullAssistantContent = finalMessage.content;

        if (toolResults.length > 0) {
          // Add assistant message + tool results, continue loop
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

      // Finalize: clean up tool indicators and send final message
      await writer.finalize();

      // If response is long, send remaining chunks
      const finalText = writer.getText();
      await writer.sendRemainingChunks(finalText);

      return finalText;
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        const timeoutMsg = '\u23f3 Время ожидания истекло. Попробуйте ещё раз.';
        try {
          await bot.api.sendMessage({
            chat_id: this.ctx.chatId,
            text: timeoutMsg,
            ...(messageThreadId && { message_thread_id: messageThreadId }),
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
          console.error('[AGENT] Anthropic API error:', error.status, error.message);
        }

        try {
          await bot.api.sendMessage({
            chat_id: this.ctx.chatId,
            text: errorMsg,
            ...(messageThreadId && { message_thread_id: messageThreadId }),
          });
        } catch {}
        return errorMsg;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
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

RULES:
1. Use tools to get data. NEVER invent numbers.
2. For questions about expenses -- call get_expenses with filters.
3. For budget info -- call get_budgets.
4. For actions -- use the appropriate tool.
5. IMPORTANT: Confirm with the user before write/delete operations.
6. When the user asks about THEIR expenses, look for a category matching their name.

FORMATTING: Use ONLY HTML tags:
- <b>bold</b> for amounts and categories
- <i>italic</i> for additional info
- <code>code</code> for exact numbers
- <blockquote>quote</blockquote>

DO NOT use Markdown! Escape < > & as &lt; &gt; &amp;
DO NOT invent links!

Respond in the same language the user writes in (Russian or English).`;

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
