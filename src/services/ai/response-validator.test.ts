/** Tests for the response validation pass — mocks aiComplete from shared completion */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const mockAiComplete = mock(() =>
  Promise.resolve({ text: 'APPROVE', finishReason: 'stop', usage: {}, model: 'test' }),
);

mock.module('./completion', () => ({
  aiComplete: mockAiComplete,
  stripThinkingTags: (t: string) => t,
}));

import { validateResponse } from './response-validator';

describe('validateResponse', () => {
  beforeEach(() => {
    mockAiComplete.mockClear();
  });

  test('approves valid response', async () => {
    mockAiComplete.mockResolvedValueOnce({
      text: 'APPROVE',
      finishReason: 'stop',
      usage: {},
      model: 'GLM',
    });

    const result = await validateResponse('test-key', {
      userMessage: 'сколько я потратил?',
      toolCalls: ['get_expenses'],
      response: 'Ты потратил 500 EUR',
    });

    expect(result.approved).toBe(true);
  });

  test('rejects response with reason', async () => {
    mockAiComplete.mockResolvedValueOnce({
      text: 'REJECT: Ответ без вызова инструментов',
      finishReason: 'stop',
      usage: {},
      model: 'GLM',
    });

    const result = await validateResponse('test-key', {
      userMessage: 'сводка расходов',
      toolCalls: [],
      response: 'Ты потратил 5543 EUR',
    });

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('Ответ без вызова инструментов');
    }
  });

  test('rejects on API error when no tools were called (prevents hallucination)', async () => {
    mockAiComplete.mockRejectedValueOnce(new Error('All AI models failed'));

    const result = await validateResponse('test-key', {
      userMessage: 'сколько денег на картах',
      toolCalls: [],
      response: 'Всего на картах: $85',
    });

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toContain('hallucination');
    }
  });

  test('approves on API error when tools were called (fail-open)', async () => {
    mockAiComplete.mockRejectedValueOnce(new Error('All AI models failed'));

    const result = await validateResponse('test-key', {
      userMessage: 'сколько я потратил?',
      toolCalls: ['get_expenses'],
      response: 'Ты потратил 500 EUR',
    });

    expect(result.approved).toBe(true);
  });

  test('sends correct payload to aiComplete', async () => {
    mockAiComplete.mockResolvedValueOnce({
      text: 'APPROVE',
      finishReason: 'stop',
      usage: {},
      model: 'GLM',
    });

    await validateResponse('test-key', {
      userMessage: 'покажи расходы',
      toolCalls: ['get_expenses', 'get_budgets'],
      response: 'Вот расходы...',
    });

    expect(mockAiComplete).toHaveBeenCalledTimes(1);
    type CallOpts = {
      maxTokens: number;
      timeoutMs: number;
      maxRetries: number;
      messages: Array<{ role: string; content: string }>;
    };
    const opts = (mockAiComplete.mock.calls[0] as unknown as [CallOpts])[0];
    expect(opts.maxTokens).toBe(256);
    expect(opts.timeoutMs).toBe(15_000);
    expect(opts.maxRetries).toBe(1);
    // User message contains tool calls and original message
    const userMsg = opts.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('get_expenses, get_budgets');
    expect(userMsg?.content).toContain('покажи расходы');
  });

  test('handles empty tool calls list', async () => {
    mockAiComplete.mockResolvedValueOnce({
      text: 'REJECT: No tools called',
      finishReason: 'stop',
      usage: {},
      model: 'GLM',
    });

    await validateResponse('test-key', {
      userMessage: 'сколько?',
      toolCalls: [],
      response: 'Итого 100',
    });

    type MsgOpts = { messages: Array<{ role: string; content: string }> };
    const opts = (mockAiComplete.mock.calls[0] as unknown as [MsgOpts])[0];
    const userMsg = opts.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('(none — no tools were called)');
  });

  test('validation prompt contains mutation rule', async () => {
    mockAiComplete.mockResolvedValueOnce({
      text: 'APPROVE',
      finishReason: 'stop',
      usage: {},
      model: 'GLM',
    });

    await validateResponse('test-key', {
      userMessage: 'запомни что мы используем RSD',
      toolCalls: [],
      response: 'Запомнил!',
    });

    type MsgOpts = { messages: Array<{ role: string; content: string }> };
    const opts = (mockAiComplete.mock.calls[0] as unknown as [MsgOpts])[0];
    const systemMsg = opts.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain('mutation requests');
    expect(systemMsg?.content).toContain('set_custom_prompt');
  });

  test('rejects mutation without tool call', async () => {
    mockAiComplete.mockResolvedValueOnce({
      text: 'REJECT: Ответ без вызова set_custom_prompt',
      finishReason: 'stop',
      usage: {},
      model: 'GLM',
    });

    const result = await validateResponse('test-key', {
      userMessage: 'запомни что наш сайт про женскую одежду',
      toolCalls: [],
      response: 'Запомнил! Тема — женский сайт 👗',
    });

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toContain('set_custom_prompt');
    }
  });

  test('approves valid mutation with tool call', async () => {
    mockAiComplete.mockResolvedValueOnce({
      text: 'APPROVE',
      finishReason: 'stop',
      usage: {},
      model: 'GLM',
    });

    const result = await validateResponse('test-key', {
      userMessage: 'запомни что наш сайт про женскую одежду',
      toolCalls: ['set_custom_prompt'],
      response: 'Готово, сохранил.',
    });

    expect(result.approved).toBe(true);
  });
});
