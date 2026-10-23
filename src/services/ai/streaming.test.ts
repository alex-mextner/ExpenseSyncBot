// Tests for AI streaming: fallback chain, tool call index resolution, isRetryableError

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ChainOrder } from '../../config/env';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { ModelPreset, Role } from './model-presets';
import type { RoleChainEntry } from './role-routing';

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
const DEFAULT_ORDER = defaultOrder();

const mockEnv = {
  ANTHROPIC_API_KEY: 'test-key',
  AI_BASE_URL: 'https://test.ai/v1',
  AI_MODEL: 'test-model',
  AI_FAST_MODEL: 'test-fast',
  AI_SMART_CHAIN: { ...defaultOrder() },
  AI_FAST_CHAIN: { ...defaultOrder() },
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
  OPENROUTER_API_KEY: '',
  OPENROUTER_BASE_URL: 'https://test.openrouter/api/v1',
  OPENROUTER_MODEL: 'or-smart',
  OPENROUTER_FAST_MODEL: 'or-fast',
  AI_ROUTING: 'legacy' as 'legacy' | 'roles',
  AI_ROLE_CHAINS: { planner: [], executor: [], repair: [] } as Record<Role, RoleChainEntry[]>,
};
mock.module('../../config/env', () => ({ env: mockEnv }));

// Mock clients to avoid real HTTP calls
mock.module('./clients', () => ({
  zaiClient: () => ({}),
  claudeClient: () => ({}),
  hfClient: () => ({}),
  openrouterClient: () => ({}),
}));

// Usage rows are covered in streaming.usage.test.ts; these tests do not touch the database.
mock.module('./usage-recorder', () => ({ recordAiUsage: () => {} }));

import OpenAI from 'openai';
import {
  isProviderDemoted,
  recordProviderRateLimit,
  resetProviderBreaker,
} from './provider-breaker';
import {
  CLAUDE_THINKING_RESERVE_TOKENS,
  chatRequestParams,
  classifyAiError,
  claudeRequestParams,
  getBackoffDelay,
  getRateLimitCooldownMs,
  isRetryableError,
  pickRepresentativeError,
} from './streaming';

describe('claudeRequestParams', () => {
  // Anthropic's OpenAI-compat endpoint ignores reasoning_effort (measured 2026-10-10, #146), so it
  // is never sent; thinking spends the same max_tokens budget as the visible answer, hence the reserve.
  it.each([
    'claude-sonnet-5-5',
    'claude-sonnet-5-5-20261001',
    'claude-opus-5-5',
    'claude-fable-5-1',
    // Legacy and unlisted IDs (#144): a config swap must still get the safe thinking-on shape.
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-unlisted-9-9',
  ])('%s keeps thinking on with a reserve on top of the caller budget', (model) => {
    expect(claudeRequestParams(model, 200)).toEqual({
      max_tokens: 200 + CLAUDE_THINKING_RESERVE_TOKENS,
    });
  });

  it.each([
    'claude-haiku-5-5',
    'claude-haiku-4-5-20251001',
  ])('%s runs with thinking disabled and the caller budget unchanged', (model) => {
    expect(claudeRequestParams(model, 200)).toEqual({
      thinking: { type: 'disabled' },
      max_tokens: 200,
    });
  });
});

describe('chatRequestParams', () => {
  it('builds the Claude shape (no temperature) for anthropic slots', () => {
    expect(chatRequestParams('claude-sonnet-5-5', 256, 0.1, true)).toEqual({
      max_tokens: 256 + CLAUDE_THINKING_RESERVE_TOKENS,
    });
  });

  it('passes max_tokens and temperature through for other providers', () => {
    expect(chatRequestParams('glm-5', 256, 0.1, false)).toEqual({
      max_tokens: 256,
      temperature: 0.1,
    });
  });
});

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

  it('returns false (never throws) for a thrown null/undefined/primitive', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError('boom')).toBe(false);
  });

  it('returns true for a connection-outage aggregate (plain Error, no status/code)', () => {
    // An all-APIConnectionError chain yields a plain aggregate with no status/code, only a joined
    // "Connection error" message — it must still be retryable (matched connection-like by message).
    const aggregate = new Error('All 3 providers in smart chain failed: z.ai: Connection error.');
    expect(isRetryableError(aggregate)).toBe(true);
  });

  it('returns false for a concrete 4xx whose message mentions connection/timeout', () => {
    // A defined status is authoritative — a 400 is a client error and must stay non-retryable even
    // though its message says "connection error" (matches classifyAiError keeping it generic).
    const err = new OpenAI.APIError(
      400,
      { message: 'connection error' },
      'connection error',
      new Headers(),
    );
    expect(isRetryableError(err)).toBe(false);
  });
});

