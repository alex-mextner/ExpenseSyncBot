// Tests for telegram-sender — the single entry point for all outgoing Telegram messages.
// Covers: sendMessage / editMessageText / deleteMessage / sendDirect / sendChatAction /
// createInviteLink / sendDocumentDirect + withChatContext propagation + 429 retry.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TelegramMessage } from '@gramio/types';
import { TelegramError } from 'gramio';
import type { BotInstance } from '../../bot/types';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const {
  initSender,
  sendMessage,
  editMessageText,
  deleteMessage,
  sendDirect,
  sendChatAction,
  createInviteLink,
  sendDocumentDirect,
  withChatContext,
} = await import('./telegram-sender');
const { chatStorage } = await import('../../utils/chat-context');

function make429(): TelegramError<'sendMessage'> {
  return new TelegramError(
    {
      ok: false as const,
      description: 'Too Many Requests: retry after 1',
      error_code: 429,
      parameters: { retry_after: 1 },
    } as ConstructorParameters<typeof TelegramError>[0],
    'sendMessage' as ConstructorParameters<typeof TelegramError>[1],
    {} as ConstructorParameters<typeof TelegramError>[2],
  ) as TelegramError<'sendMessage'>;
}

function makeFakeBot(sendFn: () => Promise<TelegramMessage>): BotInstance {
  return { api: { sendMessage: sendFn } } as unknown as BotInstance;
}

function inContext<T>(fn: () => Promise<T>): Promise<T> {
  return withChatContext(-1001, null, fn);
}

beforeEach(() => {
  logMock.trace.mockReset();
  logMock.debug.mockReset();
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();
  logMock.fatal.mockReset();
  // Reset to a fresh no-op bot so earlier tests don't bleed state
  initSender({
    api: { sendMessage: () => Promise.reject(new Error('no bot set')) },
  } as unknown as BotInstance);
});

// ── sendMessage: happy path & context propagation ─────────────────────────

describe('sendMessage happy path', () => {
  test('calls bot.api.sendMessage with chat_id from context and parse_mode HTML', async () => {
    const recorded: Array<Record<string, unknown>> = [];
    initSender({
      api: {
        sendMessage: async (params: Record<string, unknown>) => {
          recorded.push(params);
          return { message_id: 42 } as TelegramMessage;
        },
      },
    } as unknown as BotInstance);

    const result = await withChatContext(-1002, null, () => sendMessage('hello'));

    expect(result?.message_id).toBe(42);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      chat_id: -1002,
      text: 'hello',
      parse_mode: 'HTML',
    });
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('user-provided options are merged (reply_markup passes through)', async () => {
    let captured: Record<string, unknown> | undefined;
    initSender({
      api: {
        sendMessage: async (params: Record<string, unknown>) => {
          captured = params;
          return { message_id: 1 } as TelegramMessage;
        },
      },
    } as unknown as BotInstance);

    const keyboard = { inline_keyboard: [[{ text: 'ok', callback_data: 'x' }]] };
    await inContext(() =>
      sendMessage('with kb', {
        reply_markup: keyboard,
      } as Parameters<typeof sendMessage>[1]),
    );

    expect(captured?.['reply_markup']).toEqual(keyboard);
    expect(captured?.['parse_mode']).toBe('HTML');
  });

  test('throws when called outside withChatContext', async () => {
    initSender(makeFakeBot(async () => ({ message_id: 1 }) as TelegramMessage));

    await expect(sendMessage('orphan')).rejects.toThrow(/outside chat context/);
  });

  test('propagates error when bot.api throws synchronously at property access', async () => {
    // Surfaces any misuse where the bot reference returns a faulty api object
    initSender({
      get api(): unknown {
        throw new Error('bot api exploded');
      },
    } as unknown as BotInstance);

    const r = await inContext(() => sendMessage('x'));
    // getBot() returns fine, but `.api.sendMessage(...)` throws synchronously inside try{} — caught, returns null
    expect(r).toBeNull();
    expect(logMock.warn).toHaveBeenCalled();
  });
});

