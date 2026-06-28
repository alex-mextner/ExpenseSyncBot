// Tests for AI streaming: fallback chain, tool call index resolution, isRetryableError

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();

mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

mock.module('../../config/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test-key',
    AI_BASE_URL: 'https://test.ai/v1',
    AI_MODEL: 'test-model',
    AI_FAST_MODEL: 'test-fast',
    GEMINI_API_KEY: 'test-gemini',
    GEMINI_BASE_URL: 'https://test.gemini/v1',
    GEMINI_MODEL: 'gemini-test',
    GEMINI_FAST_MODEL: 'gemini-fast',
    GEMINI_VISION_MODEL: 'gemini-vision',
    HF_TOKEN: 'test-hf',
    HF_BASE_URL: 'https://test.hf/v1',
    HF_MODEL: 'hf-test',
    HF_FAST_MODEL: 'hf-fast',
    HF_VISION_MODEL: 'hf-vision',
  },
}));

// Mock clients to avoid real HTTP calls
mock.module('./clients', () => ({
  zaiClient: () => ({}),
  geminiClient: () => ({}),
  hfClient: () => ({}),
}));

import OpenAI from 'openai';
import { getBackoffDelay, isRetryableError } from './streaming';

describe('isRetryableError', () => {
  it('returns true for 429 rate limit', () => {
    const err = new OpenAI.APIError(
      429,
      { message: 'rate limited' },
      'rate limited',
      new Headers(),
    );
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for 500 server error', () => {
    const err = new OpenAI.APIError(500, { message: 'internal' }, 'internal', new Headers());
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns false for 400 bad request', () => {
    const err = new OpenAI.APIError(400, { message: 'bad request' }, 'bad request', new Headers());
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns false for 401 unauthorized', () => {
    const err = new OpenAI.APIError(401, { message: 'unauth' }, 'unauth', new Headers());
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns true for AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for timeout error', () => {
    const err = new Error('Request timed out');
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    const err = new Error('Connection refused') as NodeJS.ErrnoException;
    err.code = 'ECONNREFUSED';
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for APIError with undefined status (SDK v6 abort)', () => {
    const err = new OpenAI.APIError(undefined as unknown as number, {}, 'abort', new Headers());
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns false for generic Error', () => {
    expect(isRetryableError(new Error('some error'))).toBe(false);
  });
});

describe('getBackoffDelay', () => {
  it('returns 5000 for 429 (retry-after parsing requires plain object headers)', () => {
    // NOTE: getBackoffDelay reads headers?.['retry-after'] but OpenAI SDK stores
    // Headers object which doesn't support bracket notation. Pre-existing issue.
    const err = new OpenAI.APIError(
      429,
      { message: 'rate limited' },
      'rate limited',
      new Headers({ 'retry-after': '3' }),
    );
    expect(getBackoffDelay(0, err)).toBe(5000);
  });

  it('exponential backoff for non-429', () => {
    expect(getBackoffDelay(0, new Error('fail'))).toBe(2000);
    expect(getBackoffDelay(1, new Error('fail'))).toBe(6000);
    expect(getBackoffDelay(2, new Error('fail'))).toBe(18000);
    expect(getBackoffDelay(3, new Error('fail'))).toBe(30_000); // capped
  });
});

