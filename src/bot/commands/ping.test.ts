import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const sendMessageMock = mock(
  (_text: string, _options?: unknown): Promise<{ message_id: number } | null> =>
    Promise.resolve({ message_id: 1 }),
);

mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
}));

const { handlePingCommand } = await import('./ping');

describe('handlePingCommand', () => {
  beforeEach(() => {
    sendMessageMock.mockClear();
  });

  test('sends "pong" followed by ISO timestamp', async () => {
    await handlePingCommand();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const text = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(text).toContain('pong');
    // ISO 8601 YYYY-MM-DDTHH:mm:ss.sssZ
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('timestamp is current (within 1 second)', async () => {
    const before = Date.now();
    await handlePingCommand();
    const after = Date.now();

    const text = sendMessageMock.mock.calls[0]?.[0] as string;
    const tsMatch = text.match(/\d{4}-\d{2}-\d{2}T[^\s]+/);
    expect(tsMatch).not.toBeNull();
    const ts = new Date(tsMatch?.[0] ?? '').getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test('does not log errors on happy path', async () => {
    await handlePingCommand();
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
