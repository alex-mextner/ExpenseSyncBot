// Tests for the AI usage recorder: deferred insert, storage failure never reaches the caller,
// and an end-to-end aiStreamRound round that writes real rows (and survives a broken database)

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  type AiUsageEventInput,
  AiUsageEventsRepository,
} from '../../database/repositories/ai-usage-events.repository';
import { createTestDb } from '../../test-utils/db';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();

mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const mockEnv = {
  ANTHROPIC_API_KEY: 'test-key',
  AI_BASE_URL: 'https://test.ai/v1',
  AI_MODEL: 'test-model',
  AI_FAST_MODEL: 'test-fast',
  GROQ_API_KEY: '',
  GROQ_BASE_URL: 'https://test.groq/v1',
  GROQ_MODEL: 'groq-smart',
  GROQ_FAST_MODEL: 'groq-fast',
  CLAUDE_API_TOKEN: '',
  CLAUDE_BASE_URL: 'https://test.claude/v1/',
  CLAUDE_MODEL: 'claude-smart',
  CLAUDE_FAST_MODEL: 'claude-fast',
  CLAUDE_VISION_MODEL: 'claude-vision',
  HF_TOKEN: 'test-hf',
  HF_BASE_URL: 'https://test.hf/v1',
  HF_MODEL: 'hf-test',
  HF_FAST_MODEL: 'hf-fast',
  HF_VISION_MODEL: 'hf-vision',
};
mock.module('../../config/env', () => ({ env: mockEnv }));

mock.module('./clients', () => ({
  zaiClient: () => ({}),
  groqClient: () => ({}),
  claudeClient: () => ({}),
  hfClient: () => ({}),
}));

const db = createTestDb();
const repo = new AiUsageEventsRepository(db);
const mockDatabase = { aiUsageEvents: repo };
mock.module('../../database', () => ({ database: mockDatabase }));

import type OpenAI from 'openai';
import { resetProviderBreaker } from './provider-breaker';

// Both modules bind their logger when they load: import them only after mock.module has run.
const { flushAiUsageRecording, recordAiUsage } = await import('./usage-recorder');
const { aiStreamRound } = await import('./streaming');

interface StoredRow {
  provider: string;
  model: string;
  chain: string;
  purpose: string;
  outcome: string;
  error_class: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  request_id: string | null;
}

function event(overrides: Partial<AiUsageEventInput> = {}): AiUsageEventInput {
  return {
    at: 1_760_000_000_000,
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    chain: 'smart',
    purpose: 'agent',
    outcome: 'ok',
    errorClass: null,
    httpStatus: null,
    durationMs: 900,
    promptTokens: 12,
    completionTokens: 3,
    reasoningTokens: null,
    cachedTokens: null,
    requestId: 'req-1',
    ...overrides,
  };
}

function storedRows(): StoredRow[] {
  return db
    .query<StoredRow, []>(
      `SELECT provider, model, chain, purpose, outcome, error_class, prompt_tokens, completion_tokens, request_id
       FROM ai_usage_events ORDER BY id`,
    )
    .all();
}

const STREAM_WITH_USAGE = {
  [Symbol.asyncIterator]: async function* () {
    yield { choices: [{ delta: { content: 'the answer' }, finish_reason: 'stop' }] };
    yield {
      choices: [],
      usage: { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 },
    };
  },
};

/** Route the z.ai client to a fake `create` that answers with STREAM_WITH_USAGE. */
async function useWorkingProvider(): Promise<() => void> {
  const clientsMod = await import('./clients');
  const spy = spyOn(clientsMod, 'zaiClient').mockReturnValue({
    chat: { completions: { create: async () => STREAM_WITH_USAGE } },
  } as unknown as OpenAI);
  return () => spy.mockRestore();
}

beforeEach(() => {
  db.exec('DELETE FROM ai_usage_events');
  mockDatabase.aiUsageEvents = repo;
  resetProviderBreaker();
  logMock.warn.mockClear();
  logMock.error.mockClear();
});

describe('recordAiUsage', () => {
  it('returns at once and inserts on a later turn', async () => {
    recordAiUsage([event()]);
    expect(storedRows()).toHaveLength(0);

    await flushAiUsageRecording();

    expect(storedRows()).toEqual([
      {
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        chain: 'smart',
        purpose: 'agent',
        outcome: 'ok',
        error_class: null,
        prompt_tokens: 12,
        completion_tokens: 3,
        request_id: 'req-1',
      },
    ]);
  });

  it('stores a batch together', async () => {
    recordAiUsage([event(), event({ provider: 'groq', requestId: 'req-2' })]);
    await flushAiUsageRecording();
    expect(storedRows().map((r) => r.provider)).toEqual(['claude', 'groq']);
  });

  it('ignores an empty batch', async () => {
    recordAiUsage([]);
    await flushAiUsageRecording();
    expect(storedRows()).toHaveLength(0);
  });

  it('logs a failing insert with the error and drops it without throwing', async () => {
    const failure = new Error('database is locked');
    const spy = spyOn(repo, 'recordMany').mockImplementation(() => {
      throw failure;
    });
    try {
      expect(() => recordAiUsage([event()])).not.toThrow();
      await flushAiUsageRecording();
    } finally {
      spy.mockRestore();
    }

    expect(logMock.warn).toHaveBeenCalledWith(
      { err: failure },
      expect.stringContaining('Failed to store usage events'),
    );
    expect(storedRows()).toHaveLength(0);
  });
});

describe('aiStreamRound with the real recorder', () => {
  it('writes a row for the attempt that answered', async () => {
    const restore = await useWorkingProvider();
    try {
      const result = await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        chain: 'fast',
        purpose: 'validator',
      });
      expect(result.text).toBe('the answer');
    } finally {
      restore();
    }
    await flushAiUsageRecording();

    expect(storedRows()).toEqual([
      {
        provider: 'zai',
        model: 'test-fast',
        chain: 'fast',
        purpose: 'validator',
        outcome: 'ok',
        error_class: null,
        prompt_tokens: 21,
        completion_tokens: 4,
        request_id: expect.any(String),
      },
    ]);
  });

  it('still returns the answer when the usage table is missing, and logs a warning', async () => {
    mockDatabase.aiUsageEvents = new AiUsageEventsRepository(new Database(':memory:'));
    const restore = await useWorkingProvider();
    let text = '';
    try {
      text = (
        await aiStreamRound({
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 100,
          chain: 'smart',
          purpose: 'agent',
        })
      ).text;
    } finally {
      restore();
    }
    await flushAiUsageRecording();

    expect(text).toBe('the answer');
    expect(logMock.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      expect.stringContaining('Failed to store usage events'),
    );
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('still returns the answer when the insert throws', async () => {
    const spy = spyOn(repo, 'recordMany').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    const restore = await useWorkingProvider();
    let text = '';
    try {
      text = (
        await aiStreamRound({
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 100,
          chain: 'smart',
          purpose: 'agent',
        })
      ).text;
      await flushAiUsageRecording();
    } finally {
      restore();
      spy.mockRestore();
    }

    expect(text).toBe('the answer');
    expect(logMock.warn).toHaveBeenCalled();
  });
});
