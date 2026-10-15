// Tests for HTML sanitization utilities — streaming, truncation, and tag closing edge cases
import { describe, expect, test } from 'bun:test';
import {
  closeUnmatchedTags,
  escapeHtml,
  escapeMarkdown,
  escapeMarkdownV2,
  processThinkTags,
  sanitizeHtmlForTelegram,
  stripAllHtml,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  truncateForTelegram,
} from './html';

// ── closeUnmatchedTags ──────────────────────────────────────────────

describe('closeUnmatchedTags', () => {
  test('returns text unchanged when all tags are balanced', () => {
    const html = '<b>bold</b> and <i>italic</i>';
    expect(closeUnmatchedTags(html)).toBe(html);
  });

  test('closes single unclosed <i> tag', () => {
    const html = '<i>streaming text without close';
    expect(closeUnmatchedTags(html)).toBe('<i>streaming text without close</i>');
  });

  test('closes single unclosed <b> tag', () => {
    const html = '<b>bold text still open';
    expect(closeUnmatchedTags(html)).toBe('<b>bold text still open</b>');
  });

  test('closes multiple unclosed tags in reverse order', () => {
    const html = '<b><i>nested but not closed';
    expect(closeUnmatchedTags(html)).toBe('<b><i>nested but not closed</i></b>');
  });

  test('closes unclosed <blockquote> with nested closed tags', () => {
    const html = '<blockquote expandable><b>title</b>\ncontent';
    expect(closeUnmatchedTags(html)).toBe(
      '<blockquote expandable><b>title</b>\ncontent</blockquote>',
    );
  });

  test('handles extra closing tags gracefully (no crash)', () => {
    const html = 'text</b></i>';
    // Extra closing tags have no matching open — just pass through
    expect(closeUnmatchedTags(html)).toBe('text</b></i>');
  });

  test('handles self-closing tags correctly (no false close)', () => {
    const html = '<b>text<br/>more</b>';
    expect(closeUnmatchedTags(html)).toBe('<b>text<br/>more</b>');
  });

  test('handles tg-spoiler hyphenated tag', () => {
    const html = '<tg-spoiler>spoiler text';
    const result = closeUnmatchedTags(html);
    expect(result).toContain('</tg-spoiler>');
  });
});

// ── sanitizeHtmlForTelegram ─────────────────────────────────────────

