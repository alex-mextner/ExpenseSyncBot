// Tests for the fallback walk of aiStreamRound: what falls through to the next provider, what
// propagates, how text, tool calls and the final message are assembled, deadlines and per-provider
// timeouts, and the aggregate error of an exhausted chain.

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import OpenAI from 'openai';
import { aiStreamRound, resetFallbackEnv } from './streaming.test-support';

describe('aiStreamRound fallback chain', () => {
  beforeEach(() => {
    resetFallbackEnv();
  });

  it('falls back to next provider on 400 BadRequest', async () => {
    // Mock: first provider (z.ai) → 400, second (Claude) should be tried
    // We test this via the full aiStreamRound by mocking fetch
    const calls: string[] = [];

    const createMock = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      calls.push(params.model);
      if (params.model === 'test-model') {
        throw new OpenAI.APIError(400, { message: 'bad request' }, 'bad request', new Headers());
      }
      if (params.model === 'claude-smart') {
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
    spyOn(clientsMod, 'claudeClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'hfClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      chain: 'smart',
    });

    expect(result.text).toBe('hello from HF');
    expect(result.providerUsed).toContain('HF');
    // All three providers were tried
    expect(calls).toEqual(['test-model', 'claude-smart', 'hf-test']);
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
      aiStreamRound(
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
    const result = await aiStreamRound(
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
    // Claude/HF should NOT be tried
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

    const result = await aiStreamRound({
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

    const result = await aiStreamRound({
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
        // Claude: actual text
        yield { choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }] };
      },
    }));
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'claudeClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
      chain: 'smart',
    });

    expect(result.text).toBe('recovered');
    expect(result.providerUsed).toContain('Claude');
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
    spyOn(clientsMod, 'claudeClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'hfClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const controller = new AbortController();
    controller.abort();

    try {
      await aiStreamRound({
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
    spyOn(clientsMod, 'claudeClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
      chain: 'smart',
      perProviderTimeoutMs: 20,
    });

    expect(result.text).toBe('fresh fallback');
    expect(result.providerUsed).toContain('Claude');
    expect(calls).toEqual(['test-model', 'claude-smart']);
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
    spyOn(clientsMod, 'claudeClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    try {
      await aiStreamRound({
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

    const result = await aiStreamRound({
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

    const result = await aiStreamRound({
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
    const result = await aiStreamRound(
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
    spyOn(clientsMod, 'claudeClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'hfClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    try {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('All 3 providers');
      expect(msg).toContain('z.ai');
      expect(msg).toContain('Claude');
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
    spyOn(clientsMod, 'claudeClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'hfClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    try {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
      throw new Error('unreachable');
    } catch (err) {
      expect((err as { status?: number }).status).toBe(503);
    }
  });

  it('uses OCR chain (Claude vision → HF, no z.ai)', async () => {
    const clientsMod = await import('./clients');
    const calls: string[] = [];
    const createMock = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      calls.push(params.model);
      if (params.model === 'claude-vision') {
        throw new Error('claude-vision-fail');
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
    spyOn(clientsMod, 'claudeClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);
    spyOn(clientsMod, 'hfClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'ocr' }],
      maxTokens: 200,
      chain: 'ocr',
    });

    expect(result.text).toBe('ocr-text');
    // OCR chain uses only vision models (claude-vision + hf-vision).
    // Previous tests in this describe block already spied on zaiClient, so
    // we can't rely on zaiSpy.mock.calls here — instead verify no non-vision
    // model name appears in the calls array.
    expect(calls.every((m) => m === 'claude-vision' || m === 'hf-vision')).toBe(true);
    expect(calls).toContain('claude-vision');
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
    spyOn(clientsMod, 'claudeClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
      chain: 'smart',
    });

    // First provider (test-model) was tried and failed, second (claude-smart) succeeded
    expect(modelsCalled).toContain('test-model');
    expect(modelsCalled).toContain('claude-smart');
    expect(result.text).toBe('ok');
  });
});
