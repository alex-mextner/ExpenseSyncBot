import { describe, expect, test } from 'bun:test';
import {
  closeUnmatchedTags,
  escapeHtml,
  processThinkTags,
  sanitizeHtmlForTelegram,
  stripAllHtml,
} from '../../utils/html';

// ── escapeHtml ─────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  test('escapes ampersand, less-than, greater-than', () => {
    expect(escapeHtml('A & B < C > D')).toBe('A &amp; B &lt; C &gt; D');
  });

  test('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  test('leaves plain text intact', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });

  test('escapes HTML tags completely', () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;",
    );
  });
});

// ── sanitizeHtmlForTelegram ────────────────────────────────────────────

describe('sanitizeHtmlForTelegram', () => {
  test('preserves whitelisted tags: b, i, code, pre, a, s, u, blockquote', () => {
    const input = '<b>bold</b> <i>italic</i> <code>mono</code> <u>underline</u> <s>strike</s>';
    const result = sanitizeHtmlForTelegram(input);
    expect(result).toContain('<b>bold</b>');
    expect(result).toContain('<i>italic</i>');
    expect(result).toContain('<code>mono</code>');
    expect(result).toContain('<u>underline</u>');
    expect(result).toContain('<s>strike</s>');
  });

  test('strips disallowed tags (div, p, span without tg-spoiler, h1, etc.)', () => {
    const input = '<div>content</div> <h1>title</h1> <p>paragraph</p>';
    const result = sanitizeHtmlForTelegram(input);
    // Disallowed tags should remain escaped
    expect(result).not.toContain('<div>');
    expect(result).not.toContain('<h1>');
    expect(result).not.toContain('<p>');
    expect(result).toContain('&lt;div&gt;');
    expect(result).toContain('&lt;h1&gt;');
    expect(result).toContain('&lt;p&gt;');
  });

  test('removes script tags (security)', () => {
    const input = '<script>alert("xss")</script> hello';
    const result = sanitizeHtmlForTelegram(input);
    expect(result).not.toContain('<script>');
    expect(result).toContain('hello');
  });

  test('strips event handler attributes from allowed tags', () => {
    // onerror in <b> - restoreAllowedAttributes for <b> returns "" for all attributes
    const input = '<b onclick="alert(1)">text</b>';
    const result = sanitizeHtmlForTelegram(input);
    expect(result).not.toContain('onclick');
    expect(result).toContain('<b>text</b>');
  });

  test('preserves href attribute on <a> tags', () => {
    const input = '<a href="https://example.com">link</a>';
    const result = sanitizeHtmlForTelegram(input);
    expect(result).toContain('<a href="https://example.com">link</a>');
  });

  test('preserves expandable attribute on <blockquote>', () => {
    const input = '<blockquote expandable>content</blockquote>';
    const result = sanitizeHtmlForTelegram(input);
    expect(result).toContain('<blockquote expandable>content</blockquote>');
  });

  test('escapes bare ampersands and angle brackets in text', () => {
    const input = 'price < 100 & discount > 20';
    const result = sanitizeHtmlForTelegram(input);
    expect(result).toBe('price &lt; 100 &amp; discount &gt; 20');
  });

  test('handles empty string', () => {
    expect(sanitizeHtmlForTelegram('')).toBe('');
  });

  test('closes unclosed tags automatically', () => {
    const input = '<b>unclosed bold';
    const result = sanitizeHtmlForTelegram(input);
    expect(result).toBe('<b>unclosed bold</b>');
  });

  test('preserves <tg-spoiler> tag', () => {
    const input = '<tg-spoiler>hidden</tg-spoiler>';
    const result = sanitizeHtmlForTelegram(input);
    expect(result).toContain('<tg-spoiler>hidden</tg-spoiler>');
  });

  test('handles nested allowed tags', () => {
    const input = '<b><i>bold italic</i></b>';
    const result = sanitizeHtmlForTelegram(input);
    expect(result).toBe('<b><i>bold italic</i></b>');
  });
});

