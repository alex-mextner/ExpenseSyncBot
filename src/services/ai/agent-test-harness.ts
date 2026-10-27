/**
 * Shared fixtures of the ExpenseBotAgent test files (agent*.test.ts): the module mocks, result
 * builders and trajectory queries. The one agent test file outgrew the 1200-line limit, so the
 * suites were split by area; the mocks must be registered before agent.ts is imported, which is
 * why they live here, ahead of the dynamic import every test file reads the agent from.
 */

import { mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Role } from './model-presets';
import type { ChainName, StreamRoundResult } from './streaming';
import type { AgentContext } from './types';

export const logMock = createMockLogger();

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

export const mockAiStreamRound =
  mock<
    (
      opts: import('./streaming').StreamRoundOptions,
      callbacks: import('./streaming').StreamCallbacks,
    ) => Promise<StreamRoundResult>
  >();

export const mockIsRetryableError = mock<(error: unknown) => boolean>();
export const mockGetBackoffDelay = mock<(attempt: number, error: unknown) => number>();
export const mockClassifyAiError =
  mock<(error: unknown) => import('./streaming').AiErrorClassification | null>();
export const mockNextProvider =
  mock<(chain: ChainName, exclude: readonly string[], role?: Role) => string | null>();

mock.module('./streaming', () => ({
  aiStreamRound: mockAiStreamRound,
  isRetryableError: mockIsRetryableError,
  getBackoffDelay: mockGetBackoffDelay,
  classifyAiError: mockClassifyAiError,
  nextProvider: mockNextProvider,
}));

export const mockValidateResponse = mock<
  (input: {
    userMessage: string;
    toolCalls: string[];
    response: string;
  }) => Promise<{ approved: true } | { approved: false; reason: string }>
>(async () => ({ approved: true }));
mock.module('./response-validator', () => ({
  validateResponse: mockValidateResponse,
}));

export const mockReportAiFailureToAdmin = mock<(input: unknown) => Promise<void>>(() =>
  Promise.resolve(),
);
mock.module('./error-reporter', () => ({
  reportAiFailureToAdmin: mockReportAiFailureToAdmin,
}));

export const mockExecuteTool = mock<
  (name: string, input: unknown, ctx: unknown) => Promise<unknown>
>(async () => ({ success: true, output: 'ok', data: { total: 100 }, summary: 'done' }));
mock.module('./tool-executor', () => ({
  executeTool: mockExecuteTool,
}));

// Loaded after the mocks above: a static import is hoisted and would create the agent's
// logger from the real module, so log assertions would see nothing.
export const { aiDebugLogger, ExpenseBotAgent } = await import('./agent');
export const { TOOL_DEFINITIONS } = await import('./tools');
export type ExpenseBotAgent = InstanceType<typeof ExpenseBotAgent>;
export const { database } = await import('../../database');
export const { env } = await import('../../config/env');

// Every run writes an agent_trajectories row, whose group_id references groups(id).
database.exec(
  `INSERT OR IGNORE INTO groups (id, telegram_group_id, default_currency, enabled_currencies) VALUES (1, 123, 'EUR', '["EUR"]')`,
);

// Minimal AgentContext with all required fields
export function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    chatId: 123,
    groupId: 1,
    userId: 10,
    telegramUserId: 99,
    userName: 'testuser',
    userFullName: 'Test User',
    customPrompt: null,
    telegramGroupId: 123,
    ...overrides,
  };
}

/** The smart chain as the mocks see it: a round answers from the first provider it did not exclude. */
export const CHAIN = ['Groq (gpt-oss-120b)', 'z.ai (glm-5.1)', 'Claude (sonnet)', 'HF (qwen)'];
export const firstAvailable = (exclude: readonly string[] = []) =>
  CHAIN.find((provider) => !exclude.includes(provider)) ?? null;

/** Build a StreamRoundResult for a simple text response */
export function makeTextResult(text: string): StreamRoundResult {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: text },
    providerUsed: 'mock',
  };
}

/** Build a StreamRoundResult that requests a single tool call (no text yet) */
export function makeToolCallResult(toolName: string): StreamRoundResult {
  return {
    text: '',
    toolCalls: [{ id: 'call_1', name: toolName, arguments: '{}' }],
    finishReason: 'tool_calls',
    assistantMessage: {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: toolName, arguments: '{}' } },
      ],
    },
    providerUsed: 'mock',
  };
}

/**
 * Mock aiStreamRound to return a text response, also calling onTextDelta for each chunk.
 * Uses mockImplementationOnce.
 */
export function mockStreamReturn(chunks: string[] = ['ok']) {
  const text = chunks.join('');
  mockAiStreamRound.mockImplementationOnce(async (_opts, callbacks) => {
    for (const chunk of chunks) {
      callbacks.onTextDelta?.(chunk);
    }
    return makeTextResult(text);
  });
}

/** Queue a single tool-calling round (no text), so runAgentLoop executes a tool then loops. */
export function mockToolCallRound(name: string, args = '{}') {
  mockAiStreamRound.mockImplementationOnce(async (_opts, callbacks) => {
    callbacks.onToolCallStart?.(name);
    return {
      text: '',
      toolCalls: [{ id: 'call_1', name, arguments: args }],
      finishReason: 'tool_calls',
      assistantMessage: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }],
      },
      providerUsed: 'mock',
    } satisfies StreamRoundResult;
  });
}

