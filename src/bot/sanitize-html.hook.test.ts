import { describe, expect, test } from 'bun:test';
import { sanitizeHtmlPreRequest } from './sanitize-html.hook';

type PreRequestCtx = { method: string; params: Record<string, unknown> };

describe('sanitizeHtmlPreRequest', () => {
  const hook = sanitizeHtmlPreRequest;

  // ── Only fires when parse_mode === 'HTML' ─────────────────────────

  test('leaves text untouched when parse_mode is absent', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'cats & dogs' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('cats & dogs');
  });

  test('leaves text untouched when parse_mode is MarkdownV2', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'cats & dogs', parse_mode: 'MarkdownV2' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('cats & dogs');
  });

  // ── sendMessage text sanitization ─────────────────────────────────

  test('escapes bare & in sendMessage text', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'cats & dogs', parse_mode: 'HTML' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('cats &amp; dogs');
  });

  test('strips unsupported <div> tag in sendMessage text', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: '<div>content</div>', parse_mode: 'HTML' },
    };
    const result = await hook(ctx as never);
    const text = (result.params as { text: string }).text;
    expect(text).not.toContain('<div>');
    expect(text).toContain('content');
  });

  test('preserves allowed <b> and <i> tags in sendMessage', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: '<b>bold</b> and <i>italic</i>', parse_mode: 'HTML' },
    };
    const result = await hook(ctx as never);
    const text = (result.params as { text: string }).text;
    expect(text).toBe('<b>bold</b> and <i>italic</i>');
  });

  // ── editMessageText text sanitization ─────────────────────────────

  test('sanitizes text in editMessageText', async () => {
    const ctx: PreRequestCtx = {
      method: 'editMessageText',
      params: { text: 'price <h1>header</h1> & total', parse_mode: 'HTML' },
    };
    const result = await hook(ctx as never);
    const text = (result.params as { text: string }).text;
    expect(text).not.toContain('<h1>');
    expect(text).toContain('header');
    expect(text).toContain('&amp;');
  });

  // ── caption sanitization (photos, documents) ──────────────────────

  test('sanitizes caption in sendPhoto', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendPhoto',
      params: { caption: 'receipt <p>total: 100 & tax</p>', parse_mode: 'HTML' },
    };
    const result = await hook(ctx as never);
    const caption = (result.params as { caption: string }).caption;
    expect(caption).not.toContain('<p>');
    expect(caption).toContain('total: 100');
    expect(caption).toContain('&amp;');
  });

  // ── idempotence: safe to call twice ───────────────────────────────

  test('calling hook twice produces same result (no double-escaping)', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'Revenue & expenses: <b>€100</b>', parse_mode: 'HTML' },
    };
    const first = await hook(ctx as never);
    const secondCtx = { method: 'sendMessage', params: { ...first.params } };
    const second = await hook(secondCtx as never);
    expect((first.params as { text: string }).text).toBe((second.params as { text: string }).text);
  });
});
