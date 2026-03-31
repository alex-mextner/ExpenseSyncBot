// Tests for registerExchangeRateCron — startup fetch, retry, admin notification

import { mock } from 'bun:test';
import type { TelegramMessage } from '@gramio/types';

// ── Module mocks (must be declared before importing the module under test) ──

const updateExchangeRatesMock = mock(async (): Promise<void> => {});
const sendDirectMock = mock(
  async (_chatId: number, _text: string): Promise<TelegramMessage | null> => null,
);

mock.module('../services/currency/converter', () => ({
  updateExchangeRates: updateExchangeRatesMock,
}));

mock.module('../services/bank/telegram-sender', () => ({
  sendDirect: sendDirectMock,
}));

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import cron from 'node-cron';
import { env } from '../config/env';
import { registerExchangeRateCron } from './cron';

let cronSpy: ReturnType<typeof spyOn>;
let savedAdminChatId: number | null;

const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  const fakeTask = { stop: mock(() => {}) };
  cronSpy = spyOn(cron, 'schedule').mockReturnValue(
    fakeTask as unknown as ReturnType<typeof cron.schedule>,
  );

  updateExchangeRatesMock.mockReset();
  updateExchangeRatesMock.mockResolvedValue(undefined);
  sendDirectMock.mockReset();
  sendDirectMock.mockResolvedValue(null);

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
    expect(updateExchangeRatesMock).toHaveBeenCalledTimes(1);
  });

  it('registers daily cron job at "0 1 * * *" (01:00 UTC)', () => {
    registerExchangeRateCron();
    expect(cronSpy).toHaveBeenCalledTimes(1);
    expect(cronSpy.mock.calls[0]?.[0]).toBe('0 1 * * *');
  });

  it('does not retry or notify admin on success', async () => {
    registerExchangeRateCron();
    await tick();

    expect(updateExchangeRatesMock).toHaveBeenCalledTimes(1);
    expect(sendDirectMock).not.toHaveBeenCalled();
  });

  it('retries 3 times then notifies admin', async () => {
    updateExchangeRatesMock.mockRejectedValue(new Error('API down'));
    env.BOT_ADMIN_CHAT_ID = 12345;

    registerExchangeRateCron();
    await tick();

    expect(updateExchangeRatesMock).toHaveBeenCalledTimes(3);
    expect(sendDirectMock).toHaveBeenCalledTimes(1);
    expect(sendDirectMock.mock.calls[0]?.[0]).toBe(12345);
    const msg = sendDirectMock.mock.calls[0]?.[1] as string;
    expect(msg).toContain('не обновились');
  });

  it('does not notify admin when BOT_ADMIN_CHAT_ID is null', async () => {
    updateExchangeRatesMock.mockRejectedValue(new Error('API down'));
    env.BOT_ADMIN_CHAT_ID = null;

    registerExchangeRateCron();
    await tick();

    expect(updateExchangeRatesMock).toHaveBeenCalledTimes(3);
    expect(sendDirectMock).not.toHaveBeenCalled();
  });

  it('cron callback also retries and notifies admin', async () => {
    // Startup succeeds
    updateExchangeRatesMock.mockResolvedValueOnce(undefined);

    registerExchangeRateCron();
    await tick();

    // Now make subsequent calls fail
    updateExchangeRatesMock.mockRejectedValue(new Error('API down'));
    env.BOT_ADMIN_CHAT_ID = 12345;

    const cronCallback = cronSpy.mock.calls[0]?.[1] as () => void;
    cronCallback();
    await tick();

    // 1 startup success + 3 retries from cron
    expect(updateExchangeRatesMock).toHaveBeenCalledTimes(4);
    expect(sendDirectMock).toHaveBeenCalledTimes(1);
  });
});
