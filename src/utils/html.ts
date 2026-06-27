/**
 * HTML and Markdown utilities for sanitizing text for Telegram parse modes.
 */

/**
 * Escape HTML entities to prevent parsing errors.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Telegram-allowed HTML tags whitelist.
 */
const ALLOWED_TAGS = [
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'a',
  'blockquote',
  'tg-spoiler',
  'tg-emoji',
  'span',
];

/**
 * Restore only safe attributes for allowed tags. Everything else is stripped.
 */
function restoreAllowedAttributes(tag: string, escapedAttrs: string): string {
  if (!escapedAttrs) return '';

  // Unescape to parse attributes. Decode &amp; LAST so an input like `&amp;lt;`
  // resolves to the literal text `&lt;` instead of double-unescaping into `<`.
  const attrs = escapedAttrs.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  const t = tag.toLowerCase();

  if (t === 'a') {
    const hrefMatch = attrs.match(/href=["']([^"']*)["']/i);
    if (hrefMatch) {
      const safeHref = (hrefMatch[1] || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return ` href="${safeHref}"`;
    }
    return '';
  }
  if (t === 'blockquote') {
    if (attrs.includes('expandable')) return ' expandable';
    return '';
  }
  if (t === 'pre' || t === 'code') {
    const classMatch = attrs.match(/class=["']([^"']*)["']/i);
    if (classMatch) {
      const safeClass = (classMatch[1] || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return ` class="${safeClass}"`;
    }
    return '';
  }
  if (t === 'span') {
    if (attrs.includes('tg-spoiler')) return ' class="tg-spoiler"';
    return '';
  }
  if (t === 'tg-emoji') {
    const idMatch = attrs.match(/emoji-id=["']([^"']*)["']/i);
    if (idMatch) {
      const safeId = (idMatch[1] || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return ` emoji-id="${safeId}"`;
    }
    return '';
  }
  return '';
}

/**
 * Close any unclosed HTML tags to ensure valid HTML for Telegram.
 */
export function closeUnmatchedTags(html: string): string {
  const openTags: string[] = [];
  const tagRegex = /<\/?([a-z][a-z0-9-]*)[^>]*>/gi;
  let match: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: needed for regex iteration
  while ((match = tagRegex.exec(html)) !== null) {
    const fullTag = match[0];
    const tagName = (match[1] || '').toLowerCase();
    if (!tagName) continue;

    if (fullTag.startsWith('</')) {
      const lastIndex = openTags.lastIndexOf(tagName);
      if (lastIndex !== -1) {
        openTags.splice(lastIndex, 1);
      }
    } else if (!fullTag.endsWith('/>')) {
      openTags.push(tagName);
    }
  }

  let result = html;
  for (let i = openTags.length - 1; i >= 0; i--) {
    result += `</${openTags[i]}>`;
  }
  return result;
}

/**
 * Sanitize text for Telegram HTML parse mode.
 *
 * Strategy: decode existing entities first (idempotent), escape everything,
 * then restore only whitelisted tags. Safe to call multiple times on the
 * same text without double-escaping.
 */
export function sanitizeHtmlForTelegram(text: string): string {
  // Decode existing entities first so re-sanitizing is idempotent.
  // &amp; → & → &amp; (same result), so calling twice is safe. Decode &amp; LAST
  // so `&amp;lt;` resolves to literal `&lt;` rather than double-unescaping into `<`.
  const decoded = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  // Step 1: Escape ALL special characters
  let result = decoded.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Step 2: Restore whitelisted tags
  for (const tag of ALLOWED_TAGS) {
    // Opening tags with optional attributes
    const openRegex = new RegExp(`&lt;(${tag})((?:\\s|&amp;).*?)?&gt;`, 'gi');
    result = result.replace(openRegex, (_, tagName, attrs) => {
      const safeAttrs = restoreAllowedAttributes(tagName, attrs || '');
      return `<${tagName}${safeAttrs}>`;
    });

    // Closing tags
    const closeRegex = new RegExp(`&lt;/${tag}&gt;`, 'gi');
    result = result.replace(closeRegex, `</${tag}>`);
  }

  // Step 3: Close any unclosed tags
  result = closeUnmatchedTags(result);

  return result;
}

/**
 * Telegram sendMessage/editMessageText limit — 4096 chars incl. HTML markup.
 * Anything longer is rejected with `400 MESSAGE_TOO_LONG`.
 */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Truncate a message so it fits Telegram's message length limit.
 * Closes any HTML tags broken by the cut (via closeUnmatchedTags),
 * then appends a visible ellipsis marker.
 */
export function truncateForTelegram(
  text: string,
  maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH,
): string {
  if (text.length <= maxLength) return text;
  const marker = '\n…(обрезано)';
  const sliced = text.slice(0, maxLength - marker.length);
  return `${closeUnmatchedTags(sliced)}${marker}`;
}

/**
 * Strip ALL HTML tags and decode entities back to plain text.
 */
export function stripAllHtml(text: string): string {
  // Strip tags to a fixpoint. For this generalized `<[^>]*>` pattern a single
  // global pass already removes every complete tag (any `<` that has a later `>`
  // is consumed; only danglers with no following `>` can remain), so the loop is
  // belt-and-suspenders here — but it is the complete-sanitization form the CodeQL
  // js/incomplete-multi-character-sanitization gate expects and stays correct if
  // the pattern is ever narrowed to a specific tag name.
  let stripped = text;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/<[^>]*>/g, '');
  } while (stripped !== previous);

  // Decode entities with &amp; LAST so `&amp;lt;` becomes literal `&lt;` instead of
  // double-unescaping into `<`.
  return stripped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// MarkdownV2 special chars per Telegram docs: _ * [ ] ( ) ~ ` > # + - = | { } . !
// The backslash itself must also be escaped.
const MDV2_SPECIAL_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const MDV2_DECODE_RE = /\\([_*[\]()~`>#+\-=|{}.!\\])/g;

/**
 * Escape text for Telegram MarkdownV2 parse mode.
 * Idempotent: decodes existing backslash escapes first, then re-escapes everything.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MDV2_DECODE_RE, '$1').replace(MDV2_SPECIAL_RE, '\\$&');
}

// Legacy Markdown special chars per Telegram docs: _ * ` [ ]
// Backslash itself must also be escaped.
const MD_SPECIAL_RE = /[_*`[\]\\]/g;
const MD_DECODE_RE = /\\([_*`[\]\\])/g;

/**
 * Escape text for Telegram legacy Markdown parse mode.
 * Idempotent: decodes existing backslash escapes first, then re-escapes everything.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(MD_DECODE_RE, '$1').replace(MD_SPECIAL_RE, '\\$&');
}

/**
 * Process <think> tags for AI streaming responses.
 * Completed blocks → expandable blockquote.
 * Unclosed (streaming) blocks → visible indicator.
 */
export function processThinkTags(text: string): string {
  // Completed think blocks → expandable blockquote (skip empty blocks)
  text = text.replace(/<think>([\s\S]*?)<\/think>/g, (_, content) => {
    if (!content.trim()) return '';
    const escaped = escapeHtml(content);
    return `<blockquote expandable>🤔 <b>Размышления</b>\n${escaped}</blockquote>\n`;
  });

  // Unclosed <think> (streaming) — show as-is with escape
  text = text.replace(/<think>([\s\S]*)$/, (_, content) => {
    const escaped = escapeHtml(content);
    return `🤔 <i>Бот думает...</i>\n${escaped}`;
  });

  return text;
}