describe('getBackoffDelay', () => {
  it('honors Retry-After on a 429', () => {
    const err = new OpenAI.APIError(
      429,
      { message: 'rate limited' },
      'rate limited',
      new Headers({ 'retry-after': '3' }),
    );
    expect(getBackoffDelay(0, err)).toBe(3000);
  });

  it('exponential backoff for non-429', () => {
    expect(getBackoffDelay(0, new Error('fail'))).toBe(2000);
    expect(getBackoffDelay(1, new Error('fail'))).toBe(6000);
    expect(getBackoffDelay(2, new Error('fail'))).toBe(18000);
    expect(getBackoffDelay(3, new Error('fail'))).toBe(30_000); // capped
  });

  it('uses the 429 backoff for an aggregate plain Error carrying status 429', () => {
    const aggregate = Object.assign(new Error('All 3 providers failed'), { status: 429 });
    expect(getBackoffDelay(0, aggregate)).toBe(5000); // rate-limit path, not the 2000ms exponential
  });
});

describe('getRateLimitCooldownMs', () => {
  it('honors Retry-After without the short retry cap', () => {
    const err = new OpenAI.APIError(
      429,
      { message: 'rate limited' },
      'rate limited',
      new Headers({ 'retry-after': '120' }),
    );
    expect(getRateLimitCooldownMs(err, 1_000)).toBe(120_000);
  });

  it('honors an explicit quota reset timestamp from the provider message', () => {
    const now = Date.parse('2026-09-24T20:00:00Z');
    const err = Object.assign(
      new Error('Weekly quota limit reached; reset at 2026-09-24T21:15:09Z'),
      { status: 429 },
    );
    expect(getRateLimitCooldownMs(err, now)).toBe(4_510_000);
  });

  it('uses a five-minute fallback when no reset hint is available', () => {
    const err = Object.assign(new Error('rate limit'), { status: 429 });
    expect(getRateLimitCooldownMs(err, 1_000)).toBe(300_000);
  });
});

