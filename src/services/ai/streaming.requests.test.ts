// Tests for the request each provider receives: Claude right after z.ai, the per-model Claude
// thinking params, tool_choice, and a quota-exhausted z.ai being skipped on the next round.

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
    ['smart' as const, ['test-model', 'claude-smart']],
    ['fast' as const, ['test-fast', 'claude-fast']],
  ])('tries Claude right after z.ai in the %s chain', async (chain, expected) => {
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

      expect(sent.map((p) => p.model)).toEqual(['test-model', 'claude-smart', 'hf-test']);
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
    const spy = spyOn(clientsMod, 'zaiClient').mockReturnValue({
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

  // Owner-ordered z.ai head: a depleted z.ai (429 quota) must cost one fast failure, not one per request.
  it.each([
    ['smart' as const, 'test-model', 'claude-smart'],
    ['fast' as const, 'test-fast', 'claude-fast'],
  ])('a quota-exhausted z.ai (429) falls through to Claude and is skipped on the next %s round', async (chain, zaiModel, claudeModel) => {
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    const calls: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      calls.push(params.model);
      if (params.model === zaiModel) {
        throw new OpenAI.APIError(
          429,
          { message: 'Insufficient balance or quota' },
          'quota',
          new Headers(),
        );
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'from Claude' }, finish_reason: 'stop' }] };
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
      expect((await aiStreamRound(options)).text).toBe('from Claude');
      expect((await aiStreamRound(options)).text).toBe('from Claude');
      expect(calls).toEqual([zaiModel, claudeModel, claudeModel]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
