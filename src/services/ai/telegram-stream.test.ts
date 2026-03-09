import { test, expect, describe } from 'bun:test';
import { TelegramStreamWriter } from './telegram-stream';

/**
 * Testing private methods via bracket notation on a minimal instance.
 * The constructor requires a Bot, chatId — we pass stubs since these
 * pure string methods don't touch the bot API.
 */
function makeWriter(): TelegramStreamWriter {
  const fakeBot = { api: {} } as any;
  return new TelegramStreamWriter(fakeBot, 123);
}

// ── splitIntoChunks ───────────────────────────────────────────────────

describe('splitIntoChunks', () => {
  const writer = makeWriter();
  const split = (text: string, max: number): string[] =>
    (writer as any).splitIntoChunks(text, max);

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
  const truncate = (text: string): string =>
    (writer as any).truncateForTelegram(text);

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
    const text = padding + '<b>important</b>';
    const result = truncate(text);
    // The incomplete "<b>" should be stripped — result should not end with a partial tag
    expect(result).not.toContain('<b>');
    expect(result.endsWith('...')).toBe(true);
  });

  test('closes unclosed HTML tags after truncation', () => {
    // Open a <b> tag early, then pad to exceed the limit
    const text = '<b>' + 'Y'.repeat(5000) + '</b>';
    const result = truncate(text);
    // The closing </b> from the original is cut off, but truncateForTelegram
    // should add it back
    expect(result).toContain('</b>');
    expect(result.endsWith('...')).toBe(true);
  });
});
