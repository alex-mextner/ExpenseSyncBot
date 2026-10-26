// Tests for what chain building reports when it skips a provider: the log level and text per
// reason, the once-per-process dedup, and the default-order retry for an unusable operator order.
// streaming.chains.test.ts pins which slots a chain ends up with; the logs are pinned here.

import { beforeEach, describe, expect, it, mock } from 'bun:test';
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

const mockEnv = {
  ANTHROPIC_API_KEY: 'test-key',
  AI_MODEL: 'test-model',
  AI_FAST_MODEL: 'test-fast',
  AI_SMART_CHAIN: defaultOrder(),
  AI_FAST_CHAIN: defaultOrder(),
  CLAUDE_API_TOKEN: 'test-claude',
  CLAUDE_MODEL: 'claude-smart',
  CLAUDE_FAST_MODEL: 'claude-fast',
  CLAUDE_VISION_MODEL: 'claude-vision',
  HF_TOKEN: 'test-hf',
  HF_MODEL: 'hf-test',
  HF_FAST_MODEL: 'hf-fast',
  HF_VISION_MODEL: 'hf-vision',
  OPENROUTER_API_KEY: '',
  OPENROUTER_MODEL: 'or-smart',
  OPENROUTER_FAST_MODEL: 'or-fast',
  AI_ROUTING: 'legacy' as 'legacy' | 'roles',
  AI_ROLE_CHAINS: { planner: [], executor: [], repair: [] } as Record<Role, RoleChainEntry[]>,
};
mock.module('../../config/env', () => ({ env: mockEnv }));

mock.module('./clients', () => ({
  zaiClient: () => ({}),
  claudeClient: () => ({}),
  hfClient: () => ({}),
  openrouterClient: () => ({}),
}));
mock.module('./usage-recorder', () => ({ recordAiUsage: () => {} }));

// The skip markers live in module state and the logger is bound at load: import after the mocks.
const { nextProvider } = await import('./streaming');

const RETIRED_MODEL = 'openai/gpt-oss-120b';
const RETIRED_FAST_MODEL = 'qwen/qwen3.8-27b';

/** Every logger call at `level` whose message contains `fragment`, as [detail, message]. */
function logged(level: 'debug' | 'warn' | 'error', fragment: string): [unknown, unknown][] {
  return logMock[level].mock.calls
    .filter((call) => String(call[1]).includes(fragment))
    .map((call) => [call[0], call[1]]);
}

beforeEach(() => {
  for (const level of ['debug', 'warn', 'error'] as const) logMock[level].mockClear();
  mockEnv.AI_SMART_CHAIN = defaultOrder();
  mockEnv.AI_FAST_CHAIN = defaultOrder();
  mockEnv.CLAUDE_API_TOKEN = 'test-claude';
  mockEnv.HF_TOKEN = 'test-hf';
  mockEnv.HF_MODEL = 'hf-test';
  mockEnv.HF_FAST_MODEL = 'hf-fast';
  mockEnv.OPENROUTER_API_KEY = '';
  mockEnv.AI_ROUTING = 'legacy';
  mockEnv.AI_ROLE_CHAINS = { planner: [], executor: [], repair: [] };
});

