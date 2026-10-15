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
 * Make untrusted text safe inside an HTML message that will pass the outgoing sanitizer.
 * A plain escapeHtml() would be UNDONE there: sanitizeHtmlForTelegram decodes entities and
 * restores whitelisted tags, so a user's `<b>` / `<a href>` would become real markup. So
 * neutralize angle brackets to look-alikes (no tag can form) and escape `&` (idempotent
 * through the sanitizer).
 */
export function neutralizeHtml(raw: string): string {
  return raw.replace(/</g, '‹').replace(/>/g, '›').replace(/&/g, '&amp;');
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

/** Inline formatting tags the sanitizer keeps; a model's list marker may sit inside them. */
const INLINE_FORMAT_TAGS = ALLOWED_TAGS.filter(
  (tag) => !['code', 'pre', 'blockquote', 'tg-emoji'].includes(tag),
);
/**
 * A model-written list marker at a given index (sticky): a bullet or `1.`/`1)`, then any inline
 * formatting tags (closing ones, or empty wrappers like `<i></i>`), then whitespace. Groups:
 * 1 bullet, 2 number, 3 the tags (kept in the output).
 */
const LIST_ITEM_MARKER = new RegExp(
  `(?:([•\\-–—*·])|(\\d{1,9})[.)])((?:</?(?:${INLINE_FORMAT_TAGS.join('|')})>)*)\\s+`,
  'iy',
);

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

/** Nesting levels that still get their own indent; deeper items share the last one. */
const MAX_LIST_INDENT_LEVELS = 3;

/**
 * The tag starting at `start`, quotes respected: `{ end }` is its `>`. `{ resumeAt }` when a `<`
 * outside quotes comes first — no tag here; scanning resumes at that `<` (not inside the failed
 * span, which keeps the scan linear). null when the text ends inside it.
 */
function scanTag(text: string, start: number): { end: number } | { resumeAt: number } | null {
  let quote = '';
  for (let k = start + 1; k < text.length; k++) {
    const ch = text[k];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { end: k };
    } else if (ch === '<') {
      return { resumeAt: k };
    }
  }
  return null;
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
}

/**
 * Turn HTML lists into plain lines: Telegram HTML has no list tags, and escaped `<ul>`/`<li>`
 * show up literally (#165). `<ul>` items become `• item`, `<ol>` items `1. item`; nested lists are
 * indented two spaces per level (capped). Whitespace around list tags (source indentation) goes.
 * One linear pass over real tags: attribute values and `<code>`/`<pre>` contents are untouched.
 */
