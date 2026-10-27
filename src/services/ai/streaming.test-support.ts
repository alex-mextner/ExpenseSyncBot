/**
 * Shared fixtures of the streaming*.test.ts files: the module mocks, the mutable env, and the
 * `chainModels` probe that reads a chain's slots off the requests it sends. The one streaming test
 * file outgrew the 1200-line limit, so the suites were split by area. The mocks must be registered
 * before streaming.ts loads (it binds its logger and clients then), which is why they live here,
 * ahead of the dynamic imports every test file reads the module under test from.
 */

import { expect, mock, spyOn } from 'bun:test';
import OpenAI from 'openai';
import type { ChainOrder } from '../../config/env';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Role } from './model-presets';
import type { RoleChainEntry } from './role-routing';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from './streaming';

const logMock = createMockLogger();

mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));
export const defaultOrder = (): ChainOrder => ({
  order: ['zai', 'claude', 'hf'],
  fromEnv: false,
  fallback: ['zai', 'claude', 'hf'],
});
export const DEFAULT_ORDER = defaultOrder();

export const mockEnv = {
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

// Dynamic, not static: streaming.ts binds its logger and env when it loads, so it must load after the mocks above.
export const streamingModule = await import('./streaming');
export const { isProviderDemoted, recordProviderRateLimit, resetProviderBreaker } = await import(
  './provider-breaker'
);

/** aiStreamRound for tests that do not care what the round is for: the purpose is filled in. */
export function aiStreamRound(
  options: Omit<StreamRoundOptions, 'purpose'>,
  callbacks?: StreamCallbacks,
): Promise<StreamRoundResult> {
  return streamingModule.aiStreamRound({ ...options, purpose: 'probe' }, callbacks);
}

/** Env and breaker state every fallback-chain test starts from. */
export function resetFallbackEnv(): void {
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
}

// Every slot fails with a 500 so the chain walks all providers; the recorded models are the chain.
// The aggregate's provider count must equal the recorded calls, so a slot whose client could not
// even be built (it never reaches `create`) still shows up as a mismatch.
export async function chainModels(
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
  const spies = (['zaiClient', 'claudeClient', 'hfClient', 'openrouterClient'] as const).map((fn) =>
    spyOn(clientsMod, fn).mockReturnValue({
      chat: { completions: { create } },
    } as unknown as OpenAI),
  );
  let message = '';
  try {
    await aiStreamRound({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      chain,
      ...(excludeProviders ? { excludeProviders } : {}),
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
