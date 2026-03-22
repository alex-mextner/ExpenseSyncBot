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

  test('completes incomplete tag before newline (model omitted closing >)', () => {
    // Model generated </blockquote without > before the newline
    const text =
      '<blockquote expandable>⚙️ <b>Инструменты</b></blockquote>\n\n<blockquote expandable>⚙️ <b>Инструменты</b></blockquote\nmore text';
    const result = truncate(text);
    // Incomplete </blockquote must be completed to </blockquote>, not removed
    expect(result).not.toMatch(/<\/blockquote(?!>)/);
    expect(result).toContain('</blockquote>');
    // Content after the newline must survive
    expect(result).toContain('more text');
    // Valid blockquotes must stay intact
    expect(result).toContain('<blockquote expandable>');
  });

  test('removes incomplete tag at end of string when text is short', () => {
    // Mid-stream flush: unclosed <i> gets closed, mismatched </blockquote at end gets stripped
    const text = 'Ответ<i>курсив</blockquote';
    const result = truncate(text);
    expect(result).not.toContain('<blockquote');
    expect(result).toContain('Ответ');
    expect(result).toContain('</i>');
  });

  test('case 1 then case 2: completes before-newline tag and strips end-of-string tag', () => {
    // Both passes interact: first pass completes </b\n, second strips trailing </i
    const text = '</b\nfoo</i';
    const result = truncate(text);
    // Case 1: </b\n → </b>\n
    expect(result).toContain('</b>');
    expect(result).toContain('foo');
    // Case 2: trailing </i removed
    expect(result).not.toContain('</i');
  });

  test('CRLF: completes incomplete tag before \\r\\n without producing </tag\\r> artefact', () => {
    const text = '<b>hello</b\r\nworld';
    const result = truncate(text);
    // Must not produce </b\r> or any \r> sequence
    expect(result).not.toContain('\r>');
    // Incomplete </b should be completed
    expect(result).toContain('</b>');
    expect(result).toContain('world');
  });

  test('does not remove valid closed tags before newlines', () => {
    // <blockquote expandable> ends with > — must NOT be removed
    const text = '<blockquote expandable>content</blockquote>\nNext line';
    const result = truncate(text);
    expect(result).toContain('<blockquote expandable>');
    expect(result).toContain('</blockquote>');
    expect(result).toContain('Next line');
  });
});

// ── getText / historyText ─────────────────────────────────────────────
// Regression: tool blockquote was saved to chat history, causing the AI
// to mimic <blockquote expandable> format.

