// Tests for /ai_stats — admin-only AI usage report: window parsing, delivery to the admin chat, failures

import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { TelegramMessage } from '@gramio/types';
import {
  type AiUsageEventInput,
  AiUsageEventsRepository,
} from '../../database/repositories/ai-usage-events.repository';
import { createTestDb } from '../../test-utils/db';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const sendDirectMock = mock(
  async (_chatId: number, _text: string): Promise<TelegramMessage | null> =>
    ({
      message_id: 1,
    }) as TelegramMessage,
);
const sendMessageMock = mock(
  async (_text: string): Promise<TelegramMessage | null> => ({ message_id: 2 }) as TelegramMessage,
);
mock.module('../../services/bank/telegram-sender', () => ({
  sendDirect: sendDirectMock,
  sendMessage: sendMessageMock,
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
}));

const db = createTestDb();
const repo = new AiUsageEventsRepository(db);
const mockDatabase = { aiUsageEvents: repo };
mock.module('../../database', () => ({ database: mockDatabase }));

const { handleAiStatsCommand } = await import('./ai-stats');

const ADMIN_CHAT_ID = 4242;
const DAY_MS = 86_400_000;

function event(overrides: Partial<AiUsageEventInput> = {}): AiUsageEventInput {
  return {
    at: Date.now() - 60_000,
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    chain: 'smart',
    purpose: 'agent',
    outcome: 'ok',
    errorClass: null,
    httpStatus: null,
    durationMs: 1_000,
    promptTokens: 100,
    completionTokens: 20,
    reasoningTokens: null,
    cachedTokens: null,
    requestId: 'r',
    role: null,
    preset: null,
    costMicroUsd: null,
    firstTokenMs: null,
    generationMs: null,
    promptSize: null,
    ...overrides,
  };
}

function ctxWith(text: string): Parameters<typeof handleAiStatsCommand>[0] {
  return { text, from: { id: ADMIN_CHAT_ID }, chat: { id: -100, type: 'supergroup' } } as never;
}

function sentTexts(): string[] {
  return sendDirectMock.mock.calls.map((call) => call[1]);
}

beforeEach(() => {
  db.exec('DELETE FROM ai_usage_events');
  mockDatabase.aiUsageEvents = repo;
  sendDirectMock.mockClear();
  sendMessageMock.mockClear();
  logMock.error.mockClear();
  logMock.warn.mockClear();
});

describe('handleAiStatsCommand', () => {
  test('sends the 7-day report to the admin chat, with Claude shown as having no traffic', async () => {
    repo.recordMany([event(), event({ at: Date.now() - 30 * DAY_MS, model: 'old-model' })]);

    await handleAiStatsCommand(ctxWith('/ai_stats'), ADMIN_CHAT_ID);

    expect(sendDirectMock).toHaveBeenCalledTimes(1);
    expect(sendDirectMock.mock.calls[0]?.[0]).toBe(ADMIN_CHAT_ID);
    const text = sentTexts()[0] ?? '';
    expect(text).toContain('AI-статистика за 7 дней');
    expect(text).toContain('openai/gpt-oss-120b');
    expect(text).not.toContain('old-model');
    expect(text).toContain('claude — нет запросов');
  });

  test('never posts into the chat the command came from', async () => {
    repo.recordMany([event()]);

    await handleAiStatsCommand(ctxWith('/ai_stats'), ADMIN_CHAT_ID);

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test.each([
    ['/ai_stats 30', 'AI-статистика за 30 дней'],
    ['/ai_stats@ExpenseSyncBot 14', 'AI-статистика за 14 дней'],
    ['/ai_stats   1', 'AI-статистика за 1 день'],
  ])('reads the window from %p', async (text, title) => {
    repo.recordMany([event()]);

    await handleAiStatsCommand(ctxWith(text), ADMIN_CHAT_ID);

    expect(sentTexts()[0]).toContain(title);
  });

  test('a longer window includes older rows', async () => {
    repo.recordMany([event({ at: Date.now() - 20 * DAY_MS, model: 'twenty-days-old' })]);

    await handleAiStatsCommand(ctxWith('/ai_stats 7'), ADMIN_CHAT_ID);
    expect(sentTexts()[0]).not.toContain('twenty-days-old');

    sendDirectMock.mockClear();
    await handleAiStatsCommand(ctxWith('/ai_stats 30'), ADMIN_CHAT_ID);
    expect(sentTexts()[0]).toContain('twenty-days-old');
  });

  test.each([
    ['abc'],
    ['0'],
    ['181'],
    ['-3'],
    ['7 8'],
    ['1.5'],
  ])('rejects the window %p with a usage hint and reads nothing', async (arg) => {
    const listSpy = spyOn(repo, 'listSince');
    try {
      await handleAiStatsCommand(ctxWith(`/ai_stats ${arg}`), ADMIN_CHAT_ID);
      expect(listSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
    }

    expect(sendDirectMock).toHaveBeenCalledTimes(1);
    expect(sentTexts()[0]).toContain('/ai_stats [дней]');
    expect(sentTexts()[0]).toContain('180');
  });

  test('an empty window says there is no data', async () => {
    await handleAiStatsCommand(ctxWith('/ai_stats'), ADMIN_CHAT_ID);

    expect(sentTexts()[0]).toContain('нет данных');
  });

  test('splits a long report into messages under the Telegram limit', async () => {
    repo.recordMany(
      Array.from({ length: 60 }, (_, i) => event({ model: `vendor/model-with-a-long-name-${i}` })),
    );

    await handleAiStatsCommand(ctxWith('/ai_stats'), ADMIN_CHAT_ID);

    expect(sendDirectMock.mock.calls.length).toBeGreaterThan(1);
    for (const text of sentTexts()) expect(text.length).toBeLessThanOrEqual(4096);
  });

  test('tells the admin and logs when the usage table cannot be read', async () => {
    const { Database } = await import('bun:sqlite');
    mockDatabase.aiUsageEvents = new AiUsageEventsRepository(new Database(':memory:'));

    await handleAiStatsCommand(ctxWith('/ai_stats'), ADMIN_CHAT_ID);

    expect(sentTexts()).toEqual(['❌ Не удалось прочитать статистику AI. Подробности в логах.']);
    expect(logMock.error).toHaveBeenCalledWith({ err: expect.any(Error) }, expect.any(String));
  });

  test('logs when Telegram does not accept the report', async () => {
    repo.recordMany([event()]);
    sendDirectMock.mockResolvedValueOnce(null);

    await handleAiStatsCommand(ctxWith('/ai_stats'), ADMIN_CHAT_ID);

    expect(logMock.warn).toHaveBeenCalled();
  });
});