// ── withChatContext: chatId / threadId propagation ────────────────────────

describe('withChatContext', () => {
  test('stores chatId and threadId in AsyncLocalStorage', async () => {
    let seen: { chatId: number; threadId: number | null } | undefined;
    await withChatContext(-500, 7, async () => {
      seen = chatStorage.getStore();
    });
    expect(seen).toEqual({ chatId: -500, threadId: 7 });
  });

  test('sendMessage reads chatId from enclosing withChatContext', async () => {
    let receivedChatId: number | string | undefined;
    initSender({
      api: {
        sendMessage: async (params: Record<string, unknown>) => {
          receivedChatId = params['chat_id'] as number;
          return { message_id: 1 } as TelegramMessage;
        },
      },
    } as unknown as BotInstance);

    await withChatContext(-999, 12, () => sendMessage('yo'));
    expect(receivedChatId).toBe(-999);
  });

  test('nested withChatContext — inner overrides outer', async () => {
    const seenChatIds: number[] = [];
    initSender({
      api: {
        sendMessage: async (params: Record<string, unknown>) => {
          seenChatIds.push(params['chat_id'] as number);
          return { message_id: 1 } as TelegramMessage;
        },
      },
    } as unknown as BotInstance);

    await withChatContext(-100, null, async () => {
      await sendMessage('outer');
      await withChatContext(-200, 3, async () => {
        await sendMessage('inner');
      });
      await sendMessage('outer again');
    });

    expect(seenChatIds).toEqual([-100, -200, -100]);
  });

  test('context isolation — concurrent contexts do not leak', async () => {
    const seen: number[] = [];
    initSender({
      api: {
        sendMessage: async (params: Record<string, unknown>) => {
          await new Promise((r) => setTimeout(r, 5));
          seen.push(params['chat_id'] as number);
          return { message_id: 1 } as TelegramMessage;
        },
      },
    } as unknown as BotInstance);

    await Promise.all([
      withChatContext(-1, null, () => sendMessage('a')),
      withChatContext(-2, null, () => sendMessage('b')),
      withChatContext(-3, null, () => sendMessage('c')),
    ]);

    expect(seen.sort((a, b) => a - b)).toEqual([-3, -2, -1]);
  });
});

// ── sendMessage: error handling ───────────────────────────────────────────

describe('sendMessage error handling', () => {
  test('returns null on generic (non-429) error without retry', async () => {
    let calls = 0;
    const bot = makeFakeBot(async () => {
      calls++;
      throw new Error('network error');
    });
    initSender(bot);

    const result = await inContext(() => sendMessage('hi'));

    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(logMock.warn).toHaveBeenCalled();
  });

  test('returns null on 403 "bot was blocked" — no retry, logs warn', async () => {
    let calls = 0;
    const bot = makeFakeBot(async () => {
      calls++;
      const err = Object.assign(new Error('Forbidden: bot was blocked by the user'), {
        code: 403,
      });
      throw err;
    });
    initSender(bot);

    const result = await inContext(() => sendMessage('hi'));

    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(logMock.warn).toHaveBeenCalled();
  });

  test('retries once on 429 and returns result on success', async () => {
    let calls = 0;
    const bot = makeFakeBot(async () => {
      calls++;
      if (calls === 1) throw make429();
      return { message_id: 99 } as TelegramMessage;
    });
    initSender(bot);

    const result = await inContext(() => sendMessage('hi'));

    expect(result?.message_id).toBe(99);
    expect(calls).toBe(2);
  });

  test('returns null when retry also fails with 429', async () => {
    let calls = 0;
    const bot = makeFakeBot(async () => {
      calls++;
      throw make429();
    });
    initSender(bot);

    const result = await inContext(() => sendMessage('hi'));

    expect(result).toBeNull();
    expect(calls).toBe(2);
    expect(logMock.warn).toHaveBeenCalled();
  });

  test('429 then non-429 failure on retry — returns null, logs retry warn', async () => {
    let calls = 0;
    const bot = makeFakeBot(async () => {
      calls++;
      if (calls === 1) throw make429();
      throw new Error('network collapsed');
    });
    initSender(bot);

    const result = await inContext(() => sendMessage('hi'));

    expect(result).toBeNull();
    expect(calls).toBe(2);
    expect(logMock.warn).toHaveBeenCalled();
  });
});