/** Queue one round that calls several tools at once, as `[name, arguments]` pairs in order. */
export function mockToolCallsRound(calls: ReadonlyArray<readonly [string, string]>) {
  mockAiStreamRound.mockImplementationOnce(async (_opts, callbacks) => {
    const toolCalls = calls.map(([name, args], index) => ({
      id: `call_${index + 1}`,
      name,
      arguments: args,
    }));
    for (const call of toolCalls) callbacks.onToolCallStart?.(call.name);
    return {
      text: '',
      toolCalls,
      finishReason: 'tool_calls',
      assistantMessage: {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      },
      providerUsed: 'mock',
    } satisfies StreamRoundResult;
  });
}

/** Extract the LAST call's options from mockAiStreamRound (most recent invocation) */
export function getLastCallOpts(): import('./streaming').StreamRoundOptions {
  const calls = mockAiStreamRound.mock.calls;
  const call = calls.at(-1);
  if (!call) throw new Error('Expected mockAiStreamRound to be called');
  return call[0] as import('./streaming').StreamRoundOptions;
}

/** Text of every system message of a request, in order. */
export function systemText(opts: import('./streaming').StreamRoundOptions): string {
  return opts.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content as string)
    .join('\n\n');
}

// Minimal bot stub with tracked calls
export function makeMockBot() {
  return {
    api: {
      sendMessage: mock(() =>
        Promise.resolve({ message_id: 1, chat: { id: 1 }, date: 0, text: '' }),
      ),
      editMessageText: mock(() =>
        Promise.resolve({ message_id: 1, chat: { id: 1 }, date: 0, text: '' }),
      ),
      sendChatAction: mock(() => Promise.resolve(true)),
      deleteMessage: mock(() => Promise.resolve(true)),
    },
  };
}

/**
 * Per-test reset shared by every agent test file: clears call counts and restores the default
 * mock behavior (answers validate, errors are not retryable, the chain is the plain smart chain).
 */
export function resetAgentMocks() {
  // Reset mock call counts between tests
  mockAiStreamRound.mockClear();
  mockIsRetryableError.mockClear();
  mockGetBackoffDelay.mockClear();
  mockClassifyAiError.mockClear();
  mockReportAiFailureToAdmin.mockClear();
  // mockReset (not mockClear) so any queued one-shot impl can't leak into the next test.
  mockValidateResponse.mockReset();
  mockValidateResponse.mockResolvedValue({ approved: true });
  mockExecuteTool.mockReset();
  mockExecuteTool.mockResolvedValue({
    success: true,
    output: 'ok',
    data: { total: 100 },
    summary: 'done',
  });

  // Default: errors are not retryable (unless overridden per test)
  mockIsRetryableError.mockReturnValue(false);
  mockGetBackoffDelay.mockReturnValue(0);
  // Default: classify as a generic recognized AI error (wrapped + sent to user).
  mockClassifyAiError.mockReturnValue({
    kind: 'generic',
    userMessage: '\u274c Ошибка AI. Попробуйте позже.',
  });
  mockNextProvider.mockReset();
  mockNextProvider.mockImplementation((_chain, exclude) => firstAvailable(exclude));
  database.exec('DELETE FROM agent_trajectories');
}

/**
 * Every tool round asks for one more distinct conversion (the 2026-10-12 pattern); the provider
 * that answers is the first one of CHAIN the round did not exclude, like the real chain.
 * Returns, per call, the history's last message and tool-result count as that call saw them
 * (the agent keeps appending to the same messages array).
 */
export function mockOneConversionPerRound(finalText: string) {
  const seen: Array<{ lastMessage: string; toolResults: number }> = [];
  let n = 0;
  mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
    seen.push({
      lastMessage: JSON.stringify(opts.messages.at(-1)),
      toolResults: opts.messages.filter((m) => m.role === 'tool').length,
    });
    const provider = firstAvailable(opts.excludeProviders) ?? 'none';
    if (opts.toolChoice === 'none') {
      callbacks.onTextDelta?.(finalText);
      return { ...makeTextResult(finalText), providerUsed: provider };
    }
    n++;
    const args = JSON.stringify({ expression: `${n} RSD`, target_currency: 'EUR' });
    return {
      ...makeToolCallResult('calculate'),
      toolCalls: [{ id: `c${n}`, name: 'calculate', arguments: args }],
      providerUsed: provider,
    };
  });
  mockExecuteTool.mockImplementation(async (_name, input) => ({
    success: true,
    output: `= ${JSON.stringify(input)}`,
  }));
  return seen;
}

export interface TrajectoryRow {
  id: number;
  outcome: string;
  error_kind: string | null;
  is_mention: number;
  tool_rounds: number;
  tool_calls: number;
  nudges: number;
  handoffs: number;
  providers: string;
  answer_provider: string | null;
  finalize_reason: string | null;
  follow_up_after_ms: number | null;
}
export interface TrajectoryRoundRow {
  round: number;
  provider: string;
  calls: string;
  decision: string;
  reason: string | null;
}
export const trajectories = () =>
  database.queryAll<TrajectoryRow>('SELECT * FROM agent_trajectories ORDER BY id');
export const trajectoryRounds = (id: number) =>
  database.queryAll<TrajectoryRoundRow>(
    'SELECT round, provider, calls, decision, reason FROM agent_trajectory_rounds WHERE trajectory_id = ? ORDER BY round',
    id,
  );

/** Mocks the stall-guard describes reset on top of resetAgentMocks. */
export function resetStallGuardMocks() {
  mockAiStreamRound.mockReset();
  logMock.warn.mockClear();
  logMock.error.mockClear();
}
