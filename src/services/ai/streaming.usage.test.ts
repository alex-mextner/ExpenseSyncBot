// Tests for AI usage capture in streaming.ts: token normalization, failure classification,
// stream_options retry and the one-event-per-provider-attempt contract

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ChainOrder } from '../../config/env';
import type { AiUsageEventInput } from '../../database/repositories/ai-usage-events.repository';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();

mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const defaultOrder = (): ChainOrder => ({
  order: ['zai', 'claude', 'hf'],
  fromEnv: false,
  fallback: ['zai', 'claude', 'hf'],
});
/** Puts HF at the head of both chains, to provoke a failing head provider (the order is an env setting). */
const hfHead = (): ChainOrder => ({
  order: ['hf', 'zai', 'claude'],
  fromEnv: true,
  fallback: ['zai', 'claude', 'hf'],
});

const mockEnv = {
  ANTHROPIC_API_KEY: 'test-key',
  AI_BASE_URL: 'https://test.ai/v1',
  AI_MODEL: 'test-model',
  AI_FAST_MODEL: 'test-fast',
  AI_SMART_CHAIN: defaultOrder(),
  AI_FAST_CHAIN: defaultOrder(),
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
  claudeClient: () => ({}),
  hfClient: () => ({}),
}));

const recorded: AiUsageEventInput[] = [];
mock.module('./usage-recorder', () => ({
  recordAiUsage: (events: readonly AiUsageEventInput[]) => {
    recorded.push(...events);
  },
}));

import OpenAI from 'openai';
import { resetProviderBreaker } from './provider-breaker';
import type { StreamRoundOptions, StreamRoundResult } from './streaming';

// streaming.ts binds its logger when it loads: import it only now, after mock.module has
// replaced the logger, so the warn/error assertions below see the real calls.
const {
  aiStreamRound,
  classifyAttemptFailure,
  EmptyProviderResponseError,
  normalizeUsage,
  resetStreamingUsageCompatibility,
} = await import('./streaming');

type CreateParams = OpenAI.ChatCompletionCreateParamsStreaming;
type CreateFn = (params: CreateParams, opts?: { signal?: AbortSignal }) => Promise<unknown>;

function apiError(status: number, message: string): Error {
  return new OpenAI.APIError(status, { message }, message, new Headers());
}

function streamOf(chunks: object[]): { [Symbol.asyncIterator]: () => AsyncGenerator<object> } {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function textChunks(text: string, usage?: OpenAI.CompletionUsage): object[] {
  return [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ...(usage ? [{ choices: [], usage }] : []),
  ];
}

const FULL_USAGE: OpenAI.CompletionUsage = {
  prompt_tokens: 11,
  completion_tokens: 5,
  total_tokens: 16,
  prompt_tokens_details: { cached_tokens: 3 },
  completion_tokens_details: { reasoning_tokens: 2 },
};

/** Route every provider client to one fake `create`; returns the restore function. */
async function useCreate(create: CreateFn): Promise<() => void> {
  const clientsMod = await import('./clients');
  const spies = (['zaiClient', 'claudeClient', 'hfClient'] as const).map((fn) =>
    spyOn(clientsMod, fn).mockReturnValue({
      chat: { completions: { create } },
    } as unknown as OpenAI),
  );
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}

const MESSAGES: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'user', content: 'secret user prompt text' },
];

async function run(overrides: Partial<StreamRoundOptions> = {}): Promise<StreamRoundResult> {
  return aiStreamRound({
    messages: MESSAGES,
    maxTokens: 100,
    chain: 'smart',
    purpose: 'agent',
    ...overrides,
  });
}

beforeEach(() => {
  resetProviderBreaker();
  resetStreamingUsageCompatibility();
  recorded.length = 0;
  logMock.warn.mockClear();
  logMock.error.mockClear();
  mockEnv.AI_SMART_CHAIN = defaultOrder();
  mockEnv.AI_FAST_CHAIN = defaultOrder();
  mockEnv.CLAUDE_API_TOKEN = '';
});