describe('sanitizeHtmlForTelegram', () => {
  // #165: Telegram HTML has no list tags; models (gpt-oss) still answer with them.
  describe('HTML lists become plain lines', () => {
    test('the stage answer: a <ul> of categories turns into • lines, no visible tags', () => {
      const answer =
        'Траты за октябрь:\n<ul>\n  <li><b>Путешествия</b>: <b>2798.61 EUR</b></li>\n  <li><b>Еда</b>: <b>420.00 EUR</b></li>\n</ul>\nИтого: <b>3218.61 EUR</b>';
      expect(sanitizeHtmlForTelegram(answer)).toBe(
        'Траты за октябрь:\n• <b>Путешествия</b>: <b>2798.61 EUR</b>\n• <b>Еда</b>: <b>420.00 EUR</b>\nИтого: <b>3218.61 EUR</b>',
      );
    });

    test('issue acceptance: <ul><li>a</li><li><b>b</b></li></ul>', () => {
      const result = sanitizeHtmlForTelegram('<ul><li>a</li><li><b>b</b></li></ul>');
      expect(result).toBe('• a\n• <b>b</b>');
      expect(result).not.toContain('&lt;ul');
      expect(result).not.toContain('&lt;li');
    });

    test('an <ol> is numbered, a nested list is indented', () => {
      expect(
        sanitizeHtmlForTelegram('<ol><li>Еда<ul><li>кафе</li></ul></li><li>Дом</li></ol>'),
      ).toBe('1. Еда\n  • кафе\n2. Дом');
    });

    test('is idempotent', () => {
      const once = sanitizeHtmlForTelegram('<ul><li><b>a</b> &amp; b</li></ul>');
      expect(sanitizeHtmlForTelegram(once)).toBe(once);
    });

    test('list-like text inside an attribute value is left alone', () => {
      const html = '<a href="https://example.com/?q=&lt;ul&gt;">Open</a><ul><li>x</li></ul>';
      const result = sanitizeHtmlForTelegram(html);
      expect(result).toContain('Open</a>');
      expect(result).not.toContain('q=\n');
      expect(result).toContain('\n• x');
    });

    test('a tag that only starts with li is not a list item', () => {
      const result = sanitizeHtmlForTelegram('<ul><li>a</li></ul><li-custom>keep</li-custom>');
      expect(result).toBe('• a\n&lt;li-custom&gt;keep&lt;/li-custom&gt;');
    });

    test.each([
      ['code', '<code>&lt;ul&gt;&lt;li&gt;a&lt;/li&gt;&lt;/ul&gt;</code>'],
      ['pre', '<pre>&lt;ul&gt;&lt;li&gt;example&lt;/li&gt;&lt;/ul&gt;</pre>'],
      [
        'code with a closing-tag look-alike inside',
        '<code>&lt;/code-example&gt;&lt;ol&gt;&lt;li&gt;a&lt;/li&gt;&lt;/ol&gt;</code>',
      ],
    ])('list markup inside <%s> stays literal', (_tag, html) => {
      expect(sanitizeHtmlForTelegram(html)).toBe(html);
    });

    test.each(['<li-custom>', '<li_custom>', '<li:x>'])('%s is not a list item', (tag) => {
      const close = `</${tag.slice(1)}`;
      const result = sanitizeHtmlForTelegram(`<ul><li>a</li></ul>${tag}keep${close}`);
      expect(result.startsWith('• a\n&lt;')).toBe(true);
      expect(result).not.toContain('• keep');
    });

    test('explicit numbering is kept: <ol start> and <li value>', () => {
      expect(
        sanitizeHtmlForTelegram(
          '<ol start="5"><li>пятый</li><li>шестой</li><li value="9">девятый</li><li>десятый</li></ol>',
        ),
      ).toBe('5. пятый\n6. шестой\n9. девятый\n10. десятый');
    });

    test.each([
      ['<ol start="-2"><li>a</li><li>b</li></ol>', '-2. a\n-1. b'],
      ['<ol start="1000000"><li>a</li></ol>', '1000000. a'],
      ['<ol title="example start=9"><li>a</li></ol>', '1. a'],
      ['<ol data-v2="example start=9"><li>a</li><li>b</li></ol>', '1. a\n2. b'],
      ['<ol data_note="example start=9"><li>a</li></ol>', '1. a'],
      ['<ol reversed start="5"><li>a</li><li>b</li></ol>', '5. a\n4. b'],
      ['<ol start=\'3\'><li value="-1">a</li><li>b</li></ol>', '-1. a\n0. b'],
      ['<ol reversed><li>a</li><li>b</li></ol>', '• a\n• b'],
    ])('numbering attributes are read exactly: %s', (html, expected) => {
      expect(sanitizeHtmlForTelegram(html)).toBe(expected);
    });

    test('a self-closing <ul/> opens no list', () => {
      expect(sanitizeHtmlForTelegram('<ul/><ol><li>a</li></ol>')).toBe('1. a');
    });

    test('a stray </ul> inside an <ol> keeps the numbering', () => {
      expect(sanitizeHtmlForTelegram('<ol><li>a</ul><li>b</li></ol>')).toBe('1. a\n2. b');
    });
    test('a self-closing <code/> is not a code block', () => {
      expect(sanitizeHtmlForTelegram('<code/>text<ul><li>real</li></ul>')).toBe(
        '&lt;code/&gt;text\n• real',
      );
    });

    test('list markup in a quoted attribute of a long custom tag stays out of the list', () => {
      const tag = `x-${'a'.repeat(40)}`;
      const result = sanitizeHtmlForTelegram(
        `<${tag} title="<ul><li>example</li></ul>">t</${tag}>`,
      );
      expect(result).not.toContain('• example');
    });

    test.each([
      'x_custom',
      'x:y',
    ])('list markup in a quoted attribute of <%s> stays out of the list', (tag) => {
      const result = sanitizeHtmlForTelegram(
        `<${tag} title="<ul><li>example</li></ul>">keep</${tag}>`,
      );
      expect(result).not.toContain('• example');
    });

    // Stage QA of PR #170 (b): the model wrote its own bullet inside <li>, and the conversion
    // added a second one: "• • Путешествия: 2798.61 EUR".
    test.each([
      [
        'the stage shape',
        '<ul><li>• Путешествия: <b>2798.61 EUR</b></li><li>• Еда: <b>420.00 EUR</b></li></ul>',
        '• Путешествия: <b>2798.61 EUR</b>\n• Еда: <b>420.00 EUR</b>',
      ],
      [
        'the bullet inside <b>',
        '<ul><li><b>• Путешествия</b>: 2798.61 EUR</li></ul>',
        '• <b>Путешествия</b>: 2798.61 EUR',
      ],
      [
        'dashes, asterisks and middle dots become •',
        '<ul><li>- a</li><li>– b</li><li>— c</li><li>* d</li><li>· e</li></ul>',
        '• a\n• b\n• c\n• d\n• e',
      ],
      [
        'a numbered item keeps the model number, no extra marker',
        '<ul><li>1. Еда</li><li>2) Дом</li></ul>',
        '1. Еда\n2) Дом',
      ],
      [
        'an <ol> item with its own number is not numbered twice',
        '<ol><li>1. Еда</li><li>2. Дом</li></ol>',
        '1. Еда\n2. Дом',
      ],
      [
        'a negative amount or a decimal is not a marker',
        '<ul><li>-5 EUR</li><li>1.5 kg</li></ul>',
        '• -5 EUR\n• 1.5 kg',
      ],
      [
        'a nested item keeps its indent',
        '<ul><li>Еда<ul><li>• кафе</li></ul></li></ul>',
        '• Еда\n  • кафе',
      ],
      ['a bullet in its own <b>', '<ul><li><b>•</b> Еда</li></ul>', '• <b></b>Еда'],
      [
        'an inline tag with a "<" in a quoted attribute (the sanitizer drops the attribute)',
        '<ul><li><b title="<">• item</b></li></ul>',
        '• <b>item</b>',
      ],
      [
        'numbering continues from the number the model wrote',
        '<ol><li>2. A</li><li>B</li></ol>',
        '2. A\n3. B',
      ],
      ['a newline after the bullet', '<ul><li>•\nЕда</li><li>•\r\nДом</li></ul>', '• Еда\n• Дом'],
      ['a bullet alone before </li> is not a marker', '<ul><li>•</li> <li>B</li></ul>', '• •\n• B'],
      [
        'a non-formatting tag ends the look-ahead',
        '<ul><li><custom>• item</custom></li></ul>',
        '• &lt;custom&gt;• item&lt;/custom&gt;',
      ],
      [
        'an empty formatting wrapper before the bullet',
        '<ul><li><b></b>• item</li></ul>',
        '• <b></b>item',
      ],
      [
        'five-digit numbers the model wrote',
        '<ol start="9999"><li>9999. A</li><li>10000. B</li></ol>',
        '9999. A\n10000. B',
      ],
      [
        'an empty wrapper after the bullet',
        '<ul><li><b>•</b><i></i> item</li></ul>',
        '• <b></b><i></i>item',
      ],
      [
        'a newline inside the wrapper before the bullet',
        '<ul><li><b>\n  • item</b></li><li>next</li></ul>',
        '• <b>item</b>\n• next',
      ],
    ])('a marker the model already wrote is not doubled: %s', (_label, html, expected) => {
      expect(sanitizeHtmlForTelegram(html)).toBe(expected);
    });

    test('text after a closed item starts its own line', () => {
      expect(sanitizeHtmlForTelegram('<ul><li>Еда: 10 EUR</li> Итого: 10 EUR</ul>')).toBe(
        '• Еда: 10 EUR\nИтого: 10 EUR',
      );
    });

    test('broken quoted tags after a list stay text', () => {
      const html = `<ul><li>a</li></ul><a title="${'<a '.repeat(50)}" <b " <`;
      const result = sanitizeHtmlForTelegram(html);
      expect(result.startsWith('• a\n&lt;a title=')).toBe(true);
    });

    test('a closing-tag look-alike with a space does not end a code example', () => {
      const html = '<code>&lt;/code &gt;&lt;ul&gt;&lt;li&gt;x&lt;/li&gt;&lt;/ul&gt;</code>';
      expect(sanitizeHtmlForTelegram(html)).toBe(html);
    });

    test('an unclosed <pre> (still streaming) keeps its list markup literal', () => {
      expect(sanitizeHtmlForTelegram('<pre>&lt;ul&gt;&lt;li&gt;a')).toBe(
        '<pre>&lt;ul&gt;&lt;li&gt;a</pre>',
      );
    });

    test('a list after a code block is converted, whatever text came before', () => {
      expect(
        sanitizeHtmlForTelegram(`${'İ'.repeat(10)}<code>x</code><ol><li>a</li><li>b</li></ol>`),
      ).toBe(`${'İ'.repeat(10)}<code>x</code>\n1. a\n2. b`);
    });

    test('deep nesting does not blow up the output (indent is capped)', () => {
      const depth = 4000;
      const html = `${'<ul><li>'.repeat(depth)}x${'</li></ul>'.repeat(depth)}`;
      const result = sanitizeHtmlForTelegram(html);
      expect(result.length).toBeLessThan(html.length);
      expect(result).toContain('x');
    });

    test('a long run of spaces after a list is dropped only where it surrounds list tags', () => {
      const html = `<ul><li>a</li></ul>x${' '.repeat(40_000)}x`;
      expect(sanitizeHtmlForTelegram(html)).toBe(`• a\nx${' '.repeat(40_000)}x`);
    });
  });

  // Basic functionality
  test('preserves allowed tags', () => {
    const html = '<b>bold</b> <i>italic</i> <code>code</code>';
    expect(sanitizeHtmlForTelegram(html)).toBe(html);
  });

  test('strips disallowed tags but keeps content', () => {
    const html = '<div>content</div>';
    const result = sanitizeHtmlForTelegram(html);
    expect(result).not.toContain('<div>');
    expect(result).toContain('content');
  });

  test('escapes bare ampersand', () => {
    expect(sanitizeHtmlForTelegram('cats & dogs')).toBe('cats &amp; dogs');
  });

  test('escapes bare < and > outside tags', () => {
    const result = sanitizeHtmlForTelegram('1 < 2 > 0');
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
  });

  test('is idempotent — calling twice gives same result', () => {
    const html = 'Revenue & expenses: <b>€100</b>';
    const first = sanitizeHtmlForTelegram(html);
    const second = sanitizeHtmlForTelegram(first);
    expect(first).toBe(second);
  });

  // SECURITY: &amp; is decoded LAST, so an already-escaped `&amp;lt;b&amp;gt;`
  // stays escaped instead of double-unescaping into a real `<b>` tag, and the
  // function stays idempotent on that input (a prior bug collapsed it on re-run).
  test('SECURITY: does not double-unescape &amp;lt; and stays idempotent', () => {
    const escaped = '&amp;lt;b&amp;gt;';
    const first = sanitizeHtmlForTelegram(escaped);
    expect(first).not.toContain('<b>');
    expect(first).toContain('&amp;lt;');
    expect(sanitizeHtmlForTelegram(first)).toBe(first);
  });

  // ── Streaming scenarios (unclosed tags from AI) ────────────────────

  test('STREAMING: closes unclosed <i> at end of text', () => {
    const html = '<i>streaming text still being generated';
    const result = sanitizeHtmlForTelegram(html);
    expect(result).toContain('</i>');
    expect(result).toBe('<i>streaming text still being generated</i>');
  });

  test('STREAMING: closes unclosed <b> with completed <i> pairs', () => {
    const html = '<b>Категория: <i>details</i> and more';
    const result = sanitizeHtmlForTelegram(html);
    expect(result).toContain('</b>');
    expect(result).toBe('<b>Категория: <i>details</i> and more</b>');
  });

  test('STREAMING: handles incomplete closing tag </ at end of text', () => {
    // AI is mid-stream generating </i> but only </ has arrived
    const html = '<i>some text</';
    const result = sanitizeHtmlForTelegram(html);
    // The </ should be escaped (not a valid tag), and <i> should be closed
    expect(result).toContain('</i>');
    // The </ should be escaped to &lt;/
    expect(result).toMatch(/&lt;\//);
    expect(result).toContain('</i>');
  });

  test('STREAMING: handles incomplete opening tag <i at end of text', () => {
    // AI started writing <i> but only <i arrived (no >)
    const html = 'text before <i';
    const result = sanitizeHtmlForTelegram(html);
    // The incomplete <i should be escaped, not treated as a tag
    expect(result).toContain('&lt;i');
  });

  // ── Production crash scenario ──────────────────────────────────────

  test('PRODUCTION BUG: exact text from error logs — unclosed <i> in expense report', () => {
    // This is the exact text structure that caused 400 errors in production
    const html = `<blockquote expandable>⚙️ <b>Инструменты</b>
✅ <i>Загружаю расходы: март 2026</i></blockquote>

<b>Потрачено за март 2026 по категориям</b>

<u>EUR-категории</u>:

▪️ <b>Путешествия</b>: <b>2949.47 EUR</b>
<i>• 14.03 — 1149.47 EUR (Барселона билеты)
• 14.03 — 1800.00 EUR (Барселона отель)</i>

▪️ <b>Лена</b>: <b>594.37 EUR</b>
<i>• 21.03 — 94.37 EUR (Zara)
• 02.03 — 280.00 EUR (косметика)</i>

▪️ <b>Коты</b>: <b>54.16 EUR</b> ≈ 6342 RSD
<i>• 10.03 — 2575 RSD (наполнитель)
• 03.03 — 3767 RSD`;

    const result = sanitizeHtmlForTelegram(html);

    // Must have balanced tags — count opens vs closes for <i>
    const iOpens = (result.match(/<i>/gi) || []).length;
    const iCloses = (result.match(/<\/i>/gi) || []).length;
    expect(iOpens).toBe(iCloses);

    // Same for <b>
    const bOpens = (result.match(/<b>/gi) || []).length;
    const bCloses = (result.match(/<\/b>/gi) || []).length;
    expect(bOpens).toBe(bCloses);

    // Same for <blockquote>
    const bqOpens = (result.match(/<blockquote[^>]*>/gi) || []).length;
    const bqCloses = (result.match(/<\/blockquote>/gi) || []).length;
    expect(bqOpens).toBe(bqCloses);

    // Same for <u>
    const uOpens = (result.match(/<u>/gi) || []).length;
    const uCloses = (result.match(/<\/u>/gi) || []).length;
    expect(uOpens).toBe(uCloses);
  });

  test('PRODUCTION BUG: text with incomplete </i at end (streaming)', () => {
    const html = `▪️ <b>Коты</b>: <b>54.16 EUR</b>
<i>• 10.03 — 2575 RSD (наполнитель)
• 03.03 — 3767 RSD (корм)</`;

    const result = sanitizeHtmlForTelegram(html);

    const iOpens = (result.match(/<i>/gi) || []).length;
    const iCloses = (result.match(/<\/i>/gi) || []).length;
    expect(iOpens).toBe(iCloses);
  });

  // ── Attribute handling ─────────────────────────────────────────────

  test('preserves href on <a> tags', () => {
    const html = '<a href="https://example.com">link</a>';
    const result = sanitizeHtmlForTelegram(html);
    expect(result).toContain('href="https://example.com"');
  });

  test('preserves expandable attribute on <blockquote>', () => {
    const html = '<blockquote expandable>content</blockquote>';
    const result = sanitizeHtmlForTelegram(html);
    expect(result).toContain('<blockquote expandable>');
  });

  test('strips unknown attributes from allowed tags', () => {
    const html = '<b class="red" onclick="alert()">text</b>';
    const result = sanitizeHtmlForTelegram(html);
    expect(result).not.toContain('class=');
    expect(result).not.toContain('onclick=');
    expect(result).toContain('<b>');
    expect(result).toContain('text');
  });

  // SECURITY: exercises restoreAllowedAttributes' attribute decode path (the most
  // sensitive — it parses href). An escaped `&amp;lt;script&amp;gt;` inside an
  // href must NOT double-unescape into a live `<script>` in the attribute value.
  test('SECURITY: href value does not double-unescape &amp;lt; into a live tag', () => {
    const html = '<a href="https://x.com/?q=&amp;lt;script&amp;gt;">link</a>';
    const result = sanitizeHtmlForTelegram(html);
    expect(result).not.toMatch(/<script/i);
    expect(result).toContain('href="https://x.com/?q=');
  });
});

// ── processThinkTags ────────────────────────────────────────────────

describe('processThinkTags', () => {
  test('converts completed <think> block to expandable blockquote', () => {
    const text = '<think>reasoning here</think>Answer';
    const result = processThinkTags(text);
    expect(result).toContain('<blockquote expandable>');
    expect(result).toContain('Размышления');
    expect(result).toContain('Answer');
  });

  test('removes empty <think> blocks', () => {
    const text = '<think></think>Answer';
    const result = processThinkTags(text);
    expect(result).not.toContain('Размышления');
    expect(result).toBe('Answer');
  });

  test('converts unclosed <think> (streaming) to thinking indicator', () => {
    const text = '<think>partial reasoning';
    const result = processThinkTags(text);
    expect(result).toContain('Бот думает...');
    expect(result).toContain('partial reasoning');
  });

  test('escapes HTML inside think blocks to prevent injection', () => {
    const text = '<think><b>bold</b> & "quotes"</think>After';
    const result = processThinkTags(text);
    expect(result).toContain('&lt;b&gt;');
    expect(result).toContain('&amp;');
  });
});

// ── escapeHtml ──────────────────────────────────────────────────────

describe('escapeHtml', () => {
  test('escapes & < >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  test('leaves plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

// ── stripAllHtml ────────────────────────────────────────────────────

describe('stripAllHtml', () => {
  test('removes all tags and decodes entities', () => {
    const html = '<b>bold</b> &amp; <i>italic</i>';
    expect(stripAllHtml(html)).toBe('bold & italic');
  });

  test('handles nested tags', () => {
    expect(stripAllHtml('<b><i>nested</i></b>')).toBe('nested');
  });

  // SECURITY: a single tag-strip pass is an incomplete sanitizer — a partial match
  // like `<scr<script>ipt>` reassembles into a live `<script>` after one removal.
  // stripAllHtml loops to a fixpoint, so no live tag may survive.
  test('SECURITY: strips reassembling nested script (no residual live tag)', () => {
    const evil = '<scr<script>ipt>alert(1)</scr</script>ipt>';
    const result = stripAllHtml(evil);
    expect(result).not.toMatch(/<script/i);
    expect(result).not.toContain('<');
  });

  // SECURITY: &amp; must be decoded LAST, otherwise `&amp;lt;` double-unescapes
  // into a real `<` (an injection vector). It must stay the literal text `&lt;`.
  test('SECURITY: does not double-unescape &amp;lt; into <', () => {
    expect(stripAllHtml('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(stripAllHtml('&amp;lt;script&amp;gt;')).not.toContain('<script>');
  });
});

// ── escapeMarkdownV2 ────────────────────────────────────────────────

describe('escapeMarkdownV2', () => {
  test('escapes all 18 special characters', () => {
    expect(escapeMarkdownV2('_*[]()~`>#+-=|{}.!')).toBe(
      '\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!',
    );
  });

  test('is idempotent', () => {
    const text = 'price: 100.50 (EUR)!';
    const first = escapeMarkdownV2(text);
    const second = escapeMarkdownV2(first);
    expect(first).toBe(second);
  });
});

// ── escapeMarkdown ──────────────────────────────────────────────────

describe('escapeMarkdown', () => {
  test('escapes _ * ` [ ]', () => {
    expect(escapeMarkdown('_*`[]')).toBe('\\_\\*\\`\\[\\]');
  });

  test('is idempotent', () => {
    const text = 'snake_case and 2 * 3';
    const first = escapeMarkdown(text);
    const second = escapeMarkdown(first);
    expect(first).toBe(second);
  });
});

// ── Tag balancing stress tests ──────────────────────────────────────

describe('tag balancing stress', () => {
  test('handles 50+ tag pairs correctly', () => {
    const pairs = Array.from({ length: 50 }, (_, i) => `<b>item${i}</b>`).join(' ');
    const result = sanitizeHtmlForTelegram(pairs);
    const bOpens = (result.match(/<b>/gi) || []).length;
    const bCloses = (result.match(/<\/b>/gi) || []).length;
    expect(bOpens).toBe(bCloses);
  });

  test('handles alternating open/close with unclosed tail', () => {
    const html = '<b>a</b><i>b</i><b>c</b><i>d';
    const result = sanitizeHtmlForTelegram(html);
    const iOpens = (result.match(/<i>/gi) || []).length;
    const iCloses = (result.match(/<\/i>/gi) || []).length;
    expect(iOpens).toBe(iCloses);
  });

  test('deeply nested unclosed tags all get closed', () => {
    const html = '<blockquote expandable><b><i><code>deep';
    const result = sanitizeHtmlForTelegram(html);
    expect(result).toContain('</code>');
    expect(result).toContain('</i>');
    expect(result).toContain('</b>');
    expect(result).toContain('</blockquote>');
  });

  test('text with only encoded entities and no real tags passes through clean', () => {
    const html = '100 &lt; 200 &amp; 300 &gt; 50';
    const result = sanitizeHtmlForTelegram(html);
    // Should be the same (idempotent)
    expect(result).toBe('100 &lt; 200 &amp; 300 &gt; 50');
  });
});

// ── truncateForTelegram ─────────────────────────────────────────────

describe('truncateForTelegram', () => {
  test('returns short text unchanged', () => {
    expect(truncateForTelegram('hello')).toBe('hello');
  });

  test('returns text at exactly the limit unchanged', () => {
    const text = 'a'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(truncateForTelegram(text)).toBe(text);
  });

  test('truncates text over the limit and adds ellipsis marker', () => {
    const text = 'a'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 100);
    const result = truncateForTelegram(text);
    expect(result.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(result).toContain('…(обрезано)');
  });

  test('respects custom maxLength', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(3); // 78 chars
    const result = truncateForTelegram(text, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toContain('…(обрезано)');
  });

  test('does not touch text shorter than custom maxLength', () => {
    expect(truncateForTelegram('short', 100)).toBe('short');
  });
});
