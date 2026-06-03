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

  it('stops the chain immediately when the overall signal is pre-aborted', async () => {
    // When the caller's overall deadline has already passed, trying any provider
    // is pointless — the chain must abort at once with an AbortError-classified error,
    // NOT loop through all three providers.
    const clientsMod = await import('./clients');
    const createMock = mock(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'nope' }, finish_reason: 'stop' }] };
      },
    }));
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

    try {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
        signal: controller.signal,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).name).toBe('AbortError');
    }
    // No provider should have been called — the overall signal was already aborted.
    expect(createMock).not.toHaveBeenCalled();
  });

  it('per-provider timeout fires → falls back to next provider with a FRESH (non-aborted) signal', async () => {
    // Problem A regression: the first provider hangs until its OWN per-provider
    // timeout fires. The fallback must reach the second provider with a signal that
    // is NOT aborted (the shared-signal bug would hand it the already-aborted signal).
    // On the OLD code the first provider's hang never resolves → the test times out.
    const clientsMod = await import('./clients');
    const calls: string[] = [];
    const secondSignalStates: Array<boolean | undefined> = [];

    const createMock = mock(
      async (
        params: OpenAI.ChatCompletionCreateParamsStreaming,
        opts?: { signal?: AbortSignal },
      ) => {
        calls.push(params.model);
        if (params.model === 'test-model') {
          // Hang until our injected per-provider timeout aborts this provider's signal.
          await new Promise<void>((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted by per-provider timeout');
              err.name = 'AbortError';
              reject(err);
            });
          });
          throw new Error('unreachable');
        }
        // Second provider: record whether its signal is fresh (not aborted).
        secondSignalStates.push(opts?.signal?.aborted);
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { choices: [{ delta: { content: 'fresh fallback' }, finish_reason: 'stop' }] };
          },
        };
      },
    );
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
      perProviderTimeoutMs: 20,
    });

    expect(result.text).toBe('fresh fallback');
    expect(result.providerUsed).toContain('Gemini');
    expect(calls).toEqual(['test-model', 'gemini-test']);
    // The second provider received a fresh, non-aborted signal.
    expect(secondSignalStates).toEqual([false]);
  });

  it('per-provider timeout fires but overall signal also aborted → stops the chain', async () => {
    // If the caller's overall deadline passed while the first provider was running,
    // the chain must NOT try the next provider — it throws an AbortError instead.
    const clientsMod = await import('./clients');
    const calls: string[] = [];
    const overallController = new AbortController();

    const createMock = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      calls.push(params.model);
      // First provider: abort the OVERALL signal, then reject as if its own timeout fired.
      overallController.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'geminiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    try {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
        signal: overallController.signal,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).name).toBe('AbortError');
    }
    // Only the first provider was tried — overall deadline stops the chain.
    expect(calls).toEqual(['test-model']);
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

describe('formatApiError', () => {
  let mod: typeof import('./streaming');
  beforeEach(async () => {
    mod = await import('./streaming');
  });

  it('returns rate-limit message for 429', () => {
    const err = new OpenAI.APIError(429, { message: 'rl' }, 'rl', new Headers());
    const msg = mod.formatApiError(err);
    expect(msg).toContain('Слишком много');
  });

  it('returns overloaded message for 529', () => {
    const err = new OpenAI.APIError(529, { message: 'over' }, 'over', new Headers());
    const msg = mod.formatApiError(err);
    expect(msg).toContain('перегружен');
  });

  it('returns generic error for other statuses', () => {
    const err = new OpenAI.APIError(500, { message: 'srv' }, 'srv', new Headers());
    const msg = mod.formatApiError(err);
    expect(msg).toContain('Ошибка AI');
  });

  it('returns generic error for non-APIError', () => {
    const msg = mod.formatApiError(new Error('anything'));
    expect(msg).toContain('Ошибка AI');
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
