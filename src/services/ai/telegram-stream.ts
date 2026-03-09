/**
 * Telegram streaming adapter for the AI agent
 * Handles throttled message updates, tool indicators, and message chunking
 */
import type { Bot } from 'gramio';
import { TOOL_LABELS } from './tools';
import type { ToolResult } from './types';

const UPDATE_INTERVAL_MS = 3000;
const ERROR_COOLDOWN_MS = 10000;
const MIN_DELTA_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 4000;

export class TelegramStreamWriter {
  private sentMessageId: number | null = null;
  private fullText = '';
  private lastUpdateTime = 0;
  private lastSentText = '';
  private lastErrorTime = 0;
  private toolIndicators: string[] = [];

  constructor(
    private bot: Bot,
    private chatId: number,
    private messageThreadId?: number
  ) {}

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
   * Show tool execution indicator
   */
  async onToolStart(name: string): Promise<void> {
    const toolLabel = TOOL_LABELS[name] || name;
    const indicator = `\n<code>  </code><i>${toolLabel}...</i>`;
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
  onToolResult(name: string, result: ToolResult): void {
    const toolLabel = TOOL_LABELS[name] || name;
    const pendingPattern = `\n<code>  </code><i>${toolLabel}...</i>`;
    const status = result.success ? '\u2705' : '\u274c';
    const replacement = `\n${status} <i>${toolLabel}</i>`;

    this.fullText = this.fullText.replace(pendingPattern, replacement);
  }

  /**
   * Send final message, cleaning up tool indicators
   */
  async finalize(): Promise<void> {
    // Strip tool indicators from final text -- the model's text is the real answer
    let cleanText = this.fullText;
    for (const indicator of this.toolIndicators) {
      cleanText = cleanText.replace(indicator, '');
    }
    // Also clean up completed indicators (the replacements)
    cleanText = cleanText.replace(/\n[\u2705\u274c] <i>[^<]+<\/i>/g, '');
    // Clean up leading/trailing whitespace and extra newlines
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

    if (!cleanText) {
      cleanText = '\u26a0\ufe0f AI did not produce a response.';
    }

    this.fullText = cleanText;

    if (this.fullText !== this.lastSentText) {
      await this.flushUpdate();
    }
  }

  /**
   * Get the accumulated text (for saving to history)
   */
  getText(): string {
    return this.fullText;
  }

  /**
   * Send or edit the Telegram message
   */
  private async flushUpdate(): Promise<void> {
    const textToSend = this.truncateForTelegram(this.fullText);

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
          ...(this.messageThreadId && { message_thread_id: this.messageThreadId }),
        });
        this.sentMessageId = sent.message_id;
      }

      this.lastSentText = textToSend;
      this.lastUpdateTime = Date.now();
    } catch (err: any) {
      if (err?.payload?.error_code === 429) {
        console.error('[STREAM] Rate limited, cooling down');
        this.lastErrorTime = Date.now();
      } else if (err?.payload?.description?.includes('message is not modified')) {
        this.lastSentText = textToSend;
        this.lastUpdateTime = Date.now();
      } else {
        console.error('[STREAM] Update error:', err);
      }
    }
  }

  /**
   * Truncate text to fit Telegram message limit, preserving valid HTML
   */
  private truncateForTelegram(text: string): string {
    if (text.length <= MAX_MESSAGE_LENGTH) return text;

    let truncated = text.substring(0, MAX_MESSAGE_LENGTH);

    // Don't cut in the middle of an HTML tag
    const lastTagStart = truncated.lastIndexOf('<');
    const lastTagEnd = truncated.lastIndexOf('>');
    if (lastTagStart > lastTagEnd) {
      truncated = truncated.substring(0, lastTagStart);
    }

    // Close unclosed tags
    const openTags: string[] = [];
    const tagRegex = /<\/?([a-z]+)[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(truncated)) !== null) {
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
    for (let i = openTags.length - 1; i >= 0; i--) {
      truncated += `</${openTags[i]}>`;
    }

    return `${truncated}...`;
  }

  /**
   * Send additional chunks for long final messages
   */
  async sendRemainingChunks(fullText: string): Promise<void> {
    if (fullText.length <= MAX_MESSAGE_LENGTH) return;

    // Split into chunks by paragraphs
    const chunks = this.splitIntoChunks(fullText, MAX_MESSAGE_LENGTH);

    // First chunk was already sent/edited via finalize()
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk) {
        try {
          await this.bot.api.sendMessage({
            chat_id: this.chatId,
            text: chunk,
            parse_mode: 'HTML',
            ...(this.messageThreadId && { message_thread_id: this.messageThreadId }),
          });
        } catch (err) {
          console.error('[STREAM] Failed to send chunk:', err);
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
      if ((current + '\n\n' + para).length > maxLength && current) {
        chunks.push(current.trim());
        current = para;
      } else {
        current = current ? `${current}\n\n${para}` : para;
      }
    }
    if (current) chunks.push(current.trim());
    return chunks;
  }
}
