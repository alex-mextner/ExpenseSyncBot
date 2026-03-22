/**
 * Telegram streaming adapter for the AI agent
 * Handles throttled message updates, tool indicators, and message chunking
 */
import type { Bot } from 'gramio';
import { processThinkTags } from '../../bot/commands/ask';
import { createLogger } from '../../utils/logger.ts';
import { TOOL_LABELS } from './tools';
import type { ToolResult } from './types';

const logger = createLogger('telegram-stream');

/**
 * Extract key parameters from tool input for display in the indicator
 */
function formatToolInput(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';

  switch (name) {
    case 'set_budget':
      return [input.category, input.amount && `${input.amount} ${input.currency || ''}`.trim()]
        .filter(Boolean)
        .join(', ');
    case 'delete_budget':
      return [input.category, input.month].filter(Boolean).join(', ');
    case 'add_expense':
      return [
        input.amount && `${input.amount} ${input.currency || ''}`.trim(),
        input.category,
        input.comment,
      ]
        .filter(Boolean)
        .join(', ');
    case 'delete_expense':
      return input.expense_id ? `#${input.expense_id}` : '';
    case 'get_expenses':
      return [input.category, input.period, input.summary_only && 'сводка']
        .filter(Boolean)
        .join(', ');
    case 'get_budgets':
      return [input.category, input.month].filter(Boolean).join(', ');
    case 'manage_category':
      return [input.action, input.name].filter(Boolean).join(' ');
    case 'set_custom_prompt':
      return input.prompt ? `${String(input.prompt).length} символов` : 'очистка';
    default:
      return '';
  }
}

const UPDATE_INTERVAL_MS = 3000;
const ERROR_COOLDOWN_MS = 10000;
const MIN_DELTA_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 4000;

export class TelegramStreamWriter {
  private sentMessageId: number | null = null;
  private fullText = '';
  private historyText = '';
  private lastUpdateTime = 0;
  private lastSentText = '';
  private lastErrorTime = 0;
  private toolIndicators: string[] = [];
  private typingInterval: ReturnType<typeof setInterval> | null = null;
  private placeholderMessageId: number | null = null;

  constructor(
    private bot: Bot,
    private chatId: number,
  ) {
    // Send placeholder and keep "typing" status alive
    this.bot.api
      .sendMessage({
        chat_id: this.chatId,
        text: '⏳ Минутку...',
      })
      .then((msg) => {
        this.placeholderMessageId = msg.message_id;
      })
      .catch(() => {});

    this.typingInterval = setInterval(() => {
      if (!this.sentMessageId) {
        this.bot.api
          .sendChatAction({
            chat_id: this.chatId,
            action: 'typing',
          })
          .catch(() => {});
      } else {
        this.stopTyping();
      }
    }, 4000);
  }