describe('normalizeUsage', () => {
  it('maps prompt, completion, reasoning and cached tokens', () => {
    expect(normalizeUsage(FULL_USAGE)).toEqual({
      promptTokens: 11,
      completionTokens: 5,
      reasoningTokens: 2,
      cachedTokens: 3,
    });
  });

  it('keeps a field NULL when the provider omits it', () => {
    expect(normalizeUsage({ prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 })).toEqual({
      promptTokens: 9,
      completionTokens: 4,
      reasoningTokens: null,
      cachedTokens: null,
    });
  });

  it('keeps a reported zero as 0, distinct from unknown', () => {
    expect(
      normalizeUsage({
        prompt_tokens: 9,
        completion_tokens: 4,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      }),
    ).toEqual({ promptTokens: 9, completionTokens: 4, reasoningTokens: 0, cachedTokens: 0 });
  });

  it('treats no usage object as all-unknown, never zero', () => {
    const unknown = {
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
    };
    expect(normalizeUsage(null)).toEqual(unknown);
    expect(normalizeUsage(undefined)).toEqual(unknown);
  });

  it('rejects values that cannot be token counts', () => {
    const odd = {
      prompt_tokens: -1,
      completion_tokens: Number.NaN,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 1.5 },
      completion_tokens_details: { reasoning_tokens: '7' },
    } as unknown as OpenAI.CompletionUsage;
    expect(normalizeUsage(odd)).toEqual({
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
    });
  });
});

