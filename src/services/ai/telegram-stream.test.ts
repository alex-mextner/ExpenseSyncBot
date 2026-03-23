import { afterEach, describe, expect, mock, test } from 'bun:test';
import { TelegramError } from 'gramio';
import { TelegramStreamWriter } from './telegram-stream';

/**
 * Helper to construct TelegramError instances for tests.
 * GramIO constructor: new TelegramError({ ok, description, error_code, parameters }, method, params)
 */
function makeTelegramError(
  description: string,
  errorCode: number,
  parameters: { retry_after?: number } = {},
): TelegramError<'editMessageText'> {
  return new TelegramError(
    { ok: false as const, description, error_code: errorCode, parameters },
    'editMessageText',
    // biome-ignore lint/suspicious/noExplicitAny: test stub — full API params not needed
    {} as any,
  );
}

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

  test('partial tags without closing > are escaped to literal text, not completed', () => {
    // Sanitization runs before the case-1/case-2 regexes.
    // Partial tags like </b (no >) are not whitelisted so they get escaped.
    const text = '</b\nfoo</i';
    const result = truncate(text);
    // Plain text survives
    expect(result).toContain('foo');
    // Partial tags are escaped — no raw < left
    expect(result).not.toContain('</b>');
    expect(result).not.toContain('</i>');
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

// ── STREAMING BUG: unclosed tags during flush ───────────────────────

describe('truncateForTelegram streaming scenarios', () => {
  const writer = makeWriter();
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  afterEach(() => (writer as any).stopTyping());
  // biome-ignore lint/suspicious/noExplicitAny: access private method in test
  const truncate = (text: string): string => (writer as any).truncateForTelegram(text);

  test('STREAMING: unclosed <i> in mid-generation expense report', () => {
    // AI is still generating — <i> opened but </i> not yet emitted
    const text = `<b>Потрачено</b>

▪️ <b>Коты</b>: <b>54.16 EUR</b>
<i>• 10.03 — 2575 RSD (наполнитель)
• 03.03 — 3767 RSD`;
    const result = truncate(text);
    const iOpens = (result.match(/<i>/gi) || []).length;
    const iCloses = (result.match(/<\/i>/gi) || []).length;
    expect(iOpens).toBe(iCloses);
  });

  test('STREAMING: incomplete closing tag </ at end', () => {
    // AI mid-stream: generating </i> but only </ arrived
    const text = `<i>• 10.03 — 2575 RSD (наполнитель)
• 03.03 — 3767 RSD (корм)</`;
    const result = truncate(text);
    const iOpens = (result.match(/<i>/gi) || []).length;
    const iCloses = (result.match(/<\/i>/gi) || []).length;
    expect(iOpens).toBe(iCloses);
  });

  test('STREAMING: incomplete closing tag </i at end (no >)', () => {
    const text = '<i>text still coming</i';
    const result = truncate(text);
    const iOpens = (result.match(/<i>/gi) || []).length;
    const iCloses = (result.match(/<\/i>/gi) || []).length;
    expect(iOpens).toBe(iCloses);
  });

  test('PRODUCTION: exact error text with tool blockquote + expense list', () => {
    const text = `<blockquote expandable>⚙️ <b>Инструменты</b>
✅ <i>Загружаю расходы: март 2026</i></blockquote>

<blockquote expandable>⚙️ <b>Инструменты</b></blockquote>

<blockquote expandable>⚙️ <b>Инструменты</b></blockquote>

<b>Потрачено за март 2026 по категориям</b>

<u>EUR-категории</u>:

▪️ <b>Путешествия</b>: <b>2949.47 EUR</b>
<i>• 14.03 — 1149.47 EUR (Барселона билеты)
• 14.03 — 1800.00 EUR (Барселона отель)</i>

▪️ <b>Лена</b>: <b>594.37 EUR</b>
<i>• 21.03 — 94.37 EUR (Zara)
• 11.03 — 130.00 EUR (Zara)
• 07.03 — 50.00 EUR (Подарок)
• 03.03 — 40.00 EUR (косметика)
• 02.03 — 280.00 EUR (косметика)</i>

▪️ <b>Квартира</b>: <b>500.00 EUR</b>
<i>• 01.03 — 500.00 EUR (Лена)</i>

▪️ <b>Еда</b>: <b>131.90 EUR</b> ≈ 15443 RSD
<i>• 13 записей, 1285–628 RSD каждая</i>

▪️ <b>Алекс</b>: <b>27.50 EUR</b>
<i>• 19.03 — 27.50 EUR</i>

▪️ <b>Развлечения</b>: <b>32.70 EUR</b>
<i>• 15.03 — 32.70 EUR</i>

▪️ <b>Спорт</b>: <b>33.33 EUR</b>
<i>• 02.03 — 33.33 EUR</i>

▪️ <b>Коты</b>: <b>54.16 EUR</b> ≈ 6342 RSD
<i>• 10.03 — 2575 RSD (наполнитель)
• 03.03 — 3767 RSD`;

    const result = truncate(text);

    // ALL tag types must be balanced
    for (const tag of ['i', 'b', 'u', 'blockquote']) {
      const openRegex = tag === 'blockquote' ? /<blockquote[^>]*>/gi : new RegExp(`<${tag}>`, 'gi');
      const closeRegex = new RegExp(`</${tag}>`, 'gi');
      const opens = (result.match(openRegex) || []).length;
      const closes = (result.match(closeRegex) || []).length;
      if (opens !== closes) {
        throw new Error(`Tag <${tag}> unbalanced: ${opens} opens vs ${closes} closes`);
      }
    }
  });

  test('TRUNCATION: long text with <i> tag cut mid-content', () => {
    // Text is > 4000 chars, truncation cuts inside <i> block
    const header = '<b>Потрачено за март 2026</b>\n\n';
    const entry = '▪️ <b>Кат</b>: <b>100 EUR</b>\n<i>• 01.03 — 100 EUR (запись)</i>\n\n';
    const openEntry = '▪️ <b>Последний</b>: <b>999 EUR</b>\n<i>';
    const longContent = '• 01.03 — 100 EUR (длинное описание расхода) '.repeat(80);
    const text = header + entry.repeat(20) + openEntry + longContent;

    const result = truncate(text);

    // Must be within limit
    expect(result.length).toBeLessThanOrEqual(4100); // 4000 + closing tags + ...

    // All tags must be balanced
    for (const tag of ['i', 'b']) {
      const opens = (result.match(new RegExp(`<${tag}>`, 'gi')) || []).length;
      const closes = (result.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
      expect(opens).toBe(closes);
    }
  });
});

// ── sendOrEdit: HTML error fallback ─────────────────────────────────

describe('sendOrEdit HTML error fallback', () => {
  test('falls back to plain text when editMessageText fails with HTML parse error', async () => {
    const calls: Array<{ text: string; parse_mode?: string }> = [];

    const fakeBot = {
      api: {
        sendMessage: mock((opts: { text: string; parse_mode?: string }) => {
          calls.push(opts);
          return Promise.resolve({ message_id: 1 });
        }),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock((opts: { text: string; parse_mode?: string }) => {
          calls.push(opts);
          if (opts.parse_mode === 'HTML') {
            return Promise.reject(
              makeTelegramError(
                'Bad Request: can\'t parse entities: Can\'t find end tag corresponding to start tag "i"',
                400,
              ),
            );
          }
          // Plain text retry succeeds
          return Promise.resolve();
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;

    const writer = new TelegramStreamWriter(fakeBot, 123);

    // Set fullText directly to avoid appendText's fire-and-forget flush timing issues
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'first text';
    await writer.flush(true); // sendMessage succeeds → sentMessageId set

    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'first text more text';
    // biome-ignore lint/suspicious/noExplicitAny: reset to force new edit
    (writer as any).lastSentText = '';
    await writer.flush(true); // editMessageText with HTML fails → plain text fallback

    // Should have a plain text call (no parse_mode) from sendPlainTextFallback
    const plainTextCall = calls.find(
      (c) => !c.parse_mode && c.text && c.text.includes('first text'),
    );
    expect(plainTextCall).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });

  test('finalize succeeds even after multiple failed intermediate flushes', async () => {
    let editCallCount = 0;
    let lastSuccessText = '';

    const fakeBot = {
      api: {
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock((opts: { text: string; parse_mode?: string }) => {
          editCallCount++;
          if (opts.parse_mode === 'HTML' && editCallCount <= 2) {
            return Promise.reject(
              makeTelegramError("Bad Request: can't parse entities: Can't find end tag", 400),
            );
          }
          // Plain text fallback and later HTML edits succeed
          lastSuccessText = opts.text;
          return Promise.resolve();
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;

    const writer = new TelegramStreamWriter(fakeBot, 123);

    // First flush: sendMessage succeeds (sets sentMessageId)
    writer.appendText('<i>partial');
    await writer.flush(true);

    // Second flush: editMessageText fails → plain text fallback
    writer.appendText(' streaming');
    await writer.flush(true);

    // Finalize: AI finished, tags are closed now
    writer.appendText('</i> done.');
    await writer.finalize();

    // finalize should have sent something
    expect(lastSuccessText).toBeTruthy();
    expect(lastSuccessText).toContain('done');

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });
});

// ── 429 rate limit handling ─────────────────────────────────────────

describe('429 rate limit handling', () => {
  test('detects TelegramError with code 429 and triggers cooldown', async () => {
    let editCount = 0;
    const fakeBot = {
      api: {
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => {
          editCount++;
          return Promise.reject(
            makeTelegramError('Too Many Requests: retry after 5', 429, { retry_after: 5 }),
          );
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);

    // First flush: sendMessage succeeds → sentMessageId set
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'initial text';
    await writer.flush(true);

    // Second flush: editMessageText → 429 → cooldown
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'updated text';
    // biome-ignore lint/suspicious/noExplicitAny: reset to force new edit
    (writer as any).lastSentText = '';
    await writer.flush(true);
    expect(editCount).toBe(1);

    // Third flush: should be blocked by error cooldown
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'even more text';
    // biome-ignore lint/suspicious/noExplicitAny: reset to force new edit
    (writer as any).lastSentText = '';
    await writer.flush(true);
    expect(editCount).toBe(1); // no new call — cooldown active

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });

  test('"message is not modified" is silently ignored (no cooldown)', async () => {
    let editCount = 0;
    const fakeBot = {
      api: {
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => {
          editCount++;
          if (editCount === 1) {
            return Promise.reject(makeTelegramError('Bad Request: message is not modified', 400));
          }
          return Promise.resolve();
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);

    // First flush: sendMessage → sentMessageId set
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'initial';
    await writer.flush(true);

    // Second flush: editMessageText → "not modified" (silently OK, no cooldown)
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'same text';
    // biome-ignore lint/suspicious/noExplicitAny: reset to force new edit
    (writer as any).lastSentText = '';
    await writer.flush(true);
    expect(editCount).toBe(1);

    // Third flush: should NOT be blocked — "not modified" doesn't set lastErrorTime
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'different text now';
    // biome-ignore lint/suspicious/noExplicitAny: reset to force new edit
    (writer as any).lastSentText = '';
    // biome-ignore lint/suspicious/noExplicitAny: reset flush time to bypass throttle
    (writer as any).lastFlushTime = 0;
    await writer.flush(true);
    expect(editCount).toBeGreaterThanOrEqual(2);

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });
});

// ── flush mutex (concurrent call prevention) ─────────────────────────

describe('flush mutex prevents concurrent API calls', () => {
  test('concurrent flush(true) calls result in at most 1 editMessageText', async () => {
    let editCount = 0;
    const fakeBot = {
      api: {
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => {
          editCount++;
          // Simulate network delay — while this is in flight, other flush calls arrive
          return new Promise((resolve) => setTimeout(resolve, 50));
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);

    // First: establish sentMessageId via sendMessage
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'initial';
    await writer.flush(true);

    // Now fire 20 concurrent flush(true) calls — simulating rapid token arrival
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'updated text with many tokens';
    // biome-ignore lint/suspicious/noExplicitAny: reset to force different text
    (writer as any).lastSentText = '';
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(writer.flush(true));
    }
    await Promise.all(promises);

    // Mutex ensures only 1 editMessageText call, not 20
    expect(editCount).toBe(1);

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });
});
