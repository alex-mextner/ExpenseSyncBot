/** Tests for the response validation pass — mocks aiStreamRound from streaming module */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

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

const mockAiStreamRound = mock(() => Promise.resolve(streamResult('APPROVE')));

mock.module('./streaming', () => ({
  aiStreamRound: mockAiStreamRound,
}));

import { validateResponse } from './response-validator';

describe('validateResponse', () => {
  beforeEach(() => {
    mockAiStreamRound.mockClear();
  });

  test('approves valid response', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    const result = await validateResponse({
      userMessage: 'сколько я потратил?',
      toolCalls: ['get_expenses'],
      response: 'Ты потратил 500 EUR',
    });

    expect(result.approved).toBe(true);
  });

  test('rejects response with reason', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('REJECT: Ответ без вызова инструментов'));

    const result = await validateResponse({
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
    mockAiStreamRound.mockRejectedValueOnce(new Error('All AI models failed'));

    const result = await validateResponse({
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
    mockAiStreamRound.mockRejectedValueOnce(new Error('All AI models failed'));

    const result = await validateResponse({
      userMessage: 'сколько я потратил?',
      toolCalls: ['get_expenses'],
      response: 'Ты потратил 500 EUR',
    });

    expect(result.approved).toBe(true);
  });

  test('sends correct payload to aiStreamRound', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    await validateResponse({
      userMessage: 'покажи расходы',
      toolCalls: ['get_expenses', 'get_budgets'],
      response: 'Вот расходы...',
    });

    expect(mockAiStreamRound).toHaveBeenCalledTimes(1);
    type CallOpts = {
      maxTokens: number;
      chain: string;
      messages: Array<{ role: string; content: string }>;
    };
    const opts = (mockAiStreamRound.mock.calls[0] as unknown as [CallOpts])[0];
    expect(opts.maxTokens).toBe(256);
    expect(opts.chain).toBe('fast');
    // User message contains tool calls and original message
    const userMsg = opts.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('get_expenses, get_budgets');
    expect(userMsg?.content).toContain('покажи расходы');
  });

  test('handles empty tool calls list', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('REJECT: No tools called'));

    await validateResponse({
      userMessage: 'сколько?',
      toolCalls: [],
      response: 'Итого 100',
    });

    type MsgOpts = { messages: Array<{ role: string; content: string }> };
    const opts = (mockAiStreamRound.mock.calls[0] as unknown as [MsgOpts])[0];
    const userMsg = opts.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('(none — no tools were called)');
  });

  test('validation prompt contains mutation rule', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    await validateResponse({
      userMessage: 'запомни что мы используем RSD',
      toolCalls: [],
      response: 'Запомнил!',
    });

    type MsgOpts = { messages: Array<{ role: string; content: string }> };
    const opts = (mockAiStreamRound.mock.calls[0] as unknown as [MsgOpts])[0];
    const systemMsg = opts.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain('mutation requests');
    expect(systemMsg?.content).toContain('set_custom_prompt');
  });

  test('rejects mutation without tool call', async () => {
    mockAiStreamRound.mockResolvedValueOnce(
      streamResult('REJECT: Ответ без вызова set_custom_prompt'),
    );

    const result = await validateResponse({
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
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    const result = await validateResponse({
      userMessage: 'запомни что наш сайт про женскую одежду',
      toolCalls: ['set_custom_prompt'],
      response: 'Готово, сохранил.',
    });

    expect(result.approved).toBe(true);
  });
});
