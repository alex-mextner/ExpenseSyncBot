/** Tests for advice-specific validation */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TriggerResult } from '../analytics/types';

// Mock logger
const mockLogger = { info: mock(), warn: mock(), error: mock(), debug: mock() };
mock.module('../../utils/logger', () => ({
  createLogger: () => mockLogger,
}));

// Mock env
mock.module('../../config/env', () => ({
  env: { AI_BASE_URL: undefined, AI_VALIDATION_MODEL: 'claude-haiku-4-5-20251001' },
}));

// Mock Anthropic SDK — typed mock for messages.create
const mockCreate = mock((_params: unknown, _opts?: unknown) =>
  Promise.resolve({ content: [{ type: 'text', text: 'APPROVE' }] }),
);
mock.module('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

// Import after mocks
const { validateAdvice } = await import('./advice-validator');

describe('validateAdvice', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
  });

  const trigger: TriggerResult = {
    type: 'budget_threshold',
    tier: 'alert',
    topic: 'budget_threshold:Food:exceeded',
    data: { category: 'Food', spent: 500, limit: 400, currency: 'EUR' },
  };

  test('approves valid advice', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'APPROVE' }],
    });

    const result = await validateAdvice('test-key', {
      tier: 'alert',
      trigger,
      advice: 'Бюджет на еду превышен: потрачено 500€ из 400€ (125%). Сократи расходы на еду.',
    });

    expect(result.approved).toBe(true);
  });

  test('rejects advice with reason', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'REJECT: Нет конкретных цифр в совете' }],
    });

    const result = await validateAdvice('test-key', {
      tier: 'quick',
      trigger,
      advice: 'Стоит обратить внимание на расходы.',
    });

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('Нет конкретных цифр в совете');
    }
  });

  test('approves by default on API error (agent used tools)', async () => {
    mockCreate.mockRejectedValue(new Error('API unavailable'));

    const result = await validateAdvice('test-key', {
      tier: 'alert',
      trigger,
      advice: 'Some advice text with numbers 500€',
    });

    expect(result.approved).toBe(true);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  test('handles AbortError from timeout', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    mockCreate.mockRejectedValue(abortError);

    const result = await validateAdvice('test-key', {
      tier: 'deep',
      trigger,
      advice: 'Detailed financial review...',
    });

    expect(result.approved).toBe(true);
  });

  test('passes trigger data to the validator model', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'APPROVE' }],
    });

    await validateAdvice('test-key', {
      tier: 'alert',
      trigger,
      advice: 'Test advice',
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const params = mockCreate.mock.calls[0]?.[0] as any;
    expect(params.messages[0].content).toContain('budget_threshold');
    expect(params.messages[0].content).toContain('Food');
  });

  test('truncates long advice to 2000 chars', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'APPROVE' }],
    });

    const longAdvice = 'A'.repeat(5000);
    await validateAdvice('test-key', {
      tier: 'deep',
      trigger,
      advice: longAdvice,
    });

    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args
    const params = mockCreate.mock.calls[0]?.[0] as any;
    const content = params.messages[0].content;
    expect(content.length).toBeLessThan(3000);
  });
});
