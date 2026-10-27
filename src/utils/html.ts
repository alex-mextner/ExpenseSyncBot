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

function quotedAttributeValue(attrs: string, attr: string): string | null {
  const match = attrs.match(new RegExp(`${attr}=["']([^"']*)["']`, 'i'));
  if (!match) return null;
  return (match[1] || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Rebuilds the safe attribute string (with leading space) for one allowed tag, or ''. */
type AttributeRestorer = (attrs: string) => string;

const restoreClass: AttributeRestorer = (attrs) => {
  const safeClass = quotedAttributeValue(attrs, 'class');
  return safeClass === null ? '' : ` class="${safeClass}"`;
};

const ATTRIBUTE_RESTORERS = new Map<string, AttributeRestorer>([
  [
    'a',
    (attrs) => {
      const safeHref = quotedAttributeValue(attrs, 'href');
      return safeHref === null ? '' : ` href="${safeHref}"`;
    },
  ],
  ['blockquote', (attrs) => (attrs.includes('expandable') ? ' expandable' : '')],
  ['pre', restoreClass],
  ['code', restoreClass],
  ['span', (attrs) => (attrs.includes('tg-spoiler') ? ' class="tg-spoiler"' : '')],
  [
    'tg-emoji',
    (attrs) => {
      const safeId = quotedAttributeValue(attrs, 'emoji-id');
      return safeId === null ? '' : ` emoji-id="${safeId}"`;
    },
  ],
]);

/**
 * Restore only safe attributes for allowed tags. Everything else is stripped.
 */
function restoreAllowedAttributes(tag: string, escapedAttrs: string): string {
  if (!escapedAttrs) return '';

  // Unescape to parse attributes. Decode &amp; LAST so an input like `&amp;lt;`
  // resolves to the literal text `&lt;` instead of double-unescaping into `<`.
  const attrs = escapedAttrs.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  return ATTRIBUTE_RESTORERS.get(tag.toLowerCase())?.(attrs) ?? '';
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

/** An open `<ul>`/`<ol>`: its tag name, whether items are numbered, and the running item number. */
interface OpenList {
  kind: string;
  ordered: boolean;
  count: number;
  step: number;
}

/** A list marker the model wrote itself at the start of an item (see HtmlListConverter). */
interface WrittenMarker {
  number: number | null;
  from: number;
  to: number;
  closingTags: string;
}

/** Integer value of a numbering attribute (`start`, `value`), or null when absent/not a number. */
function numberAttr(attrs: Map<string, string>, attr: string): number | null {
  const raw = attrs.get(attr);
  return raw !== undefined && /^-?\d{1,9}$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

/**
 * Numbering attributes (<ol start="5" reversed>, <li value="3">) are kept: steps are referred
 * to by number. Attributes are tokenized with quoted values consumed whole, so text inside
 * another attribute (`title="start=9"`) is never read as one.
 */
function parseTagAttributes(tagText: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of tagText.matchAll(
    /\s([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
  )) {
    const attrName = m[1]?.toLowerCase();
    if (attrName && !attrs.has(attrName)) attrs.set(attrName, (m[2] ?? m[3] ?? m[4] ?? '').trim());
  }
  return attrs;
}

/**
 * Index just past the inline formatting tag (opening or closing) at `p`, or null when the tag at
 * `p` is not one (or is unterminated / broken by a `<`). Read with the quote-aware tag scanner.
 */
function skipInlineFormatTag(text: string, p: number): number | null {
  const opening = /<\/?([a-z][^\s/>"'=<]*)(?=[\s/>])/iy;
  opening.lastIndex = p;
  const tag = opening.exec(text)?.[1]?.toLowerCase();
  if (!tag || !INLINE_FORMAT_TAGS.includes(tag)) return null;
  const scanned = scanTag(text, p);
  if (!scanned || !('end' in scanned)) return null;
  return scanned.end + 1;
}

/**
 * Single-pass converter state for convertHtmlLists. The pass emits text chunks into `out` and
 * tracks the line/whitespace state needed to lay lists out as plain lines.
 */
class HtmlListConverter {
  private readonly out: string[] = [];
  private readonly lists: OpenList[] = [];
  private lastIsText = false;
  private skipLeadingSpace = false;
  private lineBreakDue = false;
  // The model's own bullet right after an <li> ("<li>• Еда", "<li><b>•</b> Еда"): replaced, since
  // the item gets its own marker. text[dropFrom, dropTo) is pushed as `dropKeep` (the closing tags
  // that sat between the bullet and the item text); dropFrom is -1 when none is pending.
  private dropFrom = -1;
  private dropTo = -1;
  private dropKeep = '';
  private textStart = 0;

  constructor(private readonly text: string) {}

  convert(): string {
    let i = this.text.indexOf('<');
    while (i !== -1) {
      i = this.visitTag(i);
    }
    this.pushRange(this.textStart, this.text.length);
    return this.out.join('');
  }

  /** Handle the `<` at `i`; returns where scanning continues, or -1 when the rest stays text. */
  private visitTag(i: number): number {
    const { text } = this;
    // Any tag name is read whole (`li_custom`, `x:y`), so its attributes are scanned quote-aware and
    // only exactly `ul`/`ol`/`li` count as list tags.
    const tagName = /<(\/?)([a-z][^\s/>"'=<]*)/iy;
    tagName.lastIndex = i;
    const nameMatch = tagName.exec(text);
    if (!nameMatch) return text.indexOf('<', i + 1);

    const scanned = scanTag(text, i);
    // A tag the text ends inside: the rest stays text.
    if (!scanned) return -1;
    if ('resumeAt' in scanned) return scanned.resumeAt;

    const { end } = scanned;
    const closing = nameMatch[1] === '/';
    const name = (nameMatch[2] ?? '').toLowerCase();
    const selfClosing = text[end - 1] === '/';
    if (!closing && !selfClosing && (name === 'code' || name === 'pre')) {
      return this.skipCodeBlock(name, end);
    }
    if (name === 'ul' || name === 'ol' || name === 'li') {
      this.handleListTag(name, closing, selfClosing, i, end);
    }
    return text.indexOf('<', end + 1);
  }

  /**
   * Code is shown as written: skip to its closing tag — exactly `</code>`, the only form the
   * sanitizer restores — list markup inside included. With no closing tag (yet — streaming),
   * everything after it is code (-1).
   */
  private skipCodeBlock(name: string, end: number): number {
    const closeTag = new RegExp(`</${name}>`, 'gi');
    closeTag.lastIndex = end + 1;
    if (!closeTag.exec(this.text)) return -1;
    return this.text.indexOf('<', closeTag.lastIndex);
  }

  private handleListTag(
    name: string,
    closing: boolean,
    selfClosing: boolean,
    tagStart: number,
    end: number,
  ): void {
    this.pushRange(this.textStart, tagStart);
    // A self-closing list tag (`<ul/>`) opens nothing; it is dropped like any other list tag.
    if (!((name === 'ul' || name === 'ol') && selfClosing)) {
      const attrs = parseTagAttributes(this.text.slice(tagStart, end));
      if (name === 'li' && !closing) {
        this.openItem(end, attrs);
      } else if (name === 'li') {
        this.closeItem();
      } else if (closing) {
        this.closeList(name);
      } else {
        this.openList(name, attrs);
      }
    }
    this.textStart = end + 1;
  }

  private endsWithNewline(): boolean {
    return this.out.at(-1)?.endsWith('\n') ?? true;
  }

  private pushText(raw: string): void {
    let from = 0;
    if (this.skipLeadingSpace) while (from < raw.length && isSpace(raw[from])) from++;
    if (from === raw.length) return;
    if (this.lineBreakDue && !this.endsWithNewline()) this.out.push('\n');
    this.out.push(from === 0 ? raw : raw.slice(from));
    this.lastIsText = true;
    this.skipLeadingSpace = false;
    this.lineBreakDue = false;
  }

  /** Push text[from, to), with the pending model bullet replaced if it lies there. */
  private pushRange(from: number, to: number): void {
    const { text } = this;
    if (this.dropFrom >= from && this.dropFrom < to) {
      this.pushText(text.slice(from, this.dropFrom) + this.dropKeep + text.slice(this.dropTo, to));
      this.dropFrom = -1;
    } else {
      this.pushText(text.slice(from, to));
    }
  }

  /** Start of the marker after the `<li>` ending at `liEnd`: past whitespace and inline tags. */
  private findMarkerStart(liEnd: number): { at: number; spaceFrom: number } | null {
    const { text } = this;
    let p = liEnd + 1;
    let spaceFrom = p;
    for (;;) {
      spaceFrom = p;
      while (p < text.length && /\s/.test(text[p] ?? '')) p++;
      if (text[p] !== '<') break;
      // Opening and closing inline formatting tags are skipped (`<b></b>• item`).
      const next = skipInlineFormatTag(text, p);
      if (next === null) return null;
      p = next;
    }
    return { at: p, spaceFrom };
  }

  /**
   * The marker the model wrote at the start of the item whose `<li>` ends at `liEnd`, past
   * whitespace and inline opening tags (`<b>`, read with the same quote-aware scanner): a bullet
   * ('•', '-', '–', '—', '*', '·') or a number ('1.', '1)'), followed — after any closing tags — by
   * whitespace, so "-5 EUR" and "1.5 kg" are not markers.
   */
  private leadingMarker(liEnd: number): WrittenMarker | null {
    const start = this.findMarkerStart(liEnd);
    if (!start) return null;
    LIST_ITEM_MARKER.lastIndex = start.at;
    const m = LIST_ITEM_MARKER.exec(this.text);
    if (!m) return null;
    return {
      number: m[2] === undefined ? null : Number.parseInt(m[2], 10),
      // The whitespace right before the marker goes with it (`<b>\n  • item</b>`), so the item
      // text stays on the marker's line.
      from: start.spaceFrom,
      to: LIST_ITEM_MARKER.lastIndex,
      closingTags: m[3] ?? '',
    };
  }

  private trimTrailingSpace(): void {
    const { out } = this;
    while (this.lastIsText && out.length > 0) {
      const chunk = out[out.length - 1] ?? '';
      let end = chunk.length;
      while (end > 0 && isSpace(chunk[end - 1])) end--;
      if (end > 0) {
        out[out.length - 1] = chunk.slice(0, end);
        return;
      }
      out.pop();
    }
  }

  private startLine(): void {
    this.trimTrailingSpace();
    if (this.out.length > 0 && !this.endsWithNewline()) this.out.push('\n');
    this.lastIsText = false;
    this.skipLeadingSpace = true;
  }

  /** `<li>`: new line with the item's marker (bullet, or the list's running number). */
  private openItem(liEnd: number, attrs: Map<string, string>): void {
    this.startLine();
    const list = this.lists.at(-1);
    const value = numberAttr(attrs, 'value');
    if (list) list.count = value ?? list.count + list.step;
    const level = Math.min(Math.max(this.lists.length - 1, 0), MAX_LIST_INDENT_LEVELS);
    // The model may have written its own marker inside the item (stage QA of PR #170: "• •").
    // A number it wrote is kept as the marker and the counter follows it; a bullet is replaced
    // by ours.
    const own = this.leadingMarker(liEnd);
    if (own && own.number === null) {
      this.dropFrom = own.from;
      this.dropTo = own.to;
      this.dropKeep = own.closingTags;
    }
    if (own?.number != null && list?.ordered) list.count = own.number;
    const marker = own?.number != null ? '' : list?.ordered ? `${list.count}. ` : '• ';
    this.out.push(`${'  '.repeat(level)}${marker}`);
    this.lineBreakDue = false;
  }

  /** `</li>`: text after a closed item (`</li> Итого: …`) starts its own line. */
  private closeItem(): void {
    this.trimTrailingSpace();
    this.lastIsText = false;
    this.lineBreakDue = true;
    this.skipLeadingSpace = true;
  }

  /**
   * `</ul>` / `</ol>`: only a closer of the open list's own kind closes it: a stray `</ul>`
   * inside an `<ol>` must not drop its numbering.
   */
  private closeList(name: string): void {
    this.trimTrailingSpace();
    this.lastIsText = false;
    if (this.lists.at(-1)?.kind === name) this.lists.pop();
    this.lineBreakDue = true;
    this.skipLeadingSpace = true;
  }

  private openList(name: string, attrs: Map<string, string>): void {
    this.startLine();
    // A reversed list counts down from its start. Without a start its first number is the
    // item count, unknown in this single pass, so it gets bullets rather than wrong numbers.
    const reversed = name === 'ol' && attrs.has('reversed');
    const start = numberAttr(attrs, 'start');
    const step = reversed ? -1 : 1;
    this.lists.push({
      kind: name,
      ordered: name === 'ol' && !(reversed && start === null),
      count: (start ?? 1) - step,
      step,
    });
  }
}

/**
 * Turn HTML lists into plain lines: Telegram HTML has no list tags, and escaped `<ul>`/`<li>`
 * show up literally (#165). `<ul>` items become `• item`, `<ol>` items `1. item`; nested lists are
 * indented two spaces per level (capped). Whitespace around list tags (source indentation) goes.
 * One linear pass over real tags: attribute values and `<code>`/`<pre>` contents are untouched.
 */
function convertHtmlLists(text: string): string {
  if (!/<\/?(?:ul|ol|li)[\s/>]/i.test(text)) return text;
  return new HtmlListConverter(text).convert();
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