describe('classifyAttemptFailure', () => {
  const idle = { callerAborted: false, providerTimedOut: false };

  it.each([
    [
      '429 rate limit',
      apiError(429, 'Rate limit reached for model on tokens per minute'),
      'rate_limit',
      429,
    ],
    [
      '429 per-minute token limit that links to the billing page',
      apiError(
        429,
        'Rate limit reached for model `m` on tokens per minute (TPM): Limit 8000, Used 7900. Need more tokens? Upgrade to Dev Tier today at https://console.example.com/settings/billing',
      ),
      'rate_limit',
      429,
    ],
    ['429 exhausted quota', apiError(429, 'You exceeded your current quota'), 'quota', 429],
    [
      '429 z.ai weekly limit (live prod answer, 2026-10-23)',
      apiError(429, 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-30 10:00:00'),
      'quota',
      429,
    ],
    ['402 out of credits', apiError(402, 'no remaining credits'), 'quota', 402],
    [
      '400 credit balance',
      apiError(400, 'Your credit balance is too low to access the API'),
      'quota',
      400,
    ],
    ['401', apiError(401, 'invalid x-api-key'), 'auth', 401],
    ['403', apiError(403, 'forbidden'), 'auth', 403],
    ['400', apiError(400, 'bad param'), 'bad_request', 400],
    ['404', apiError(404, 'model not found'), 'bad_request', 404],
    ['422', apiError(422, 'unprocessable'), 'bad_request', 422],
    ['500', apiError(500, 'internal'), 'server', 500],
    ['503', apiError(503, 'unavailable'), 'server', 503],
    ['408 request timeout', apiError(408, 'request timeout'), 'timeout', 408],
    ['529 overloaded', apiError(529, 'overloaded'), 'server', 529],
  ] as const)('%s', (_label, error, errorClass, httpStatus) => {
    expect(classifyAttemptFailure(error, idle)).toEqual({ errorClass, httpStatus });
  });

  it('classifies a status-less connection failure as server with no HTTP status', () => {
    expect(
      classifyAttemptFailure(new OpenAI.APIConnectionError({ message: 'Connection error.' }), idle),
    ).toEqual({ errorClass: 'server', httpStatus: null });
  });

  it('classifies an SDK connection timeout as timeout', () => {
    expect(classifyAttemptFailure(new OpenAI.APIConnectionTimeoutError(), idle)).toEqual({
      errorClass: 'timeout',
      httpStatus: null,
    });
  });

  it('classifies the empty-response error as empty', () => {
    expect(classifyAttemptFailure(new EmptyProviderResponseError('HF (x)'), idle)).toEqual({
      errorClass: 'empty',
      httpStatus: null,
    });
  });

  it('classifies an unrecognised error as other', () => {
    expect(classifyAttemptFailure(new Error('boom'), idle)).toEqual({
      errorClass: 'other',
      httpStatus: null,
    });
    expect(classifyAttemptFailure('weird', idle)).toEqual({
      errorClass: 'other',
      httpStatus: null,
    });
  });

  it('prefers the abort signals over the error shape', () => {
    const abort = new OpenAI.APIUserAbortError();
    expect(classifyAttemptFailure(abort, { callerAborted: false, providerTimedOut: true })).toEqual(
      {
        errorClass: 'timeout',
        httpStatus: null,
      },
    );
    expect(classifyAttemptFailure(abort, { callerAborted: true, providerTimedOut: false })).toEqual(
      {
        errorClass: 'aborted',
        httpStatus: null,
      },
    );
    expect(classifyAttemptFailure(abort, { callerAborted: true, providerTimedOut: true })).toEqual({
      errorClass: 'aborted',
      httpStatus: null,
    });
  });

  it('classifies an abort that no signal explains as aborted', () => {
    expect(classifyAttemptFailure(new OpenAI.APIUserAbortError(), idle)).toEqual({
      errorClass: 'aborted',
      httpStatus: null,
    });
  });
});

describe('aiStreamRound usage events', () => {
  it('records an ok attempt with the tokens from the final usage chunk', async () => {
    mockEnv.AI_SMART_CHAIN = hfHead();
    mockEnv.AI_FAST_CHAIN = hfHead();
    const restore = await useCreate(async () => streamOf(textChunks('hello', FULL_USAGE)));
    try {
      const result = await run();
      expect(result.text).toBe('hello');
    } finally {
      restore();
    }

    expect(recorded).toEqual([
      {
        at: expect.any(Number),
        provider: 'hf',
        model: 'hf-test',
        chain: 'smart',
        purpose: 'agent',
        outcome: 'ok',
        errorClass: null,
        httpStatus: null,
        durationMs: expect.any(Number),
        promptTokens: 11,
        completionTokens: 5,
        reasoningTokens: 2,
        cachedTokens: 3,
        requestId: expect.any(String),
      },
    ]);
  });

  it('keeps tokens NULL when the provider reports no usage', async () => {
    mockEnv.AI_SMART_CHAIN = hfHead();
    mockEnv.AI_FAST_CHAIN = hfHead();
    const restore = await useCreate(async () => streamOf(textChunks('hello')));
    try {
      await run();
    } finally {
      restore();
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      outcome: 'ok',
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
    });
  });

  it('stores no prompt, completion or identifying data', async () => {
    mockEnv.AI_SMART_CHAIN = hfHead();
    mockEnv.AI_FAST_CHAIN = hfHead();
    const restore = await useCreate(async () =>
      streamOf(textChunks('the model answer', FULL_USAGE)),
    );
    try {
      await run();
    } finally {
      restore();
    }

    expect(Object.keys(recorded[0] ?? {}).sort()).toEqual([
      'at',
      'cachedTokens',
      'chain',
      'completionTokens',
      'durationMs',
      'errorClass',
      'httpStatus',
      'model',
      'outcome',
      'promptTokens',
      'provider',
      'purpose',
      'reasoningTokens',
      'requestId',
    ]);
    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toContain('secret user prompt text');
    expect(serialized).not.toContain('the model answer');
  });

  it('records one event per attempt and stops at the first success', async () => {
    mockEnv.AI_SMART_CHAIN = hfHead();
    mockEnv.AI_FAST_CHAIN = hfHead();
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    const restore = await useCreate(async (params) => {
      if (params.model === 'hf-test') throw apiError(429, 'Rate limit reached for model');
      return streamOf(textChunks('from z.ai', FULL_USAGE));
    });
    try {
      const result = await run();
      expect(result.providerUsed).toBe('z.ai (test-model)');
    } finally {
      restore();
    }

    expect(
      recorded.map((e) => [e.provider, e.model, e.outcome, e.errorClass, e.httpStatus]),
    ).toEqual([
      ['hf', 'hf-test', 'error', 'rate_limit', 429],
      ['zai', 'test-model', 'ok', null, null],
    ]);
    // claude and hf were never reached: no row for them.
    expect(recorded[0]?.promptTokens).toBeNull();
    expect(recorded[0]?.requestId).toBe(recorded[1]?.requestId ?? 'missing');
    expect(recorded[0]?.requestId).toEqual(expect.any(String));
  });

  it('gives every round its own request id', async () => {
    const restore = await useCreate(async () => streamOf(textChunks('hello')));
    try {
      await run();
      await run();
    } finally {
      restore();
    }
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.requestId).not.toBe(recorded[1]?.requestId);
  });

  it('records an error row per slot when the whole chain fails', async () => {
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    const restore = await useCreate(async (params) => {
      if (params.model === 'test-model') throw apiError(500, 'down');
      if (params.model === 'claude-smart') throw apiError(400, 'invalid request');
      throw apiError(402, 'no remaining credits');
    });
    try {
      await expect(run()).rejects.toThrow('All 3 providers in smart chain failed');
    } finally {
      restore();
    }

    expect(recorded.map((e) => [e.provider, e.outcome, e.errorClass, e.httpStatus])).toEqual([
      ['zai', 'error', 'server', 500],
      ['claude', 'error', 'bad_request', 400],
      ['hf', 'error', 'quota', 402],
    ]);
  });

  it('records a provider that streams an empty answer as an empty failure, keeping reported tokens', async () => {
    const restore = await useCreate(async (params) => {
      if (params.model === 'test-model') {
        return streamOf([
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          {
            choices: [],
            usage: { prompt_tokens: 40, completion_tokens: 25, total_tokens: 65 },
          },
        ]);
      }
      return streamOf(textChunks('fallback answer'));
    });
    try {
      const result = await run();
      expect(result.text).toBe('fallback answer');
    } finally {
      restore();
    }

    expect(recorded[0]).toMatchObject({
      provider: 'zai',
      outcome: 'error',
      errorClass: 'empty',
      httpStatus: null,
      promptTokens: 40,
      completionTokens: 25,
      reasoningTokens: null,
    });
    expect(recorded[1]).toMatchObject({ provider: 'hf', outcome: 'ok' });
  });

  it('records a mid-stream failure after text was emitted and propagates it', async () => {
    const restore = await useCreate(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
        throw new OpenAI.APIConnectionError({ message: 'Connection error.' });
      },
    }));
    const seen: string[] = [];
    try {
      await expect(
        aiStreamRound(
          { messages: MESSAGES, maxTokens: 100, chain: 'smart', purpose: 'agent' },
          { onTextDelta: (t) => seen.push(t) },
        ),
      ).rejects.toThrow('Connection error.');
    } finally {
      restore();
    }

    expect(seen).toEqual(['partial']);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      provider: 'zai',
      outcome: 'error',
      errorClass: 'server',
      httpStatus: null,
      promptTokens: null,
    });
  });

  it('records a caller deadline as aborted and stops the chain', async () => {
    mockEnv.AI_SMART_CHAIN = hfHead();
    mockEnv.AI_FAST_CHAIN = hfHead();
    const controller = new AbortController();
    const restore = await useCreate((_params, opts) => {
      const hang = Promise.withResolvers<never>();
      opts?.signal?.addEventListener('abort', () => hang.reject(new OpenAI.APIUserAbortError()));
      controller.abort();
      return hang.promise;
    });
    try {
      await expect(run({ signal: controller.signal })).rejects.toThrow(
        'AI overall deadline exceeded',
      );
    } finally {
      restore();
    }

    expect(recorded.map((e) => [e.provider, e.outcome, e.errorClass])).toEqual([
      ['hf', 'error', 'aborted'],
    ]);
  });

  it('records a per-provider timeout as timeout and falls through to the next provider', async () => {
    mockEnv.AI_SMART_CHAIN = hfHead();
    mockEnv.AI_FAST_CHAIN = hfHead();
    const restore = await useCreate((params, opts) => {
      if (params.model !== 'hf-test') return Promise.resolve(streamOf(textChunks('from z.ai')));
      const hang = Promise.withResolvers<never>();
      opts?.signal?.addEventListener('abort', () => hang.reject(new OpenAI.APIUserAbortError()));
      return hang.promise;
    });
    try {
      const result = await run({ perProviderTimeoutMs: 1 });
      expect(result.providerUsed).toBe('z.ai (test-model)');
    } finally {
      restore();
    }

    expect(recorded.map((e) => [e.provider, e.outcome, e.errorClass])).toEqual([
      ['hf', 'error', 'timeout'],
      ['zai', 'ok', null],
    ]);
  });

  it('records slots excluded by a handoff as skipped, without requesting them', async () => {
    mockEnv.AI_SMART_CHAIN = hfHead();
    mockEnv.AI_FAST_CHAIN = hfHead();
    const requested: string[] = [];
    const restore = await useCreate(async (params) => {
      requested.push(params.model);
      return streamOf(textChunks('from z.ai'));
    });
    try {
      await run({ excludeProviders: ['HF (hf-test)'] });
    } finally {
      restore();
    }

    expect(requested).toEqual(['test-model']);
    expect(
      recorded.map((e) => [e.provider, e.model, e.outcome, e.errorClass, e.durationMs]),
    ).toEqual([
      ['hf', 'hf-test', 'skipped', null, null],
      ['zai', 'test-model', 'ok', null, expect.any(Number)],
    ]);
    expect(recorded[0]).toMatchObject({
      httpStatus: null,
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
    });
    expect(recorded[0]?.requestId).toBe(recorded[1]?.requestId ?? 'missing');
  });

  it.each([
    ['smart', 'agent', 'zai', 'test-model'],
    ['fast', 'validator', 'zai', 'test-fast'],
    ['ocr', 'ocr', 'claude', 'claude-vision'],
  ] as const)('labels the %s chain event with its chain, purpose, provider and model', async (chain, purpose, provider, model) => {
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    const restore = await useCreate(async () => streamOf(textChunks('ok', FULL_USAGE)));
    try {
      await run({ chain, purpose });
    } finally {
      restore();
    }

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ chain, purpose, provider, model, outcome: 'ok' });
  });
});

