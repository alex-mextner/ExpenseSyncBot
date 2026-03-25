// Tests for the escapeHtml() utility.

import { describe, expect, it } from 'bun:test';
import { escapeHtml } from './html-escape';

describe('escapeHtml', () => {
  it('escapes <script> tags', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes quotes and ampersands', () => {
    expect(escapeHtml('"foo" & \'bar\'')).toBe('&quot;foo&quot; &amp; &#39;bar&#39;');
  });

  it('escapes all five special characters individually', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  it('handles numbers', () => {
    expect(escapeHtml(42)).toBe('42');
  });

  it('handles plain strings with no special characters', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('does not double-escape already-escaped entities', () => {
    // escapeHtml is not idempotent — it escapes the & in &amp; to &amp;amp;
    // This is the correct behaviour: callers must only pass raw (unescaped) values.
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('handles an XSS payload in an error_description query param', () => {
    const malicious = '<img src=x onerror="alert(\'XSS\')">';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).toContain('&lt;img');
  });
});
