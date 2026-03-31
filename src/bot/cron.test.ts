// Tests for registerExchangeRateCron — startup fetch, retry, admin notification

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import cron from 'node-cron';
import { env } from '../config/env';
import * as senderModule from '../services/bank/telegram-sender';
import * as converterModule from '../services/currency/converter';
import { registerExchangeRateCron } from './cron';

let cronSpy: ReturnType<typeof spyOn>;
let updateSpy: ReturnType<typeof spyOn>;
let sendDirectSpy: ReturnType<typeof spyOn>;
let savedAdminChatId: number | null;

const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  const fakeTask = { stop: mock(() => {}) };
  cronSpy = spyOn(cron, 'schedule').mockReturnValue(
    fakeTask as unknown as ReturnType<typeof cron.schedule>,
  );
  updateSpy = spyOn(converterModule, 'updateExchangeRates').mockResolvedValue(undefined);
  sendDirectSpy = spyOn(senderModule, 'sendDirect').mockResolvedValue(null);

  savedAdminChatId = env.BOT_ADMIN_CHAT_ID;

  // Make backoff delays instant in tests
  // @ts-expect-error -- simplified mock for test, real setTimeout has complex overloads
  spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void) => {
    fn();
    return 0;
  });
});

afterEach(() => {
  env.BOT_ADMIN_CHAT_ID = savedAdminChatId;
  mock.restore();
});

/** Wait for async chains to settle */
function tick(ms = 50): Promise<void> {
  return new Promise((r) => realSetTimeout(r, ms));
}

describe('registerExchangeRateCron', () => {
  it('calls updateExchangeRates on startup', () => {
    registerExchangeRateCron();
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('registers daily cron job at "0 1 * * *" (01:00 UTC)', () => {
    registerExchangeRateCron();
    expect(cronSpy).toHaveBeenCalledTimes(1);
    expect(cronSpy.mock.calls[0]?.[0]).toBe('0 1 * * *');
  });

  it('does not retry or notify admin on success', async () => {
    registerExchangeRateCron();
    await tick();

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(sendDirectSpy).not.toHaveBeenCalled();
  });

  it('retries 3 times then notifies admin', async () => {
    updateSpy.mockRejectedValue(new Error('API down'));
    env.BOT_ADMIN_CHAT_ID = 12345;

    registerExchangeRateCron();
    await tick();

    expect(updateSpy).toHaveBeenCalledTimes(3);
    expect(sendDirectSpy).toHaveBeenCalledTimes(1);
    expect(sendDirectSpy.mock.calls[0]?.[0]).toBe(12345);
    const msg = sendDirectSpy.mock.calls[0]?.[1] as string;
    expect(msg).toContain('не обновились');
  });

  it('does not notify admin when BOT_ADMIN_CHAT_ID is null', async () => {
    updateSpy.mockRejectedValue(new Error('API down'));
    env.BOT_ADMIN_CHAT_ID = null;

    registerExchangeRateCron();
    await tick();

    expect(updateSpy).toHaveBeenCalledTimes(3);
    expect(sendDirectSpy).not.toHaveBeenCalled();
  });

  it('cron callback also retries and notifies admin', async () => {
    // Startup succeeds
    updateSpy.mockResolvedValueOnce(undefined);

    registerExchangeRateCron();
    await tick();

    // Now make subsequent calls fail
    updateSpy.mockRejectedValue(new Error('API down'));
    env.BOT_ADMIN_CHAT_ID = 12345;

    const cronCallback = cronSpy.mock.calls[0]?.[1] as () => void;
    cronCallback();
    await tick();

    // 1 startup success + 3 retries from cron
    expect(updateSpy).toHaveBeenCalledTimes(4);
    expect(sendDirectSpy).toHaveBeenCalledTimes(1);
  });
});
