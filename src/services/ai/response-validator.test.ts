/**
 * Tests for the response validation pass
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { validateResponse } from './response-validator';

// Mock Anthropic SDK
const mockCreate = mock((_args: Record<string, unknown>, _opts?: Record<string, unknown>) =>
  Promise.resolve({
    content: [{ type: 'text' as const, text: 'APPROVE' }],
  }),
);

mock.module('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

describe('validateResponse', () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  test('approves valid response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: 'APPROVE' }],
    });

    const result = await validateResponse('test-key', {
      userMessage: 'сколько я потратил?',
      toolCalls: ['get_expenses'],
      response: 'Ты потратил 500 EUR',
    });

    expect(result.approved).toBe(true);
  });

  test('rejects response with reason', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: 'REJECT: Ответ без вызова инструментов' }],
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

  test('approves on API error (fail-open)', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API down'));

    const result = await validateResponse('test-key', {
      userMessage: 'hello',
      toolCalls: [],
      response: 'Привет!',
    });

    expect(result.approved).toBe(true);
  });

  test('sends correct payload to LLM', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: 'APPROVE' }],
    });

    await validateResponse('test-key', {
      userMessage: 'покажи расходы',
      toolCalls: ['get_expenses', 'get_budgets'],
      response: 'Вот расходы...',
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0];
    expect(call).toBeDefined();
    const args = call?.[0];
    expect(args?.['max_tokens']).toBe(256);
    const messages = args?.['messages'] as Array<{ content: string }>;
    expect(messages[0]?.content).toContain('get_expenses, get_budgets');
    expect(messages[0]?.content).toContain('покажи расходы');
  });

  test('handles empty tool calls list', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: 'REJECT: No tools called' }],
    });

    await validateResponse('test-key', {
      userMessage: 'сколько?',
      toolCalls: [],
      response: 'Итого 100',
    });

    const call = mockCreate.mock.calls[0];
    expect(call).toBeDefined();
    const args = call?.[0];
    const messages = args?.['messages'] as Array<{ content: string }>;
    expect(messages[0]?.content).toContain('(none — no tools were called)');
  });
});
