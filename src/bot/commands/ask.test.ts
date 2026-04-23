// Tests for /advice smart streaming — regression coverage for the mid-stream hang bug
// where aiStreamRound was called without an AbortSignal, leaving the user staring at a
// half-written status message indefinitely when a provider stream stalled.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { StreamRoundOptions, StreamRoundResult } from '../../services/ai/streaming';
import { buildNeutralSnapshot } from '../../test-utils/fixtures';
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
  findById: mock<(_id: number) => import('../../database/types').Group | null>(
    () =>
      ({
        id: 1,
        telegram_group_id: -1000,
        default_currency: 'EUR',
        custom_prompt: null,
        active_topic_id: null,
      }) as unknown as import('../../database/types').Group,
  ),
};

const mockAdviceLogs = {
  getRecentTopics: mock(() => [] as string[]),
  create: mock((_data: Record<string, unknown>) => undefined),
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
  finalizedErrors: [] as string[],
  closed: 0,
};

class StubStatusWriter {
  append(delta: string): void {
    writerCalls.appended.push(delta);
  }
  async finalize(finalText: string): Promise<void> {
    writerCalls.finalized.push(finalText);
  }
  async finalizeError(errorSuffix: string): Promise<void> {
    writerCalls.finalizedErrors.push(errorSuffix);
  }
  async close(): Promise<void> {
    writerCalls.closed += 1;
  }
}

mock.module('../../services/receipt/status-writer', () => ({
  StatusWriter: StubStatusWriter,
}));

// Advice validator — always approve so these tests focus on streaming safety, not validation.
mock.module('../../services/ai/advice-validator', () => ({
  validateAdvice: mock(async () => ({ approved: true })),
}));

// Advice triggers — mockable per test. checkSmartTriggers is imported statically
// by ask.ts, so we must mock the module BEFORE dynamic-import below.
const checkSmartTriggersMock = mock<
  (
    groupId: number,
    snapshot: unknown,
  ) => import('../../services/analytics/types').TriggerResult | null
>(() => null);
const recordAdviceSentMock = mock<(groupId: number, tier: string) => void>(() => {});
mock.module('../../services/analytics/advice-triggers', () => ({
  checkSmartTriggers: checkSmartTriggersMock,
  recordAdviceSent: recordAdviceSentMock,
  checkDailyAdvice: mock(() => null),
  checkWeeklyAdvice: mock(() => null),
}));

