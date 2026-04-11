// Tests for /advice smart streaming — regression coverage for the mid-stream hang bug
// where aiStreamRound was called without an AbortSignal, leaving the user staring at a
// half-written status message indefinitely when a provider stream stalled.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { StreamRoundOptions, StreamRoundResult } from '../../services/ai/streaming';
import type { FinancialSnapshot } from '../../services/analytics/types';
import { mockDatabase } from '../../test-utils/mocks/database';
import { createMockLogger } from '../../test-utils/mocks/logger';

// ── Logger ──────────────────────────────────────────────────────────────
const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Database ────────────────────────────────────────────────────────────
const mockGroups = {
  findById: mock(() => ({
    id: 1,
    telegram_group_id: -1000,
    default_currency: 'EUR',
    custom_prompt: null,
    active_topic_id: null,
  })),
};

const mockAdviceLogs = {
  getRecentTopics: mock(() => [] as string[]),
  create: mock(() => undefined),
};

// formatSnapshotForPrompt (real) touches several repos — return empty
// collections so it can build a prompt string without crashing.
const mockBankAccounts = { findByGroupId: mock(() => []) };
const mockRecurringPatterns = { getActiveByGroupId: mock(() => []) };

const mockDb = mockDatabase({
  groups: mockGroups,
  adviceLogs: mockAdviceLogs,
  bankAccounts: mockBankAccounts,
  recurringPatterns: mockRecurringPatterns,
});

mock.module('../../database', () => ({
  database: mockDb,
  _budgetWriter: () => mockDb['budgets'],
}));

// ── Analytics snapshot (fed to sendSmartAdvice via spendingAnalytics mock) ──
function buildNeutralSnapshot(): FinancialSnapshot {
  return {
    burnRates: [],
    weekTrend: {
      period: 'week',
      current_total: 0,
      previous_total: 0,
      change_percent: 0,
      direction: 'stable',
      category_changes: [],
    },
    monthTrend: {
      period: 'month',
      current_total: 0,
      previous_total: 0,
      change_percent: 0,
      direction: 'stable',
      category_changes: [],
    },
    anomalies: [],
    dayOfWeekPatterns: [],
    velocity: {
      period_1_daily_avg: 0,
      period_2_daily_avg: 0,
      acceleration: 0,
      trend: 'stable',
    },
    budgetUtilization: null,
    streak: {
      current_streak_days: 0,
      streak_type: 'no_spending',
      avg_daily_during_streak: 0,
      overall_daily_average: 0,
    },
    projection: null,
  };
}

mock.module('../../services/analytics/spending-analytics', () => ({
  spendingAnalytics: {
    getFinancialSnapshot: mock(() => buildNeutralSnapshot()),
  },
}));

// formatSnapshotForPrompt / computeOverallSeverity touch repos transitively —
// stub the whole formatters module so the test only exercises the advice flow.
mock.module('../../services/analytics/formatters', () => ({
  formatSnapshotForPrompt: mock(() => '## Snapshot\nneutral'),
  computeOverallSeverity: mock(() => 'good'),
}));

// ── aiStreamRound ───────────────────────────────────────────────────────
const mockAiStreamRound =
  mock<
    (
      opts: StreamRoundOptions,
      callbacks?: import('../../services/ai/streaming').StreamCallbacks,
    ) => Promise<StreamRoundResult>
  >();

mock.module('../../services/ai/streaming', () => ({
  aiStreamRound: mockAiStreamRound,
  stripThinkingTags: (text: string) => text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(),
  isRetryableError: mock(() => false),
  getBackoffDelay: mock(() => 0),
  formatApiError: mock(() => 'mock-error'),
}));

// ── StatusWriter ────────────────────────────────────────────────────────
// Replace StatusWriter with a stub that captures the streamed text and final output.
// The real class is an integration with telegram-sender; here we only care about
// verifying the advice flow wires up the writer and ultimately calls finalize().
const writerCalls = {
  appended: [] as string[],
  finalized: [] as string[],
  closed: 0,
};