describe('aiStreamRound streaming usage request', () => {
  it('asks every provider for streaming usage', async () => {
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    const params: CreateParams[] = [];
    const restore = await useCreate(async (p) => {
      params.push(p);
      throw apiError(500, 'down');
    });
    try {
      await expect(run()).rejects.toThrow('All 3 providers');
    } finally {
      restore();
    }

    expect(params.map((p) => p.model)).toEqual(['test-model', 'claude-smart', 'hf-test']);
    for (const p of params) expect(p.stream_options).toEqual({ include_usage: true });
  });

  it('leaves the Claude request shape untouched apart from stream_options', async () => {
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    mockEnv.CLAUDE_MODEL = 'claude-sonnet-5-5';
    const params: CreateParams[] = [];
    const restore = await useCreate(async (p) => {
      params.push(p);
      return streamOf(textChunks('ok'));
    });
    try {
      await run({ excludeProviders: ['z.ai (test-model)'] });
    } finally {
      restore();
      mockEnv.CLAUDE_MODEL = 'claude-smart';
    }

    expect(params).toEqual([
      {
        model: 'claude-sonnet-5-5',
        messages: MESSAGES,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 100 + 8192,
      },
    ]);
    expect(params[0]).not.toHaveProperty('temperature');
  });

  it('retries the same provider without stream_options when it rejects the option', async () => {
    const calls: CreateParams[] = [];
    const restore = await useCreate(async (p) => {
      calls.push(p);
      if (p.stream_options) throw apiError(400, "Unknown parameter: 'stream_options'.");
      return streamOf(textChunks('plain answer'));
    });
    try {
      const result = await run();
      expect(result.text).toBe('plain answer');
      expect(result.providerUsed).toBe('z.ai (test-model)');
    } finally {
      restore();
    }

    expect(calls.map((c) => [c.model, c.stream_options !== undefined])).toEqual([
      ['test-model', true],
      ['test-model', false],
    ]);
    // One provider attempt = one row, even though two HTTP requests were sent.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      provider: 'zai',
      outcome: 'ok',
      promptTokens: null,
      completionTokens: null,
    });
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('also retries without stream_options on a 422 validation error that names it', async () => {
    const calls: CreateParams[] = [];
    const restore = await useCreate(async (p) => {
      calls.push(p);
      if (p.stream_options) throw apiError(422, 'Extra inputs are not permitted: stream_options');
      return streamOf(textChunks('plain answer'));
    });
    try {
      const result = await run();
      expect(result.text).toBe('plain answer');
    } finally {
      restore();
    }

    expect(calls.map((c) => c.stream_options !== undefined)).toEqual([true, false]);
    expect(recorded.map((e) => [e.provider, e.outcome])).toEqual([['zai', 'ok']]);
  });

  it('remembers a provider that rejected stream_options and does not ask it again', async () => {
    mockEnv.AI_SMART_CHAIN = hfHead();
    mockEnv.AI_FAST_CHAIN = hfHead();
    const calls: CreateParams[] = [];
    const restore = await useCreate(async (p) => {
      calls.push(p);
      if (p.model === 'hf-test' && p.stream_options) {
        throw apiError(400, 'unknown parameter: stream_options');
      }
      return streamOf(textChunks('ok'));
    });
    try {
      await run();
      await run();
    } finally {
      restore();
    }

    expect(calls.map((c) => c.stream_options !== undefined)).toEqual([true, false, false]);
  });

  it('does not retry a 400 that has nothing to do with stream_options', async () => {
    const calls: CreateParams[] = [];
    const restore = await useCreate(async (p) => {
      calls.push(p);
      if (p.model === 'test-model') throw apiError(400, 'Unknown parameter: tool_choice');
      return streamOf(textChunks('from hf'));
    });
    try {
      const result = await run();
      expect(result.providerUsed).toBe('HF (hf-test)');
    } finally {
      restore();
    }

    expect(calls.map((c) => c.model)).toEqual(['test-model', 'hf-test']);
    expect(recorded.map((e) => [e.provider, e.outcome, e.errorClass])).toEqual([
      ['zai', 'error', 'bad_request'],
      ['hf', 'ok', null],
    ]);
  });

  it('remembers the rejection per model: another model of the same endpoint is still asked', async () => {
    mockEnv.AI_SMART_CHAIN = defaultOrder();
    mockEnv.AI_FAST_CHAIN = defaultOrder();
    const requests: Array<[string, boolean]> = [];
    const restore = await useCreate(async (p) => {
      requests.push([p.model, p.stream_options !== undefined]);
      if (p.model === 'hf-test' && p.stream_options) {
        throw apiError(400, "Unknown parameter: 'stream_options'.");
      }
      if (p.model === 'test-model' || p.model === 'test-fast') throw apiError(500, 'down');
      return streamOf(textChunks('from hf'));
    });
    try {
      await run({ chain: 'smart' });
      await run({ chain: 'fast' });
    } finally {
      restore();
    }

    // The smart-chain HF model rejected the option; the fast-chain HF model is asked with it.
    expect(requests).toEqual([
      ['test-model', true],
      ['hf-test', true],
      ['hf-test', false],
      ['test-fast', true],
      ['hf-fast', true],
    ]);
  });
});
