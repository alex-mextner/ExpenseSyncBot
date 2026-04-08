/** Tests for the smart advice pipeline in ask.ts */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ValidationResult } from '../../services/ai/advice-validator';
import type { FinancialSnapshot, TriggerResult } from '../../services/analytics/types';

// === Mocks ===

const mockLogger = { info: mock(), warn: mock(), error: mock(), debug: mock() };
mock.module('../../utils/logger', () => ({
  createLogger: () => mockLogger,
}));

mock.module('../../config/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test-key',
    AI_BASE_URL: undefined,
    AI_MODEL: 'test-model',
    AI_DEBUG_LOGS: false,
    AI_VALIDATION_MODEL: 'test-model',
    BOT_USERNAME: 'ExpenseSyncBot',
  },
}));

// Mock database
const mockAdviceLogs = {
  countToday: mock(() => 0),
  hasTopicThisMonth: mock(() => false),
  getRecent: mock(() => []),
  getRecentTopics: mock((): string[] => []),
  create: mock(),
};
mock.module('../../database', () => ({
  database: {
    groups: {
      findById: mock(() => ({
        id: 1,
        telegram_group_id: -100123,
        default_currency: 'EUR',
        custom_prompt: null,
        google_refresh_token: null,
      })),
    },
    adviceLogs: mockAdviceLogs,
    chatMessages: {
      getRecentMessages: mock(() => []),
      create: mock(),
      pruneOldMessages: mock(),
    },
    users: { findByTelegramId: mock(() => null), create: mock(() => ({ id: 1 })) },
  },
}));

// Mock sendMessage — typed to accept string argument
const mockSendMessage = mock((_text: string, _opts?: unknown) => Promise.resolve(null));
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: mockSendMessage,
}));

// Mock spending analytics
const mockGetFinancialSnapshot = mock((): FinancialSnapshot => buildBaseSnapshot());
mock.module('../../services/analytics/spending-analytics', () => ({
  spendingAnalytics: { getFinancialSnapshot: mockGetFinancialSnapshot },
}));

// Mock advice triggers
const mockCheckSmartTriggers = mock((): TriggerResult | null => null);
const mockRecordAdviceSent = mock();
mock.module('../../services/analytics/advice-triggers', () => ({
  checkSmartTriggers: mockCheckSmartTriggers,
  recordAdviceSent: mockRecordAdviceSent,
}));

// Mock formatters
mock.module('../../services/analytics/formatters', () => ({
  computeOverallSeverity: mock(() => 'warning'),
}));

// Mock currency converter
mock.module('../../services/currency/converter', () => ({
  convertCurrency: mock((_amount: number) => _amount),
  formatAmount: mock((_amount: number, _currency: string) => `${Math.round(_amount)} ${_currency}`),
}));

// Mock html utils
mock.module('../../utils/html', () => ({
  sanitizeHtmlForTelegram: mock((_text: string) => _text),
  stripAllHtml: mock((_text: string) => _text.replace(/<[^>]+>/g, '')),
}));

// Mock advice validator — typed to return ValidationResult
const mockValidateAdvice = mock(
  (_key: string, _input: unknown): Promise<ValidationResult> => Promise.resolve({ approved: true }),
);
mock.module('../../services/ai/advice-validator', () => ({
  validateAdvice: mockValidateAdvice,
}));

// Mock agent — typed for runBatch(prompt: string)
const mockRunBatch = mock(
  (_prompt: string): Promise<string> =>
    Promise.resolve('Бюджет на еду превышен на 125%. Потрачено 500€ из 400€.'),
);
mock.module('../../services/ai/agent', () => ({
  ExpenseBotAgent: class MockAgent {
    runBatch = mockRunBatch;
  },
}));

// Import after all mocks
const { maybeSmartAdvice, handleAdviceCommand } = await import('./ask');

// === Helpers ===

function buildBaseSnapshot(overrides: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return {
    burnRates: [],
    weekTrend: {
      period: 'week',
      current_total: 100,
      previous_total: 90,
      change_percent: 11,
      direction: 'up',
      category_changes: [],
    },
    monthTrend: {
      period: 'month',
      current_total: 400,
      previous_total: 350,
      change_percent: 14,
      direction: 'up',
      category_changes: [],
    },
    anomalies: [],
    dayOfWeekPatterns: [],
    velocity: { trend: 'stable', acceleration: 0, period_1_daily_avg: 10, period_2_daily_avg: 10 },
    budgetUtilization: null,
    streak: {
      current_streak_days: 0,
      streak_type: 'above_average',
      avg_daily_during_streak: 0,
      overall_daily_average: 10,
    },
    projection: null,
    technicalAnalysis: null,
    ...overrides,
  };
}