class StubStatusWriter {
  constructor(_: { header: string; mode?: 'code' | 'plain' }) {
    void _;
  }
  append(delta: string): void {
    writerCalls.appended.push(delta);
  }
  async finalize(finalText: string): Promise<void> {
    writerCalls.finalized.push(finalText);
  }
  async close(): Promise<void> {
    writerCalls.closed += 1;
  }
}

mock.module('../../services/receipt/status-writer', () => ({
  StatusWriter: StubStatusWriter,
}));

// ── telegram-sender (used on finalize-error fallback) ───────────────────
const mockSendMessage = mock(async () => null);
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: mockSendMessage,
  editMessageText: mock(async () => undefined),
  deleteMessage: mock(async () => undefined),
  withChatContext: async (_chatId: number, _threadId: number | null, fn: () => Promise<unknown>) =>
    fn(),
}));

// Import AFTER all mocks are registered
const { handleAdviceCommand } = await import('./ask');

// ── Test helpers ────────────────────────────────────────────────────────
function successfulStream(chunks: string[] = ['hello advice']): void {
  mockAiStreamRound.mockImplementationOnce(async (_opts, callbacks) => {
    for (const chunk of chunks) {
      callbacks?.onTextDelta?.(chunk);
    }
    const text = chunks.join('');
    return {
      text,
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: text },
      providerUsed: 'mock-smart',
    };
  });
}

function fakeGroup() {
  return {
    id: 1,
    telegram_group_id: -1000,
    default_currency: 'EUR',
    custom_prompt: null,
    active_topic_id: null,
  } as unknown as import('../../database/types').Group;
}

function fakeCtx() {
  // handleAdviceCommand voids ctx — a minimal stub is enough.
  return {} as unknown as import('../types').Ctx['Command'];
}

// ── Tests ───────────────────────────────────────────────────────────────
describe('handleAdviceCommand — stream abort safety', () => {
  beforeEach(() => {
    mockAiStreamRound.mockClear();
    mockSendMessage.mockClear();
    mockAdviceLogs.create.mockClear();
    writerCalls.appended.length = 0;
    writerCalls.finalized.length = 0;
    writerCalls.closed = 0;
  });

  test('passes an AbortSignal to aiStreamRound so hung provider streams cannot run forever', async () => {
    successfulStream(['Финансовый обзор', ' за месяц']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    expect(logMock.error).not.toHaveBeenCalled();
    expect(mockAiStreamRound).toHaveBeenCalledTimes(1);
    const [opts] = mockAiStreamRound.mock.calls[0] as unknown as [StreamRoundOptions];
    expect(opts.signal).toBeDefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // AbortSignal.timeout() returns a signal that has not yet fired
    expect(opts.signal?.aborted).toBe(false);
  });

  test('uses the smart chain for deep-tier analysis', async () => {
    successfulStream(['ok']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    const [opts] = mockAiStreamRound.mock.calls[0] as unknown as [StreamRoundOptions];
    expect(opts.chain).toBe('smart');
    expect(opts.maxTokens).toBe(3000); // deep tier budget
  });

  test('propagates text deltas to the status writer and finalizes the cleaned advice', async () => {
    successfulStream(['Ситуация', ' нормальная']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    expect(writerCalls.appended).toEqual(['Ситуация', ' нормальная']);
    expect(writerCalls.finalized).toHaveLength(1);
    expect(writerCalls.finalized[0]).toContain('Финансовый обзор');
    expect(writerCalls.finalized[0]).toContain('Ситуация нормальная');
  });

  test('closes the status writer when aiStreamRound rejects (aborted / errored stream)', async () => {
    mockAiStreamRound.mockImplementationOnce(async (_opts, callbacks) => {
      // Emit a partial delta, then fail — simulates a stream that starts writing
      // and then dies mid-way (abort, network drop, provider hang timing out).
      callbacks?.onTextDelta?.('Critical situati');
      throw new Error('stream aborted mid-flight');
    });

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    expect(writerCalls.appended).toEqual(['Critical situati']);
    // The inner catch must tear down the writer instead of leaving the orphan
    // message visible to the user.
    expect(writerCalls.closed).toBeGreaterThanOrEqual(1);
    expect(writerCalls.finalized).toHaveLength(0);
    // Outer catch in sendSmartAdvice logs the failure but does not throw.
    expect(logMock.error).toHaveBeenCalled();
  });
});
