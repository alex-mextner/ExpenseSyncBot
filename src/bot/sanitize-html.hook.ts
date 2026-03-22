/**
 * GramIO preRequest hook that sanitizes text/caption for Telegram HTML parse mode.
 * Registered once on the bot; fires before every outgoing API call.
 */
import type { Hooks } from 'gramio';
import { sanitizeHtmlForTelegram } from '../utils/html';

type SanitizableParams = { parse_mode?: string; text?: string; caption?: string };

/**
 * Sanitize outgoing Telegram API calls when parse_mode is HTML.
 * Strips unsupported tags and escapes bare &, <, > characters.
 * Safe to call multiple times — sanitizeHtmlForTelegram is idempotent.
 */
export const sanitizeHtmlPreRequest: Hooks.PreRequest = (ctx) => {
  const params = ctx.params as SanitizableParams | undefined;
  if (!params || params.parse_mode !== 'HTML') return ctx;

  if (typeof params.text === 'string') {
    params.text = sanitizeHtmlForTelegram(params.text);
  }
  if (typeof params.caption === 'string') {
    params.caption = sanitizeHtmlForTelegram(params.caption);
  }

  return ctx;
};
