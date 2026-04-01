// Tests for telegram-sender — specifically 429 rate-limit retry behavior.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { TelegramMessage } from '@gramio/types';
import { TelegramError } from 'gramio';
import type { BotInstance } from '../../bot/types';
import { initSender, sendMessage, withChatContext } from './telegram-sender';

function make429(): TelegramError<'sendMessage'> {
  // TelegramError constructor params: (response, method, params) — cast needed for test stubs
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

describe('sendMessage 429 retry', () => {
  beforeEach(() => {
    // Reset to a fresh no-op bot so earlier tests don't bleed state
    initSender({
      api: { sendMessage: () => Promise.reject(new Error('no bot set')) },
    } as unknown as BotInstance);
  });

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
  });
});
