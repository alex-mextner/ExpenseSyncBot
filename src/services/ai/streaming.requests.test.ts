// Tests for Claude-first requests, model-specific thinking params, tool_choice, and failover
// after a priority provider exhausts its quota.

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import OpenAI from 'openai';
import {
  aiStreamRound,
  mockEnv,
  resetFallbackEnv,
  streamingModule,
} from './streaming.test-support';

const { claudeRequestParams } = streamingModule;

describe('aiStreamRound fallback chain', () => {
  beforeEach(() => {
    resetFallbackEnv();
  });

  it.each([
    ['smart' as const, ['claude-smart']],
    ['fast' as const, ['claude-fast']],
  ])('serves the %s chain through Claude without contacting fallbacks', async (chain, expected) => {
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    const calls: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      calls.push(params.model);
      if (params.model === 'test-model' || params.model === 'test-fast') {
        throw new OpenAI.APIError(500, { message: 'glm down' }, 'glm down', new Headers());
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'hello from Claude' }, finish_reason: 'stop' }] };
        },
      };
    });

    const clientsMod = await import('./clients');
    const spies = (['zaiClient', 'claudeClient', 'hfClient'] as const).map((fn) =>
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI),
    );

    try {
      const result = await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        chain,
      });

      expect(result.text).toBe('hello from Claude');
      expect(result.providerUsed).toContain('Claude');
      expect(calls).toEqual(expected);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it.each([
    ['smart' as const, 'claude-sonnet-5-5', ['test-model', 'hf-test']],
    ['fast' as const, 'claude-haiku-5-5', ['test-fast', 'hf-fast']],
    ['ocr' as const, 'claude-sonnet-5-5', ['hf-vision']],
    ['ocr' as const, 'claude-haiku-5-5', ['hf-vision']],
  ])('Claude requests in the %s chain (%s) omit temperature and use the per-model thinking params; other providers are unchanged', async (chain, claudeModel, otherModels) => {
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    if (chain === 'smart') mockEnv.CLAUDE_MODEL = claudeModel;
    else if (chain === 'fast') mockEnv.CLAUDE_FAST_MODEL = claudeModel;
    else mockEnv.CLAUDE_VISION_MODEL = claudeModel;
    const hfModel = otherModels[otherModels.length - 1];
    type SentParams = OpenAI.ChatCompletionCreateParamsStreaming & { thinking?: unknown };
    const sent = new Map<string, SentParams>();
    const create = mock(async (params: SentParams) => {
      sent.set(params.model, params);
      if (params.model !== hfModel) {
        throw new OpenAI.APIError(500, { message: 'down' }, 'down', new Headers());
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });

    const clientsMod = await import('./clients');
    const spies = (['zaiClient', 'claudeClient', 'hfClient'] as const).map((fn) =>
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI),
    );

    try {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        temperature: 0.7,
        chain,
      });

      const claude = sent.get(claudeModel);
      expect(claude).toBeDefined();
      expect(claude && 'temperature' in claude).toBe(false);
      expect(claude).toMatchObject(claudeRequestParams(claudeModel, 100));
      for (const model of otherModels) {
        expect(sent.get(model)?.temperature).toBe(0.7);
        expect(sent.get(model)?.max_tokens).toBe(100);
        expect(sent.get(model)?.thinking).toBeUndefined();
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  const calculateTool: OpenAI.ChatCompletionTool[] = [
    { type: 'function', function: { name: 'calculate', parameters: { type: 'object' } } },
  ];

  it("sends tools with tool_choice 'none' to every smart-chain provider when the caller forbids tool calls", async () => {
    // The agent's forced final round: the history holds tool calls, so the tools stay declared,
    // but the model must answer in text (see the forced round in agent.ts).
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    const sent: OpenAI.ChatCompletionCreateParamsStreaming[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      sent.push(params);
      throw new OpenAI.APIError(500, { message: 'down' }, 'down', new Headers());
    });

    const clientsMod = await import('./clients');
    const spies = (['zaiClient', 'claudeClient', 'hfClient'] as const).map((fn) =>
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI),
    );

    try {
      await expect(
        aiStreamRound({
          messages: [{ role: 'user', content: 'hi' }],
          tools: calculateTool,
          toolChoice: 'none',
          maxTokens: 100,
          chain: 'smart',
        }),
      ).rejects.toThrow();

      expect(sent.map((p) => p.model)).toEqual(['claude-smart', 'test-model', 'hf-test']);
      for (const params of sent) {
        expect(params.tools).toEqual(calculateTool);
        expect(params.tool_choice).toBe('none');
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('omits tool_choice unless the caller asks for it and tools are sent', async () => {
    const sent: OpenAI.ChatCompletionCreateParamsStreaming[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      sent.push(params);
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    const clientsMod = await import('./clients');
    const spy = spyOn(clientsMod, 'claudeClient').mockReturnValue({
      chat: { completions: { create } },
    } as unknown as OpenAI);

    try {
      const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'hi' }];
      await aiStreamRound({ messages, tools: calculateTool, maxTokens: 100 });
      // tool_choice is only valid next to tools — a provider rejects it alone.
      await aiStreamRound({ messages, toolChoice: 'none', maxTokens: 100 });

      expect(sent).toHaveLength(2);
      expect(sent[0]?.tools).toEqual(calculateTool);
      expect(sent[0]).not.toHaveProperty('tool_choice');
      expect(sent[1]).not.toHaveProperty('tools');
      expect(sent[1]).not.toHaveProperty('tool_choice');
    } finally {
      spy.mockRestore();
    }
  });

  // A depleted primary should fail once, then yield to the next priority provider.
  it.each([
    ['smart' as const, 'test-model', 'claude-smart'],
    ['fast' as const, 'test-fast', 'claude-fast'],
  ])('a quota-exhausted Claude (429) falls through to z.ai and is skipped on the next %s round', async (chain, zaiModel, claudeModel) => {
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    const calls: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      calls.push(params.model);
      if (params.model === claudeModel) {
        throw new OpenAI.APIError(
          429,
          { message: 'Insufficient balance or quota' },
          'quota',
          new Headers(),
        );
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'from z.ai' }, finish_reason: 'stop' }] };
        },
      };
    });
    const clientsMod = await import('./clients');
    const spies = (['zaiClient', 'claudeClient'] as const).map((fn) =>
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI),
    );
    try {
      const options = {
        messages: [{ role: 'user' as const, content: 'hi' }],
        maxTokens: 100,
        chain,
      };
      expect((await aiStreamRound(options)).text).toBe('from z.ai');
      expect((await aiStreamRound(options)).text).toBe('from z.ai');
      expect(calls).toEqual([claudeModel, zaiModel, zaiModel]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('HF model request compatibility', () => {
  it.each([
    ['hf', 'Qwen/Qwen3.8-2.4T-A95B', 100, 4196, 'low', undefined],
    ['hf', 'Qwen/Qwen3.8-2.4T-A95B:deepinfra', 100, 4196, 'low', undefined],
    ['hf', 'Qwen/Qwen3.8-2.4T-A95B:deepinfra', 8192, 12288, 'low', undefined],
    ['hf', 'Qwen/Qwen3.8-Flash-Next-FP8', 100, 100, undefined, false],
    ['hf', 'Qwen/Qwen3.8-Flash-Next-FP8:nscale', 100, 100, undefined, false],
    ['hf', 'vendor/unrelated-model:deepinfra', 100, 100, undefined, undefined],
    ['hf', 'meta-llama/Llama-4-Scout-17B-16E-Instruct:deepinfra', 100, 100, undefined, undefined],
    ['openrouter', 'Qwen/Qwen3.8-2.4T-A95B', 100, 100, undefined, undefined],
    ['openrouter', 'Qwen/Qwen3.8-Flash-Next-FP8', 100, 100, undefined, undefined],
  ] as const)('%s %s preserves the answer budget and sends only supported reasoning controls', async (provider, model, maxTokens, expectedMaxTokens, expectedEffort, expectedThinking) => {
    type SentParams = OpenAI.ChatCompletionCreateParamsStreaming & {
      chat_template_kwargs?: { enable_thinking: boolean };
    };
    const sent: SentParams[] = [];
    const create = mock(async (params: SentParams) => {
      sent.push(params);
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'visible answer' }, finish_reason: 'stop' }] };
        },
      };
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const { streamingSlot } = await import('./streaming/slot');
    const slot = streamingSlot('request probe', provider, () => client, model);
    const output = await slot.stream(
      {
        messages: [{ role: 'user', content: 'hi' }],
        purpose: 'probe',
        maxTokens,
        temperature: 0.3,
      },
      {},
    );
    expect(output.result.text).toBe('visible answer');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.max_tokens).toBe(expectedMaxTokens);
    expect(sent[0]?.reasoning_effort).toBe(expectedEffort);
    expect(sent[0]?.chat_template_kwargs?.enable_thinking).toBe(expectedThinking);
    expect(sent[0]).not.toHaveProperty('thinking');
    expect(sent[0]?.temperature).toBe(0.3);
  });
});