describe('aiStreamRound fallback chain', () => {
  // We need to test the actual chain logic with mocked streaming slots.
  // Import the module after mocks are set up.
  // biome-ignore lint/suspicious/noExplicitAny: test-only type for mocking streaming internals
  let streamingModule: any;

  beforeEach(async () => {
    // Re-import to get fresh module with mocked deps
    streamingModule = await import('./streaming');
  });

  it('falls back to next provider on 400 BadRequest', async () => {
    // Mock: first provider (z.ai) → 400, second (Gemini) should be tried
    // We test this via the full aiStreamRound by mocking fetch
    const calls: string[] = [];

    const createMock = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      calls.push(params.model);
      if (params.model === 'test-model') {
        throw new OpenAI.APIError(400, { message: 'bad request' }, 'bad request', new Headers());
      }
      if (params.model === 'gemini-test') {
        throw new OpenAI.APIError(
          400,
          { message: 'bad request too' },
          'bad request too',
          new Headers(),
        );
      }
      // HF succeeds with a simple async iterator
      return {
        [Symbol.asyncIterator]: async function* () {
          yield {
            choices: [{ delta: { content: 'hello from HF' }, finish_reason: null }],
          };
          yield {
            choices: [{ delta: {}, finish_reason: 'stop' }],
          };
        },
      };
    });

    // Mock all three clients to use our createMock
    const clientsMod = await import('./clients');
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'geminiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'hfClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await streamingModule.aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      chain: 'smart',
    });

    expect(result.text).toBe('hello from HF');
    expect(result.providerUsed).toContain('HF');
    // All three providers were tried
    expect(calls).toEqual(['test-model', 'gemini-test', 'hf-test']);
  });

  it('propagates error when text was already emitted', async () => {
    const clientsMod = await import('./clients');
    const createMock = mock(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'partial text' }, finish_reason: null }] };
        throw new Error('stream died mid-way');
      },
    }));

    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    let emittedText = '';
    await expect(
      streamingModule.aiStreamRound(
        { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, chain: 'smart' },
        {
          onTextDelta: (t: string) => {
            emittedText += t;
          },
        },
      ),
    ).rejects.toThrow('stream died mid-way');

    expect(emittedText).toBe('partial text');
  });

  it('happy path: first provider succeeds, text + tool call callbacks fire in order', async () => {
    const clientsMod = await import('./clients');
    const createMock = mock(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [{ delta: { content: 'Hello ' }, finish_reason: null }],
        };
        yield {
          choices: [{ delta: { content: 'world' }, finish_reason: null }],
        };
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'get_expenses', arguments: '{"limit":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '5}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
      },
    }));
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const textChunks: string[] = [];
    const toolCallNames: string[] = [];
    const result = await streamingModule.aiStreamRound(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, chain: 'smart' },
      {
        onTextDelta: (t: string) => textChunks.push(t),
        onToolCallStart: (name: string) => toolCallNames.push(name),
      },
    );

    expect(textChunks).toEqual(['Hello ', 'world']);
    expect(result.text).toBe('Hello world');
    expect(toolCallNames).toEqual(['get_expenses']);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'get_expenses',
      arguments: '{"limit":5}',
    });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.providerUsed).toContain('z.ai');
    // Gemini/HF should NOT be tried
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('assistantMessage contains tool_calls when tools present', async () => {
    const clientsMod = await import('./clients');
    const createMock = mock(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tc1',
                    function: { name: 'calc', arguments: '{"a":1}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        };
      },
    }));
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await streamingModule.aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
      chain: 'smart',
    });

    expect(result.assistantMessage.role).toBe('assistant');
    expect(result.assistantMessage.content).toBeNull();
    const msg = result.assistantMessage as {
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls?.[0]).toEqual({
      id: 'tc1',
      type: 'function',
      function: { name: 'calc', arguments: '{"a":1}' },
    });
  });

  it('assistantMessage has content string and no tool_calls for pure text', async () => {
    const clientsMod = await import('./clients');
    const createMock = mock(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'plain answer' }, finish_reason: 'stop' }] };
      },
    }));
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await streamingModule.aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
      chain: 'smart',
    });

    expect(result.assistantMessage.content).toBe('plain answer');
    const msg = result.assistantMessage as { tool_calls?: unknown };
    expect(msg.tool_calls).toBeUndefined();
  });

  it('empty response (no text, no tools) triggers fallback to next provider', async () => {
    const clientsMod = await import('./clients');
    let callNum = 0;
    const createMock = mock(async () => ({
      [Symbol.asyncIterator]: async function* () {
        callNum++;
        if (callNum === 1) {
          // z.ai: empty response (common z.ai quirk)
          yield { choices: [{ delta: { content: '' }, finish_reason: 'stop' }] };
          return;
        }
        // Gemini: actual text
        yield { choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }] };
      },
    }));
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'geminiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await streamingModule.aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
      chain: 'smart',
    });

    expect(result.text).toBe('recovered');
    expect(result.providerUsed).toContain('Gemini');
  });

  it('aborts cleanly when signal triggers before stream start', async () => {
    const clientsMod = await import('./clients');
    const createMock = mock(async (_params: unknown, opts?: { signal?: AbortSignal }) => {
      // Simulate SDK v6: a pre-aborted signal yields an APIError with undefined status
      if (opts?.signal?.aborted) {
        throw new OpenAI.APIError(undefined as unknown as number, {}, 'aborted', new Headers());
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'nope' }, finish_reason: 'stop' }] };
        },
      };
    });
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'geminiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'hfClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const controller = new AbortController();
    controller.abort();

    // All providers abort → aggregated error with 3 provider failures
    await expect(
      streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
        signal: controller.signal,
      }),
    ).rejects.toThrow(/All 3 providers/);
  });

  it('tool-call resolution: handles missing tc.index (HF Router quirk)', async () => {
    const clientsMod = await import('./clients');
    const createMock = mock(async () => ({
      [Symbol.asyncIterator]: async function* () {
        // First chunk: no index, but id + name => new tool call
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call_a',
                    function: { name: 'tool_a', arguments: '{"x":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        // Second chunk: no index, no id/name => append to last
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: { arguments: '1}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
      },
    }));
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await streamingModule.aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
      chain: 'smart',
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: 'call_a',
      name: 'tool_a',
      arguments: '{"x":1}',
    });
  });

  it('tool-call resolution: skips chunks with no index/id/name and no prior tool call', async () => {
    const clientsMod = await import('./clients');
    const createMock = mock(async () => ({
      [Symbol.asyncIterator]: async function* () {
        // Orphaned chunk: no index, no id, no name, no prior tool call → skipped
        yield {
          choices: [
            {
              delta: {
                tool_calls: [{ function: { arguments: 'junk' } }],
              },
              finish_reason: null,
            },
          ],
        };
        yield { choices: [{ delta: { content: 'text anyway' }, finish_reason: 'stop' }] };
      },
    }));
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await streamingModule.aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
      chain: 'smart',
    });

    expect(result.toolCalls).toHaveLength(0);
    expect(result.text).toBe('text anyway');
  });

  it('streams text chunks in order; final text matches concatenation', async () => {
    const clientsMod = await import('./clients');
    const createMock = mock(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'a' }, finish_reason: null }] };
        yield { choices: [{ delta: { content: 'b' }, finish_reason: null }] };
        yield { choices: [{ delta: { content: 'c' }, finish_reason: null }] };
        yield { choices: [{ delta: { content: 'd' }, finish_reason: 'stop' }] };
      },
    }));
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const chunks: string[] = [];
    const result = await streamingModule.aiStreamRound(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, chain: 'smart' },
      { onTextDelta: (t: string) => chunks.push(t) },
    );

    expect(chunks).toEqual(['a', 'b', 'c', 'd']);
    expect(result.text).toBe(chunks.join(''));
  });

  it('all providers fail: aggregated error mentions all provider names', async () => {
    const clientsMod = await import('./clients');
    const createMock = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      throw new Error(`boom ${params.model}`);
    });
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'geminiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'hfClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    try {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('All 3 providers');
      expect(msg).toContain('z.ai');
      expect(msg).toContain('Gemini');
      expect(msg).toContain('HF');
      expect(msg).toContain('smart');
    }
  });

  it('preserves last error status on aggregated error', async () => {
    const clientsMod = await import('./clients');
    const createMock = mock(async () => {
      throw Object.assign(new Error('last-fail'), { status: 503 });
    });
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'geminiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'hfClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    try {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
      throw new Error('unreachable');
    } catch (err) {
      expect((err as { status?: number }).status).toBe(503);
    }
  });

  it('uses OCR chain (Gemini → HF, no z.ai)', async () => {
    const clientsMod = await import('./clients');
    const calls: string[] = [];
    const createMock = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      calls.push(params.model);
      if (params.model === 'gemini-vision') {
        throw new Error('gemini-vision-fail');
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ocr-text' }, finish_reason: 'stop' }] };
        },
      };
    });
    const zaiSpy = spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'geminiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'hfClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await streamingModule.aiStreamRound({
      messages: [{ role: 'user', content: 'ocr' }],
      maxTokens: 200,
      chain: 'ocr',
    });

    expect(result.text).toBe('ocr-text');
    // OCR chain uses only vision models (gemini-vision + hf-vision).
    // Previous tests in this describe block already spied on zaiClient, so
    // we can't rely on zaiSpy.mock.calls here — instead verify no non-vision
    // model name appears in the calls array.
    expect(calls.every((m) => m === 'gemini-vision' || m === 'hf-vision')).toBe(true);
    expect(calls).toContain('gemini-vision');
    expect(calls).toContain('hf-vision');
    void zaiSpy;
  });

  it('falls back to next provider when first provider fails', async () => {
    const clientsMod = await import('./clients');
    const modelsCalled: string[] = [];
    const createMock = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      modelsCalled.push(params.model);
      if (params.model === 'test-model') {
        throw new Error('first down');
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'geminiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await streamingModule.aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
      chain: 'smart',
    });

    // First provider (test-model) was tried and failed, second (gemini-test) succeeded
    expect(modelsCalled).toContain('test-model');
    expect(modelsCalled).toContain('gemini-test');
    expect(result.text).toBe('ok');
  });
});