// ── closeUnmatchedTags ─────────────────────────────────────────────────

describe('closeUnmatchedTags', () => {
  test('closes single unclosed tag', () => {
    expect(closeUnmatchedTags('<b>text')).toBe('<b>text</b>');
  });

  test('closes multiple unclosed tags in reverse order', () => {
    const result = closeUnmatchedTags('<b><i>text');
    expect(result).toBe('<b><i>text</i></b>');
  });

  test('does not add closing tags when HTML is already balanced', () => {
    const input = '<b>bold</b> <i>italic</i>';
    expect(closeUnmatchedTags(input)).toBe(input);
  });

  test('handles empty string', () => {
    expect(closeUnmatchedTags('')).toBe('');
  });

  test('handles text without any tags', () => {
    expect(closeUnmatchedTags('plain text')).toBe('plain text');
  });

  test('handles self-closing-style tag (ignored as non-opening)', () => {
    // Tags ending with /> are treated as self-closing
    expect(closeUnmatchedTags('<br/>text')).toBe('<br/>text');
  });

  test('removes closing tag from stack if matching open exists', () => {
    // Extra closing tag with no matching open — still consumed from stack
    const result = closeUnmatchedTags('<b>bold</b></i>');
    // </i> has no matching open tag, lastIndexOf returns -1, nothing spliced
    expect(result).toBe('<b>bold</b></i>');
  });
});

// ── stripAllHtml ───────────────────────────────────────────────────────

describe('stripAllHtml', () => {
  test('removes all HTML tags', () => {
    expect(stripAllHtml('<b>bold</b> <i>italic</i>')).toBe('bold italic');
  });

  test('decodes HTML entities back to characters', () => {
    expect(stripAllHtml('&lt;tag&gt; &amp; &quot;quote&quot;')).toBe('<tag> & "quote"');
  });

  test('handles empty string', () => {
    expect(stripAllHtml('')).toBe('');
  });

  test('handles text without tags or entities', () => {
    expect(stripAllHtml('plain text 123')).toBe('plain text 123');
  });

  test('strips nested tags completely', () => {
    expect(stripAllHtml('<div><b><i>deep</i></b></div>')).toBe('deep');
  });
});

// ── processThinkTags ───────────────────────────────────────────────────

describe('processThinkTags', () => {
  test('converts completed <think> block to expandable blockquote', () => {
    const input = '<think>some reasoning here</think> answer';
    const result = processThinkTags(input);
    expect(result).toContain('<blockquote expandable>');
    expect(result).toContain('answer');
    // Content inside think is escaped
    expect(result).toContain('some reasoning here');
  });

  test('converts unclosed <think> (streaming) to thinking indicator', () => {
    const input = '<think>still thinking about this';
    const result = processThinkTags(input);
    expect(result).toContain('<i>');
    expect(result).toContain('still thinking about this');
    expect(result).not.toContain('<think>');
  });

  test('handles text without think tags', () => {
    const input = 'normal answer without thinking';
    expect(processThinkTags(input)).toBe(input);
  });

  test('escapes HTML inside think content', () => {
    const input = '<think>if a < b & c > d</think>done';
    const result = processThinkTags(input);
    expect(result).toContain('a &lt; b &amp; c &gt; d');
  });

  test('skips empty think block — no blockquote, no empty content', () => {
    // Empty <think></think> was producing <blockquote expandable></blockquote>
    // which Telegram rejects as "text must be non-empty".
    const input = '<think></think>answer';
    const result = processThinkTags(input);
    expect(result).not.toContain('<blockquote expandable>');
    expect(result).toContain('answer');
  });

  test('skips whitespace-only think block', () => {
    const input = '<think>   \n  </think>answer';
    const result = processThinkTags(input);
    expect(result).not.toContain('<blockquote expandable>');
    expect(result).toContain('answer');
  });
});