  private stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
    this.deletePlaceholder();
  }

  private deletePlaceholder(): void {
    if (this.placeholderMessageId) {
      const id = this.placeholderMessageId;
      this.placeholderMessageId = null;
      this.bot.api
        .deleteMessage({
          chat_id: this.chatId,
          message_id: id,
        })
        .catch(() => {});
    }
  }

  /**
   * Append text delta from streaming
   */
  async onTextDelta(delta: string): Promise<void> {
    this.fullText += delta;

    const now = Date.now();
    if (now - this.lastUpdateTime < UPDATE_INTERVAL_MS) return;
    if (now - this.lastErrorTime < ERROR_COOLDOWN_MS) return;
    if (this.fullText.length - this.lastSentText.length < MIN_DELTA_LENGTH) return;

    await this.flushUpdate();
  }

  /**
   * Show tool execution indicator with input details
   */
  async onToolStart(name: string, input?: Record<string, unknown>): Promise<void> {
    const toolLabel = TOOL_LABELS[name] || name;
    const details = formatToolInput(name, input);
    const detailsSuffix = details ? `: ${details}` : '';
    const indicator = `\n<code>  </code><i>${toolLabel}${detailsSuffix}...</i>`;
    this.toolIndicators.push(indicator);
    this.fullText += indicator;

    const now = Date.now();
    if (now - this.lastUpdateTime >= 2000 && now - this.lastErrorTime >= ERROR_COOLDOWN_MS) {
      await this.flushUpdate();
    }
  }

  /**
   * Update tool execution indicator with result status
   */
  onToolResult(name: string, input: Record<string, unknown> | undefined, result: ToolResult): void {
    const toolLabel = TOOL_LABELS[name] || name;
    const details = formatToolInput(name, input);
    const detailsSuffix = details ? `: ${details}` : '';
    const pendingPattern = `\n<code>  </code><i>${toolLabel}${detailsSuffix}...</i>`;
    const status = result.success ? '\u2705' : '\u274c';
    const replacement = `\n${status} <i>${toolLabel}${detailsSuffix}</i>`;

    this.fullText = this.fullText.replace(pendingPattern, replacement);
  }

  /**
   * Send final message, cleaning up tool indicators
   */
  async finalize(): Promise<void> {
    this.stopTyping();
    let cleanText = this.fullText;

    // Collect completed tool indicators into an expandable blockquote
    const toolLines: string[] = [];
    for (const indicator of this.toolIndicators) {
      cleanText = cleanText.replace(indicator, '');
    }
    // Capture completed indicators (✅/❌ lines) and remove from main text
    cleanText = cleanText.replace(/\n([\u2705\u274c] <i>[^<]+<\/i>)/g, (_, line) => {
      toolLines.push(line);
      return '';
    });

    // Process <think> tags -> expandable blockquote (same as HF path)
    cleanText = processThinkTags(cleanText);
    // Clean up leading/trailing whitespace and extra newlines
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

    // Save history text before adding tool UI (prevents AI from mimicking the format)
    this.historyText = cleanText;

    // Prepend tool summary as expandable blockquote
    if (toolLines.length > 0) {
      const toolSummary = `<blockquote expandable>\u2699\ufe0f <b>Инструменты</b>\n${toolLines.join('\n')}</blockquote>`;
      cleanText = `${toolSummary}\n\n${cleanText}`;
    }

    if (!cleanText) {
      cleanText = '\u26a0\ufe0f AI did not produce a response.';
    }

    this.fullText = cleanText;

    if (this.fullText !== this.lastSentText) {
      await this.flushUpdate();
    }
  }

  /**
   * Get the clean AI response text (for saving to history, without tool UI)
   */
  getText(): string {
    return this.historyText;
  }

  /**
   * Send or edit the Telegram message
   */
  private async flushUpdate(): Promise<void> {
    const textToSend = this.truncateForTelegram(processThinkTags(this.fullText));

    if (textToSend === this.lastSentText) return;

    try {
      if (this.sentMessageId) {
        await this.bot.api.editMessageText({
          chat_id: this.chatId,
          message_id: this.sentMessageId,
          text: textToSend,
          parse_mode: 'HTML',
        });
      } else {
        const sent = await this.bot.api.sendMessage({
          chat_id: this.chatId,
          text: textToSend,
          parse_mode: 'HTML',
        });
        this.sentMessageId = sent.message_id;
      }

      this.lastSentText = textToSend;
      this.lastUpdateTime = Date.now();
    } catch (err) {
      const tgErr = err as unknown as { payload?: { error_code?: number; description?: string } };
      if (tgErr?.payload?.error_code === 429) {
        logger.error('[STREAM] Rate limited, cooling down');
        this.lastErrorTime = Date.now();
      } else if (tgErr?.payload?.description?.includes('message is not modified')) {
        this.lastSentText = textToSend;
        this.lastUpdateTime = Date.now();
      } else {
        logger.error({ err }, '[STREAM] Update error');
      }
    }
  }

  /**
   * Truncate text to fit Telegram message limit and close any unclosed HTML tags.
   * Unclosed tags must always be fixed — not only on truncation — because
   * intermediate stream flushes can cut mid-tag while the AI is still generating.
   */
  private truncateForTelegram(text: string): string {
    let truncated = text;
    let wasTruncated = false;

    if (text.length > MAX_MESSAGE_LENGTH) {
      truncated = text.substring(0, MAX_MESSAGE_LENGTH);
      wasTruncated = true;
    }

    // Fix incomplete HTML tags — applies to both truncated and non-truncated text,
    // because the model itself can generate a tag without the closing > (e.g. </blockquote\n).
    // Case 1: incomplete tag before a newline — complete it in-place (</blockquote\n → </blockquote>\n)
    truncated = truncated.replace(/<[a-zA-Z/][^>\n\r]*(?=\r?\n)/g, '$&>');
    // Case 2: incomplete tag at end of string — remove it (no content to preserve after it)
    const lastTagStart = truncated.lastIndexOf('<');
    const lastTagEnd = truncated.lastIndexOf('>');
    if (lastTagStart > lastTagEnd) {
      truncated = truncated.substring(0, lastTagStart);
    }

    // Telegram HTML does not support <br> — convert to newline before tag tracking.
    truncated = truncated.replace(/<br\s*\/?>/gi, '\n');

    // Always close unclosed tags — stream may be mid-generation
    const openTags: string[] = [];
    const tagRegex = /<\/?([a-z]+)[^>]*>/gi;
    for (const match of truncated.matchAll(tagRegex)) {
      const fullTag = match[0];
      const tagName = match[1];
      if (!tagName) continue;
      if (fullTag.startsWith('</')) {
        const lastIndex = openTags.lastIndexOf(tagName);
        if (lastIndex !== -1) openTags.splice(lastIndex, 1);
      } else if (!fullTag.endsWith('/>')) {
        openTags.push(tagName);
      }
    }
    if (wasTruncated) truncated += '...';
    for (let i = openTags.length - 1; i >= 0; i--) {
      truncated += `</${openTags[i]}>`;
    }

    return truncated;
  }

  /**
   * Send additional chunks for long final messages (uses internal display text from finalize)
   */
  async sendRemainingChunks(): Promise<void> {
    if (this.fullText.length <= MAX_MESSAGE_LENGTH) return;

    // Split into chunks by paragraphs
    const chunks = this.splitIntoChunks(this.fullText, MAX_MESSAGE_LENGTH);

    // First chunk was already sent/edited via finalize()
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk) {
        try {
          await this.bot.api.sendMessage({
            chat_id: this.chatId,
            text: chunk,
            parse_mode: 'HTML',
          });
        } catch (err) {
          logger.error({ err: err }, '[STREAM] Failed to send chunk');
        }
      }
    }
  }

  private splitIntoChunks(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let current = '';
    const paragraphs = text.split('\n\n');

    for (const para of paragraphs) {
      if (`${current}\n\n${para}`.length > maxLength && current) {
        chunks.push(...this.splitByWords(current.trim(), maxLength));
        current = para;
      } else {
        current = current ? `${current}\n\n${para}` : para;
      }
    }
    if (current) chunks.push(...this.splitByWords(current.trim(), maxLength));
    return chunks;
  }

  /**
   * Split text at word boundaries so no chunk exceeds maxLength.
   * If a single word is longer than maxLength it stays in its own chunk.
   */
  private splitByWords(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const result: string[] = [];
    const words = text.split(' ');
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxLength && current) {
        result.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) result.push(current);
    return result;
  }
}
