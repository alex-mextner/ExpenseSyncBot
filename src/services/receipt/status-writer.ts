/**
 * Lightweight throttled status message writer for long-running background tasks
 * (receipt parsing, etc.). Sends a status message, updates it with streaming text
 * deltas, and deletes it when done.
 *
 * Unlike TelegramStreamWriter (which is tuned for the agent flow with tool
 * indicators and history preservation), this is a minimal "progress indicator".
 */

import { escapeHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { deleteMessage, editMessageText, sendMessage } from '../bank/telegram-sender';

const logger = createLogger('status-writer');

const UPDATE_INTERVAL_MS = 1500; // safe edit rate for a single chat
const MAX_DISPLAY_CHARS = 3500; // keep well under Telegram's 4096 limit
const ERROR_COOLDOWN_MS = 10_000;

interface StatusWriterOptions {
  /** Header shown above streamed text (e.g. "🤖 AI читает чек...") */
  header: string;
}

export class StatusWriter {
  private messageIdPromise: Promise<number | null>;
  private buffer = '';
  private lastFlushTime = Date.now();
  private lastSentText = '';
  private lastErrorTime = 0;
  private flushInProgress = false;
  private closed = false;

  constructor(private options: StatusWriterOptions) {
    // Send initial placeholder immediately — editMessageText will update it in-place.
    this.messageIdPromise = sendMessage(this.formatDisplay(''))
      .then((msg) => msg?.message_id ?? null)
      .catch((err: unknown) => {
        logger.error({ err }, '[STATUS_WRITER] Failed to send placeholder');
        return null;
      });
  }

  /**
   * Append a text delta from streaming. Triggers a throttled flush.
   * Safe to call many times per second — internally rate-limited.
   */
  append(delta: string): void {
    if (this.closed) return;
    if (this.buffer === '') {
      this.lastFlushTime = Date.now();
    }
    this.buffer += delta;
    void this.flush(false);
  }

  /**
   * Force-flush the current buffer without waiting for the throttle window.
   * Used when you want an immediate update (e.g. status change).
   */
  async forceFlush(): Promise<void> {
    if (this.closed) return;
    await this.flush(true);
  }

  /**
   * Delete the status message entirely. Call this when the background task is
   * done and the real result is being sent as a separate message.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const messageId = await this.messageIdPromise;
    if (messageId === null) return;
    try {
      await deleteMessage(messageId);
    } catch (err) {
      logger.warn({ err }, '[STATUS_WRITER] Failed to delete status message');
    }
  }

  /**
   * Replace the status with a final text and keep the message (no delete).
   * Useful when the status IS the final result (e.g. error notification).
   */
  async finalize(finalText: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const messageId = await this.messageIdPromise;
    if (messageId === null) return;
    try {
      await editMessageText(messageId, finalText);
    } catch (err) {
      logger.warn({ err }, '[STATUS_WRITER] Failed to finalize message');
    }
  }

  private async flush(force: boolean): Promise<void> {
    const now = Date.now();
    if (now - this.lastErrorTime < ERROR_COOLDOWN_MS) return;
    if (!force && now - this.lastFlushTime < UPDATE_INTERVAL_MS) return;
    if (this.flushInProgress) return;

    this.flushInProgress = true;
    try {
      const display = this.formatDisplay(this.buffer);
      if (display === this.lastSentText) return;

      const messageId = await this.messageIdPromise;
      if (messageId === null) return;

      await editMessageText(messageId, display);
      this.lastSentText = display;
      this.lastFlushTime = Date.now();
    } catch (err) {
      logger.warn({ err }, '[STATUS_WRITER] edit failed, entering cooldown');
      this.lastErrorTime = Date.now();
    } finally {
      this.flushInProgress = false;
    }
  }

  private formatDisplay(buffer: string): string {
    const trimmed = this.truncateBuffer(buffer);
    if (!trimmed) {
      return this.options.header;
    }
    // Escape all HTML special chars so the streaming output can never produce
    // malformed markup that Telegram rejects (the stream is arbitrary text from
    // the LLM — it may contain <, >, &, incomplete entities, etc.).
    // The resulting <code>...</code> wrapper is guaranteed balanced.
    return `${this.options.header}\n\n<code>${escapeHtml(trimmed)}</code>`;
  }

  private truncateBuffer(buffer: string): string {
    if (buffer.length <= MAX_DISPLAY_CHARS) return buffer;
    // Keep the tail — that's where the newest content is
    return `...${buffer.slice(-MAX_DISPLAY_CHARS)}`;
  }
}
