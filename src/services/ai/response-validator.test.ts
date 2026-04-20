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

  test('handles whitespace around APPROVE verdict', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('  APPROVE  \n'));
    const result = await validateResponse({
      userMessage: 'hi',
      toolCalls: [],
      response: 'hello',
    });
    expect(result.approved).toBe(true);
  });

  test('falls back to generic reason when REJECT body is empty', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('REJECT:  '));
    const result = await validateResponse({
      userMessage: 'тест',
      toolCalls: ['get_expenses'],
      response: 'ответ',
    });
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('Validation failed');
    }
  });

  test('strips REJECT prefix case-insensitively', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('reject: не то'));
    const result = await validateResponse({
      userMessage: 'x',
      toolCalls: ['get_expenses'],
      response: 'y',
    });
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('не то');
    }
  });

  test('truncates very long responses to 2000 chars before sending to validator', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    const longResponse = 'Z'.repeat(5000);
    await validateResponse({
      userMessage: 'сколько?',
      toolCalls: ['get_expenses'],
      response: longResponse,
    });

    type MsgOpts = { messages: Array<{ role: string; content: string }> };
    const opts = (mockAiStreamRound.mock.calls[0] as unknown as [MsgOpts])[0];
    const userMsg = opts.messages.find((m) => m.role === 'user');
    // 2000 Z chars + prefix/suffix, but NOT the full 5000
    expect(userMsg?.content).toBeDefined();
    const zCount = (userMsg?.content.match(/Z/g) ?? []).length;
    expect(zCount).toBe(2000);
  });

  test('handles empty response and user message', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    const result = await validateResponse({
      userMessage: '',
      toolCalls: [],
      response: '',
    });

    expect(result.approved).toBe(true);
    expect(mockAiStreamRound).toHaveBeenCalledTimes(1);
  });

  test('handles whitespace-only response', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    const result = await validateResponse({
      userMessage: 'привет',
      toolCalls: [],
      response: '   \n  \t ',
    });

    expect(result.approved).toBe(true);
  });

  test('uses 15s abort signal for validator call', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    await validateResponse({
      userMessage: 'x',
      toolCalls: [],
      response: 'y',
    });

    type SignalOpts = { signal?: AbortSignal };
    const opts = (mockAiStreamRound.mock.calls[0] as unknown as [SignalOpts])[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // Not aborted yet
    expect(opts.signal?.aborted).toBe(false);
  });

  test('non-Error rejection still approved when tools were called', async () => {
    // throwing a plain string — validator should still handle gracefully
    mockAiStreamRound.mockRejectedValueOnce('string error');

    const result = await validateResponse({
      userMessage: 'x',
      toolCalls: ['get_expenses'],
      response: 'y',
    });

    expect(result.approved).toBe(true);
  });

  test('output with extra text after APPROVE is still treated as approval', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE — looks good'));
    const result = await validateResponse({
      userMessage: 'x',
      toolCalls: [],
      response: 'y',
    });
    expect(result.approved).toBe(true);
  });

  test('output starting with REJECT but containing APPROVE in body is rejected', async () => {
    mockAiStreamRound.mockResolvedValueOnce(
      streamResult('REJECT: would APPROVE but hallucinated value'),
    );
    const result = await validateResponse({
      userMessage: 'x',
      toolCalls: ['get_expenses'],
      response: 'y',
    });
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('would APPROVE but hallucinated value');
    }
  });

  test('tool call summary joins multiple items with comma', async () => {
    mockAiStreamRound.mockResolvedValueOnce(streamResult('APPROVE'));

    await validateResponse({
      userMessage: 'x',
      toolCalls: ['a', 'b', 'c'],
      response: 'y',
    });

    type MsgOpts = { messages: Array<{ role: string; content: string }> };
    const opts = (mockAiStreamRound.mock.calls[0] as unknown as [MsgOpts])[0];
    const userMsg = opts.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('a, b, c');
  });
});
