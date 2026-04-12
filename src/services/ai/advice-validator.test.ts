/** Tests for advice-specific validation */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { TriggerResult } from '../analytics/types';
import type { StreamRoundOptions } from './streaming';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

function streamResult(text: string) {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant' as const, content: text },
    providerUsed: 'mock-fast',
  };
}

const mockAiStreamRound = mock((_opts: StreamRoundOptions) =>
  Promise.resolve(streamResult('APPROVE')),
);

mock.module('./streaming', () => ({
  aiStreamRound: mockAiStreamRound,
}));

const { validateAdvice } = await import('./advice-validator');

describe('validateAdvice', () => {
  beforeEach(() => {
    mockAiStreamRound.mockClear();
    logMock.info.mockClear();
    logMock.error.mockClear();
  });

  const trigger: TriggerResult = {
    type: 'budget_threshold',
    tier: 'alert',
    topic: 'budget_threshold:Food:exceeded',
    data: { category: 'Food', spent: 500, limit: 400, currency: 'EUR' },
  };

  test('approves valid advice', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    const result = await validateAdvice({
      tier: 'alert',
      trigger,
      advice: 'Бюджет на еду превышен: потрачено 500€ из 400€ (125%). Сократи расходы на еду.',
    });

    expect(result.approved).toBe(true);
  });

  test('rejects advice with reason', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('REJECT: Нет конкретных цифр в совете'));

    const result = await validateAdvice({
      tier: 'quick',
      trigger,
      advice: 'Стоит обратить внимание на расходы.',
    });

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('Нет конкретных цифр в совете');
    }
  });

  test('approves by default on provider error (agent used tools)', async () => {
    mockAiStreamRound.mockRejectedValueOnce(new Error('All AI providers failed'));

    const result = await validateAdvice({
      tier: 'alert',
      trigger,
      advice: 'Some advice text with numbers 500€',
    });

    expect(result.approved).toBe(true);
    expect(logMock.error).toHaveBeenCalled();
  });

  test('handles AbortError from timeout', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    mockAiStreamRound.mockRejectedValueOnce(abortError);

    const result = await validateAdvice({
      tier: 'deep',
      trigger,
      advice: 'Detailed financial review...',
    });

    expect(result.approved).toBe(true);
  });

  test('passes trigger data to the validator model', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    await validateAdvice({
      tier: 'alert',
      trigger,
      advice: 'Test advice',
    });

    expect(mockAiStreamRound).toHaveBeenCalledTimes(1);
    const params = mockAiStreamRound.mock.calls[0]?.[0];
    const userMessage =
      typeof params?.messages[1]?.content === 'string' ? params.messages[1].content : '';
    expect(userMessage).toContain('budget_threshold');
    expect(userMessage).toContain('Food');
  });

  test('truncates long advice to 2000 chars', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    const longAdvice = 'A'.repeat(5000);
    await validateAdvice({
      tier: 'deep',
      trigger,
      advice: longAdvice,
    });

    const params = mockAiStreamRound.mock.calls[0]?.[0];
    const userMessage =
      typeof params?.messages[1]?.content === 'string' ? params.messages[1].content : '';
    expect(userMessage.length).toBeLessThan(3000);
  });
});