// ── sendDirect ────────────────────────────────────────────────────────────

describe('sendDirect', () => {
  test('sends to the passed chatId regardless of ambient context', async () => {
    const seen: number[] = [];
    initSender({
      api: {
        sendMessage: async (params: Record<string, unknown>) => {
          seen.push(params['chat_id'] as number);
          return { message_id: 7 } as TelegramMessage;
        },
      },
    } as unknown as BotInstance);

    // No ambient context
    const r1 = await sendDirect(555, 'admin notice');
    expect(r1?.message_id).toBe(7);
    expect(seen[0]).toBe(555);

    // With ambient context that should be overridden
    await withChatContext(-100, null, async () => {
      await sendDirect(999, 'admin 2');
    });
    expect(seen[1]).toBe(999);
  });

  test('returns null on error (inherits sendMessage error handling)', async () => {
    initSender(
      makeFakeBot(async () => {
        throw new Error('boom');
      }),
    );

    const r = await sendDirect(1, 'x');
    expect(r).toBeNull();
  });
});

// ── editMessageText ───────────────────────────────────────────────────────

describe('editMessageText', () => {
  test('happy path — calls editMessageText with chat_id, message_id, HTML', async () => {
    let captured: Record<string, unknown> | undefined;
    initSender({
      api: {
        editMessageText: async (params: Record<string, unknown>) => {
          captured = params;
          return { message_id: 5 } as TelegramMessage;
        },
      },
    } as unknown as BotInstance);

    await withChatContext(-42, null, () => editMessageText(5, 'new text'));

    expect(captured).toMatchObject({
      chat_id: -42,
      message_id: 5,
      text: 'new text',
      parse_mode: 'HTML',
    });
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  test('swallows errors by default and logs warn (throwOnError omitted)', async () => {
    initSender({
      api: {
        editMessageText: async () => {
          throw new Error('message to edit not found');
        },
      },
    } as unknown as BotInstance);

    await expect(inContext(() => editMessageText(99, 'text'))).resolves.toBeUndefined();
    expect(logMock.warn).toHaveBeenCalled();
  });

  test('throwOnError: true propagates the underlying error', async () => {
    initSender({
      api: {
        editMessageText: async () => {
          throw new Error('bad request');
        },
      },
    } as unknown as BotInstance);

    await expect(
      inContext(() => editMessageText(99, 'text', { throwOnError: true })),
    ).rejects.toThrow(/bad request/);
    expect(logMock.warn).toHaveBeenCalled();
  });

  test('throwOnError is stripped from outgoing Telegram params', async () => {
    let captured: Record<string, unknown> | undefined;
    initSender({
      api: {
        editMessageText: async (params: Record<string, unknown>) => {
          captured = params;
          return { message_id: 1 } as TelegramMessage;
        },
      },
    } as unknown as BotInstance);

    await inContext(() =>
      editMessageText(1, 'x', {
        throwOnError: true,
        disable_web_page_preview: true,
      } as Parameters<typeof editMessageText>[2]),
    );

    expect(captured).not.toHaveProperty('throwOnError');
    expect(captured?.['disable_web_page_preview']).toBe(true);
  });
});

// ── deleteMessage ─────────────────────────────────────────────────────────

describe('deleteMessage', () => {
  test('happy path — calls deleteMessage with chat_id + message_id', async () => {
    let captured: Record<string, unknown> | undefined;
    initSender({
      api: {
        deleteMessage: async (params: Record<string, unknown>) => {
          captured = params;
          return true;
        },
      },
    } as unknown as BotInstance);

    await withChatContext(-77, null, () => deleteMessage(13));

    expect(captured).toMatchObject({ chat_id: -77, message_id: 13 });
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  test('swallows errors, logs warn', async () => {
    initSender({
      api: {
        deleteMessage: async () => {
          throw new Error('message not found');
        },
      },
    } as unknown as BotInstance);

    await expect(inContext(() => deleteMessage(1))).resolves.toBeUndefined();
    expect(logMock.warn).toHaveBeenCalled();
  });
});

// ── sendChatAction ────────────────────────────────────────────────────────

describe('sendChatAction', () => {
  test('calls sendChatAction with action: "typing"', async () => {
    let captured: Record<string, unknown> | undefined;
    initSender({
      api: {
        sendChatAction: async (params: Record<string, unknown>) => {
          captured = params;
          return true;
        },
      },
    } as unknown as BotInstance);

    await withChatContext(-1, null, () => sendChatAction());

    expect(captured).toEqual({ chat_id: -1, action: 'typing' });
  });

  test('silent on error — no throw, no log', async () => {
    initSender({
      api: {
        sendChatAction: async () => {
          throw new Error('bad');
        },
      },
    } as unknown as BotInstance);

    // Note: sendChatAction's try/catch wraps both the getContext() call AND the api call.
    // When called outside context, the getContext() throw is ALSO silently swallowed — this
    // matches production behavior (typing indicators are best-effort).
    await expect(sendChatAction()).resolves.toBeUndefined();
  });
});

// ── createInviteLink ──────────────────────────────────────────────────────

describe('createInviteLink', () => {
  test('returns invite_link on success', async () => {
    initSender({
      api: {
        createChatInviteLink: async () => ({
          invite_link: 'https://t.me/+abc',
          name: 'ExpenseSyncBot redirect',
        }),
      },
    } as unknown as BotInstance);

    const link = await createInviteLink(-123);
    expect(link).toBe('https://t.me/+abc');
  });

  test('returns null on error, logs debug', async () => {
    initSender({
      api: {
        createChatInviteLink: async () => {
          throw new Error('forbidden');
        },
      },
    } as unknown as BotInstance);

    const link = await createInviteLink(-123);
    expect(link).toBeNull();
    expect(logMock.debug).toHaveBeenCalled();
  });
});

// ── sendDocumentDirect ────────────────────────────────────────────────────

describe('sendDocumentDirect', () => {
  test('calls sendDocument with chat_id + file, no caption', async () => {
    let captured: Record<string, unknown> | undefined;
    initSender({
      api: {
        sendDocument: async (params: Record<string, unknown>) => {
          captured = params;
          return { message_id: 1 } as TelegramMessage;
        },
      },
    } as unknown as BotInstance);

    const file = new File(['hello'], 'log.txt');
    await sendDocumentDirect(42, file);

    expect(captured?.['chat_id']).toBe(42);
    expect(captured?.['document']).toBe(file);
    expect(captured).not.toHaveProperty('caption');
    expect(captured).not.toHaveProperty('parse_mode');
  });

  test('calls sendDocument with caption + HTML parse_mode when caption provided', async () => {
    let captured: Record<string, unknown> | undefined;
    initSender({
      api: {
        sendDocument: async (params: Record<string, unknown>) => {
          captured = params;
          return { message_id: 1 } as TelegramMessage;
        },
      },
    } as unknown as BotInstance);

    await sendDocumentDirect(42, new File([''], 'a.txt'), '<b>caption</b>');

    expect(captured?.['caption']).toBe('<b>caption</b>');
    expect(captured?.['parse_mode']).toBe('HTML');
  });

  test('swallows errors, logs warn', async () => {
    initSender({
      api: {
        sendDocument: async () => {
          throw new Error('big file');
        },
      },
    } as unknown as BotInstance);

    await expect(sendDocumentDirect(1, new File([''], 'a.txt'))).resolves.toBeUndefined();
    expect(logMock.warn).toHaveBeenCalled();
  });
});
