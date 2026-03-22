/**
 * GramIO preRequest hook that sanitizes text/caption for all Telegram parse modes.
 * Registered once on the bot; fires before every outgoing API call.
 */
import type { Hooks } from 'gramio';
import { escapeMarkdown, escapeMarkdownV2, sanitizeHtmlForTelegram } from '../utils/html';

type SanitizableParams = { parse_mode?: string; text?: string; caption?: string };

function sanitizeField(value: string, parseMode: string): string {
  if (parseMode === 'HTML') return sanitizeHtmlForTelegram(value);
  if (parseMode === 'MarkdownV2') return escapeMarkdownV2(value);
  if (parseMode === 'Markdown') return escapeMarkdown(value);
  return value;
}

/**
 * Sanitize outgoing Telegram API calls based on parse_mode:
 * - HTML: strip unsupported tags, escape bare &, <, >
 * - MarkdownV2: escape all 18 MarkdownV2 special characters
 * - Markdown: escape legacy Markdown special characters (_ * ` [ ])
 * All sanitizers are idempotent — safe to call multiple times.
 */
export const sanitizeHtmlPreRequest: Hooks.PreRequest = (ctx) => {
  const params = ctx.params as SanitizableParams | undefined;
  if (!params?.parse_mode) return ctx;

  const mode = params.parse_mode;

  if (typeof params.text === 'string') {
    params.text = sanitizeField(params.text, mode);
  }
  if (typeof params.caption === 'string') {
    params.caption = sanitizeField(params.caption, mode);
  }

  return ctx;
};
