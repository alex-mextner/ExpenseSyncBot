/**
 * sendOrEdit: how the writer delivers one display text to Telegram — placeholder adoption,
 * edit vs. send, 429 retry, "not modified", HTML parse fallback, and the error cooldown.
 * Drives the private sendOrEdit directly with a scripted bot so every branch is pinned,
 * including the order of API calls and the writer state each outcome leaves behind.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Bot } from 'gramio';
import { logMock, makeTelegramError, TelegramStreamWriter } from './telegram-stream.test-helpers';

type ApiCall = {
  method: 'sendMessage' | 'editMessageText';
  params: { chat_id?: number; text: string; message_id?: number; parse_mode?: string };
};

/** Scripted outcome: a value resolves, an Error rejects; once the script runs out calls succeed. */
type Outcome<T> = T | Error;

function scripted<T>(steps: Outcome<T>[], fallback: T): () => Promise<T> {
  return () => {
    const step = steps.length > 0 ? (steps.shift() as Outcome<T>) : fallback;
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  };
}

/** The writer's private state and method that these tests drive. */
interface WriterInternals {
  sendOrEdit(text: string): Promise<void>;
  sentMessageId: number | null;
  lastSentText: string;
  lastErrorTime: number;
  lastFlushTime: number;
  stopTyping(): void;
}

function makeScriptedWriter(script: {
  sendMessage?: Outcome<{ message_id: number }>[];
  editMessageText?: Outcome<true>[];
}) {
  const calls: ApiCall[] = [];
  const nextSend = scripted(script.sendMessage ?? [], { message_id: 1 });
  const nextEdit = scripted(script.editMessageText ?? [], true as const);
  const bot = {
    api: {
      sendMessage: (params: ApiCall['params']) => {
        calls.push({ method: 'sendMessage', params });
        return nextSend();
      },
      editMessageText: (params: ApiCall['params']) => {
        calls.push({ method: 'editMessageText', params });
        return nextEdit();
      },
      sendChatAction: () => Promise.resolve(true),
      deleteMessage: () => Promise.resolve(true),
    },
  };
  // Test stub: only the four API methods the writer calls exist on it.
  const writer = new TelegramStreamWriter(bot as unknown as Bot, 123);
  // Test-only view of private members (same approach as the other telegram-stream tests).
  const internals = writer as unknown as WriterInternals;
  /** Calls after the constructor's placeholder send. */
  const callsAfterPlaceholder = () => calls.slice(1);
  return { writer, internals, calls, callsAfterPlaceholder };
}

const PARSE_ERROR = "Bad Request: can't parse entities: Can't find end tag";