function convertHtmlLists(text: string): string {
  if (!/<\/?(?:ul|ol|li)[\s/>]/i.test(text)) return text;
  const out: string[] = [];
  const lists: Array<{ kind: string; ordered: boolean; count: number; step: number }> = [];
  let lastIsText = false;
  let skipLeadingSpace = false;
  let lineBreakDue = false;
  // The model's own bullet right after an <li> ("<li>• Еда", "<li><b>•</b> Еда"): replaced, since
  // the item gets its own marker. text[dropFrom, dropTo) is pushed as `dropKeep` (the closing tags
  // that sat between the bullet and the item text); dropFrom is -1 when none is pending.
  let dropFrom = -1;
  let dropTo = -1;
  let dropKeep = '';

  const endsWithNewline = () => out.at(-1)?.endsWith('\n') ?? true;
  const pushText = (raw: string) => {
    let from = 0;
    if (skipLeadingSpace) while (from < raw.length && isSpace(raw[from])) from++;
    if (from === raw.length) return;
    if (lineBreakDue && !endsWithNewline()) out.push('\n');
    out.push(from === 0 ? raw : raw.slice(from));
    lastIsText = true;
    skipLeadingSpace = false;
    lineBreakDue = false;
  };
  /** Push text[from, to), with the pending model bullet replaced if it lies there. */
  const pushRange = (from: number, to: number) => {
    if (dropFrom >= from && dropFrom < to) {
      pushText(text.slice(from, dropFrom) + dropKeep + text.slice(dropTo, to));
      dropFrom = -1;
    } else {
      pushText(text.slice(from, to));
    }
  };
  /**
   * The marker the model wrote at the start of the item whose `<li>` ends at `liEnd`, past
   * whitespace and inline opening tags (`<b>`, read with the same quote-aware scanner): a bullet
   * ('•', '-', '–', '—', '*', '·') or a number ('1.', '1)'), followed — after any closing tags — by
   * whitespace, so "-5 EUR" and "1.5 kg" are not markers.
   */
  const leadingMarker = (liEnd: number) => {
    let p = liEnd + 1;
    let spaceFrom = p;
    for (;;) {
      spaceFrom = p;
      while (p < text.length && /\s/.test(text[p] ?? '')) p++;
      if (text[p] !== '<') break;
      // Opening and closing inline formatting tags are skipped (`<b></b>• item`).
      const opening = /<\/?([a-z][^\s/>"'=<]*)(?=[\s/>])/iy;
      opening.lastIndex = p;
      const tag = opening.exec(text)?.[1]?.toLowerCase();
      if (!tag || !INLINE_FORMAT_TAGS.includes(tag)) return null;
      const scanned = scanTag(text, p);
      if (!scanned || !('end' in scanned)) return null;
      p = scanned.end + 1;
    }
    LIST_ITEM_MARKER.lastIndex = p;
    const m = LIST_ITEM_MARKER.exec(text);
    if (!m) return null;
    return {
      number: m[2] === undefined ? null : Number.parseInt(m[2], 10),
      // The whitespace right before the marker goes with it (`<b>\n  • item</b>`), so the item
      // text stays on the marker's line.
      from: spaceFrom,
      to: LIST_ITEM_MARKER.lastIndex,
      closingTags: m[3] ?? '',
    };
  };
  const trimTrailingSpace = () => {
    while (lastIsText && out.length > 0) {
      const chunk = out[out.length - 1] ?? '';
      let end = chunk.length;
      while (end > 0 && isSpace(chunk[end - 1])) end--;
      if (end > 0) {
        out[out.length - 1] = chunk.slice(0, end);
        return;
      }
      out.pop();
    }
  };
  const startLine = () => {
    trimTrailingSpace();
    if (out.length > 0 && !endsWithNewline()) out.push('\n');
    lastIsText = false;
    skipLeadingSpace = true;
  };

  let textStart = 0;
  // Any tag name is read whole (`li_custom`, `x:y`), so its attributes are scanned quote-aware and
  // only exactly `ul`/`ol`/`li` count as list tags.
  const tagName = /<(\/?)([a-z][^\s/>"'=<]*)/iy;
  let i = text.indexOf('<');
  while (i !== -1) {
    tagName.lastIndex = i;
    const nameMatch = tagName.exec(text);
    if (!nameMatch) {
      i = text.indexOf('<', i + 1);
      continue;
    }
    const scanned = scanTag(text, i);
    // A tag the text ends inside: the rest stays text.
    if (!scanned) break;
    if ('resumeAt' in scanned) {
      i = scanned.resumeAt;
      continue;
    }
    const { end } = scanned;
    const closing = nameMatch[1] === '/';
    const name = (nameMatch[2] ?? '').toLowerCase();
    const selfClosing = text[end - 1] === '/';
    if (!closing && !selfClosing && (name === 'code' || name === 'pre')) {
      // Code is shown as written: skip to its closing tag — exactly `</code>`, the only form the
      // sanitizer restores — list markup inside included. With no closing tag (yet — streaming),
      // everything after it is code.
      const closeTag = new RegExp(`</${name}>`, 'gi');
      closeTag.lastIndex = end + 1;
      const close = closeTag.exec(text);
      if (!close) break;
      i = text.indexOf('<', closeTag.lastIndex);
      continue;
    }
    // A self-closing list tag (`<ul/>`) opens nothing; it is dropped like any other list tag.
    if ((name === 'ul' || name === 'ol') && selfClosing) {
      pushRange(textStart, i);
      textStart = end + 1;
    } else if (name === 'ul' || name === 'ol' || name === 'li') {
      pushRange(textStart, i);
      // Numbering attributes (<ol start="5" reversed>, <li value="3">) are kept: steps are referred
      // to by number. Attributes are tokenized with quoted values consumed whole, so text inside
      // another attribute (`title="start=9"`) is never read as one.
      const attrs = new Map<string, string>();
      for (const m of text
        .slice(i, end)
        .matchAll(/\s([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        const attrName = m[1]?.toLowerCase();
        if (attrName && !attrs.has(attrName))
          attrs.set(attrName, (m[2] ?? m[3] ?? m[4] ?? '').trim());
      }
      const numberAttr = (attr: string) => {
        const raw = attrs.get(attr);
        return raw !== undefined && /^-?\d{1,9}$/.test(raw) ? Number.parseInt(raw, 10) : null;
      };
      if (name === 'li' && !closing) {
        startLine();
        const list = lists.at(-1);
        const value = numberAttr('value');
        if (list) list.count = value ?? list.count + list.step;
        const level = Math.min(Math.max(lists.length - 1, 0), MAX_LIST_INDENT_LEVELS);
        // The model may have written its own marker inside the item (stage QA of PR #170: "• •").
        // A number it wrote is kept as the marker and the counter follows it; a bullet is replaced
        // by ours.
        const own = leadingMarker(end);
        if (own && own.number === null) {
          dropFrom = own.from;
          dropTo = own.to;
          dropKeep = own.closingTags;
        }
        if (own?.number != null && list?.ordered) list.count = own.number;
        const marker = own?.number != null ? '' : list?.ordered ? `${list.count}. ` : '• ';
        out.push(`${'  '.repeat(level)}${marker}`);
        lineBreakDue = false;
      } else if (name === 'li') {
        // Text after a closed item (`</li> Итого: …`) starts its own line.
        trimTrailingSpace();
        lastIsText = false;
        lineBreakDue = true;
        skipLeadingSpace = true;
      } else if (closing) {
        trimTrailingSpace();
        lastIsText = false;
        // Only a closer of the open list's own kind closes it: a stray `</ul>` inside an `<ol>`
        // must not drop its numbering.
        if (lists.at(-1)?.kind === name) lists.pop();
        lineBreakDue = true;
        skipLeadingSpace = true;
      } else {
        startLine();
        // A reversed list counts down from its start. Without a start its first number is the
        // item count, unknown in this single pass, so it gets bullets rather than wrong numbers.
        const reversed = name === 'ol' && attrs.has('reversed');
        const start = numberAttr('start');
        const step = reversed ? -1 : 1;
        lists.push({
          kind: name,
          ordered: name === 'ol' && !(reversed && start === null),
          count: (start ?? 1) - step,
          step,
        });
      }
      textStart = end + 1;
    }
    i = text.indexOf('<', end + 1);
  }
  pushRange(textStart, text.length);
  return out.join('');
}

/**
 * Sanitize text for Telegram HTML parse mode.
 *
 * Strategy: decode existing entities first (idempotent), turn HTML lists into plain lines,
 * escape everything, then restore only whitelisted tags. Safe to call multiple times on the
 * same text without double-escaping.
 */
export function sanitizeHtmlForTelegram(text: string): string {
  // Decode existing entities first so re-sanitizing is idempotent.
  // &amp; → & → &amp; (same result), so calling twice is safe. Decode &amp; LAST
  // so `&amp;lt;` resolves to literal `&lt;` rather than double-unescaping into `<`.
  const decoded = convertHtmlLists(
    text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  );

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