// ── telegram-sender (used on finalize-error fallback) ───────────────────
const mockSendMessage = mock(async () => null);
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: mockSendMessage,
  editMessageText: mock(async () => undefined),
  deleteMessage: mock(async () => undefined),
  sendChatAction: mock(async () => undefined),
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
    writerCalls.finalizedErrors.length = 0;
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

  test('uses the smart chain and deep-tier budget + temperature from TIER_CONFIGS', async () => {
    successfulStream(['ok']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    const [opts] = mockAiStreamRound.mock.calls[0] as unknown as [StreamRoundOptions];
    expect(opts.chain).toBe('smart');
    expect(opts.maxTokens).toBe(3000); // deep tier budget
    // Deep tier uses a higher temperature (0.6) for more exploratory analysis —
    // previously this was silently dropped and defaulted to 0.3 in streaming.ts.
    expect(opts.temperature).toBe(0.6);
  });

  test('propagates text deltas to the status writer and finalizes the cleaned advice', async () => {
    successfulStream(['Ситуация', ' нормальная']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    expect(writerCalls.appended).toEqual(['Ситуация', ' нормальная']);
    expect(writerCalls.finalized).toHaveLength(1);
    expect(writerCalls.finalized[0]).toContain('Финансовый обзор');
    expect(writerCalls.finalized[0]).toContain('Ситуация нормальная');
  });

  test('retries once on failure and succeeds on second attempt', async () => {
    // First attempt fails
    mockAiStreamRound.mockImplementationOnce(async () => {
      throw new Error('provider timeout');
    });
    // Second attempt succeeds
    successfulStream(['Всё хорошо']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    expect(mockAiStreamRound).toHaveBeenCalledTimes(2);
    // First writer was closed (message deleted), second was finalized with the result
    expect(writerCalls.closed).toBe(1);
    expect(writerCalls.finalized).toHaveLength(1);
    expect(writerCalls.finalized[0]).toContain('Всё хорошо');
    expect(writerCalls.finalizedErrors).toHaveLength(0);
    expect(logMock.warn).toHaveBeenCalled();
  });

  test('shows error after both attempts fail', async () => {
    // Both attempts fail
    mockAiStreamRound.mockImplementationOnce(async (_opts, callbacks) => {
      callbacks?.onTextDelta?.('Critical situati');
      throw new Error('stream aborted mid-flight');
    });
    mockAiStreamRound.mockImplementationOnce(async () => {
      throw new Error('second attempt also failed');
    });

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    expect(mockAiStreamRound).toHaveBeenCalledTimes(2);
    // First writer was closed (deleted), second writer shows error
    expect(writerCalls.closed).toBe(1);
    expect(writerCalls.finalized).toHaveLength(0);
    expect(writerCalls.finalizedErrors).toHaveLength(1);
    expect(writerCalls.finalizedErrors[0]).toContain('Генерация прервана');
    expect(logMock.error).toHaveBeenCalled();
  });
});

// Load the validator module handle so we can swap the stub per-test.
const validatorModule = await import('../../services/ai/advice-validator');

describe('handleAdviceCommand — validation and logging', () => {
  beforeEach(() => {
    mockAiStreamRound.mockReset();
    mockSendMessage.mockClear();
    mockAdviceLogs.create.mockClear();
    writerCalls.appended.length = 0;
    writerCalls.finalized.length = 0;
    writerCalls.finalizedErrors.length = 0;
    writerCalls.closed = 0;
    logMock.error.mockReset();
    logMock.warn.mockReset();
    logMock.info.mockReset();
    // Default: validator approves
    (validatorModule.validateAdvice as ReturnType<typeof mock>).mockImplementation(async () => ({
      approved: true,
    }));
  });

  test('records advice to adviceLogs on success', async () => {
    successfulStream(['Совет: не трать больше']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    expect(mockAdviceLogs.create).toHaveBeenCalledTimes(1);
    const logArg = mockAdviceLogs.create.mock.calls[0]?.[0] as {
      group_id: number;
      tier: string;
      advice_text: string;
    };
    expect(logArg.group_id).toBe(1);
    expect(logArg.tier).toBe('deep');
    expect(logArg.advice_text).toContain('Совет');
  });

  test('does NOT record advice when validator rejects', async () => {
    successfulStream(['hallucinated text']);
    (validatorModule.validateAdvice as ReturnType<typeof mock>).mockImplementation(async () => ({
      approved: false,
      reason: 'generic filler',
    }));

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    expect(mockAdviceLogs.create).not.toHaveBeenCalled();
    // Writer is closed without finalize (streamed placeholder is deleted)
    expect(writerCalls.finalized).toHaveLength(0);
    expect(writerCalls.closed).toBeGreaterThanOrEqual(1);
    expect(logMock.warn).toHaveBeenCalled();
  });

  test('empty advice text (<10 chars after sanitize) short-circuits', async () => {
    successfulStream(['', '']); // empty stream

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    // No finalize, no advice log entry
    expect(writerCalls.finalized).toHaveLength(0);
    expect(mockAdviceLogs.create).not.toHaveBeenCalled();
  });

  test('strips <think>...</think> blocks from the final message', async () => {
    successfulStream(['<think>internal reasoning here</think>\n\nFinal advice: ', 'do better']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    expect(writerCalls.finalized).toHaveLength(1);
    const final = writerCalls.finalized[0] ?? '';
    expect(final).not.toContain('internal reasoning here');
    expect(final).not.toContain('<think>');
    expect(final).toContain('Final advice');
  });

  test('deep tier header contains "Финансовый обзор"', async () => {
    // Advice body must be ≥10 chars or ask.ts short-circuits before finalize
    successfulStream(['Вот финансовая сводка по группе.']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    const final = writerCalls.finalized[0] ?? '';
    expect(final).toContain('Финансовый обзор');
    expect(final).toContain('📊');
  });

  test('custom_prompt appended to base prompt', async () => {
    successfulStream(['ok']);
    const groupWithPrompt = {
      id: 1,
      telegram_group_id: -1000,
      default_currency: 'EUR',
      custom_prompt: 'Speak like a pirate',
      active_topic_id: null,
    } as unknown as import('../../database/types').Group;
    mockGroups.findById.mockReturnValueOnce(groupWithPrompt);

    await handleAdviceCommand(fakeCtx(), groupWithPrompt);

    const [opts] = mockAiStreamRound.mock.calls[0] as unknown as [StreamRoundOptions];
    const userMsg = opts.messages[0]?.content;
    const content = typeof userMsg === 'string' ? userMsg : '';
    expect(content).toContain('КАСТОМНЫЕ ИНСТРУКЦИИ ГРУППЫ');
    expect(content).toContain('Speak like a pirate');
  });

  test('no custom_prompt block when group.custom_prompt is null', async () => {
    successfulStream(['ok']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    const [opts] = mockAiStreamRound.mock.calls[0] as unknown as [StreamRoundOptions];
    const content = typeof opts.messages[0]?.content === 'string' ? opts.messages[0].content : '';
    expect(content).not.toContain('КАСТОМНЫЕ ИНСТРУКЦИИ ГРУППЫ');
  });

  // (Removed placeholder test: "falls back to plain sendMessage when finalize throws" —
  // couldn't be implemented cleanly because ask.ts captures StatusWriter at module-init,
  // so a per-test re-mock of './status-writer' has no effect. The fallback branch is
  // reachable in practice when StubStatusWriter.finalize rejects — left for a future
  // refactor that injects StatusWriter as a dependency.)

  test('snapshot fetched exactly once per command call', async () => {
    successfulStream(['ok']);
    const spa = await import('../../services/analytics/spending-analytics');
    (spa.spendingAnalytics.getFinancialSnapshot as ReturnType<typeof mock>).mockClear();

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    expect(spa.spendingAnalytics.getFinancialSnapshot).toHaveBeenCalledTimes(1);
    expect(spa.spendingAnalytics.getFinancialSnapshot).toHaveBeenCalledWith(1);
  });

  test('logs "[ADVICE] Generating deep advice" on start', async () => {
    successfulStream(['ok']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    const infoCalls = logMock.info.mock.calls.map((c) => JSON.stringify(c));
    expect(infoCalls.some((c) => c.includes('Generating deep advice'))).toBe(true);
  });

  test('logs "Sent deep advice" on success', async () => {
    successfulStream(['Вот финансовая сводка по группе с деталями.']);

    await handleAdviceCommand(fakeCtx(), fakeGroup());

    const infoCalls = logMock.info.mock.calls.map((c) => JSON.stringify(c));
    expect(infoCalls.some((c) => c.includes('Sent deep advice'))).toBe(true);
  });
});

// ── maybeSmartAdvice ────────────────────────────────────────────────────

const { maybeSmartAdvice } = await import('./ask');

describe('maybeSmartAdvice', () => {
  beforeEach(() => {
    mockAiStreamRound.mockClear();
    mockAdviceLogs.create.mockClear();
    recordAdviceSentMock.mockClear();
    writerCalls.appended.length = 0;
    writerCalls.finalized.length = 0;
    writerCalls.finalizedErrors.length = 0;
    writerCalls.closed = 0;
    logMock.error.mockReset();
    logMock.warn.mockReset();
    logMock.info.mockReset();
  });

  test('does nothing when checkSmartTriggers returns null', async () => {
    const spy = spyOnChecker(null);
    await maybeSmartAdvice(1);

    expect(mockAiStreamRound).not.toHaveBeenCalled();
    expect(mockAdviceLogs.create).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('logs suppressed advice and persists cooldown when trigger fires', async () => {
    const trigger = {
      type: 'budget_threshold' as const,
      tier: 'quick' as const,
      topic: 'budget_threshold:Food:warning',
      data: { category: 'Food' },
    };
    const spy = spyOnChecker(trigger);

    await maybeSmartAdvice(1);

    // Auto-advice must NOT hit the AI provider or Telegram.
    expect(mockAiStreamRound).not.toHaveBeenCalled();

    // Trigger, severity, and context snapshot are logged for offline review.
    const suppressedLog = logMock.info.mock.calls.find((c) =>
      JSON.stringify(c).includes('Auto-advice suppressed'),
    );
    expect(suppressedLog).toBeDefined();
    const [logPayload] = suppressedLog as [Record<string, unknown>, string];
    expect(logPayload).toMatchObject({
      groupId: 1,
      trigger: { type: 'budget_threshold', tier: 'quick', topic: trigger.topic },
    });
    expect(typeof logPayload['context']).toBe('string');

    // Cooldown is recorded so the same topic is not re-logged on every call.
    expect(recordAdviceSentMock).toHaveBeenCalledWith(1, 'quick');
    expect(mockAdviceLogs.create).toHaveBeenCalledTimes(1);
    const createArg = mockAdviceLogs.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createArg).toMatchObject({
      group_id: 1,
      tier: 'quick',
      trigger_type: 'budget_threshold',
      topic: trigger.topic,
      advice_text: '[auto-advice suppressed]',
    });
    spy.mockRestore();
  });

  test('swallows errors (does not propagate)', async () => {
    const spa = await import('../../services/analytics/spending-analytics');
    (spa.spendingAnalytics.getFinancialSnapshot as ReturnType<typeof mock>).mockImplementationOnce(
      () => {
        throw new Error('DB down');
      },
    );

    await expect(maybeSmartAdvice(1)).resolves.toBeUndefined();
    expect(logMock.error).toHaveBeenCalled();
  });

  test('persists the trigger tier verbatim for alert triggers', async () => {
    const spy = spyOnChecker({
      type: 'budget_threshold',
      tier: 'alert',
      topic: 'budget_threshold:Food:exceeded',
      data: { category: 'Food' },
    });

    await maybeSmartAdvice(1);

    expect(mockAiStreamRound).not.toHaveBeenCalled();
    expect(recordAdviceSentMock).toHaveBeenCalledWith(1, 'alert');
    const createArg = mockAdviceLogs.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createArg?.['tier']).toBe('alert');
    spy.mockRestore();
  });
});

// helper: sets the mocked checkSmartTriggers return value for the next call
function spyOnChecker(returnValue: import('../../services/analytics/types').TriggerResult | null): {
  mockRestore: () => void;
} {
  checkSmartTriggersMock.mockImplementationOnce(() => returnValue);
  return { mockRestore: () => {} };
}
