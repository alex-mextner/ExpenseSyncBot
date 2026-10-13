/**
 * Telegram streaming adapter for the AI agent
 * Handles throttled message updates, the work log of tool steps, and message chunking
 */
import type { Bot } from 'gramio';
import { TelegramError } from 'gramio';
import {
  escapeHtml,
  neutralizeHtml,
  processThinkTags,
  sanitizeHtmlForTelegram,
  stripAllHtml,
} from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { pluralize } from '../../utils/pluralize';
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
    case 'get_bank_transactions':
      return [
        formatParam(input['bank_name']),
        formatParam(input['period']),
        formatParam(input['status']),
      ]
        .filter(Boolean)
        .join(', ');
    case 'find_missing_expenses':
      return formatParam(input['period']) || '';
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
 * The skip marker and nothing else (case, surrounding spaces and a final '.'/'!' tolerated): the
 * model deliberately chose silence. Unlike isSkipSignal it never matches an answer that merely
 * contains the marker.
 */
function isBareSkipMarker(text: string): boolean {
  return /^\[(?:SKIP|ПРОПУСК)\][.!]?$/i.test(text.trim());
}

/**
 * Returns true if the AI response is a skip signal — bot chose to stay silent.
 * Strict in the prompt (require [SKIP]), forgiving in parsing (accept variations).
 * Short responses (≤50 chars) use substring match; longer ones require exact match
 * to avoid swallowing real replies that quote the marker.
 */
export function isSkipSignal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '...' || trimmed === '…') return true;
  const upper = trimmed.toUpperCase();
  const hasMarker =
    upper.includes('[SKIP]') ||
    upper.includes('[ПРОПУСК]') ||
    upper.includes('[SKIP') ||
    upper.includes('ПРОПУСК]');
  if (!hasMarker) return false;
  // Short text — definitely a skip signal (possibly with stray whitespace/punctuation)
  // Long text — the marker is likely quoted inside a real answer
  return trimmed.length <= 50;
}

/**
 * Shown (and stored in history) when the agent ends without answer text and silence is not an
 * option (see finalize): the user addressed the bot, or tools ran and the answer is blank or
 * the caller forbids silence. A message made only of tool status lines is not an answer, so
 * this replaces it.
 */
export const NO_ANSWER_MESSAGE =
  '⚠️ Не получилось сформулировать ответ. Попробуй спросить ещё раз или переформулировать вопрос.';

const UPDATE_INTERVAL_MS = 1000; // ~Telegram's safe edit rate per chat
const ERROR_COOLDOWN_MS = 10000;
const MAX_MESSAGE_LENGTH = 4000;

/**
 * Work log: the tool steps of a run, shown as a collapsed blockquote at the TOP of the reply
 * (owner, 2026-10-12: progress lines never go into the answer). Its markup is two entities —
 * the blockquote and the bold header — however many steps there are (Telegram: 100/message).
 */
const WORK_LOG_HEADER = '⚙️ <b>Инструменты</b>';
/** The log's share of a message; the rest belongs to the answer. */
const WORK_LOG_MAX_LENGTH = 1000;
/** Room for the shortest log: the header and the "… ещё N шагов раньше" line. */
const WORK_LOG_MIN_LENGTH = 100;
/** One step stays one short line: long expressions or comments are cut. */
const WORK_LOG_STEP_MAX_LENGTH = 100;
const WORK_LOG_GAP = '\n\n';