describe('sendOrEdit', () => {
  const writers: WriterInternals[] = [];
  const track = <T extends { internals: WriterInternals }>(made: T): T => {
    writers.push(made.internals);
    return made;
  };

  beforeEach(() => {
    logMock.error.mockClear();
    logMock.warn.mockClear();
  });
  afterEach(() => {
    for (const w of writers.splice(0)) w.stopTyping();
  });

  test('text equal to the last sent one makes no API call', async () => {
    const { internals, calls } = track(makeScriptedWriter({}));
    internals.lastSentText = 'same';
    await internals.sendOrEdit('same');
    // Only the constructor's placeholder was sent
    expect(calls).toHaveLength(1);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  describe('delivery', () => {
    test('adopts the placeholder: edits it as HTML and records the state', async () => {
      const { internals, callsAfterPlaceholder } = track(
        makeScriptedWriter({ sendMessage: [{ message_id: 77 }] }),
      );
      const before = Date.now();
      await internals.sendOrEdit('<b>hi</b>');

      expect(callsAfterPlaceholder()).toEqual([
        {
          method: 'editMessageText',
          params: { chat_id: 123, message_id: 77, text: '<b>hi</b>', parse_mode: 'HTML' },
        },
      ]);
      expect(internals.sentMessageId).toBe(77);
      expect(internals.lastSentText).toBe('<b>hi</b>');
      expect(internals.lastFlushTime).toBeGreaterThanOrEqual(before);
      expect(internals.lastErrorTime).toBe(0);
    });

    test('an already known message id is edited without waiting for the placeholder', async () => {
      const { internals, callsAfterPlaceholder } = track(makeScriptedWriter({}));
      internals.sentMessageId = 5;
      await internals.sendOrEdit('text');
      expect(callsAfterPlaceholder()[0]?.params.message_id).toBe(5);
    });

    test('failed placeholder: the text goes out as a new HTML message and its id is kept', async () => {
      const { internals, callsAfterPlaceholder } = track(
        makeScriptedWriter({ sendMessage: [new Error('network down'), { message_id: 9 }] }),
      );
      await internals.sendOrEdit('text');

      expect(callsAfterPlaceholder()).toEqual([
        { method: 'sendMessage', params: { chat_id: 123, text: 'text', parse_mode: 'HTML' } },
      ]);
      expect(internals.sentMessageId).toBe(9);
      expect(internals.lastSentText).toBe('text');
      expect(internals.lastErrorTime).toBe(0);
    });
  });

  describe('429 rate limit', () => {
    let delays: Array<number | undefined> = [];
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = () =>
      spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms);
        return realSetTimeout(fn, 0);
      }) as unknown as typeof setTimeout);
    let restore: () => void = () => {};

    beforeEach(() => {
      delays = [];
      const spy = timeoutSpy();
      restore = () => spy.mockRestore();
    });
    afterEach(() => restore());

    test('waits retry_after seconds, retries the same edit once and records success', async () => {
      const { internals, callsAfterPlaceholder } = track(
        makeScriptedWriter({
          editMessageText: [makeTelegramError('Too Many Requests', 429, { retry_after: 2 })],
        }),
      );
      internals.sentMessageId = 5;
      await internals.sendOrEdit('text');

      expect(delays).toContain(2000);
      expect(callsAfterPlaceholder().map((c) => c.method)).toEqual([
        'editMessageText',
        'editMessageText',
      ]);
      expect(internals.lastSentText).toBe('text');
      expect(internals.lastErrorTime).toBe(0);
      expect(logMock.error).toHaveBeenCalledWith(
        { retryAfter: 2 },
        '[STREAM] Rate limited, retrying after delay',
      );
    });

    test('a 429 without retry_after waits 5 seconds', async () => {
      const { internals } = track(
        makeScriptedWriter({ editMessageText: [makeTelegramError('Too Many Requests', 429)] }),
      );
      internals.sentMessageId = 5;
      await internals.sendOrEdit('text');
      expect(delays).toContain(5000);
      expect(logMock.error).toHaveBeenCalledWith(
        { retryAfter: 5 },
        '[STREAM] Rate limited, retrying after delay',
      );
    });

    test('retry_after 0 is honoured (nullish, not falsy, default)', async () => {
      const { internals } = track(
        makeScriptedWriter({
          editMessageText: [makeTelegramError('Too Many Requests', 429, { retry_after: 0 })],
        }),
      );
      internals.sentMessageId = 5;
      await internals.sendOrEdit('text');
      expect(delays).toContain(0);
      expect(delays).not.toContain(5000);
    });

    test('a failed retry starts the error cooldown and leaves the last sent text alone', async () => {
      const retryFailure = new Error('still down');
      const { internals, callsAfterPlaceholder } = track(
        makeScriptedWriter({
          editMessageText: [
            makeTelegramError('Too Many Requests', 429, { retry_after: 1 }),
            retryFailure,
          ],
        }),
      );
      internals.sentMessageId = 5;
      internals.lastSentText = 'old';
      const before = Date.now();
      await internals.sendOrEdit('new');

      expect(callsAfterPlaceholder()).toHaveLength(2);
      expect(internals.lastSentText).toBe('old');
      expect(internals.lastErrorTime).toBeGreaterThanOrEqual(before);
      expect(logMock.error).toHaveBeenCalledWith(
        { err: retryFailure },
        '[STREAM] Retry after 429 also failed',
      );
    });

    test('429 on the very first send (no message yet): the retry sends a new message', async () => {
      const { internals, callsAfterPlaceholder } = track(
        makeScriptedWriter({
          sendMessage: [
            new Error('placeholder failed'),
            makeTelegramError('Too Many Requests', 429, { retry_after: 1 }) as Error,
            { message_id: 31 },
          ],
        }),
      );
      await internals.sendOrEdit('text');

      expect(callsAfterPlaceholder().map((c) => c.method)).toEqual(['sendMessage', 'sendMessage']);
      expect(callsAfterPlaceholder()[1]?.params.parse_mode).toBe('HTML');
      expect(internals.sentMessageId).toBe(31);
      expect(internals.lastSentText).toBe('text');
    });
  });

  describe('Telegram errors', () => {
    test('"message is not modified" counts as delivered and does not start the cooldown', async () => {
      const { internals } = track(
        makeScriptedWriter({
          editMessageText: [makeTelegramError('Bad Request: message is not modified', 400)],
        }),
      );
      internals.sentMessageId = 5;
      const before = Date.now();
      await internals.sendOrEdit('text');

      expect(internals.lastSentText).toBe('text');
      expect(internals.lastFlushTime).toBeGreaterThanOrEqual(before);
      expect(internals.lastErrorTime).toBe(0);
      expect(logMock.error).not.toHaveBeenCalled();
    });

    test('HTML parse error: warns and re-edits the same message as tag-free plain text', async () => {
      const { internals, callsAfterPlaceholder } = track(
        makeScriptedWriter({ editMessageText: [makeTelegramError(PARSE_ERROR, 400)] }),
      );
      internals.sentMessageId = 5;
      await internals.sendOrEdit('<b>bold</b> &amp; <i>text');

      expect(callsAfterPlaceholder()).toHaveLength(2);
      const plain = callsAfterPlaceholder()[1];
      expect(plain?.method).toBe('editMessageText');
      expect(plain?.params.message_id).toBe(5);
      expect(plain?.params.parse_mode).toBeUndefined();
      expect(plain?.params.text).not.toContain('<');
      expect(plain?.params.text).toContain('bold');
      // The HTML text is what counts as sent, so the next identical flush is skipped
      expect(internals.lastSentText).toBe('<b>bold</b> &amp; <i>text');
      expect(internals.lastErrorTime).toBe(0);
      expect(logMock.warn).toHaveBeenCalledWith(
        '[STREAM] HTML parse error, falling back to plain text',
      );
    });

    test('HTML parse error with no message yet: the plain text goes out as a new message', async () => {
      const { internals, callsAfterPlaceholder } = track(
        makeScriptedWriter({
          sendMessage: [
            new Error('placeholder failed'),
            makeTelegramError(PARSE_ERROR, 400) as Error,
            { message_id: 12 },
          ],
        }),
      );
      await internals.sendOrEdit('<b>bold</b>');

      expect(callsAfterPlaceholder().map((c) => c.method)).toEqual(['sendMessage', 'sendMessage']);
      expect(callsAfterPlaceholder()[1]?.params.parse_mode).toBeUndefined();
      expect(callsAfterPlaceholder()[1]?.params.text).toBe('bold');
      expect(internals.sentMessageId).toBe(12);
      expect(internals.lastSentText).toBe('<b>bold</b>');
    });

    test('a failing plain-text fallback is logged and starts the cooldown', async () => {
      const fallbackFailure = new Error('fallback rejected');
      const { internals } = track(
        makeScriptedWriter({
          editMessageText: [makeTelegramError(PARSE_ERROR, 400), fallbackFailure],
        }),
      );
      internals.sentMessageId = 5;
      internals.lastSentText = 'old';
      const before = Date.now();
      await internals.sendOrEdit('<b>x');

      expect(internals.lastSentText).toBe('old');
      expect(internals.lastErrorTime).toBeGreaterThanOrEqual(before);
      expect(logMock.error).toHaveBeenCalledWith(
        { err: fallbackFailure },
        '[STREAM] Plain text fallback also failed',
      );
    });

    test('any other Telegram error is logged and starts the cooldown', async () => {
      const failure = makeTelegramError('Bad Request: message to edit not found', 400);
      const { internals, callsAfterPlaceholder } = track(
        makeScriptedWriter({ editMessageText: [failure] }),
      );
      internals.sentMessageId = 5;
      const before = Date.now();
      await internals.sendOrEdit('text');

      expect(callsAfterPlaceholder()).toHaveLength(1);
      expect(internals.lastSentText).toBe('');
      expect(internals.lastErrorTime).toBeGreaterThanOrEqual(before);
      expect(logMock.error).toHaveBeenCalledWith({ err: failure }, '[STREAM] Update error');
      expect(logMock.warn).not.toHaveBeenCalled();
    });
  });

  test('a non-Telegram error is logged and starts the cooldown', async () => {
    const failure = new Error('socket hang up');
    const { internals, callsAfterPlaceholder } = track(
      makeScriptedWriter({ editMessageText: [failure] }),
    );
    internals.sentMessageId = 5;
    const before = Date.now();
    await internals.sendOrEdit('text');

    expect(callsAfterPlaceholder()).toHaveLength(1);
    expect(internals.lastErrorTime).toBeGreaterThanOrEqual(before);
    expect(logMock.error).toHaveBeenCalledWith({ err: failure }, '[STREAM] Update error');
  });

  test('a non-Telegram error whose message mentions a parse error gets no plain-text fallback', async () => {
    const failure = new Error(PARSE_ERROR);
    const { internals, callsAfterPlaceholder } = track(
      makeScriptedWriter({ editMessageText: [failure] }),
    );
    internals.sentMessageId = 5;
    await internals.sendOrEdit('text');

    expect(callsAfterPlaceholder()).toHaveLength(1);
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalledWith({ err: failure }, '[STREAM] Update error');
  });
});
