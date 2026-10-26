/** Chunking, truncation and skip-signal behaviour of TelegramStreamWriter. */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  isSkipSignal,
  makeRecordingWriter,
  makeWriter,
  runToolRound,
  TelegramStreamWriter,
} from './telegram-stream.test-helpers';

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

  // The old title pinned chunking of the display text (blockquote included); the work log is no
  // longer part of what gets split — see 'a long answer is split without loss…'.
  test('sendRemainingChunks sends nothing extra for a short answer under the work log', async () => {
    const { writer, chunks } = makeRecordingWriter();
    runToolRound(writer, 'get_expenses', {});
    writer.appendText('Ответ AI.');
    await writer.finalize();
    await writer.sendRemainingChunks();
    expect(chunks()).toEqual([]);
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

  // Was 'single word longer than maxLength goes into its own chunk': a chunk over the limit is
  // rejected by Telegram (and with the work log above it, the answer's tail was lost), so a word
  // longer than a chunk is cut, without losing any of it.
  test('a word longer than maxLength is cut so no chunk exceeds it', () => {
    const longWord = 'a'.repeat(200);
    const text = `hello ${longWord} world`;
    const chunks = split(text, 50);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(50);
    expect(chunks.join('').replace(/ /g, '')).toBe(text.replace(/ /g, ''));
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

describe('isSkipSignal', () => {
  // --- Should match ---
  test('exact [SKIP]', () => expect(isSkipSignal('[SKIP]')).toBe(true));
  test('[SKIP] with whitespace', () => expect(isSkipSignal('  [SKIP]  ')).toBe(true));
  test('[ПРОПУСК] Russian variant', () => expect(isSkipSignal('[ПРОПУСК]')).toBe(true));
  test('lowercase [skip]', () => expect(isSkipSignal('[skip]')).toBe(true));
  test('mixed case [Skip]', () => expect(isSkipSignal('[Skip]')).toBe(true));
  test('broken bracket [SKIP', () => expect(isSkipSignal('[SKIP')).toBe(true));
  test('broken bracket ПРОПУСК]', () => expect(isSkipSignal('ПРОПУСК]')).toBe(true));
  test('[SKIP] embedded in text', () => expect(isSkipSignal('ok [SKIP] done')).toBe(true));
  test('empty string', () => expect(isSkipSignal('')).toBe(true));
  test('triple dot', () => expect(isSkipSignal('...')).toBe(true));
  test('ellipsis character', () => expect(isSkipSignal('…')).toBe(true));
  test('whitespace only', () => expect(isSkipSignal('   ')).toBe(true));

  // --- Should NOT match ---
  test('normal text', () => expect(isSkipSignal('Привет, как дела?')).toBe(false));
  test('word skip without brackets', () => expect(isSkipSignal('skip')).toBe(false));
  test('parentheses (SKIP)', () => expect(isSkipSignal('(SKIP)')).toBe(false));
  test('random dots', () => expect(isSkipSignal('..')).toBe(false));
  test('actual response', () => expect(isSkipSignal('Итого за месяц: 500€')).toBe(false));
  test('long reply quoting [SKIP] marker', () =>
    expect(
      isSkipSignal('Маркер [SKIP] используется когда бот решает промолчать. Это машинный токен.'),
    ).toBe(false));
  test('long reply quoting [ПРОПУСК]', () =>
    expect(isSkipSignal('Токен [ПРОПУСК] — это устаревший русский вариант маркера молчания.')).toBe(
      false,
    ));
});