describe('stripThinkingTags', () => {
  let mod: typeof import('./streaming');
  beforeEach(async () => {
    mod = await import('./streaming');
  });

  it('removes <think>...</think> block', () => {
    expect(mod.stripThinkingTags('<think>hmm</think>answer')).toBe('answer');
  });

  it('removes multiline think block', () => {
    expect(mod.stripThinkingTags('<think>\nline1\nline2\n</think>\nfinal')).toBe('final');
  });

  it('removes multiple think blocks', () => {
    expect(mod.stripThinkingTags('<think>a</think>one<think>b</think>two')).toBe('onetwo');
  });

  it('trims whitespace', () => {
    expect(mod.stripThinkingTags('  hello  ')).toBe('hello');
  });

  it('leaves text without think tags unchanged', () => {
    expect(mod.stripThinkingTags('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(mod.stripThinkingTags('')).toBe('');
  });
});

describe('classifyAiError', () => {
  let mod: typeof import('./streaming');
  beforeEach(async () => {
    mod = await import('./streaming');
  });

  it('classifies an aggregated all-providers connection failure as provider_down', () => {
    const err = new Error(
      'All 3 providers in smart chain failed: z.ai (glm-5.1): Connection error.; ' +
        'Gemini (g): Connection error.; HF (h): Connection error.',
    );
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('provider_down');
    expect(c?.userMessage).toContain('временно недоступен');
  });

  it('classifies an OpenAI APIConnectionError as provider_down', () => {
    const err = new OpenAI.APIConnectionError({ message: 'Connection error.' });
    expect(mod.classifyAiError(err)?.kind).toBe('provider_down');
  });

  it('classifies ECONNREFUSED as provider_down', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(mod.classifyAiError(err)?.kind).toBe('provider_down');
  });

  it('classifies a non-429/529 5xx as provider_down', () => {
    const err = Object.assign(new Error('Server error'), { status: 503 });
    expect(mod.classifyAiError(err)?.kind).toBe('provider_down');
  });

  it('classifies 429 as rate_limit', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('rate_limit');
    expect(c?.userMessage).toContain('Слишком много');
  });

  it('reads status off a real OpenAI.APIError instance (429 → rate_limit)', () => {
    const err = new OpenAI.APIError(429, { message: 'rl' }, 'rl', new Headers());
    expect(mod.classifyAiError(err)?.kind).toBe('rate_limit');
  });

  it('classifies an aggregate carrying code=ECONNREFUSED as provider_down', () => {
    // aiStreamRound copies the last error's status+code onto the aggregate, so a
    // connection-down chain stays classifiable even if the joined message is terse.
    const err = Object.assign(new Error('All 3 providers in smart chain failed: …'), {
      code: 'ECONNREFUSED',
    });
    expect(mod.classifyAiError(err)?.kind).toBe('provider_down');
  });

  it('classifies 529 as overloaded', () => {
    const err = Object.assign(new Error('overloaded'), { status: 529 });
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('overloaded');
    expect(c?.userMessage).toContain('перегружен');
  });

  it('classifies an AbortError as timeout', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('timeout');
    expect(c?.userMessage).toContain('ожидания');
  });

  it('classifies an aggregated abort (60s agent timeout) as timeout, not provider_down', () => {
    const err = new Error(
      'All 3 providers in smart chain failed: z.ai (glm-5.1): Request was aborted.; ' +
        'Gemini (g): Request was aborted.; HF (h): Request was aborted.',
    );
    expect(mod.classifyAiError(err)?.kind).toBe('timeout');
  });

  it('classifies a 4xx (other than 429) as a generic recognized AI error', () => {
    const err = Object.assign(new Error('bad request'), { status: 400 });
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('generic');
    expect(c?.userMessage).toContain('Ошибка AI');
  });

  it('does NOT mask an aggregated all-400 failure as provider_down (stays generic)', () => {
    const err = Object.assign(
      new Error(
        'All 3 providers in smart chain failed: z.ai (glm-5.1): 400 Bad Request; ' +
          'Gemini (g): 400 Bad Request; HF (h): 400 Bad Request',
      ),
      { status: 400 },
    );
    expect(mod.classifyAiError(err)?.kind).toBe('generic');
  });

  it('does NOT mask a mixed 4xx aggregate (last=400, earlier connection blip) as an outage', () => {
    // A concrete 4xx is a request bug — the earlier "Connection error." in the summary
    // must not flip it to provider_down.
    const err = Object.assign(
      new Error(
        'All 3 providers in smart chain failed: z.ai (glm-5.1): Connection error.; ' +
          'Gemini (g): 400 Bad Request; HF (h): 400 Bad Request',
      ),
      { status: 400 },
    );
    expect(mod.classifyAiError(err)?.kind).toBe('generic');
  });

  it('returns null for an aggregated empty-response failure (no status/connection signal)', () => {
    const err = new Error(
      'All 3 providers in smart chain failed: z.ai (glm-5.1): Provider z.ai (glm-5.1) ' +
        'returned empty response (no text, no tool calls) — treating as failure; ' +
        'Gemini (g): returned empty response; HF (h): returned empty response',
    );
    expect(mod.classifyAiError(err)).toBeNull();
  });

  it('classifies ECONNRESET as provider_down', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(mod.classifyAiError(err)?.kind).toBe('provider_down');
  });

  it('classifies a "fetch failed" message as provider_down', () => {
    expect(mod.classifyAiError(new Error('fetch failed'))?.kind).toBe('provider_down');
  });

  it('returns null for an unrecognized error so the caller can rethrow', () => {
    expect(mod.classifyAiError(new TypeError('boom'))).toBeNull();
  });
});
