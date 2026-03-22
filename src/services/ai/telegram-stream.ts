/**
 * Telegram streaming adapter for the AI agent
 * Handles throttled message updates, tool indicators, and message chunking
 */
import type { Bot } from 'gramio';
import { processThinkTags } from '../../bot/commands/ask';
import { createLogger } from '../../utils/logger.ts';
import { TOOL_LABELS } from './tools';

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
  private placeholderMessageId: number | null = null;
  private fullText = ''; // current round's accumulated text
  private historyText = ''; // clean final AI text for chat history
  private lastFlushTime = 0;
  private lastSentText = ''; // last display text actually sent
  private lastFlushedLen = 0; // fullText.length at last successful flush
  private lastErrorTime = 0;
  private toolLabel: string | null = null; // live indicator shown during flush
  private pendingIndicators: string[] = []; // in-flight tool labels
  private toolLines: string[] = []; // completed ✅/❌ lines
  private intermediateChunks: string[] = []; // committed snapshots per tool-use round
  private finalDisplayText = ''; // full final text for sendRemainingChunks
  private typingInterval: ReturnType<typeof setInterval> | null = null;

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
   * Append text delta from streaming (caller must call flush afterwards)
   */
  appendText(delta: string): void {
    this.fullText += delta;
  }

  /**
   * Flush current state to Telegram. force=true bypasses time/delta throttling
   * (used when a tool starts so the user sees it immediately).
   * Error cooldown is always respected.
   */
  async flush(force = false): Promise<void> {
    const now = Date.now();
    if (now - this.lastErrorTime < ERROR_COOLDOWN_MS) return;

    if (!force) {
      if (now - this.lastFlushTime < UPDATE_INTERVAL_MS) return;
      // Skip if text hasn't grown enough and there's no live tool indicator to show
      if (this.fullText.length - this.lastFlushedLen < MIN_DELTA_LENGTH && !this.toolLabel) return;
    }

    // Build display: current streamed text + live tool indicator suffix
    let display = this.truncateForTelegram(processThinkTags(this.fullText)) || '⏳';
    if (this.toolLabel) {
      display = `${display}\n\n${this.toolLabel}`;
    }

    await this.sendOrEdit(display);
  }

  /**
   * Set the live indicator for the tool currently executing.
   * Shown as suffix in flush() until markToolResult() clears it.
   */
  setToolLabel(name: string, input?: Record<string, unknown>): void {
    const label = TOOL_LABELS[name] || name;
    const details = formatToolInput(name, input);
    const suffix = details ? `: ${details}` : '';
    const labelText = `${label}${suffix}`;
    this.toolLabel = `<i>${labelText}...</i>`;
    this.pendingIndicators.push(labelText);
  }

  /**
   * Mark the most recently started tool as done.
   * Moves label from live indicator to completed ✅/❌ line (shown in finalize blockquote).
   */
  markToolResult(success: boolean): void {
    const indicator = this.pendingIndicators.pop();
    if (indicator) {
      this.toolLines.push(`${success ? '✅' : '❌'} <i>${indicator}</i>`);
    }
    this.toolLabel = null;
  }

  /**
   * Commit this round's tool lines to history and reset text buffer.
   * Called after each tool-use round so the next round starts fresh.
   */
  commitIntermediate(): void {
    if (this.toolLines.length > 0) {
      this.intermediateChunks.push(this.toolLines.join('\n'));
      this.toolLines = [];
    }
    this.fullText = '';
    this.lastFlushedLen = 0;
    this.lastSentText = '';
  }

  /**
   * Build and send the final message:
   * collapsed tool blockquote (if any tools ran) followed by AI response.
   */
  async finalize(): Promise<void> {
    this.stopTyping();
    this.toolLabel = null;

    // Collect any remaining tool lines from the last round
    if (this.toolLines.length > 0) {
      this.intermediateChunks.push(this.toolLines.join('\n'));
      this.toolLines = [];
    }

    const response = processThinkTags(this.fullText.trim());
    // Save clean text for chat history before adding UI chrome
    this.historyText = response;

    let finalText: string;
    if (this.intermediateChunks.length > 0) {
      const body = this.intermediateChunks.join('\n');
      if (response) {
        finalText = `<blockquote expandable>⚙️ <b>Инструменты</b>\n${body}</blockquote>\n\n${response}`;
      } else {
        // AI only called tools, no text — show tool results inline
        finalText = body;
      }
    } else {
      finalText = response || '⚠️ AI did not produce a response.';
    }

    finalText = finalText.replace(/\n{3,}/g, '\n\n').trim();
    this.finalDisplayText = finalText;

    await this.sendOrEdit(this.truncateForTelegram(finalText));
  }

  /**
   * Get the clean AI response text (for saving to history, without tool UI)
   */
  getText(): string {
    return this.historyText;
  }

  /**
   * Send additional chunks for long final messages
   */
  async sendRemainingChunks(): Promise<void> {
    if (this.finalDisplayText.length <= MAX_MESSAGE_LENGTH) return;

    const chunks = this.splitIntoChunks(this.finalDisplayText, MAX_MESSAGE_LENGTH);

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
          logger.error({ err }, '[STREAM] Failed to send chunk');
        }
      }
    }
  }

  /**
   * Send or edit the Telegram message with error handling and cooldown tracking
   */
  private async sendOrEdit(text: string): Promise<void> {
    if (text === this.lastSentText) return;

    try {
      if (this.sentMessageId) {
        await this.bot.api.editMessageText({
          chat_id: this.chatId,
          message_id: this.sentMessageId,
          text,
          parse_mode: 'HTML',
        });
      } else {
        const sent = await this.bot.api.sendMessage({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
        });
        this.sentMessageId = sent.message_id;
      }

      this.lastSentText = text;
      this.lastFlushedLen = this.fullText.length;
      this.lastFlushTime = Date.now();
    } catch (err) {
      const tgErr = err as { payload?: { error_code?: number; description?: string } };
      if (tgErr?.payload?.error_code === 429) {
        logger.error('[STREAM] Rate limited, cooling down');
        this.lastErrorTime = Date.now();
      } else if (tgErr?.payload?.description?.includes('message is not modified')) {
        this.lastSentText = text;
        this.lastFlushedLen = this.fullText.length;
        this.lastFlushTime = Date.now();
      } else {
        logger.error({ err }, '[STREAM] Update error');
        // Prevent rapid retries on any HTML/content error — without this every
        // incoming token triggers a new failed API call until the stream ends.
        this.lastErrorTime = Date.now();
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
