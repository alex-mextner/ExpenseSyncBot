import { describe, expect, test } from 'bun:test';
import { sanitizeHtmlPreRequest } from './sanitize-html.hook';

type PreRequestCtx = { method: string; params: Record<string, unknown> };

describe('sanitizeHtmlPreRequest', () => {
  const hook = sanitizeHtmlPreRequest;

  // ── No parse_mode: leave as-is ────────────────────────────────────

  test('leaves text untouched when parse_mode is absent', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'cats & dogs' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('cats & dogs');
  });

  // ── HTML sanitization ─────────────────────────────────────────────

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

  test('HTML hook is idempotent (no double-escaping)', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'Revenue & expenses: <b>€100</b>', parse_mode: 'HTML' },
    };
    const first = await hook(ctx as never);
    const secondCtx = { method: 'sendMessage', params: { ...first.params } };
    const second = await hook(secondCtx as never);
    expect((first.params as { text: string }).text).toBe((second.params as { text: string }).text);
  });

  // ── MarkdownV2 escaping ───────────────────────────────────────────

  test('escapes _ in MarkdownV2 text', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'snake_case variable', parse_mode: 'MarkdownV2' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('snake\\_case variable');
  });

  test('escapes * in MarkdownV2 text', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'price * 100', parse_mode: 'MarkdownV2' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('price \\* 100');
  });

  test('escapes . and ! in MarkdownV2 text', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'Hello world. Done!', parse_mode: 'MarkdownV2' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('Hello world\\. Done\\!');
  });

  test('escapes [ ] ( ) ~ > # + - = | { } in MarkdownV2', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: '[a](b) ~x~ >q# +1 -1 =x |y {z}', parse_mode: 'MarkdownV2' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe(
      '\\[a\\]\\(b\\) \\~x\\~ \\>q\\# \\+1 \\-1 \\=x \\|y \\{z\\}',
    );
  });

  test('does not change & in MarkdownV2 (not a special char)', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'cats & dogs', parse_mode: 'MarkdownV2' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('cats & dogs');
  });

  test('MarkdownV2 hook is idempotent (no double-escaping)', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'total: 100.50 (EUR) — done!', parse_mode: 'MarkdownV2' },
    };
    const first = await hook(ctx as never);
    const secondCtx = { method: 'sendMessage', params: { ...first.params } };
    const second = await hook(secondCtx as never);
    expect((first.params as { text: string }).text).toBe((second.params as { text: string }).text);
  });

  test('escapes caption in MarkdownV2', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendPhoto',
      params: { caption: 'receipt: 100.50 (EUR)', parse_mode: 'MarkdownV2' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { caption: string }).caption).toBe('receipt: 100\\.50 \\(EUR\\)');
  });

  // ── legacy Markdown escaping ──────────────────────────────────────

  test('escapes _ in legacy Markdown text', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'snake_case', parse_mode: 'Markdown' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('snake\\_case');
  });

  test('escapes * in legacy Markdown text', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: '2 * 3 = 6', parse_mode: 'Markdown' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('2 \\* 3 = 6');
  });

  test('escapes backtick in legacy Markdown text', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'run `ls -la` now', parse_mode: 'Markdown' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('run \\`ls -la\\` now');
  });

  test('escapes [ ] in legacy Markdown text', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'see [docs] for details', parse_mode: 'Markdown' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('see \\[docs\\] for details');
  });

  test('does not escape . or ! in legacy Markdown (not special there)', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'Hello world. Done!', parse_mode: 'Markdown' },
    };
    const result = await hook(ctx as never);
    expect((result.params as { text: string }).text).toBe('Hello world. Done!');
  });

  test('legacy Markdown hook is idempotent (no double-escaping)', async () => {
    const ctx: PreRequestCtx = {
      method: 'sendMessage',
      params: { text: 'snake_case and 2 * 3', parse_mode: 'Markdown' },
    };
    const first = await hook(ctx as never);
    const secondCtx = { method: 'sendMessage', params: { ...first.params } };
    const second = await hook(secondCtx as never);
    expect((first.params as { text: string }).text).toBe((second.params as { text: string }).text);
  });
});
