/**
 * Lightweight throttled status message writer for long-running background tasks
 * (receipt parsing, etc.). Sends a status message, updates it with streaming text
 * deltas, and deletes it when done.
 *
 * Unlike TelegramStreamWriter (which is tuned for the agent flow with tool
 * indicators and history preservation), this is a minimal "progress indicator".
 */

import { escapeHtml, sanitizeHtmlForTelegram } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { deleteMessage, editMessageText, sendMessage } from '../bank/telegram-sender';

const logger = createLogger('status-writer');

const UPDATE_INTERVAL_MS = 1500; // safe edit rate for a single chat
const MAX_DISPLAY_CHARS = 3500; // keep well under Telegram's 4096 limit
const ERROR_COOLDOWN_MS = 10_000;

interface StatusWriterOptions {
  /** Header shown above streamed text (e.g. "🤖 AI читает чек...") */
  header: string;
  /**
   * How to render the streamed content:
   *  - 'code' (default): escape HTML special chars, wrap in <code>…</code>.
   *    Safe for arbitrary model output (raw JSON, random text with < > & chars).
   *    Used for OCR parsing / structured JSON responses.
   *  - 'plain': sanitize via sanitizeHtmlForTelegram — allows safe whitelisted
   *    tags, escapes everything else, closes unmatched tags. Used for long-form
   *    natural-language output (advice, receipt corrections).
   */
  mode?: 'code' | 'plain';
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
   *
   * Throws on edit failure — callers that want to fall back to a plain-text
   * message (e.g. ask.ts / advice on HTML parse errors) need to know the edit
   * didn't land. Swallowing the error here would make their fallback
   * unreachable and leave the chat stuck with the partial streamed output.
   */
  async finalize(finalText: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const messageId = await this.messageIdPromise;
    if (messageId === null) {
      throw new Error('[STATUS_WRITER] Cannot finalize — placeholder never sent');
    }
    // throwOnError: true — the caller explicitly cares about this edit
    // landing (e.g. error-finalization, advice fallback).
    await editMessageText(messageId, finalText, { throwOnError: true });
  }

  /**
   * Preserve whatever was already streamed and append an error suffix in place.
   * Unlike `close()` (which deletes the message), this keeps the partial output
   * visible so the user can see how far the generator got before it failed —
   * much friendlier UX for "stream aborted mid-flight" cases than watching the
   * message silently disappear. Edit failures are log-only (best-effort).
   */
  async finalizeError(errorSuffix: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const messageId = await this.messageIdPromise;
    if (messageId === null) return;
    const body = this.formatDisplay(this.buffer);
    const finalText = `${body}\n\n${errorSuffix}`;
    try {
      await editMessageText(messageId, finalText);
    } catch (err) {
      logger.warn({ err }, '[STATUS_WRITER] finalizeError edit failed');
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

    const mode = this.options.mode ?? 'code';
    if (mode === 'code') {
      // Escape all HTML special chars so the streaming output can never produce
      // malformed markup that Telegram rejects. The <code>…</code> wrapper is
      // guaranteed balanced.
      return `${this.options.header}\n\n<code>${escapeHtml(trimmed)}</code>`;
    }

    // Plain mode — sanitize with the full Telegram sanitizer so whitelisted
    // tags survive and everything else is escaped + unmatched tags are closed.
    // Safe even on partial mid-stream output.
    const safeBody = sanitizeHtmlForTelegram(trimmed);
    return `${this.options.header}\n\n${safeBody}`;
  }

  private truncateBuffer(buffer: string): string {
    if (buffer.length <= MAX_DISPLAY_CHARS) return buffer;
    // Keep the tail — that's where the newest content is
    return `...${buffer.slice(-MAX_DISPLAY_CHARS)}`;
  }
}