export class TelegramStreamWriter {
  private sentMessageId: number | null = null;
  private placeholderIdPromise: Promise<number | null>;
  private fullText = ''; // current round's accumulated text
  private historyText = ''; // clean final AI text for chat history
  private lastFlushTime = Date.now();
  private lastSentText = ''; // last display text actually sent
  private lastErrorTime = 0;
  private activeFlush: Promise<void> | null = null; // streaming edit in flight; also the mutex
  private toolLabel: string | null = null; // step running now, shown last in the work log
  private pendingIndicators: string[] = []; // in-flight steps
  private workLog: string[] = []; // finished ✅/❌ steps of every round, display-safe
  private remainingChunks: string[] = []; // answer parts after the first message
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
      this.bot.api
        .sendChatAction({
          chat_id: this.chatId,
          action: 'typing',
        })
        .catch(() => {});
    }, 4000);
  }

  private stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  /**
   * Reset writer state for a retry pass (API retry or validation rejection).
   * Keeps the existing Telegram message ID so edits continue in-place.
   * Clears error cooldown so the retry can flush tool indicators immediately.
   * Keeps the work log: those tools did run (a write may have changed data), so their steps
   * stay on screen even if every retry fails.
   */
  reset(): void {
    this.fullText = '';
    this.historyText = '';
    this.lastSentText = '';
    this.lastErrorTime = 0;
    this.toolLabel = null;
    this.pendingIndicators = [];
    this.remainingChunks = [];
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
    if (this.activeFlush) return;

    this.activeFlush = this.flushNow();
    try {
      await this.activeFlush;
    } finally {
      this.activeFlush = null;
    }
  }

  private async flushNow(): Promise<void> {
    try {
      // Display: work log (if any tool started) on top, then the streamed text with a typing mark
      const text = processThinkTags(this.fullText);
      const log = this.workLogFor(text.length);
      const bodyLimit = log
        ? MAX_MESSAGE_LENGTH - WORK_LOG_GAP.length - log.length
        : MAX_MESSAGE_LENGTH;
      let body = this.truncateForTelegram(text, bodyLimit) || '⏳';
      // Append "..." to indicate the AI is still writing.
      // Skip if truncateForTelegram already added "..." (truncation) or if text is empty (placeholder).
      if (this.fullText && !/\.{3}(<\/[a-z]+>)*$/i.test(body)) {
        body += '...';
      }

      await this.sendOrEdit(log ? `${log}${WORK_LOG_GAP}${body}` : body);
    } catch (err) {
      logger.error({ err }, '[STREAM] Unexpected flush error');
      this.lastErrorTime = Date.now();
    }
  }

  /**
   * Set the step for the tool currently executing.
   * Shown as the last line of the work log until markToolResult() finishes it.
   */
  setToolLabel(name: string, input?: Record<string, unknown>): void {
    const label = TOOL_LABELS[name] || name;
    const details = formatToolInput(name, input);
    // One line per step; code points, not UTF-16 units, so an emoji is never cut in half
    const chars = Array.from((details ? `${label}: ${details}` : label).replace(/\s+/g, ' '));
    const step =
      chars.length > WORK_LOG_STEP_MAX_LENGTH
        ? `${chars.slice(0, WORK_LOG_STEP_MAX_LENGTH - 1).join('')}…`
        : chars.join('');
    // Tool input comes from the model and user text: it must never turn into markup
    const safeStep = neutralizeHtml(step);
    this.toolLabel = safeStep;
    this.pendingIndicators.push(safeStep);
  }

  /**
   * Mark the most recently started tool as done: its step becomes a ✅/❌ line of the work log.
   */
  markToolResult(success: boolean): void {
    const step = this.pendingIndicators.pop();
    if (step) {
      this.workLog.push(`${success ? '✅' : '❌'} ${step}`);
    }
    this.toolLabel = null;
  }

  /**
   * Start the next round's text. Called after each tool-use round; its steps stay in the work log.
   */
  commitIntermediate(): void {
    this.fullText = '';
    this.lastSentText = '';
    this.lastFlushTime = Date.now();
  }

  /**
   * Build and send the final message: the collapsed work log (if any tools ran) on top, the AI
   * response below. An answer longer than one message is split; only the first part carries the
   * log, the rest goes out in sendRemainingChunks(). The log is cut to fit, never the answer.
   *
   * A missing answer ('' / '...' / [SKIP]) stays as-is only when `allowSilence` is set — the
   * caller then deletes the message. Once tools ran, only the bare [SKIP] marker counts: a
   * blank answer, or the marker next to other text, is then a failed answer, not a choice.
   * Otherwise the user sees NO_ANSWER_MESSAGE, never a message made only of tool status lines.
   */
  async finalize({ allowSilence = false }: { allowSilence?: boolean } = {}): Promise<void> {
    this.stopTyping();
    this.toolLabel = null;
    // A streaming edit still in flight would land over the final message
    await this.activeFlush;

    const toolsRan = this.workLog.length > 0;
    let response = processThinkTags(this.fullText.trim());
    if (isSkipSignal(response)) {
      if (allowSilence && (!toolsRan || isBareSkipMarker(response))) {
        // Silence: nothing to show — the caller deletes the placeholder.
        this.historyText = response;
        this.remainingChunks = [];
        return;
      }
      response = NO_ANSWER_MESSAGE;
    }
    // Save clean text for chat history before adding UI chrome
    this.historyText = response;

    const answer = response.replace(/\n{3,}/g, '\n\n').trim();
    const log = this.workLogFor(answer.length);
    const firstLimit = log
      ? MAX_MESSAGE_LENGTH - WORK_LOG_GAP.length - log.length
      : MAX_MESSAGE_LENGTH;
    // The first chunk is a prefix of the answer (the split keeps every separator it does not
    // break at), so the rest is the answer after it, split at the full message size.
    const first = this.splitIntoChunks(answer, firstLimit)[0] ?? '';
    const rest = answer.slice(first.length).trim();
    this.remainingChunks = rest ? this.splitIntoChunks(rest, MAX_MESSAGE_LENGTH) : [];

    // No cut by HTML length: the chunk is already within the limit, and Telegram counts the
    // parsed text — escaping `&` as `&amp;` must not cost the answer its tail.
    const firstHtml = this.truncateForTelegram(first, Number.POSITIVE_INFINITY);
    await this.sendOrEdit(log ? `${log}${WORK_LOG_GAP}${firstHtml}` : firstHtml);
  }

  /**
   * Show an AI failure. Once tools ran, the message keeps its work log and shows the failure
   * under it: a write tool may already have changed data, and the log is the user's record of
   * what was done. Without tools, the placeholder is deleted and the failure sent as plain text.
   */
  async fail(message: string): Promise<void> {
    this.stopTyping();
    this.toolLabel = null;
    // A streaming edit still in flight would land over the failure
    await this.activeFlush;
    if (this.workLog.length === 0) {
      await this.deleteSentMessage();
      await this.sendFailure({ chat_id: this.chatId, text: message });
      return;
    }
    const text = `${this.workLogFor(message.length)}${WORK_LOG_GAP}${escapeHtml(message)}`;
    await this.sendOrEdit(text);
    // sendOrEdit records only what reached the screen. When the edit failed, the failure still
    // has to reach the user: the old message goes (if it still exists) and this one is sent anew.
    if (this.lastSentText !== text) {
      await this.deleteSentMessage();
      await this.sendFailure({ chat_id: this.chatId, text, parse_mode: 'HTML' });
    }
  }

  /** Best effort: the run is already failing, so a send error is logged, not thrown. */
  private async sendFailure(params: {
    chat_id: number;
    text: string;
    parse_mode?: 'HTML';
  }): Promise<void> {
    try {
      await this.bot.api.sendMessage(params);
    } catch (err) {
      logger.error({ err }, '[STREAM] Failed to send the failure message');
    }
  }

  /**
   * Work log for a message whose answer part is `answerLength` chars: shrunk to fit beside an
   * answer that leaves room for it, else full-size (the answer is then split across messages).
   * Empty when no tool started.
   */
  private workLogFor(answerLength: number): string {
    const room = MAX_MESSAGE_LENGTH - WORK_LOG_GAP.length - answerLength;
    const budget =
      room >= WORK_LOG_MIN_LENGTH ? Math.min(room, WORK_LOG_MAX_LENGTH) : WORK_LOG_MAX_LENGTH;
    const steps = this.toolLabel ? [...this.workLog, `⏳ ${this.toolLabel}...`] : this.workLog;
    if (steps.length === 0) return '';

    const render = (lines: string[]) =>
      `<blockquote expandable>${WORK_LOG_HEADER}\n${lines.join('\n')}</blockquote>`;
    const full = render(steps);
    // Under 3 steps nothing is worth hiding (N+2 rule): show them all, the answer splits if needed
    if (full.length <= budget || steps.length < 3) return full;
    // Too long: keep the newest steps and hide at least 3 older ones. Hiding every step always
    // fits, since WORK_LOG_MIN_LENGTH covers the header and the "ещё N" line.
    for (let hidden = 3; ; hidden++) {
      const more = `… ещё ${hidden} ${pluralize(hidden, 'шаг', 'шага', 'шагов')} раньше`;
      const log = render([more, ...steps.slice(hidden)]);
      if (log.length <= budget || hidden === steps.length) return log;
    }
  }

  /**
   * Get the clean AI response text (for saving to history, without tool UI)
   */
  getText(): string {
    return this.historyText;
  }

  /**
   * Send the answer parts that did not fit into the first message (see finalize()).
   */
  async sendRemainingChunks(): Promise<void> {
    for (const chunk of this.remainingChunks) {
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
   * Truncate text to `maxLength` (default: a whole message) and close any unclosed HTML tags.
   * Unclosed tags must always be fixed — not only on truncation — because
   * intermediate stream flushes can cut mid-tag while the AI is still generating.
   */
  private truncateForTelegram(text: string, maxLength = MAX_MESSAGE_LENGTH): string {
    // Convert <br> to newline before sanitization — sanitize would otherwise escape it.
    // Telegram HTML does not support <br>.
    const withNewlines = text.replace(/<br\s*\/?>/gi, '\n');

    // Sanitize: strip unsupported tags, escape bare & < >.
    // The preRequest hook also sanitizes, so this function is safe to call
    // multiple times (sanitizeHtmlForTelegram is idempotent via decode-first).
    let truncated = sanitizeHtmlForTelegram(withNewlines);
    let wasTruncated = false;

    if (truncated.length > maxLength) {
      truncated = truncated.substring(0, maxLength);
      wasTruncated = true;
    }

    // Fix incomplete HTML tags that result from the cut at maxLength.
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
   * A word longer than maxLength (a URL, a long run of digits) is cut: Telegram rejects a longer
   * message, so keeping it whole would lose the whole message.
   */
  private splitByWords(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const result: string[] = [];
    const words = text.split(' ');
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxLength) {
        current = candidate;
        continue;
      }
      if (current) result.push(current);
      current = word;
      while (current.length > maxLength) {
        // Never cut between the two halves of a UTF-16 surrogate pair (an emoji)
        const code = current.charCodeAt(maxLength - 1);
        const cut = code >= 0xd800 && code <= 0xdbff && maxLength > 1 ? maxLength - 1 : maxLength;
        result.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
    if (current) result.push(current);
    return result;
  }
}
