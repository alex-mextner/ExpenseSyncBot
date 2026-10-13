import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

import { type Bot, TelegramError } from 'gramio';
import { sanitizeHtmlForTelegram } from '../../utils/html';

// Loaded after mock.module: a hoisted static import would create the writer's logger from the
// real module, so log assertions would see nothing.
const { isSkipSignal, NO_ANSWER_MESSAGE, TelegramStreamWriter } = await import('./telegram-stream');
type TelegramStreamWriter = InstanceType<typeof TelegramStreamWriter>;

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

/**
 * Writer on a bot stub that records what reaches the screen: edits of the streamed message,
 * new messages (the placeholder and any extra chunks) and deletions.
 */
function makeRecordingWriter() {
  const edits: string[] = [];
  const sends: Array<{ chat_id: number; text: string; parse_mode?: string }> = [];
  const deleted: number[] = [];
  const bot = {
    api: {
      sendMessage: (params: { chat_id: number; text: string; parse_mode?: string }) => {
        sends.push(params);
        return Promise.resolve({ message_id: sends.length });
      },
      sendChatAction: () => Promise.resolve(true),
      deleteMessage: (params: { message_id: number }) => {
        deleted.push(params.message_id);
        return Promise.resolve(true);
      },
      editMessageText: (params: { text: string }) => {
        edits.push(params.text);
        return Promise.resolve(true);
      },
    },
  };
  // Test stub: only the four API methods the writer calls exist on it.
  const writer = new TelegramStreamWriter(bot as unknown as Bot, 123);
  /** Extra answer chunks: HTML messages sent after the streamed one. */
  const chunks = () => sends.filter((s) => s.parse_mode === 'HTML').map((s) => s.text);
  return { writer, edits, sends, deleted, chunks };
}

const WORK_LOG_OPEN = '<blockquote expandable>';
const WORK_LOG_CLOSE = '</blockquote>';

/** Split a shown message into its work log (a leading expandable blockquote) and the answer. */
function splitWorkLog(html: string): { log: string; body: string } {
  if (!html.startsWith(WORK_LOG_OPEN)) return { log: '', body: html };
  const end = html.indexOf(WORK_LOG_CLOSE) + WORK_LOG_CLOSE.length;
  return { log: html.slice(0, end), body: html.slice(end).trim() };
}

