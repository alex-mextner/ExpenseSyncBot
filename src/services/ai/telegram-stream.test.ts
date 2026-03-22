import { afterEach, describe, expect, mock, test } from 'bun:test';
import { TelegramStreamWriter } from './telegram-stream';

/**
 * Testing private methods via bracket notation on a minimal instance.
 * The constructor requires a Bot, chatId -- we pass stubs since these
 * pure string methods don't touch the bot API.
 */
function makeWriter(): TelegramStreamWriter {
  const fakeBot = {
    api: {
      sendMessage: () => Promise.resolve({ message_id: 1 }),
      sendChatAction: () => Promise.resolve(),
      deleteMessage: () => Promise.resolve(),
      editMessageText: () => Promise.resolve(),
    },
    // biome-ignore lint/suspicious/noExplicitAny: test stub for Bot API
  } as any;
  return new TelegramStreamWriter(fakeBot, 123);
}

// ── splitIntoChunks ───────────────────────────────────────────────────

describe('splitIntoChunks', () => {
  const writer = makeWriter();
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  afterEach(() => (writer as any).stopTyping());
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  const split = (text: string, max: number): string[] => (writer as any).splitIntoChunks(text, max);

  test('short text returns single chunk', () => {
    const result = split('hello world', 4000);
    expect(result).toEqual(['hello world']);
  });

  test('text exceeding limit splits into multiple chunks', () => {
    // Build two paragraphs, each ~60 chars
    const para1 = 'A'.repeat(60);
    const para2 = 'B'.repeat(60);
    const text = `${para1}\n\n${para2}`;

    const chunks = split(text, 80);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  test('splits on paragraph boundaries (\\n\\n)', () => {
    const paragraphs = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'];
    const text = paragraphs.join('\n\n');
    // maxLength big enough for 2 paragraphs but not 3
    const maxLen = 'First paragraph.\n\nSecond paragraph.'.length;

    const chunks = split(text, maxLen);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe('First paragraph.\n\nSecond paragraph.');
    expect(chunks[1]).toBe('Third paragraph.');
  });

  test('single long paragraph without \\n\\n is split by words', () => {
    // 100 words x ~7 chars -> ~700 chars total, split at 100
    const words = Array.from({ length: 100 }, (_, i) => `word${String(i).padStart(2, '0')}`);
    const longText = words.join(' ');
    const chunks = split(longText, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    // No word cut in half -- reconstructing gives back original text
    expect(chunks.join(' ')).toBe(longText);
  });
});

// ── truncateForTelegram ───────────────────────────────────────────────

describe('truncateForTelegram', () => {
  const writer = makeWriter();
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  afterEach(() => (writer as any).stopTyping());
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  const truncate = (text: string): string => (writer as any).truncateForTelegram(text);

  test('text within limit is returned as-is', () => {
    const short = 'Hello <b>world</b>';
    expect(truncate(short)).toBe(short);
  });

  test('long text is truncated and ends with "..."', () => {
    const longText = 'A'.repeat(5000);
    const result = truncate(longText);
    expect(result.endsWith('...')).toBe(true);
    // The core content (before "...") should be at most MAX_MESSAGE_LENGTH (4000)
    expect(result.length).toBeLessThanOrEqual(4000 + 3); // 4000 chars + "..."
  });

  test('does not cut in the middle of an HTML tag', () => {
    // Construct text where the 4000th char falls inside an opening <b> tag
    const padding = 'X'.repeat(3998);
    const text = `${padding}<b>important</b>`;
    const result = truncate(text);
    // The incomplete "<b>" should be stripped -- result should not end with a partial tag
    expect(result).not.toContain('<b>');
    expect(result.endsWith('...')).toBe(true);
  });

  test('closes unclosed HTML tags after truncation', () => {
    // Open a <b> tag early, then pad to exceed the limit
    const text = `<b>${'Y'.repeat(5000)}</b>`;
    const result = truncate(text);
    // "..." appears before the closing tag so formatted text visually truncates inside the span
    expect(result).toContain('...</b>');
    expect(result.endsWith('</b>')).toBe(true);
  });

  test('unclosed tags on short text are closed without adding "..."', () => {
    // Mid-stream flush: text is short but has an unclosed <i>
    const text = 'Hello <i>world';
    const result = truncate(text);
    expect(result).toBe('Hello <i>world</i>');
    expect(result).not.toContain('...');
  });
});

// ── getText / historyText ─────────────────────────────────────────────
// Regression: tool blockquote was saved to chat history, causing the AI
// to mimic <blockquote expandable> format.

describe('getText returns text without tool blockquote', () => {
  test('getText returns clean AI text, not the display text with tool blockquote', async () => {
    const writer = makeWriter();

    // Simulate one tool call
    await writer.onTextDelta('Ответ AI.');
    await writer.onToolStart('get_expenses', { period: '2026-03' });
    writer.onToolResult('get_expenses', { period: '2026-03' }, { success: true, output: 'data' });

    await writer.finalize();

    const historyText = writer.getText();
    expect(historyText).not.toContain('<blockquote expandable>');
    expect(historyText).not.toContain('Инструменты');
    expect(historyText).toContain('Ответ AI.');
  });

  test('sendRemainingChunks uses display text (with tool blockquote) for correct chunking', async () => {
    const sent: string[] = [];
    const fakeBot = {
      api: {
        sendMessage: (opts: { text: string }) => {
          sent.push(opts.text);
          return Promise.resolve({ message_id: sent.length });
        },
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: () => Promise.resolve(),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub for Bot API
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);

    await writer.onToolStart('get_expenses', {});
    writer.onToolResult('get_expenses', {}, { success: true, output: 'ok' });
    await writer.finalize();

    // For short responses, sendRemainingChunks should be a no-op
    await writer.sendRemainingChunks();
    // Only the finalize flush sent a message (plus placeholder which was deleted)
    // No additional chunks for a short response
    const extraSends = sent.filter((t) => !t.includes('Минутку'));
    expect(extraSends.length).toBeLessThanOrEqual(1);
  });
});

// ── Edge cases: HTML tag handling ─────────────────────────────────────

describe('truncateForTelegram edge cases', () => {
  const writer = makeWriter();
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  afterEach(() => (writer as any).stopTyping());
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  const truncate = (text: string): string => (writer as any).truncateForTelegram(text);

  test('text at exactly 4000 chars is returned as-is (no truncation)', () => {
    const text = 'a'.repeat(4000);
    const result = truncate(text);
    expect(result).toBe(text);
    expect(result).not.toContain('...');
  });

  test('text at 4001 chars is truncated', () => {
    const text = 'a'.repeat(4001);
    const result = truncate(text);
    expect(result.length).toBeLessThanOrEqual(4003); // 4000 + '...'
    expect(result).toContain('...');
  });

  test('closes unclosed <b> tag when text is truncated mid-content', () => {
    const text = `<b>${'x'.repeat(4100)}`;
    const result = truncate(text);
    expect(result).toContain('</b>');
    expect(result.endsWith('<b>')).toBe(false);
  });

  test('closes unclosed <i> tag at truncation boundary', () => {
    const text = `<i>${'x'.repeat(4100)}`;
    const result = truncate(text);
    expect(result).toContain('</i>');
    expect(result.endsWith('<i>')).toBe(false);
  });

  test('closes unclosed <code> tag after truncation', () => {
    const text = `<code>${'x'.repeat(4100)}`;
    const result = truncate(text);
    expect(result).toContain('</code>');
  });

  test('handles deeply nested tags without throwing', () => {
    const text = `<b><i><code>${'x'.repeat(100)}</code></i></b>`;
    expect(() => truncate(text)).not.toThrow();
    const result = truncate(text);
    expect(result).toContain('<b>');
    expect(result).toContain('</b>');
  });

  test('does not produce "..." when short text has unclosed tags', () => {
    const text = 'Hello <b>world';
    const result = truncate(text);
    expect(result).not.toContain('...');
    expect(result).toContain('</b>');
  });
});

// ── Edge cases: splitIntoChunks ───────────────────────────────────────

describe('splitIntoChunks edge cases', () => {
  const writer = makeWriter();
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  afterEach(() => (writer as any).stopTyping());
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  const split = (text: string, max: number): string[] => (writer as any).splitIntoChunks(text, max);

  test('produces all chunks within max length for word-split text', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
    const chunks = split(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
  });

  test('reassembles to same content (no data loss) for word-split text', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = split(text, 200);
    expect(chunks.join(' ')).toBe(text);
  });

  test('handles unicode text without corrupting characters', () => {
    const text = 'привет '.repeat(700);
    const chunks = split(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(typeof chunk).toBe('string');
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  test('empty string returns single empty chunk', () => {
    const chunks = split('', 4000);
    expect(chunks).toEqual(['']);
  });

  test('single word longer than maxLength goes into its own chunk', () => {
    const longWord = 'a'.repeat(200);
    const text = `hello ${longWord} world`;
    const chunks = split(text, 50);
    const hasLongWord = chunks.some((c) => c.includes(longWord));
    expect(hasLongWord).toBe(true);
  });

  test('text with only paragraph breaks splits correctly', () => {
    const para = 'Short paragraph.';
    const text = [para, para, para, para, para].join('\n\n');
    const maxLen = `${para}\n\n${para}`.length;
    const chunks = split(text, maxLen);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLen);
    }
  });
});

// ── Edge cases: sendRemainingChunks ───────────────────────────────────

describe('sendRemainingChunks edge cases', () => {
  test('is a no-op for text within limit', async () => {
    const sent: string[] = [];
    const fakeBot = {
      api: {
        sendMessage: mock((opts: { text: string }) => {
          sent.push(opts.text);
          return Promise.resolve({ message_id: sent.length });
        }),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: () => Promise.resolve(),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub for Bot API
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);
    await writer.onTextDelta('Short message.');
    await writer.finalize();
    const sentBefore = sent.length;
    await writer.sendRemainingChunks();
    expect(sent.length).toBe(sentBefore);
  });
});

// ── Edge cases: onToolResult state ────────────────────────────────────

describe('onToolResult state tracking', () => {
  test('failed tool shows error status in display text', async () => {
    const writer = makeWriter();
    await writer.onToolStart('add_expense', { amount: 100, currency: 'EUR', category: 'food' });
    writer.onToolResult(
      'add_expense',
      { amount: 100, currency: 'EUR', category: 'food' },
      { success: false, error: 'DB error' },
    );
    // biome-ignore lint/suspicious/noExplicitAny: access private field in test
    expect((writer as any).fullText).toContain('\u274c');
    // biome-ignore lint/suspicious/noExplicitAny: access private method in test
    (writer as any).stopTyping();
  });

  test('getText returns empty string before finalize', async () => {
    const writer = makeWriter();
    await writer.onToolStart('get_budgets', {});
    writer.onToolResult('get_budgets', {}, { success: true, output: '[]' });
    expect(writer.getText()).toBe('');
    // biome-ignore lint/suspicious/noExplicitAny: access private method in test
    (writer as any).stopTyping();
  });

  test('multiple tool calls all appear in blockquote after finalize', async () => {
    const fakeBot = {
      api: {
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => Promise.resolve({ message_id: 1 })),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub for Bot API
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);
    await writer.onToolStart('get_expenses', {});
    writer.onToolResult('get_expenses', {}, { success: true, output: 'ok' });
    await writer.onToolStart('get_budgets', {});
    writer.onToolResult('get_budgets', {}, { success: false, error: 'not found' });
    await writer.onTextDelta('Summary.');
    await writer.finalize();

    // biome-ignore lint/suspicious/noExplicitAny: access private field in test
    const displayText: string = (writer as any).fullText;
    expect(displayText).toContain('<blockquote expandable>');
    expect(displayText).toContain('\u2705');
    expect(displayText).toContain('\u274c');
  });

  test('tool indicator stripped from getText() history text', async () => {
    const writer = makeWriter();
    await writer.onTextDelta('Before tool.');
    await writer.onToolStart('get_expenses', { period: '2026-03' });
    writer.onToolResult('get_expenses', { period: '2026-03' }, { success: true, output: 'data' });
    await writer.onTextDelta(' After tool.');
    await writer.finalize();

    const histText = writer.getText();
    expect(histText).not.toContain('<blockquote expandable>');
    expect(histText).not.toContain('Инструменты');
    expect(histText).toContain('Before tool.');
    expect(histText).toContain('After tool.');
    // biome-ignore lint/suspicious/noExplicitAny: access private method in test
    (writer as any).stopTyping();
  });
});
