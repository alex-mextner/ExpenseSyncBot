/**
 * Telegram streaming adapter for the AI agent
 * Handles throttled message updates, tool indicators, and message chunking
 */
import type { Bot } from 'gramio';
import { TelegramError } from 'gramio';
import { processThinkTags, sanitizeHtmlForTelegram, stripAllHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { TOOL_LABELS } from './tools';

const logger = createLogger('telegram-stream');

/**
 * Format a tool input param for display — join arrays with ", "
 */
function formatParam(value: unknown): string | false {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string') return value;
  return false;
}

/**
 * Extract key parameters from tool input for display in the indicator
 */
function formatToolInput(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';

  switch (name) {
    case 'set_budget':
      return [
        input['category'],
        input['amount'] != null && `${input['amount']} ${input['currency'] || ''}`.trim(),
      ]
        .filter(Boolean)
        .join(', ');
    case 'delete_budget':
      return [input['category'], input['month']].filter(Boolean).join(', ');
    case 'add_expense':
      return [
        input['amount'] && `${input['amount']} ${input['currency'] || ''}`.trim(),
        input['category'],
        input['comment'],
      ]
        .filter(Boolean)
        .join(', ');
    case 'delete_expense':
      return input['expense_id'] ? `#${input['expense_id']}` : '';
    case 'get_expenses': {
      const parts = [
        formatParam(input['category']),
        formatParam(input['period']),
        input['summary_only'] && 'сводка',
      ];
      const page = input['page'] as number | undefined;
      if (page && page > 1) parts.push(`стр. ${page}`);
      const pageSize = input['page_size'] as number | undefined;
      if (pageSize && pageSize !== 100) parts.push(`(${pageSize})`);
      return parts.filter(Boolean).join(', ');
    }
    case 'get_budgets':
      return [formatParam(input['category']), formatParam(input['month'])]
        .filter(Boolean)
        .join(', ');
    case 'manage_category':
      return [input['action'], input['name']].filter(Boolean).join(' ');
    case 'set_custom_prompt':
      return input['prompt'] ? `${String(input['prompt']).length} символов` : 'очистка';
    case 'calculate':
      return input['expression'] ? String(input['expression']) : '';
    default:
      return '';
  }
}

/**
 * Returns true if the AI response is a skip signal — bot chose to stay silent.
 * Recognized signals: [SKIP], ..., or empty string.
 */
export function isSkipSignal(text: string): boolean {
  const t = text.trim();
  return t === '[SKIP]' || t === '...' || t === '';
}

const UPDATE_INTERVAL_MS = 1000; // ~Telegram's safe edit rate per chat
const ERROR_COOLDOWN_MS = 10000;
const MAX_MESSAGE_LENGTH = 4000;

export class TelegramStreamWriter {
  private sentMessageId: number | null = null;
  private placeholderIdPromise: Promise<number | null>;
  private fullText = ''; // current round's accumulated text
  private historyText = ''; // clean final AI text for chat history
  private lastFlushTime = Date.now();
  private lastSentText = ''; // last display text actually sent
  private lastErrorTime = 0;
  private flushInProgress = false; // mutex: prevents concurrent API calls
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
    // Send placeholder; sendOrEdit will edit it in-place instead of creating a new message,
    // which prevents double-message race when the API call resolves after streaming begins.
    this.placeholderIdPromise = this.bot.api
      .sendMessage({
        chat_id: this.chatId,
        text: '⏳ Минутку...',
      })
      .then((msg) => msg.message_id)
      .catch(() => null);

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
  }

  /**
   * Reset writer state for a retry pass (validation rejection).
   * Keeps the existing Telegram message ID so edits continue in-place.
   * Clears error cooldown so the retry can flush tool indicators immediately.
   */
  reset(): void {
    this.fullText = '';
    this.historyText = '';
    this.lastSentText = '';
    this.lastErrorTime = 0;
    this.toolLabel = null;
    this.pendingIndicators = [];
    this.toolLines = [];
    this.intermediateChunks = [];
    this.finalDisplayText = '';
  }

  /**
   * Append text delta from streaming — triggers a rate-limited flush automatically.
   * Resets the throttle window at the start of each round so the first flush waits
   * 1 second from when streaming actually begins, not from when the writer was created.
   */
  appendText(delta: string): void {
    if (this.fullText === '') {
      this.lastFlushTime = Date.now();
    }
    this.fullText += delta;
    void this.flush(false);
  }

  /**
   * Flush current state to Telegram. force=true bypasses time throttling
   * (used when a tool starts so the user sees it immediately).
   * Error cooldown is always respected. Mutex prevents concurrent API calls —
   * without it, multiple appendText() tokens pass the time check while
   * the first sendOrEdit is still in flight, causing 429 spam.
   */
  async flush(force = false): Promise<void> {
    const now = Date.now();
    if (now - this.lastErrorTime < ERROR_COOLDOWN_MS) return;
    if (!force && now - this.lastFlushTime < UPDATE_INTERVAL_MS) return;
    if (this.flushInProgress) return;

    this.flushInProgress = true;
    try {
      // Build display: current streamed text + live tool indicator suffix
      let display = this.truncateForTelegram(processThinkTags(this.fullText)) || '⏳';
      if (this.toolLabel) {
        display = `${display}\n\n${this.toolLabel}`;
      }

      await this.sendOrEdit(display);
    } catch (err) {
      logger.error({ err }, '[STREAM] Unexpected flush error');
      this.lastErrorTime = Date.now();
    } finally {
      this.flushInProgress = false;
    }
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
    this.lastSentText = '';
    this.lastFlushTime = Date.now();
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
      if (!this.sentMessageId) {
        // Reuse the placeholder — avoids creating a second message if the API call
        // resolves after streaming has already begun (double-message race condition).
        const placeholderId = await this.placeholderIdPromise;
        this.sentMessageId = placeholderId;
      }

      if (this.sentMessageId) {
        await this.bot.api.editMessageText({
          chat_id: this.chatId,
          message_id: this.sentMessageId,
          text,
          parse_mode: 'HTML',
        });
      } else {
        // Placeholder creation failed — fall back to a new message
        const sent = await this.bot.api.sendMessage({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
        });
        this.sentMessageId = sent.message_id;
      }

      this.lastSentText = text;
      this.lastFlushTime = Date.now();
    } catch (err) {
      if (err instanceof TelegramError) {
        if (err.code === 429) {
          const retryAfter = err.payload?.retry_after ?? 5;
          logger.error({ retryAfter }, '[STREAM] Rate limited, retrying after delay');
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          // Retry once — rate limiter middleware will also delay the call
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
            this.lastFlushTime = Date.now();
          } catch (retryErr) {
            logger.error({ err: retryErr }, '[STREAM] Retry after 429 also failed');
            this.lastErrorTime = Date.now();
          }
        } else if (err.message.includes('message is not modified')) {
          this.lastSentText = text;
          this.lastFlushTime = Date.now();
        } else if (err.message.includes("can't parse entities")) {
          logger.warn('[STREAM] HTML parse error, falling back to plain text');
          await this.sendPlainTextFallback(text);
        } else {
          logger.error({ err }, '[STREAM] Update error');
          this.lastErrorTime = Date.now();
        }
      } else {
        logger.error({ err }, '[STREAM] Update error');
        this.lastErrorTime = Date.now();
      }
    }
  }

  /**
   * Fallback: strip HTML and send/edit as plain text when HTML parsing fails.
   * This prevents the bot from freezing when Telegram rejects malformed HTML.
   */
  private async sendPlainTextFallback(htmlText: string): Promise<void> {
    const plainText = stripAllHtml(htmlText);
    try {
      if (this.sentMessageId) {
        await this.bot.api.editMessageText({
          chat_id: this.chatId,
          message_id: this.sentMessageId,
          text: plainText,
        });
      } else {
        const sent = await this.bot.api.sendMessage({
          chat_id: this.chatId,
          text: plainText,
        });
        this.sentMessageId = sent.message_id;
      }
      this.lastSentText = htmlText;
      this.lastFlushTime = Date.now();
    } catch (fallbackErr) {
      logger.error({ err: fallbackErr }, '[STREAM] Plain text fallback also failed');
      this.lastErrorTime = Date.now();
    }
  }

  /**
   * Truncate text to fit Telegram message limit and close any unclosed HTML tags.
   * Unclosed tags must always be fixed — not only on truncation — because
   * intermediate stream flushes can cut mid-tag while the AI is still generating.
   */
  private truncateForTelegram(text: string): string {
    // Convert <br> to newline before sanitization — sanitize would otherwise escape it.
    // Telegram HTML does not support <br>.
    const withNewlines = text.replace(/<br\s*\/?>/gi, '\n');

    // Sanitize: strip unsupported tags, escape bare & < >.
    // The preRequest hook also sanitizes, so this function is safe to call
    // multiple times (sanitizeHtmlForTelegram is idempotent via decode-first).
    let truncated = sanitizeHtmlForTelegram(withNewlines);
    let wasTruncated = false;

    if (truncated.length > MAX_MESSAGE_LENGTH) {
      truncated = truncated.substring(0, MAX_MESSAGE_LENGTH);
      wasTruncated = true;
    }

    // Fix incomplete HTML tags that result from truncation at MAX_MESSAGE_LENGTH.
    // Sanitization ensures only whitelisted tags remain, so these regexes only
    // ever fire on valid-but-truncated tags (e.g. <blockquote expandabl…).
    // Case 1: incomplete tag before a newline — complete it in-place
    truncated = truncated.replace(/<[a-zA-Z/][^>\n\r]*(?=\r?\n)/g, '$&>');
    // Case 2: incomplete tag at end of string — remove it
    const lastTagStart = truncated.lastIndexOf('<');
    const lastTagEnd = truncated.lastIndexOf('>');
    if (lastTagStart > lastTagEnd) {
      truncated = truncated.substring(0, lastTagStart);
    }

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
   * Delete the sent message from Telegram (used when bot decides to stay silent).
   * Falls back to the placeholder if sentMessageId wasn't set yet.
   */
  async deleteSentMessage(): Promise<void> {
    this.stopTyping();
    const messageId = this.sentMessageId ?? (await this.placeholderIdPromise);
    if (messageId) {
      this.sentMessageId = null;
      this.bot.api.deleteMessage({ chat_id: this.chatId, message_id: messageId }).catch(() => {});
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