/** One finished tool round, the way the agent drives the writer. */
function runToolRound(
  writer: TelegramStreamWriter,
  name: string,
  input: Record<string, unknown>,
  success = true,
): void {
  writer.setToolLabel(name, input);
  writer.markToolResult(success);
  writer.commitIntermediate();
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

// ── finalize: tools-only (no AI text) ────────────────────────────────

describe('finalize: tools without AI text', () => {
  /** Writer whose bot records every text it puts on screen (placeholder edits included). */
  function makeShippingWriter(): { writer: TelegramStreamWriter; shipped: string[] } {
    const shipped: string[] = [];
    const bot = {
      api: {
        sendMessage: () => Promise.resolve({ message_id: 1 }),
        sendChatAction: () => Promise.resolve(true),
        deleteMessage: () => Promise.resolve(true),
        editMessageText: (params: { text: string }) => {
          shipped.push(params.text);
          return Promise.resolve(true);
        },
      },
    };
    // Test stub: only the four API methods the writer calls exist on it.
    const writer = new TelegramStreamWriter(bot as unknown as Bot, 123);
    return { writer, shipped };
  }

  // Contract change (prod incident 2026-10-12): a reply made only of ✅ tool lines is not an
  // answer. When tools ran but the AI produced no text, the user sees the failure message
  // under the collapsed tool summary, and that message is what history stores. This replaces
  // the old 'shows tool lines inline when AI produced no text' test, which pinned the bug.
  test('never ships only tool lines when AI produced no text — shows the failure message', async () => {
    const { writer, shipped } = makeShippingWriter();
    writer.setToolLabel('get_expenses', { period: '2026-03' });
    writer.markToolResult(true);
    await writer.finalize();

    const finalText = shipped.at(-1) ?? '';
    expect(finalText).toContain(NO_ANSWER_MESSAGE);
    // Tool lines stay available, collapsed under the summary header
    expect(finalText).toContain('<blockquote expandable>');
    expect(finalText).toContain('Загружаю расходы');
  });

  test('tools-only: getText() returns the failure message the user saw', async () => {
    const { writer } = makeShippingWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
    await writer.finalize();
    expect(writer.getText()).toBe(NO_ANSWER_MESSAGE);
  });

  test('a [SKIP] after tool calls is replaced by the failure message', async () => {
    const { writer, shipped } = makeShippingWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
    writer.commitIntermediate();
    writer.appendText('[SKIP]');
    await writer.finalize();
    expect(writer.getText()).toBe(NO_ANSWER_MESSAGE);
    expect(shipped.at(-1)).not.toContain('[SKIP]');
  });

  test('no tools and no text: shows the Russian failure message', async () => {
    const { writer, shipped } = makeShippingWriter();
    await writer.finalize();
    expect(writer.getText()).toBe(NO_ANSWER_MESSAGE);
    expect(shipped.at(-1)).toBe(NO_ANSWER_MESSAGE);
  });

  test('allowSilence keeps a bare [SKIP] for the caller to delete', async () => {
    const { writer } = makeShippingWriter();
    writer.appendText('[SKIP]');
    await writer.finalize({ allowSilence: true });
    expect(writer.getText()).toBe('[SKIP]');
  });

  test.each([
    ['no text', ''],
    ['an ellipsis', '...'],
    ['a unicode ellipsis', '…'],
    // Short text that only contains the marker can be a real answer — never deleted silently.
    ['the marker next to an answer', '[SKIP] Потрачено 1 200 EUR'],
  ])('allowSilence never keeps %s once tools ran — that is a failed answer', async (_label, text) => {
    const { writer } = makeShippingWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
    writer.appendText(text);
    await writer.finalize({ allowSilence: true });
    expect(writer.getText()).toBe(NO_ANSWER_MESSAGE);
  });

  test.each([
    '[SKIP]',
    ' [skip]. ',
    '[ПРОПУСК]',
  ])('allowSilence keeps the bare marker %p after tool calls for the caller to delete', async (marker) => {
    const { writer, shipped } = makeShippingWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
    writer.commitIntermediate();
    writer.appendText(marker);
    await writer.finalize({ allowSilence: true });
    expect(writer.getText()).toBe(marker.trim());
    expect(shipped.join('\n')).not.toContain(NO_ANSWER_MESSAGE);
  });

  // Asserts on the shipped message: the private finalDisplayText this used to read is gone (the
  // final message is now the work log plus the answer's first chunk).
  test('with AI text: tool summary wrapped in expandable blockquote', async () => {
    const { writer, edits } = makeRecordingWriter();
    runToolRound(writer, 'get_expenses', {});
    writer.appendText('Ответ AI.');
    await writer.finalize();

    const { log, body } = splitWorkLog(edits.at(-1) ?? '');
    expect(log).toContain('Инструменты');
    expect(body).toBe('Ответ AI.');
  });
});

// ── work log: owner contract 2026-10-12 ───────────────────────────────
// «Не нужно писать "Считаю". Это должно попадать в лог работы. Лог работы должен вверху всегда
// выводиться в свёрнутом виде». Tool/progress lines never appear in the answer body; every run
// that used tools shows them in a collapsed blockquote at the TOP of the message — while
// streaming, after the answer, and under a failure message.

describe('work log: collapsed at the top, never in the answer', () => {
  /** The tool calls of Lena's prod run (2026-10-12 11:53): one call per round, as gpt-oss made them. */
  const LENA_TOOL_CALLS: Array<[string, Record<string, unknown>]> = [
    ['get_expenses', { period: ['2026-10'], summary_only: true }],
    ...['52829.45', '52829.45', '52829.45', '52829.45', '49846.35', '52829.45', '49744.21'].map(
      (amount): [string, Record<string, unknown>] => [
        'calculate',
        { expression: `${amount} RSD`, target_currency: 'EUR' },
      ],
    ),
    ['calculate', { expression: '20488.43 RSD', target_currency: 'EUR' }],
    ['calculate', { expression: '19535.16 RSD', target_currency: 'EUR' }],
  ];
  const LENA_ANSWER =
    '<b>Октябрь 2026 по категориям, EUR</b>\n\nКвартира: 450.00\nАлекс: 424.59\nЕда: 423.72\nМашина: 174.52\nКу: 166.40\n\n<b>Итого: 1 639.23 EUR</b>';

  test('streaming: the running tool is shown inside the collapsed log, not in the answer body', async () => {
    const { writer, edits } = makeRecordingWriter();
    writer.setToolLabel('calculate', { expression: '52829.45 RSD', target_currency: 'EUR' });
    await writer.flush(true);

    const { log, body } = splitWorkLog(edits.at(-1) ?? '');
    expect(log).toContain('Считаю: 52829.45 RSD');
    expect(body).not.toContain('Считаю');
    await writer.finalize();
  });

  test('streaming: finished tool lines stay in the log while the answer streams below it', async () => {
    const { writer, edits } = makeRecordingWriter();
    runToolRound(writer, 'get_expenses', { period: '2026-10', summary_only: true });
    writer.appendText('Квартира: 450 EUR');
    await writer.flush(true);

    const { log, body } = splitWorkLog(edits.at(-1) ?? '');
    expect(log).toContain('✅ Загружаю расходы: 2026-10, сводка');
    expect(body).toBe('Квартира: 450 EUR...');
    await writer.finalize();
  });

  test("finalize: Lena's 10 tool calls go to the log at the top, the answer below has none", async () => {
    const { writer, edits } = makeRecordingWriter();
    for (const [name, input] of LENA_TOOL_CALLS) runToolRound(writer, name, input);
    writer.appendText(LENA_ANSWER);
    await writer.finalize();

    const shown = edits.at(-1) ?? '';
    expect(shown.startsWith(WORK_LOG_OPEN)).toBe(true);
    const { log, body } = splitWorkLog(shown);
    expect(log.match(/✅/g)?.length).toBe(10);
    expect(body).toBe(LENA_ANSWER);
    // History keeps the answer only.
    expect(writer.getText()).toBe(LENA_ANSWER);
  });

  test('finalize: the failure message after tools also sits under the log', async () => {
    const { writer, edits } = makeRecordingWriter();
    for (const [name, input] of LENA_TOOL_CALLS) runToolRound(writer, name, input);
    await writer.finalize();

    const { log, body } = splitWorkLog(edits.at(-1) ?? '');
    expect(log).toContain('Считаю: 19535.16 RSD');
    expect(body).toBe(NO_ANSWER_MESSAGE);
  });

  test('no work log for a run without tools — neither while streaming nor at the end', async () => {
    const { writer, edits } = makeRecordingWriter();
    writer.appendText('Привет');
    await writer.flush(true);
    await writer.finalize();

    expect(edits.length).toBeGreaterThan(0);
    expect(edits.some((text) => text.includes(WORK_LOG_OPEN))).toBe(false);
  });

  test('markup inside tool details stays text, even after the outgoing HTML sanitizer', async () => {
    const { writer, edits } = makeRecordingWriter();
    runToolRound(writer, 'add_expense', {
      amount: 5,
      currency: 'EUR',
      category: 'Еда',
      comment: '<b>жирный</b> & <a href="https://example.com">ссылка</a>',
    });
    writer.appendText('Записал.');
    await writer.finalize();

    // The bot's preRequest hook runs every HTML text through this sanitizer before sending.
    const { log } = splitWorkLog(sanitizeHtmlForTelegram(edits.at(-1) ?? ''));
    expect(log).toContain('жирный');
    expect(log).not.toContain('<b>жирный');
    expect(log).not.toContain('<a ');
  });

  test('the log adds at most 2 formatting entities however many tools ran (Telegram: 100/message)', async () => {
    const { writer, edits } = makeRecordingWriter();
    for (let i = 1; i <= 30; i++) {
      runToolRound(writer, 'calculate', { expression: `${i} RSD`, target_currency: 'EUR' });
    }
    writer.appendText('Готово.');
    await writer.finalize();

    const { log } = splitWorkLog(edits.at(-1) ?? '');
    expect(log.match(/<[a-z]+/g)?.length).toBeLessThanOrEqual(2);
  });

  test('a long log keeps its newest lines behind an "ещё N" line (N ≥ 3); the answer stays whole', async () => {
    const { writer, edits, chunks } = makeRecordingWriter();
    for (let i = 1; i <= 60; i++) {
      runToolRound(writer, 'calculate', {
        expression: `#${i}: 1234567.89 RSD по курсу на дату платежа`,
        target_currency: 'EUR',
      });
    }
    const answer = `Итого: ${'слово '.repeat(560).trim()}`;
    writer.appendText(answer);
    await writer.finalize();
    await writer.sendRemainingChunks();

    const shown = edits.at(-1) ?? '';
    expect(shown.length).toBeLessThanOrEqual(4096);
    const { log, body } = splitWorkLog(shown);
    expect(body).toBe(answer);
    expect(chunks()).toEqual([]);
    expect(log).toContain('#60:');
    expect(log).not.toContain('#1:');
    expect(Number(log.match(/ещё (\d+)/)?.[1])).toBeGreaterThanOrEqual(3);
  });

  test('the log never hides just 1 or 2 lines (N+2 rule)', async () => {
    for (let n = 1; n <= 70; n++) {
      const { writer, edits } = makeRecordingWriter();
      for (let i = 1; i <= n; i++) {
        runToolRound(writer, 'calculate', {
          expression: `#${i}: 1234567.89 RSD по курсу на дату платежа`,
          target_currency: 'EUR',
        });
      }
      writer.appendText('Готово.');
      await writer.finalize();

      const hidden = splitWorkLog(edits.at(-1) ?? '').log.match(/ещё (\d+)/)?.[1];
      if (hidden !== undefined) expect(Number(hidden)).toBeGreaterThanOrEqual(3);
    }
  });

  test('a long answer is split without loss, and only the first message carries the log', async () => {
    const { writer, edits, chunks } = makeRecordingWriter();
    for (const [name, input] of LENA_TOOL_CALLS) runToolRound(writer, name, input);
    const paragraph = (word: string) => `${word} `.repeat(750).trim();
    const answer = [paragraph('аа'), paragraph('бб'), paragraph('вв')].join('\n\n');
    writer.appendText(answer);
    await writer.finalize();
    await writer.sendRemainingChunks();

    const first = edits.at(-1) ?? '';
    expect(first.length).toBeLessThanOrEqual(4096);
    const { log, body } = splitWorkLog(first);
    expect(log).not.toBe('');
    expect(chunks().length).toBeGreaterThan(0);
    expect(chunks().some((text) => text.includes(WORK_LOG_OPEN))).toBe(false);
    expect([body, ...chunks()].join('\n\n')).toBe(answer);
  });

  test('one or two long steps beside a near-full answer are shown, never as "ещё 1/2"', async () => {
    const { writer, edits, chunks } = makeRecordingWriter();
    const comment = 'очень длинный комментарий к расходу '.repeat(4);
    runToolRound(writer, 'add_expense', { amount: 5, currency: 'EUR', category: 'Еда', comment });
    runToolRound(writer, 'add_expense', { amount: 7, currency: 'EUR', category: 'Еда', comment });
    const answer = 'слово '.repeat(640).trim();
    writer.appendText(answer);
    await writer.finalize();
    await writer.sendRemainingChunks();

    const { log, body } = splitWorkLog(edits.at(-1) ?? '');
    expect(log).not.toContain('ещё');
    expect(log).toContain('5 EUR');
    expect(log).toContain('7 EUR');
    expect([body, ...chunks()].join(' ')).toBe(answer);
  });

  test('an answer heavy in HTML entities is not cut: Telegram counts the parsed text', async () => {
    const { writer, edits, chunks } = makeRecordingWriter();
    runToolRound(writer, 'get_expenses', { period: '2026-10' });
    // 3199 chars of text, 6399 chars of HTML once every & is escaped
    const answer = 'R&D '.repeat(800).trim();
    writer.appendText(answer);
    await writer.finalize();
    await writer.sendRemainingChunks();

    const { body } = splitWorkLog(edits.at(-1) ?? '');
    expect([body, ...chunks()].join(' ').replace(/&amp;/g, '&')).toBe(answer);
  });

  test('a retry after an AI error keeps the steps already done in the log', async () => {
    const { writer, edits } = makeRecordingWriter();
    // The first attempt wrote an expense, then the AI call failed and the agent retried
    runToolRound(writer, 'add_expense', { amount: 5, currency: 'EUR', category: 'Еда' });
    writer.reset();
    writer.appendText('Записал.');
    await writer.finalize();

    const { log, body } = splitWorkLog(edits.at(-1) ?? '');
    expect(log).toContain('✅ Записываю расход: 5 EUR, Еда');
    expect(body).toBe('Записал.');
  });

  test('an unbroken answer longer than a message is split without loss under the log', async () => {
    const { writer, edits, chunks } = makeRecordingWriter();
    for (const [name, input] of LENA_TOOL_CALLS) runToolRound(writer, name, input);
    const answer = 'x'.repeat(5000);
    writer.appendText(answer);
    await writer.finalize();
    await writer.sendRemainingChunks();

    const first = edits.at(-1) ?? '';
    expect(first.length).toBeLessThanOrEqual(4096);
    const { log, body } = splitWorkLog(first);
    expect(log).not.toBe('');
    expect([body, ...chunks()].join('')).toBe(answer);
  });

  test('AI failure after tools: a slow streaming edit never lands over the error', async () => {
    // Edits apply in the order Telegram finishes them; the streaming one is held until released.
    const applied: string[] = [];
    const streamingEdit = Promise.withResolvers<void>();
    const bot = {
      api: {
        sendMessage: () => Promise.resolve({ message_id: 1 }),
        sendChatAction: () => Promise.resolve(true),
        deleteMessage: () => Promise.resolve(true),
        editMessageText: async (params: { text: string }) => {
          if (params.text.includes('частичный')) await streamingEdit.promise;
          applied.push(params.text);
          return true;
        },
      },
    };
    // Test stub: only the four API methods the writer calls exist on it.
    const writer = new TelegramStreamWriter(bot as unknown as Bot, 123);
    runToolRound(writer, 'add_expense', { amount: 5, currency: 'EUR', category: 'Еда' });
    writer.appendText('частичный ответ');
    const streaming = writer.flush(true);

    const failing = writer.fail('⏳ Слишком много запросов к AI. Подожди минуту.');
    streamingEdit.resolve();
    await Promise.all([streaming, failing]);

    expect(splitWorkLog(applied.at(-1) ?? '').body).toBe(
      '⏳ Слишком много запросов к AI. Подожди минуту.',
    );
  });

  test('AI failure after tools: an edit that fails for another reason does not leave the old message behind', async () => {
    const sends: Array<{ text: string; parse_mode?: string }> = [];
    const deleted: number[] = [];
    const bot = {
      api: {
        sendMessage: (params: { text: string; parse_mode?: string }) => {
          sends.push(params);
          return Promise.resolve({ message_id: sends.length });
        },
        sendChatAction: () => Promise.resolve(true),
        deleteMessage: (params: { message_id: number }) => {
          deleted.push(params.message_id);
          return Promise.resolve(true);
        },
        editMessageText: () => Promise.reject(makeTelegramError('Bad Request: unknown', 400)),
      },
    };
    // Test stub: only the four API methods the writer calls exist on it.
    const writer = new TelegramStreamWriter(bot as unknown as Bot, 123);
    runToolRound(writer, 'add_expense', { amount: 5, currency: 'EUR', category: 'Еда' });

    await writer.fail('⏳ Слишком много запросов к AI. Подожди минуту.');

    // The placeholder (message 1) goes, the log with the error comes as a new message
    expect(deleted).toEqual([1]);
    expect(splitWorkLog(sends.at(-1)?.text ?? '').body).toBe(
      '⏳ Слишком много запросов к AI. Подожди минуту.',
    );
  });

  test('AI failure after tools: when the message cannot be edited, log and error go out as a new message', async () => {
    const sends: Array<{ text: string; parse_mode?: string }> = [];
    const editError = makeTelegramError('Bad Request: message to edit not found', 400);
    const bot = {
      api: {
        sendMessage: (params: { text: string; parse_mode?: string }) => {
          sends.push(params);
          return Promise.resolve({ message_id: sends.length });
        },
        sendChatAction: () => Promise.resolve(true),
        deleteMessage: () => Promise.resolve(true),
        editMessageText: () => Promise.reject(editError),
      },
    };
    // Test stub: only the four API methods the writer calls exist on it.
    const writer = new TelegramStreamWriter(bot as unknown as Bot, 123);
    logMock.error.mockClear();
    runToolRound(writer, 'add_expense', { amount: 5, currency: 'EUR', category: 'Еда' });

    await writer.fail('⏳ Слишком много запросов к AI. Подожди минуту.');

    expect(logMock.error).toHaveBeenCalledWith({ err: editError }, '[STREAM] Update error');
    const sent = sends.at(-1);
    expect(sent?.parse_mode).toBe('HTML');
    const { log, body } = splitWorkLog(sent?.text ?? '');
    expect(log).toContain('Записываю расход: 5 EUR, Еда');
    expect(body).toBe('⏳ Слишком много запросов к AI. Подожди минуту.');
  });

  test('AI failure after tools: the error shows under the log in the same message', async () => {
    const { writer, edits, deleted } = makeRecordingWriter();
    runToolRound(writer, 'add_expense', { amount: 5, currency: 'EUR', category: 'Еда' });
    await writer.fail('⏳ Слишком много запросов к AI. Подожди минуту.');

    const { log, body } = splitWorkLog(edits.at(-1) ?? '');
    expect(log).toContain('Записываю расход: 5 EUR, Еда');
    expect(body).toBe('⏳ Слишком много запросов к AI. Подожди минуту.');
    expect(deleted).toEqual([]);
  });

  test('AI failure without tools: the placeholder is deleted and the error sent as plain text', async () => {
    const { writer, sends, deleted } = makeRecordingWriter();
    await writer.fail('⏳ Слишком много запросов к AI. Подожди минуту.');

    expect(deleted).toEqual([1]);
    expect(sends.at(-1)).toEqual({
      chat_id: 123,
      text: '⏳ Слишком много запросов к AI. Подожди минуту.',
    });
  });

  test('AI failure without tools: a failed send of the error is logged, not thrown', async () => {
    const sendError = new Error('network down');
    const bot = {
      api: {
        sendMessage: (params: { text: string }) =>
          params.text.startsWith('⏳ Минутку')
            ? Promise.resolve({ message_id: 1 })
            : Promise.reject(sendError),
        sendChatAction: () => Promise.resolve(true),
        deleteMessage: () => Promise.resolve(true),
        editMessageText: () => Promise.resolve(true),
      },
    };
    // Test stub: only the four API methods the writer calls exist on it.
    const writer = new TelegramStreamWriter(bot as unknown as Bot, 123);
    logMock.error.mockClear();

    await writer.fail('⏳ Слишком много запросов к AI. Подожди минуту.');

    expect(logMock.error).toHaveBeenCalledWith(
      { err: sendError },
      '[STREAM] Failed to send the failure message',
    );
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
  test('failed tool shows error status in the shipped work log', async () => {
    const { writer, edits } = makeRecordingWriter();
    writer.setToolLabel('add_expense', { amount: 100, currency: 'EUR', category: 'food' });
    writer.markToolResult(false);
    await writer.finalize();
    expect(splitWorkLog(edits.at(-1) ?? '').log).toContain('❌ Записываю расход: 100 EUR, food');
  });

  test('getText returns empty string before finalize', async () => {
    const writer = makeWriter();
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(true);
    expect(writer.getText()).toBe('');
    // biome-ignore lint/suspicious/noExplicitAny: access private method in test
    (writer as any).stopTyping();
  });

  test('multiple tool calls all appear in the work log after finalize', async () => {
    const { writer, edits } = makeRecordingWriter();
    writer.setToolLabel('get_expenses', {});
    writer.markToolResult(true);
    writer.setToolLabel('get_budgets', {});
    writer.markToolResult(false);
    writer.commitIntermediate();
    writer.appendText('Summary.');
    await writer.finalize();

    const { log } = splitWorkLog(edits.at(-1) ?? '');
    expect(log).toContain('✅ Загружаю расходы');
    expect(log).toContain('❌ Проверяю бюджеты');
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
  test('retries after 429 and succeeds on second attempt', async () => {
    let editCount = 0;
    const fakeBot = {
      api: {
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => {
          editCount++;
          if (editCount === 1) {
            // First edit: 429 with minimal retry_after for fast test
            return Promise.reject(
              makeTelegramError('Too Many Requests: retry after 1', 429, { retry_after: 1 }),
            );
          }
          // Retry succeeds
          return Promise.resolve();
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);

    // Pre-set sentMessageId so the placeholder-adoption path is bypassed for this test
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).sentMessageId = 1;

    // Flush: editMessageText → 429 → wait → retry succeeds
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'updated text';
    const start = Date.now();
    await writer.flush(true);
    const elapsed = Date.now() - start;

    // Should have retried: 2 edit calls (original 429 + retry success)
    expect(editCount).toBe(2);
    // Should have waited ~1 second for retry_after
    expect(elapsed).toBeGreaterThanOrEqual(900);

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

    // Pre-set sentMessageId so the placeholder-adoption path is bypassed for this test
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).sentMessageId = 1;

    // First flush: editMessageText → "not modified" (silently OK, no cooldown)
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'same text';
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

    // Pre-set sentMessageId so the placeholder-adoption path is bypassed for this test
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).sentMessageId = 1;

    // Fire 20 concurrent flush(true) calls — simulating rapid token arrival
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

// ── placeholder reuse (double-message race prevention) ───────────────

describe('placeholder reuse prevents double-message race', () => {
  test('reuses placeholder when flush fires before placeholder resolves', async () => {
    let sendCount = 0;
    let editCount = 0;
    let resolvePlaceholder!: (id: number) => void;
    const slowPlaceholder = new Promise<{ message_id: number }>((resolve) => {
      resolvePlaceholder = (id) => resolve({ message_id: id });
    });

    const fakeBot = {
      api: {
        sendMessage: mock(async () => {
          sendCount++;
          return slowPlaceholder; // placeholder creation is artificially slow
        }),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => {
          editCount++;
          return Promise.resolve();
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;

    const writer = new TelegramStreamWriter(fakeBot, 123);

    // Start a flush before the placeholder resolves — simulates the race
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'streaming content';
    const flushPromise = writer.flush(true);

    // Resolve placeholder while flush is awaiting it
    resolvePlaceholder(1);
    await flushPromise;

    // Only 1 sendMessage (the placeholder), no extra sendMessage
    expect(sendCount).toBe(1);
    // Content delivered via editMessageText (placeholder reused, no new sendMessage)
    expect(editCount).toBe(1);

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
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