describe('getText returns text without tool blockquote', () => {
  test('getText returns clean AI text, not the display text with tool blockquote', async () => {
    const writer = makeWriter();

    // Simulate one tool call followed by text response
    writer.setToolLabel('get_expenses', { period: '2026-03' });
    writer.markToolResult(true);
    writer.commitIntermediate();
    writer.appendText('Ответ AI.');
    await writer.finalize();

    const historyText = writer.getText();
    expect(historyText).not.toContain('<blockquote expandable>');
    expect(historyText).not.toContain('Инструменты');
    expect(historyText).toContain('Ответ AI.');
    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
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

    writer.setToolLabel('get_expenses', {});
    writer.markToolResult(true);
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

  test('<br> is converted to newline (not supported by Telegram HTML)', () => {
    const result = truncate('line1<br>line2');
    expect(result).not.toContain('<br>');
    expect(result).not.toContain('</br>');
    expect(result).toBe('line1\nline2');
  });

  test('<br/> is converted to newline', () => {
    const result = truncate('line1<br/>line2');
    expect(result).not.toContain('<br');
    expect(result).toBe('line1\nline2');
  });

  test('<br /> (with space) is converted to newline', () => {
    const result = truncate('line1<br />line2');
    expect(result).not.toContain('<br');
    expect(result).toBe('line1\nline2');
  });

  test('<BR> (uppercase) is converted to newline', () => {
    const result = truncate('line1<BR>line2');
    expect(result).not.toContain('<BR');
    expect(result).toBe('line1\nline2');
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
    writer.appendText('Short message.');
    await writer.finalize();
    const sentBefore = sent.length;
    await writer.sendRemainingChunks();
    expect(sent.length).toBe(sentBefore);
  });
});

// ── finalize: tools-only (no AI text) ────────────────────────────────

describe('finalize: tools without AI text', () => {
  test('shows tool lines inline when AI produced no text', async () => {
    const fakeBot = {
      api: {
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => Promise.resolve()),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);
    writer.setToolLabel('get_expenses', { period: '2026-03' });
    writer.markToolResult(true);
    await writer.finalize();

    // biome-ignore lint/suspicious/noExplicitAny: access private field
    const displayText: string = (writer as any).finalDisplayText;
    // Should show tool lines inline — no collapsed blockquote header
    expect(displayText).not.toContain('<blockquote expandable>');
    // Must contain the tool result line
    expect(displayText).toContain('\u2705');
    expect(displayText).toContain('Загружаю расходы');
  });

  test('tools-only: getText() history is empty (no text to save)', async () => {
    const writer = makeWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
    await writer.finalize();
    expect(writer.getText()).toBe('');
    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });

  test('with AI text: tool summary wrapped in expandable blockquote', async () => {
    const writer = makeWriter();
    writer.setToolLabel('get_expenses', {});
    writer.markToolResult(true);
    writer.commitIntermediate();
    writer.appendText('Ответ AI.');
    await writer.finalize();

    // biome-ignore lint/suspicious/noExplicitAny: access private field
    const displayText: string = (writer as any).finalDisplayText;
    expect(displayText).toContain('<blockquote expandable>');
    expect(displayText).toContain('Инструменты');
    expect(displayText).toContain('Ответ AI.');
    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });
});

// ── Telegram HTML compliance: what truncateForTelegram must guarantee ──
// RED TESTS: these all currently FAIL because truncateForTelegram has no
// sanitization step. Any text the AI generates goes to Telegram as-is,
// and Telegram returns 400 "Can't parse entities" on:
//   • unsupported tags (<div>, <h1>, <p>, <script>, <img>, etc.)
//   • bare & not escaped as &amp;
//   • bare < not part of a valid tag

describe('truncateForTelegram: must produce valid Telegram HTML', () => {
  const writer = makeWriter();
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  afterEach(() => (writer as any).stopTyping());
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  const truncate = (text: string): string => (writer as any).truncateForTelegram(text);

  test('strips unsupported <div> tag, preserves inner text', () => {
    const result = truncate('<div>some content</div>');
    expect(result).not.toContain('<div>');
    expect(result).not.toContain('</div>');
    expect(result).toContain('some content');
  });

  test('strips unsupported <h1> tag, preserves inner text', () => {
    const result = truncate('<h1>Title</h1>');
    expect(result).not.toContain('<h1>');
    expect(result).toContain('Title');
  });

  test('strips unsupported <p> tag, preserves inner text', () => {
    const result = truncate('<p>paragraph text</p>');
    expect(result).not.toContain('<p>');
    expect(result).toContain('paragraph text');
  });

  test('strips <script> tag entirely, text after it survives', () => {
    const result = truncate('<script>alert(1)</script>safe text');
    expect(result).not.toContain('<script>');
    expect(result).toContain('safe text');
  });

  test('escapes bare & to &amp;', () => {
    const result = truncate('cats & dogs');
    expect(result).toBe('cats &amp; dogs');
  });

  test('escapes bare & when surrounded by valid HTML', () => {
    const result = truncate('paid <b>100 EUR</b> & tax included');
    expect(result).not.toContain(' & ');
    expect(result).toContain('&amp;');
    expect(result).toContain('<b>100 EUR</b>');
  });

  test('preserves allowed tags while stripping disallowed ones', () => {
    const result = truncate('<b>bold</b> <div>blocked</div> <i>italic</i>');
    expect(result).toContain('<b>bold</b>');
    expect(result).toContain('<i>italic</i>');
    expect(result).not.toContain('<div>');
    expect(result).toContain('blocked');
  });
});

// ── finalize pipeline: AI text must be sanitized before reaching Telegram ──
// RED TESTS: bare & and unsupported tags from AI responses flow through
// finalize() into finalDisplayText without any sanitization.

describe('finalize pipeline: sanitizes AI text before sending', () => {
  test('bare & in AI response is not passed raw to Telegram', async () => {
    const writer = makeWriter();
    writer.appendText('Revenue & expenses for March');
    await writer.finalize();
    // biome-ignore lint/suspicious/noExplicitAny: access private field in test
    const displayText: string = (writer as any).finalDisplayText;
    expect(displayText).not.toContain(' & ');
    // biome-ignore lint/suspicious/noExplicitAny: access private method in test
    (writer as any).stopTyping();
  });

  test('<div> in AI response is not passed raw to Telegram', async () => {
    const writer = makeWriter();
    writer.appendText('<div>Section</div> and <b>bold</b>');
    await writer.finalize();
    // biome-ignore lint/suspicious/noExplicitAny: access private field in test
    const displayText: string = (writer as any).finalDisplayText;
    expect(displayText).not.toContain('<div>');
    expect(displayText).toContain('Section');
    expect(displayText).toContain('<b>bold</b>');
    // biome-ignore lint/suspicious/noExplicitAny: access private method in test
    (writer as any).stopTyping();
  });
});

// ── flush: error cooldown ─────────────────────────────────────────────

describe('flush error cooldown', () => {
  test('sets lastErrorTime on generic API error to prevent rapid retries', async () => {
    let callCount = 0;
    const fakeBot = {
      api: {
        sendMessage: mock(() => {
          callCount++;
          return Promise.reject({
            payload: { error_code: 400, description: 'Bad Request: text must be non-empty' },
          });
        }),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => Promise.resolve()),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);

    // First flush: fails and sets lastErrorTime
    writer.appendText('some text that is definitely long enough to flush');
    await writer.flush(true);
    const firstCallCount = callCount;

    // Second flush immediately after: should be blocked by ERROR_COOLDOWN_MS
    writer.appendText(' more text');
    await writer.flush(true);
    const secondCallCount = callCount;

    // No additional send attempt should have been made
    expect(secondCallCount).toBe(firstCallCount);

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });
});

// ── Edge cases: tool state tracking ───────────────────────────────────

describe('tool state tracking', () => {
  test('failed tool shows error status in final display text', async () => {
    const writer = makeWriter();
    writer.setToolLabel('add_expense', { amount: 100, currency: 'EUR', category: 'food' });
    writer.markToolResult(false);
    await writer.finalize();
    // biome-ignore lint/suspicious/noExplicitAny: access private field in test
    const displayText: string = (writer as any).finalDisplayText;
    expect(displayText).toContain('\u274c');
    // biome-ignore lint/suspicious/noExplicitAny: access private method in test
    (writer as any).stopTyping();
  });

  test('getText returns empty string before finalize', async () => {
    const writer = makeWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
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
    writer.setToolLabel('get_expenses', {});
    writer.markToolResult(true);
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(false);
    writer.commitIntermediate();
    writer.appendText('Summary.');
    await writer.finalize();

    // biome-ignore lint/suspicious/noExplicitAny: access private field in test
    const displayText: string = (writer as any).finalDisplayText;
    expect(displayText).toContain('<blockquote expandable>');
    expect(displayText).toContain('\u2705');
    expect(displayText).toContain('\u274c');
  });

  test('getText() returns only the final AI text, not tool UI', async () => {
    const writer = makeWriter();
    // Round 1: tool call
    writer.setToolLabel('get_expenses', { period: '2026-03' });
    writer.markToolResult(true);
    writer.commitIntermediate();
    // Round 2: AI text response
    writer.appendText('Ответ AI.');
    await writer.finalize();

    const histText = writer.getText();
    expect(histText).not.toContain('<blockquote expandable>');
    expect(histText).not.toContain('Инструменты');
    expect(histText).toBe('Ответ AI.');
    // biome-ignore lint/suspicious/noExplicitAny: access private method in test
    (writer as any).stopTyping();
  });
});
