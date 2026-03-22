import { afterEach, describe, expect, test } from 'bun:test';
import { TelegramStreamWriter } from './telegram-stream';

/**
 * Testing private methods via bracket notation on a minimal instance.
 * The constructor requires a Bot, chatId — we pass stubs since these
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
  } as any;
  return new TelegramStreamWriter(fakeBot, 123);
}

// ── splitIntoChunks ───────────────────────────────────────────────────

describe('splitIntoChunks', () => {
  const writer = makeWriter();
  afterEach(() => (writer as any).stopTyping());
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

  test('single long paragraph without \\n\\n stays in one chunk', () => {
    const longText = 'X'.repeat(5000);
    const chunks = split(longText, 4000);
    // No paragraph breaks → the whole text ends up in one chunk
    // because the split logic only splits on \n\n boundaries
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(longText);
  });
});

// ── truncateForTelegram ───────────────────────────────────────────────

describe('truncateForTelegram', () => {
  const writer = makeWriter();
  afterEach(() => (writer as any).stopTyping());
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
    // The incomplete "<b>" should be stripped — result should not end with a partial tag
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
// to mimic <blockquote expandable>⚙️ Инструменты</blockquote> format.

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
