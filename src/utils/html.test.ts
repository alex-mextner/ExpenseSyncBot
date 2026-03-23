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