describe('text chain provider skips', () => {
  it('warns once when a provider named in the operator order has no key', () => {
    mockEnv.AI_SMART_CHAIN = { ...defaultOrder(), order: ['openrouter', 'hf'], fromEnv: true };

    expect(nextProvider('smart', [])).toBe('HF (hf-test)');
    expect(nextProvider('smart', [])).toBe('HF (hf-test)');

    expect(logged('warn', 'named in the chain order')).toEqual([
      [
        { chain: 'smart', provider: 'openrouter', hasModel: true, hasKey: false },
        '[AI_STREAM] Provider named in the chain order is not configured — skipping it',
      ],
    ]);
  });

  it('logs an unconfigured provider of the default order at debug level, once', () => {
    mockEnv.CLAUDE_API_TOKEN = '';

    expect(nextProvider('smart', [])).toBe('z.ai (test-model)');
    expect(nextProvider('smart', ['z.ai (test-model)'])).toBe('HF (hf-test)');
    nextProvider('smart', []);

    expect(logged('debug', 'default chain order')).toEqual([
      [
        { chain: 'smart', provider: 'claude', hasModel: true, hasKey: false },
        '[AI_STREAM] Provider in the default chain order is not configured — skipping it',
      ],
    ]);
    expect(logged('warn', 'not configured')).toEqual([]);
  });

  it('skips a retired model with one warning, even when its key is missing too', () => {
    mockEnv.HF_MODEL = RETIRED_MODEL;
    mockEnv.HF_FAST_MODEL = RETIRED_FAST_MODEL;
    mockEnv.HF_TOKEN = '';

    nextProvider('smart', []);
    nextProvider('smart', []);
    nextProvider('fast', []);

    expect(logged('warn', 'excluded list')).toEqual([
      [
        { chain: 'smart', provider: 'hf', model: RETIRED_MODEL },
        '[AI_STREAM] Model is on the excluded list — skipping it',
      ],
      [
        { chain: 'fast', provider: 'hf', model: RETIRED_FAST_MODEL },
        '[AI_STREAM] Model is on the excluded list — skipping it',
      ],
    ]);
    expect(logged('warn', 'not configured')).toEqual([]);
  });

  it('an operator order naming nothing usable logs one error and runs the default order', () => {
    mockEnv.CLAUDE_API_TOKEN = '';
    mockEnv.AI_FAST_CHAIN = { ...defaultOrder(), order: ['claude'], fromEnv: true };

    expect(nextProvider('fast', [])).toBe('z.ai (test-fast)');
    expect(nextProvider('fast', [])).toBe('z.ai (test-fast)');

    expect(logged('error', 'named nothing')).toEqual([
      [
        { chain: 'fast', order: ['claude'] },
        '[AI_STREAM] Configured provider order named nothing that is configured — using the default order',
      ],
    ]);
  });

  it('an unconfigured default order is returned as is, with no fallback error', () => {
    mockEnv.CLAUDE_API_TOKEN = '';
    mockEnv.HF_TOKEN = '';
    mockEnv.AI_SMART_CHAIN = { ...defaultOrder(), order: ['claude'], fromEnv: false };

    expect(nextProvider('smart', [])).toBeNull();
    expect(logged('error', 'named nothing')).toEqual([]);
  });
});

describe('role chain entry skips', () => {
  const flash: ModelPreset = {
    id: 'flash',
    models: { openrouter: 'vendor/flash', claude: 'claude-flash' },
    effort: 'low',
    temperature: 1,
    maxOutputTokens: 8192,
    priceUsdPerMTok: null,
    roles: ['executor'],
    qualification: { sha: 'abc1234', rolePass: 0.96, historyPass: 1 },
  };
  const entry = (provider: RoleChainEntry['provider'], preset: ModelPreset | null = null) => ({
    provider,
    preset,
  });

  it('logs each unusable entry once with the reason, then the fallback to the legacy chain', () => {
    mockEnv.AI_ROUTING = 'roles';
    mockEnv.HF_MODEL = RETIRED_MODEL;
    mockEnv.AI_ROLE_CHAINS = {
      planner: [],
      repair: [],
      executor: [
        entry('openrouter', flash),
        entry('hf'),
        entry('claude', { ...flash, qualification: null }),
      ],
    };

    expect(nextProvider('smart', [], 'executor')).toBe('z.ai (test-model)');
    expect(nextProvider('smart', [], 'executor')).toBe('z.ai (test-model)');

    expect(logged('error', 'Role chain')).toEqual([
      [
        { role: 'executor', provider: 'openrouter', entry: 'openrouter:flash' },
        '[AI_STREAM] Role chain entry skipped: no key or model configured',
      ],
      [
        { role: 'executor', provider: 'hf', entry: 'hf' },
        '[AI_STREAM] Role chain entry skipped: model is on the excluded list',
      ],
      [
        { role: 'executor', provider: 'claude', entry: 'claude:flash' },
        '[AI_STREAM] Role chain entry skipped: preset is not qualified for executor',
      ],
      [
        { role: 'executor' },
        '[AI_STREAM] Role chain has nothing loadable — using the legacy chain',
      ],
    ]);
  });

  it('a role chain that loads something logs nothing', () => {
    mockEnv.AI_ROUTING = 'roles';
    mockEnv.AI_ROLE_CHAINS = { planner: [entry('claude'), entry('hf')], executor: [], repair: [] };

    expect(nextProvider('smart', [], 'planner')).toBe('Claude (claude-fast)');
    expect(logged('error', 'Role chain')).toEqual([]);
  });
});