const alertTrigger: TriggerResult = {
  type: 'budget_threshold',
  tier: 'alert',
  topic: 'budget_threshold:Food:exceeded',
  data: { category: 'Food', spent: 500, limit: 400, currency: 'EUR' },
};

/** Type-safe accessor for mock call arguments */
function getSentText(callIndex = 0): string {
  return mockSendMessage.mock.calls[callIndex]?.[0] ?? '';
}

function getBatchPrompt(callIndex = 0): string {
  return mockRunBatch.mock.calls[callIndex]?.[0] ?? '';
}

// === Tests ===

describe('maybeSmartAdvice', () => {
  beforeEach(() => {
    mockRunBatch.mockClear();
    mockSendMessage.mockClear();
    mockValidateAdvice.mockClear();
    mockRecordAdviceSent.mockClear();
    mockCheckSmartTriggers.mockReturnValue(null);
    mockGetFinancialSnapshot.mockReturnValue(buildBaseSnapshot());
    mockAdviceLogs.create.mockClear();
    mockAdviceLogs.getRecentTopics.mockReturnValue([]);
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
  });

  test('does nothing when no trigger fires', async () => {
    mockCheckSmartTriggers.mockReturnValue(null);
    await maybeSmartAdvice(1);
    expect(mockRunBatch).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('generates and sends advice when trigger fires', async () => {
    mockCheckSmartTriggers.mockReturnValue(alertTrigger);
    mockRunBatch.mockResolvedValue('Бюджет на еду превышен: 500€ из 400€ (125%).');
    mockValidateAdvice.mockResolvedValue({ approved: true });

    await maybeSmartAdvice(1);

    expect(mockRunBatch).toHaveBeenCalledTimes(1);
    expect(mockValidateAdvice).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const sentText = getSentText();
    expect(sentText).toContain('⚠️');
    expect(sentText).toContain('Финансовый алерт');
    expect(sentText).toContain('Бюджет на еду превышен');
  });

  test('records advice in log after sending', async () => {
    mockCheckSmartTriggers.mockReturnValue(alertTrigger);
    mockRunBatch.mockResolvedValue('Advice text with numbers 500€');

    await maybeSmartAdvice(1);

    expect(mockRecordAdviceSent).toHaveBeenCalledWith(1, 'alert');
    expect(mockAdviceLogs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        group_id: 1,
        tier: 'alert',
        trigger_type: 'budget_threshold',
        topic: 'budget_threshold:Food:exceeded',
      }),
    );
  });

  test('skips when agent returns empty response', async () => {
    mockCheckSmartTriggers.mockReturnValue(alertTrigger);
    mockRunBatch.mockResolvedValue('');

    await maybeSmartAdvice(1);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockRecordAdviceSent).not.toHaveBeenCalled();
  });

  test('retries when validation rejects', async () => {
    mockCheckSmartTriggers.mockReturnValue(alertTrigger);
    mockRunBatch
      .mockResolvedValueOnce('Generic advice without numbers')
      .mockResolvedValueOnce('Fixed advice: бюджет на еду 500€ из 400€.');
    mockValidateAdvice.mockResolvedValueOnce({ approved: false, reason: 'Нет конкретных цифр' });

    await maybeSmartAdvice(1);

    expect(mockRunBatch).toHaveBeenCalledTimes(2);
    const retryPrompt = getBatchPrompt(1);
    expect(retryPrompt).toContain('Нет конкретных цифр');
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  test('skips when retry also returns empty', async () => {
    mockCheckSmartTriggers.mockReturnValue(alertTrigger);
    mockRunBatch.mockResolvedValueOnce('Bad advice').mockResolvedValueOnce('');
    mockValidateAdvice.mockResolvedValueOnce({ approved: false, reason: 'Bad' });

    await maybeSmartAdvice(1);

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('silently catches errors without crashing', async () => {
    mockCheckSmartTriggers.mockReturnValue(alertTrigger);
    mockRunBatch.mockRejectedValue(new Error('API error'));

    await maybeSmartAdvice(1);

    expect(mockLogger.error).toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('appends blockquote with source data', async () => {
    const snapshot = buildBaseSnapshot({
      burnRates: [
        {
          category: 'Food',
          budget_limit: 400,
          spent: 500,
          currency: 'EUR',
          days_elapsed: 20,
          days_remaining: 10,
          daily_burn_rate: 25,
          projected_total: 750,
          projected_overshoot: 350,
          runway_days: 0,
          status: 'exceeded',
        },
      ],
    });
    mockGetFinancialSnapshot.mockReturnValue(snapshot);
    mockCheckSmartTriggers.mockReturnValue(alertTrigger);
    mockRunBatch.mockResolvedValue('Бюджет на еду превышен.');

    await maybeSmartAdvice(1);

    const sentText = getSentText();
    expect(sentText).toContain('<blockquote expandable>');
    expect(sentText).toContain('📋');
    expect(sentText).toContain('Данные анализа');
    expect(sentText).toContain('Триггер: budget_threshold');
  });
});

describe('handleAdviceCommand', () => {
  beforeEach(() => {
    mockRunBatch.mockClear();
    mockSendMessage.mockClear();
    mockValidateAdvice.mockClear();
    mockRecordAdviceSent.mockClear();
    mockAdviceLogs.create.mockClear();
    mockAdviceLogs.getRecentTopics.mockReturnValue([]);
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
  });

  test('creates deep trigger and generates advice', async () => {
    mockRunBatch.mockResolvedValue('Полный финансовый обзор с числами...');
    mockValidateAdvice.mockResolvedValue({ approved: true });

    // biome-ignore lint/suspicious/noExplicitAny: test stub for Ctx
    const mockCtx = {} as any;
    const group = {
      id: 1,
      telegram_group_id: -100123,
      default_currency: 'EUR',
      custom_prompt: null,
      // biome-ignore lint/suspicious/noExplicitAny: test stub for Group
    } as any;

    await handleAdviceCommand(mockCtx, group);

    expect(mockRunBatch).toHaveBeenCalledTimes(1);
    const prompt = getBatchPrompt();
    expect(prompt).toContain('полный финансовый обзор');
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const sentText = getSentText();
    expect(sentText).toContain('📊');
    expect(sentText).toContain('Финансовый обзор');
  });
});

describe('advice tiers', () => {
  beforeEach(() => {
    mockRunBatch.mockClear();
    mockSendMessage.mockClear();
    mockValidateAdvice.mockClear();
    mockRecordAdviceSent.mockClear();
    mockAdviceLogs.create.mockClear();
    mockAdviceLogs.getRecentTopics.mockReturnValue([]);
  });

  test('quick tier uses correct emoji and header', async () => {
    const quickTrigger: TriggerResult = {
      type: 'ta_trend_change',
      tier: 'quick',
      topic: 'ta_trend_change:Food:rising',
      data: { category: 'Food', direction: 'rising' },
    };
    mockCheckSmartTriggers.mockReturnValue(quickTrigger);
    mockRunBatch.mockResolvedValue('Расходы на еду растут: +15% за 3 месяца.');

    await maybeSmartAdvice(1);

    const sentText = getSentText();
    expect(sentText).toContain('💡');
    expect(sentText).toContain('Инсайт');
  });

  test('alert tier uses correct emoji and header', async () => {
    mockCheckSmartTriggers.mockReturnValue(alertTrigger);
    mockRunBatch.mockResolvedValue('Бюджет превышен на 25%.');

    await maybeSmartAdvice(1);

    const sentText = getSentText();
    expect(sentText).toContain('⚠️');
    expect(sentText).toContain('Финансовый алерт');
  });

  test('prompt includes trigger data', async () => {
    mockCheckSmartTriggers.mockReturnValue(alertTrigger);
    mockRunBatch.mockResolvedValue('Advice text');

    await maybeSmartAdvice(1);

    const prompt = getBatchPrompt();
    expect(prompt).toContain('budget_threshold');
    expect(prompt).toContain('Food');
  });

  test('prompt includes anti-repetition when recent topics exist', async () => {
    mockAdviceLogs.getRecentTopics.mockReturnValue(['budget_threshold:Food', 'anomaly:Transport']);
    mockCheckSmartTriggers.mockReturnValue(alertTrigger);
    mockRunBatch.mockResolvedValue('New advice text');

    await maybeSmartAdvice(1);

    const prompt = getBatchPrompt();
    expect(prompt).toContain('НЕ повторяй');
    expect(prompt).toContain('budget_threshold:Food');
  });
});

describe('HTML fallback', () => {
  beforeEach(() => {
    mockRunBatch.mockClear();
    mockSendMessage.mockClear();
    mockValidateAdvice.mockClear();
    mockRecordAdviceSent.mockClear();
    mockAdviceLogs.getRecentTopics.mockReturnValue([]);
  });

  test('falls back to plain text on HTML parse error', async () => {
    mockCheckSmartTriggers.mockReturnValue(alertTrigger);
    mockRunBatch.mockResolvedValue('<b>Bad HTML</b> advice text');
    const parseError = new Error("can't parse entities");
    mockSendMessage.mockRejectedValueOnce(parseError).mockResolvedValueOnce(null);

    await maybeSmartAdvice(1);

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    const fallbackText = getSentText(1);
    expect(fallbackText).not.toContain('<b>');
  });
});
