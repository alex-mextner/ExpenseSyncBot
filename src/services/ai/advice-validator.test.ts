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
    // Verify the advice itself was truncated to exactly 2000 chars — find the AAA block
    const match = userMessage.match(/A{2000,}/);
    expect(match).not.toBeNull();
    expect(match?.[0].length).toBe(2000);
  });

  test('approves when model outputs APPROVE with trailing whitespace', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE   \n'));

    const result = await validateAdvice({
      tier: 'alert',
      trigger,
      advice: 'любой совет',
    });

    expect(result.approved).toBe(true);
  });

  test('REJECT with empty body falls back to "Validation failed"', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('REJECT:'));

    const result = await validateAdvice({
      tier: 'quick',
      trigger,
      advice: 'совет',
    });

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('Validation failed');
    }
  });

  test('strips REJECT prefix case-insensitively', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('reject: плохо'));

    const result = await validateAdvice({
      tier: 'alert',
      trigger,
      advice: 'совет',
    });

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('плохо');
    }
  });

  test('handles empty advice string (no truncation issues)', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    const result = await validateAdvice({
      tier: 'alert',
      trigger,
      advice: '',
    });

    expect(result.approved).toBe(true);
    expect(mockAiStreamRound).toHaveBeenCalledTimes(1);
  });

  test('handles whitespace-only advice', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    const result = await validateAdvice({
      tier: 'alert',
      trigger,
      advice: '   \n\t   ',
    });

    expect(result.approved).toBe(true);
  });

  test('serializes trigger.data as JSON in user message', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    const complexTrigger: TriggerResult = {
      type: 'anomaly',
      tier: 'alert',
      topic: 'anomaly:Transport',
      data: {
        category: 'Transport',
        current: 450,
        average: 120,
        ratio: 3.75,
        dates: ['2026-04-10', '2026-04-12'],
      },
    };

    await validateAdvice({
      tier: 'alert',
      trigger: complexTrigger,
      advice: 'Траты на транспорт в 3.75x выше среднего',
    });

    const params = mockAiStreamRound.mock.calls[0]?.[0];
    const userMessage =
      typeof params?.messages[1]?.content === 'string' ? params.messages[1].content : '';
    expect(userMessage).toContain('anomaly');
    expect(userMessage).toContain('Transport');
    expect(userMessage).toContain('3.75');
    expect(userMessage).toContain('2026-04-10');
  });

  test('uses fast chain and 256 max tokens', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    await validateAdvice({
      tier: 'alert',
      trigger,
      advice: 'совет',
    });

    const params = mockAiStreamRound.mock.calls[0]?.[0];
    expect(params?.chain).toBe('fast');
    expect(params?.maxTokens).toBe(256);
  });

  test('passes an AbortSignal for 15s timeout', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    await validateAdvice({
      tier: 'alert',
      trigger,
      advice: 'совет',
    });

    const params = mockAiStreamRound.mock.calls[0]?.[0];
    expect(params?.signal).toBeInstanceOf(AbortSignal);
    expect(params?.signal?.aborted).toBe(false);
  });

  test('system message contains rejection rules about hallucinations and links', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    await validateAdvice({
      tier: 'alert',
      trigger,
      advice: 'x',
    });

    const params = mockAiStreamRound.mock.calls[0]?.[0];
    const sys = typeof params?.messages[0]?.content === 'string' ? params.messages[0].content : '';
    expect(sys).toContain('Hallucinated numbers');
    expect(sys).toContain('Invented links');
    expect(sys).toContain('Wrong language');
    expect(sys).toContain('Russian');
  });

  test('output with body after APPROVE is still treated as approval', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE looks fine'));

    const result = await validateAdvice({
      tier: 'deep',
      trigger,
      advice: 'любой текст',
    });

    expect(result.approved).toBe(true);
  });

  test('each tier is passed through to the validator user message', async () => {
    for (const tier of ['quick', 'alert', 'deep'] as const) {
      mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));
      await validateAdvice({ tier, trigger, advice: `tier-${tier}` });
      const params = mockAiStreamRound.mock.calls.at(-1)?.[0];
      const userMessage =
        typeof params?.messages[1]?.content === 'string' ? params.messages[1].content : '';
      expect(userMessage).toContain(`TIER: ${tier}`);
    }
  });
});
