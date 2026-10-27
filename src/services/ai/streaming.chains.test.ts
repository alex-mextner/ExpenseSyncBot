// Tests for which provider slots each chain ends up with: the default and configured orders, the
// Claude key gate, excluded providers, OpenRouter, retired models, role routing and nextProvider.
// The logs of skipped providers are pinned in streaming.chain-skips.test.ts.

import { beforeEach, describe, expect, it } from 'bun:test';
import type OpenAI from 'openai';
import type { ModelPreset } from './model-presets';
import type { RoleChainEntry } from './role-routing';
import {
  chainModels,
  DEFAULT_ORDER,
  mockEnv,
  recordProviderRateLimit,
  resetFallbackEnv,
  streamingModule,
} from './streaming.test-support';

describe('aiStreamRound fallback chain', () => {
  beforeEach(() => {
    resetFallbackEnv();
  });

  it.each([
    ['smart' as const, ['test-model', 'claude-smart', 'hf-test']],
    ['fast' as const, ['test-fast', 'claude-fast', 'hf-fast']],
    ['ocr' as const, ['claude-vision', 'hf-vision']],
  ])('the %s chain with every key set is exactly %p', async (chain, expected) => {
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    expect(await chainModels(chain)).toEqual(expected);
  });

  it.each([
    ['smart' as const, ['test-model', 'hf-test']],
    ['fast' as const, ['test-fast', 'hf-fast']],
    ['ocr' as const, ['hf-vision']],
  ])('without a Claude key the %s chain degrades to %p', async (chain, expected) => {
    mockEnv.CLAUDE_API_TOKEN = '';
    expect(await chainModels(chain)).toEqual(expected);
  });

  it('AI_SMART_CHAIN / AI_FAST_CHAIN override the order; the other chain keeps its default', async () => {
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    mockEnv.AI_SMART_CHAIN = { ...DEFAULT_ORDER, order: ['hf', 'claude'], fromEnv: true };
    expect(await chainModels('smart')).toEqual(['hf-test', 'claude-smart']);
    expect(await chainModels('fast')).toEqual(['test-fast', 'claude-fast', 'hf-fast']);
  });

  it('a configured order naming nothing usable falls back to the default order', async () => {
    mockEnv.CLAUDE_API_TOKEN = '';
    mockEnv.AI_SMART_CHAIN = { ...DEFAULT_ORDER, order: ['claude'], fromEnv: true };
    expect(await chainModels('smart')).toEqual(['test-model', 'hf-test']);
  });

  // A stalled model is handed off: the agent excludes it for the rest of the run (HYP-1716).
  it('skips the excluded providers and keeps the rest of the chain in order', async () => {
    expect(await chainModels('smart', ['z.ai (test-model)'])).toEqual(['claude-smart', 'hf-test']);
    expect(await chainModels('smart', ['z.ai (test-model)', 'Claude (claude-smart)'])).toEqual([
      'hf-test',
    ]);
  });

  it('openrouter is part of a chain only when the operator names it and its key and model are set', async () => {
    mockEnv.OPENROUTER_API_KEY = 'or-key';
    // Not in the default order: a key alone changes nothing.
    expect(await chainModels('smart')).toEqual(['test-model', 'claude-smart', 'hf-test']);
    expect(await chainModels('fast')).toEqual(['test-fast', 'claude-fast', 'hf-fast']);
    mockEnv.AI_SMART_CHAIN = {
      ...DEFAULT_ORDER,
      order: ['openrouter', 'claude', 'hf'],
      fromEnv: true,
    };
    mockEnv.AI_FAST_CHAIN = { ...DEFAULT_ORDER, order: ['zai', 'openrouter'], fromEnv: true };
    expect(await chainModels('smart')).toEqual(['or-smart', 'claude-smart', 'hf-test']);
    expect(await chainModels('fast')).toEqual(['test-fast', 'or-fast']);
    expect(await chainModels('ocr')).toEqual(['claude-vision', 'hf-vision']);
  });

  it('a named openrouter without key or model is skipped, the rest of the chain runs', async () => {
    mockEnv.AI_SMART_CHAIN = {
      ...DEFAULT_ORDER,
      order: ['openrouter', 'claude', 'hf'],
      fromEnv: true,
    };
    mockEnv.OPENROUTER_API_KEY = '';
    expect(await chainModels('smart')).toEqual(['claude-smart', 'hf-test']);
    mockEnv.OPENROUTER_API_KEY = 'or-key';
    mockEnv.OPENROUTER_MODEL = '';
    expect(await chainModels('smart')).toEqual(['claude-smart', 'hf-test']);
  });

  it('a retired model named in any provider env is never served: its slot is skipped', async () => {
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    mockEnv.HF_MODEL = 'openai/gpt-oss-120b';
    mockEnv.HF_FAST_MODEL = 'qwen/qwen3.8-27b';
    try {
      expect(await chainModels('smart')).toEqual(['test-model', 'claude-smart']);
      expect(await chainModels('fast')).toEqual(['test-fast', 'claude-fast']);
    } finally {
      mockEnv.HF_MODEL = 'hf-test';
      mockEnv.HF_FAST_MODEL = 'hf-fast';
    }
  });

  it('an openrouter slot is labelled OpenRouter and keyed openrouter', () => {
    mockEnv.OPENROUTER_API_KEY = 'or-key';
    mockEnv.AI_SMART_CHAIN = { ...DEFAULT_ORDER, order: ['openrouter'], fromEnv: true };
    expect(streamingModule.nextProvider('smart', [])).toBe('OpenRouter (or-smart)');
  });

  describe('role routing', () => {
    const qualified = { sha: 'abc1234', rolePass: 0.96, historyPass: 1 };
    const flash: ModelPreset = {
      id: 'flash',
      models: { openrouter: 'vendor/flash', claude: 'claude-flash' },
      effort: 'low',
      temperature: 1,
      maxOutputTokens: 8192,
      priceUsdPerMTok: null,
      roles: ['executor'],
      qualification: qualified,
    };
    const entry = (provider: RoleChainEntry['provider'], preset: ModelPreset | null = null) => ({
      provider,
      preset,
    });

    beforeEach(() => {
      mockEnv.CLAUDE_API_TOKEN = 'test-claude';
      mockEnv.OPENROUTER_API_KEY = 'or-key';
    });

    it('legacy mode ignores the role chains and the role a caller passes', async () => {
      mockEnv.AI_ROLE_CHAINS = {
        ...mockEnv.AI_ROLE_CHAINS,
        executor: [entry('openrouter', flash)],
      };
      expect(await chainModels('smart', undefined, 'executor')).toEqual([
        'test-model',
        'claude-smart',
        'hf-test',
      ]);
    });

    it('roles mode runs the role chain in its order: preset routes and bare providers', async () => {
      mockEnv.AI_ROUTING = 'roles';
      mockEnv.AI_ROLE_CHAINS = {
        ...mockEnv.AI_ROLE_CHAINS,
        executor: [entry('openrouter', flash), entry('claude')],
      };
      expect(await chainModels('smart', undefined, 'executor')).toEqual([
        'vendor/flash',
        'claude-smart',
      ]);
      // A round without a role is still the legacy smart chain.
      expect(await chainModels('smart')).toEqual(['test-model', 'claude-smart', 'hf-test']);
    });

    it('sends the preset settings: reasoning_effort and temperature on OpenRouter, ceiling on max_tokens', async () => {
      mockEnv.AI_ROUTING = 'roles';
      mockEnv.AI_ROLE_CHAINS = {
        ...mockEnv.AI_ROLE_CHAINS,
        executor: [entry('openrouter', flash)],
      };
      const requests: OpenAI.ChatCompletionCreateParamsStreaming[] = [];
      await chainModels('smart', undefined, 'executor', requests);
      const request = requests[0] as unknown as Record<string, unknown>;
      expect(request['reasoning_effort']).toBe('low');
      expect(request['temperature']).toBe(1);
      expect(request['max_tokens']).toBe(100);
    });

    it('keeps the Claude request shape for a preset routed over Claude: no temperature, no effort', async () => {
      mockEnv.AI_ROUTING = 'roles';
      mockEnv.AI_ROLE_CHAINS = { ...mockEnv.AI_ROLE_CHAINS, executor: [entry('claude', flash)] };
      const requests: OpenAI.ChatCompletionCreateParamsStreaming[] = [];
      expect(await chainModels('smart', undefined, 'executor', requests)).toEqual(['claude-flash']);
      const request = requests[0] as unknown as Record<string, unknown>;
      expect(request['temperature']).toBeUndefined();
      expect(request['reasoning_effort']).toBeUndefined();
    });

    it('refuses an unqualified preset: it never loads, the bare provider after it still does', async () => {
      mockEnv.AI_ROUTING = 'roles';
      const unqualified = { ...flash, qualification: null };
      mockEnv.AI_ROLE_CHAINS = {
        ...mockEnv.AI_ROLE_CHAINS,
        executor: [entry('openrouter', unqualified), entry('claude')],
      };
      expect(await chainModels('smart', undefined, 'executor')).toEqual(['claude-smart']);
    });

    it('refuses a preset below the gate and one qualified for another role', async () => {
      mockEnv.AI_ROUTING = 'roles';
      mockEnv.AI_ROLE_CHAINS = {
        ...mockEnv.AI_ROLE_CHAINS,
        executor: [
          entry('openrouter', { ...flash, qualification: { ...qualified, historyPass: 0.99 } }),
          entry('claude', flash),
          entry('hf'),
        ],
        repair: [entry('openrouter', flash), entry('hf')],
      };
      // claude:flash is qualified for executor, so it loads; the 99% one does not.
      expect(await chainModels('smart', undefined, 'executor')).toEqual([
        'claude-flash',
        'hf-test',
      ]);
      // flash is not a repair preset: only hf is left.
      expect(await chainModels('smart', undefined, 'repair')).toEqual(['hf-test']);
    });

    it('a role chain with nothing loadable falls back to the legacy chain', async () => {
      mockEnv.AI_ROUTING = 'roles';
      mockEnv.AI_ROLE_CHAINS = {
        ...mockEnv.AI_ROLE_CHAINS,
        executor: [entry('openrouter', { ...flash, qualification: null })],
      };
      expect(await chainModels('smart', undefined, 'executor')).toEqual([
        'test-model',
        'claude-smart',
        'hf-test',
      ]);
      // An unset role chain behaves the same.
      expect(await chainModels('smart', undefined, 'repair')).toEqual([
        'test-model',
        'claude-smart',
        'hf-test',
      ]);
    });

    it('skips a provider without a key and a bare entry whose model is retired', async () => {
      mockEnv.AI_ROUTING = 'roles';
      mockEnv.OPENROUTER_API_KEY = '';
      mockEnv.HF_MODEL = 'openai/gpt-oss-120b';
      mockEnv.AI_ROLE_CHAINS = {
        ...mockEnv.AI_ROLE_CHAINS,
        executor: [entry('openrouter', flash), entry('hf'), entry('claude')],
      };
      try {
        expect(await chainModels('smart', undefined, 'executor')).toEqual(['claude-smart']);
      } finally {
        mockEnv.HF_MODEL = 'hf-test';
      }
    });

    it('a bare planner entry uses the provider fast model; fast and ocr chains never take a role', async () => {
      mockEnv.AI_ROUTING = 'roles';
      mockEnv.AI_ROLE_CHAINS = {
        ...mockEnv.AI_ROLE_CHAINS,
        planner: [entry('claude'), entry('zai')],
      };
      expect(await chainModels('smart', undefined, 'planner')).toEqual([
        'claude-fast',
        'test-fast',
      ]);
      expect(await chainModels('fast', undefined, 'planner')).toEqual([
        'test-fast',
        'claude-fast',
        'hf-fast',
      ]);
      expect(await chainModels('ocr', undefined, 'executor')).toEqual([
        'claude-vision',
        'hf-vision',
      ]);
    });

    it('nextProvider and the excluded list follow the role chain', () => {
      mockEnv.AI_ROUTING = 'roles';
      mockEnv.AI_ROLE_CHAINS = {
        ...mockEnv.AI_ROLE_CHAINS,
        repair: [entry('claude'), entry('hf')],
      };
      expect(streamingModule.nextProvider('smart', [], 'repair')).toBe('Claude (claude-smart)');
      expect(streamingModule.nextProvider('smart', ['Claude (claude-smart)'], 'repair')).toBe(
        'HF (hf-test)',
      );
      expect(streamingModule.nextProvider('smart', [])).toBe('z.ai (test-model)');
    });
  });

  it('nextProvider names the slot the chain would try first without the excluded ones', () => {
    expect(streamingModule.nextProvider('smart', [])).toBe('z.ai (test-model)');
    expect(streamingModule.nextProvider('smart', ['z.ai (test-model)'])).toBe(
      'Claude (claude-smart)',
    );
    expect(
      streamingModule.nextProvider('smart', [
        'z.ai (test-model)',
        'Claude (claude-smart)',
        'HF (hf-test)',
      ]),
    ).toBeNull();
  });

  it('nextProvider follows the breaker order: a demoted z.ai is not next, Claude is', () => {
    recordProviderRateLimit('zai', Date.now(), 60_000);
    expect(streamingModule.nextProvider('smart', [])).toBe('Claude (claude-smart)');
  });
});
