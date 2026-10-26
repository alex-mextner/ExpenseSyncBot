/** TelegramStreamWriter work log: collapsed at the top, never in the answer. */
import { describe, expect, test } from 'bun:test';
import type { Bot } from 'gramio';
import { sanitizeHtmlForTelegram } from '../../utils/html';
import {
  logMock,
  makeRecordingWriter,
  makeTelegramError,
  NO_ANSWER_MESSAGE,
  runToolRound,
  splitWorkLog,
  TelegramStreamWriter,
  WORK_LOG_OPEN,
} from './telegram-stream.test-helpers';

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

  test('a note line shows right away and stays in the log under the steps before it', async () => {
    logMock.error.mockClear();
    const { writer, edits } = makeRecordingWriter();
    runToolRound(writer, 'calculate', { expression: '52829.45 RSD', target_currency: 'EUR' });
    await writer.addWorkLogNote('🔄 Передаю задачу z.ai (glm-5.1)…');

    // Shown before the next model streams anything.
    expect(splitWorkLog(edits.at(-1) ?? '').log).toContain('🔄 Передаю задачу z.ai (glm-5.1)…');

    runToolRound(writer, 'get_expenses', {
      period: '2026-10',
      summary_only: true,
      currency: 'EUR',
    });
    writer.appendText('Итого: 1 639.23 EUR');
    await writer.finalize();
    const { log, body } = splitWorkLog(edits.at(-1) ?? '');
    const lines = log.split('\n');
    const noteAt = lines.findIndex((line) => line.includes('🔄 Передаю задачу'));
    expect(lines[noteAt - 1]).toContain('✅ Считаю: 52829.45 RSD');
    expect(lines[noteAt + 1]).toContain('✅ Загружаю расходы');
    expect(body).toBe('Итого: 1 639.23 EUR');
    expect(writer.getText()).toBe('Итого: 1 639.23 EUR');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('markup in a note stays text', async () => {
    const { writer, edits } = makeRecordingWriter();
    runToolRound(writer, 'get_budgets', {});
    await writer.addWorkLogNote('🔄 Передаю задачу <b>x</b>…');
    writer.appendText('Ок.');
    await writer.finalize();

    const { log } = splitWorkLog(sanitizeHtmlForTelegram(edits.at(-1) ?? ''));
    expect(log).not.toContain('<b>x');
    expect(log).toContain('x');
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