describe('aiStreamRound fallback chain', () => {
  // We need to test the actual chain logic with mocked streaming slots.
  // Import the module after mocks are set up.
  // biome-ignore lint/suspicious/noExplicitAny: test-only type for mocking streaming internals
  let streamingModule: any;

  beforeEach(async () => {
    // The provider breaker is module-global state — reset it so demotions don't leak between tests.
    resetProviderBreaker();
    mockEnv.AI_SMART_CHAIN = defaultOrder();
    mockEnv.AI_FAST_CHAIN = defaultOrder();
    mockEnv.CLAUDE_API_TOKEN = 'test-claude';
    mockEnv.CLAUDE_MODEL = 'claude-smart';
    mockEnv.CLAUDE_FAST_MODEL = 'claude-fast';
    mockEnv.CLAUDE_VISION_MODEL = 'claude-vision';
    mockEnv.OPENROUTER_API_KEY = '';
    mockEnv.OPENROUTER_MODEL = 'or-smart';
    mockEnv.OPENROUTER_FAST_MODEL = 'or-fast';
    mockEnv.AI_ROUTING = 'legacy';
    mockEnv.AI_ROLE_CHAINS = { planner: [], executor: [], repair: [] };
    // Re-import to get fresh module with mocked deps
    streamingModule = await import('./streaming');
  });

  // Every slot fails with a 500 so the chain walks all providers; the recorded models are the chain.
  // The aggregate's provider count must equal the recorded calls, so a slot whose client could not
  // even be built (it never reaches `create`) still shows up as a mismatch.
  async function chainModels(
    chain: 'smart' | 'fast' | 'ocr',
    excludeProviders?: readonly string[],
    role?: Role,
    requests: OpenAI.ChatCompletionCreateParamsStreaming[] = [],
  ): Promise<string[]> {
    const calls: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      calls.push(params.model);
      requests.push(params);
      throw new OpenAI.APIError(500, { message: 'down' }, 'down', new Headers());
    });
    const clientsMod = await import('./clients');
    const spies = (['zaiClient', 'claudeClient', 'hfClient', 'openrouterClient'] as const).map(
      (fn) =>
        spyOn(clientsMod, fn).mockReturnValue({
          chat: { completions: { create } },
        } as unknown as OpenAI),
    );
    let message = '';
    try {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        chain,
        excludeProviders,
        role,
      });
    } catch (err) {
      message = (err as Error).message;
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(message).toStartWith(`All ${calls.length} providers in ${chain} chain failed`);
    return calls;
  }

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
      const result = await streamingModule.aiStreamRound({
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
      await streamingModule.aiStreamRound({
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
        streamingModule.aiStreamRound({
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
      await streamingModule.aiStreamRound({ messages, tools: calculateTool, maxTokens: 100 });
      // tool_choice is only valid next to tools — a provider rejects it alone.
      await streamingModule.aiStreamRound({ messages, toolChoice: 'none', maxTokens: 100 });

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
      expect((await streamingModule.aiStreamRound(options)).text).toBe('from Claude');
      expect((await streamingModule.aiStreamRound(options)).text).toBe('from Claude');
      expect(calls).toEqual([zaiModel, claudeModel, claudeModel]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
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

    const result = await streamingModule.aiStreamRound({
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

    const result = await streamingModule.aiStreamRound({
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
    spyOn(clientsMod, 'claudeClient').mockReturnValue({
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI);

    const result = await streamingModule.aiStreamRound({
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
    spyOn(clientsMod, 'claudeClient').mockReturnValue({
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

    const result = await streamingModule.aiStreamRound({
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

    const result = await streamingModule.aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 50,
      chain: 'smart',
    });

    // First provider (test-model) was tried and failed, second (claude-smart) succeeded
    expect(modelsCalled).toContain('test-model');
    expect(modelsCalled).toContain('claude-smart');
    expect(result.text).toBe('ok');
  });

  it('demotes a provider to the back of the chain after repeated connection failures', async () => {
    const clientsMod = await import('./clients');
    const order: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      order.push(params.model);
      if (params.model === 'test-model') {
        // z.ai unreachable (connection-type failure the breaker counts).
        throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    const round = () =>
      streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });

    // Three rounds where z.ai connection-fails first each time (Claude answers).
    for (let i = 0; i < 3; i++) {
      order.length = 0;
      await round();
      expect(order[0]).toBe('test-model'); // still tried first while it has < 3 failures
    }

    // 4th round: z.ai is now demoted → Claude is tried first, z.ai is not the head of the chain.
    order.length = 0;
    const result = await round();
    expect(order[0]).toBe('claude-smart');
    expect(order).not.toContain('test-model'); // Claude answered, so the demoted z.ai isn't reached
    expect(result.text).toBe('ok');
  });

  it('does not demote a provider for response-level (4xx) failures', async () => {
    const clientsMod = await import('./clients');
    const order: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      order.push(params.model);
      if (params.model === 'test-model') {
        // A 4xx is a response, not a connection failure — the breaker must NOT count it.
        throw new OpenAI.APIError(400, { message: 'bad' }, 'bad', new Headers());
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    const round = () =>
      streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    for (let i = 0; i < 4; i++) {
      order.length = 0;
      await round();
      expect(order[0]).toBe('test-model'); // never demoted for 4xx — always tried first
    }
  });

  // The HF router answers 402 "no remaining credits" (HYP-1667) and stays that way until the
  // owner tops up — like an exhausted quota, the slot must cool down at the back of the chain
  // instead of being retried in its normal position on every request.
  const NO_CREDITS =
    'You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers.';
  const noCredits = () =>
    new OpenAI.APIError(402, { message: NO_CREDITS }, NO_CREDITS, new Headers());

  it('a 402 (no credits) demotes the provider for an hour, so the next round skips past it', async () => {
    const clientsMod = await import('./clients');
    const order: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      order.push(params.model);
      if (params.model === 'test-model') throw noCredits();
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    const round = () =>
      streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });

    await round();
    expect(order).toEqual(['test-model', 'claude-smart']);

    order.length = 0;
    await round();
    expect(order).toEqual(['claude-smart']); // the out-of-credits z.ai is not paid for again
    expect(isProviderDemoted('zai', Date.now() + 59 * 60_000)).toBe(true);
    expect(isProviderDemoted('zai', Date.now() + 61 * 60_000)).toBe(false);
  });

  it('a 402 from the HF fallback slot demotes HF for an hour', async () => {
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'hf-test') throw noCredits();
      throw new OpenAI.APIError(503, { message: 'down' }, 'down', new Headers());
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }

    await expect(
      streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      }),
    ).rejects.toThrow('All 3 providers in smart chain failed');
    expect(isProviderDemoted('hf', Date.now() + 59 * 60_000)).toBe(true);
  });

  it('does not demote a provider for a 4xx whose message mentions "connection"', async () => {
    const clientsMod = await import('./clients');
    const order: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      order.push(params.model);
      if (params.model === 'test-model') {
        // A real response (status 400) whose text mentions "connection" — provider WAS reachable,
        // so the breaker must not count it (status defined → not an unreachable failure).
        throw new OpenAI.APIError(
          400,
          { message: 'connection error' },
          'connection error',
          new Headers(),
        );
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    const round = () =>
      streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    for (let i = 0; i < 4; i++) {
      order.length = 0;
      await round();
      expect(order[0]).toBe('test-model'); // 400 response never demotes — always tried first
    }
  });

  it('does not demote a provider when the connection failure happens mid-stream', async () => {
    // Text already emitted means the connection was fine up to that point — a later drop must NOT
    // count toward the breaker, or a flaky-late provider would wrongly get demoted.
    const clientsMod = await import('./clients');
    const create = mock(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      },
    }));
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create } },
    } as unknown as OpenAI);
    for (let i = 0; i < 4; i++) {
      await expect(
        streamingModule.aiStreamRound(
          { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, chain: 'smart' },
          { onTextDelta: () => {} },
        ),
      ).rejects.toThrow();
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(false);
  });

  it('does not demote a provider that streamed a tool-call before dropping mid-stream', async () => {
    // The provider emitted a tool-call (proof of reachability), then dropped with ECONNRESET — that
    // late drop must NOT count toward the breaker even though no TEXT was emitted.
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        return {
          [Symbol.asyncIterator]: async function* () {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_1', function: { name: 'foo', arguments: '{}' } },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
            throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
          },
        };
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    for (let i = 0; i < 4; i++) {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(false);
  });

  it('does not demote a provider that streamed a nameless tool-call chunk before dropping', async () => {
    // Tool-call id/arguments can arrive before the function name; that chunk is still proof of
    // reachability. A subsequent ECONNRESET must not demote (the breaker reads the error tag, not
    // onToolCallStart which only fires once a name is present).
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        return {
          [Symbol.asyncIterator]: async function* () {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, id: 'call_1', function: { arguments: '{}' } }],
                  },
                  finish_reason: null,
                },
              ],
            };
            throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
          },
        };
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    for (let i = 0; i < 4; i++) {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(false);
  });

  it('an abort does not mutate breaker state (does not reset accrued connection failures)', async () => {
    // An abort (the agent's 60s timeout / caller cancellation) is not evidence about the provider —
    // it must neither demote nor clear accrued connection failures.
    const clientsMod = await import('./clients');
    let round = 0;
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        if (round === 2) {
          const abort = new Error('The operation was aborted');
          abort.name = 'AbortError';
          throw abort; // a real connection failure would be ECONNREFUSED; this is a cancellation
        }
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    // conn(1), conn(2), abort(ignored), conn(3) — the abort must not reset, so the 3rd demotes.
    for (round = 0; round < 4; round++) {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(true);
  });

  it('text-then-drop resets the accrued connection-failure cluster', async () => {
    // A provider that streams text then drops mid-stream proved it was reachable, so its accrued
    // connection-failure cluster must reset — even though the round bails out (cannot fallback).
    const clientsMod = await import('./clients');
    let round = 0;
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        if (round === 2) {
          return {
            [Symbol.asyncIterator]: async function* () {
              yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
              throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
            },
          };
        }
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    // conn(1), conn(2), text-then-drop(RESET), conn(1) — the reset means the 4th round is only count 1.
    for (round = 0; round < 4; round++) {
      const pending = streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
      if (round === 2) {
        await expect(pending).rejects.toThrow(); // text emitted → cannot fallback
      } else {
        await pending;
      }
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(false);
  });

  it('an all-provider connection outage yields a retryable aggregate', async () => {
    // Every provider throws a real OpenAI.APIConnectionError (status undefined, no code). The
    // aggregate is a plain Error, but isRetryableError must still retry the chain-level outage.
    const clientsMod = await import('./clients');
    const create = mock(async () => {
      throw new OpenAI.APIConnectionError({ message: 'Connection error.' });
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    let thrown: unknown;
    try {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    } catch (error) {
      thrown = error;
    }
    expect(isRetryableError(thrown)).toBe(true);
  });

  it('demotes a provider after 3 real APIConnectionError outages', async () => {
    // APIConnectionError has status undefined and no code — it must still count as unreachable (and
    // must NOT be mistaken for an abort, which would skip the breaker).
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        throw new OpenAI.APIConnectionError({ message: 'Connection error.' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    for (let i = 0; i < 3; i++) {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(true);
  });

  it('an APIUserAbortError does not mutate breaker state', async () => {
    // The SDK abort error has status undefined and name "Error" (matched only by its "was aborted"
    // message) — it must be treated as an abort and leave accrued connection failures intact.
    const clientsMod = await import('./clients');
    let round = 0;
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        if (round === 2) throw new OpenAI.APIUserAbortError();
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    // conn(1), conn(2), abort(ignored), conn(3) — the abort must not reset, so the 3rd demotes.
    for (round = 0; round < 4; round++) {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(true);
  });

  it('a mixed transient+4xx chain intentionally retries and reads as provider_down', async () => {
    // Documents the deliberate choice (pickRepresentativeError): a transient signal outranks a
    // co-occurring 4xx, so a chain that is mostly down but has one provider 4xx still retries rather
    // than reading as a (non-retryable) bad request — failing safe toward "try later".
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model')
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      throw new OpenAI.APIError(400, { message: 'bad' }, 'bad', new Headers());
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    let thrown: unknown;
    try {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    } catch (error) {
      thrown = error;
    }
    expect(isRetryableError(thrown)).toBe(true);
    expect(classifyAiError(thrown)?.kind).toBe('provider_down');
  });

  it('a 5xx response does not lift an existing connection-demotion', async () => {
    const clientsMod = await import('./clients');
    const conn = () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    const ok = () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
      },
    });
    let round = 0;
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (round < 3) {
        if (params.model === 'test-model') throw conn(); // z.ai unreachable → accrues toward demotion
        return ok(); // Claude answers
      }
      // Final round: the whole chain fails and the demoted z.ai is reached, returning a 503.
      if (params.model === 'test-model') {
        throw new OpenAI.APIError(503, { message: 'down' }, 'down', new Headers());
      }
      throw conn();
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    const runRound = () =>
      streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    for (round = 0; round < 3; round++) await runRound();
    expect(isProviderDemoted('zai', Date.now())).toBe(true); // demoted after 3 connection failures
    await expect(runRound()).rejects.toThrow(); // round 3: z.ai returns a 503 (reachable)
    // The 503 only reset the connection counter — it did NOT rehabilitate the demoted provider.
    expect(isProviderDemoted('zai', Date.now())).toBe(true);
  });

  it('a reachable empty-response between connection failures resets the breaker streak', async () => {
    // The empty-response fallback throws a plain Error (no status, not connection-like) — it proves
    // the provider was reachable, so it must break the connection streak, not be ignored.
    const clientsMod = await import('./clients');
    let round = 0;
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        if (round === 2) {
          // Reachable but empty → streamingSlot throws the plain "empty response" Error.
          return {
            [Symbol.asyncIterator]: async function* () {
              yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
            },
          };
        }
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    // conn, conn, empty(reset), conn — the empty response resets, so the final conn is only count 1.
    for (round = 0; round < 4; round++) {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(false);
  });

  it('aggregate error prefers a transient (5xx) signal over a co-occurring 4xx (keeps retry)', async () => {
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        throw new OpenAI.APIError(400, { message: 'bad' }, 'bad', new Headers()); // one provider 4xx
      }
      throw new OpenAI.APIError(503, { message: 'down' }, 'down', new Headers()); // the rest 5xx
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    let thrown: unknown;
    try {
      await streamingModule.aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    } catch (error) {
      thrown = error;
    }
    // The transient 503 is carried, NOT the 400 — so the chain reads as provider_down, not a
    // (non-retryable) "bad request", independent of which provider failed last.
    expect((thrown as { status?: number }).status).toBe(503);
    // The aggregate is a plain Error, but isRetryableError reads status structurally → still retried.
    expect(isRetryableError(thrown)).toBe(true);
  });
});

describe('pickRepresentativeError', () => {
  const api = (status: number) => new OpenAI.APIError(status, { message: 'x' }, 'x', new Headers());
  const conn = () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });

  const statusOf = (e: Error | null) => (e as { status?: number } | null)?.status;

  it('surfaces a 429 rate-limit over any smaller co-occurring status', () => {
    expect(statusOf(pickRepresentativeError([api(500), api(400), api(429)], null))).toBe(429);
  });

  it('surfaces 529 overloaded when no 429 is present', () => {
    expect(statusOf(pickRepresentativeError([api(500), api(529), api(400)], null))).toBe(529);
  });

  it('prefers a transient connection failure over a 4xx (keeps the chain retryable)', () => {
    const c = conn();
    expect(pickRepresentativeError([c, api(400)], null)).toBe(c);
  });

  it('prefers a 5xx transient over a co-occurring 4xx', () => {
    const five = api(500);
    expect(pickRepresentativeError([five, api(400)], null)).toBe(five);
  });

  it('surfaces a 4xx only when no transient (5xx/connection) failure occurred', () => {
    expect(statusOf(pickRepresentativeError([api(400), api(403)], null))).toBe(400);
  });

  it('falls back to the provided error when nothing matched (no status, not connection-like)', () => {
    const weird = new Error('totally unexpected');
    const fallback = new Error('the last error');
    expect(pickRepresentativeError([weird], fallback)).toBe(fallback);
  });

  it('always surfaces a transient signal (never the 4xx) regardless of try order', () => {
    const cases: Error[][] = [
      [api(500), api(400), conn()],
      [conn(), api(400), api(500)],
      [api(400), conn(), api(500)],
    ];
    for (const errors of cases) {
      const status = statusOf(pickRepresentativeError(errors, null));
      // A 5xx or a status-less connection error — both classify as retryable provider_down.
      expect(status === undefined || status >= 500).toBe(true);
    }
  });

  // Locks the docstring assumption: every member of the transient tier classifies identically, so
  // which one the breaker's reordering surfaces never changes the user-facing message.
  it('every transient-tier error (5xx / connection) classifies as provider_down', () => {
    expect(classifyAiError(api(500))?.kind).toBe('provider_down');
    expect(classifyAiError(api(503))?.kind).toBe('provider_down');
    expect(classifyAiError(conn())?.kind).toBe('provider_down');
  });

  // The aggregate is a plain Error with status/code COPIED on — classifyAiError must read it
  // structurally (not via `instanceof OpenAI.APIError`), or pickRepresentativeError's copy is moot.
  it('classifies the aggregate plain Error by its copied status', () => {
    const down = Object.assign(new Error('All 3 providers in smart chain failed: …'), {
      status: 503,
    });
    const bad = Object.assign(new Error('All 3 providers in smart chain failed: …'), {
      status: 400,
    });
    expect(classifyAiError(down)?.kind).toBe('provider_down');
    expect(classifyAiError(bad)?.kind).toBe('generic');
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
        'Claude (c): Connection error.; HF (h): Connection error.',
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
        'Claude (c): Request was aborted.; HF (h): Request was aborted.',
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
          'Claude (c): 400 Bad Request; HF (h): 400 Bad Request',
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
          'Claude (c): 400 Bad Request; HF (h): 400 Bad Request',
      ),
      { status: 400 },
    );
    expect(mod.classifyAiError(err)?.kind).toBe('generic');
  });

  it('classifies an aggregated empty-response failure (no status/connection signal) as generic', () => {
    // Every provider returned an empty body → a plain Error with no status, no abort, no connection
    // match. An exhausted chain is still an AI failure, so it must surface the safe generic message
    // (and let the agent page the admin) — NOT fall through to null and silently rethrow.
    const err = new Error(
      'All 3 providers in smart chain failed: z.ai (glm-5.1): Provider z.ai (glm-5.1) ' +
        'returned empty response (no text, no tool calls) — treating as failure; ' +
        'Claude (c): returned empty response; HF (h): returned empty response',
    );
    const c = mod.classifyAiError(err);
    expect(c?.kind).toBe('generic');
    expect(c?.userMessage).toContain('Ошибка AI');
  });

  it('does NOT treat a non-aggregate plain Error as an exhausted-chain failure (stays null)', () => {
    // The exhausted-chain floor is scoped to the aggregate prefix only — a bare message that merely
    // mentions providers must still return null so the agent rethrows an unrelated bug.
    expect(
      mod.classifyAiError(new Error('the provider list in smart chain failed to load')),
    ).toBeNull();
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
