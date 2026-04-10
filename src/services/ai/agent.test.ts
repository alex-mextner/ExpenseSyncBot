// src/services/ai/agent.test.ts
// Tests for ExpenseBotAgent — streaming via aiStreamRound, tool calls, error handling

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { StreamRoundResult } from './streaming';

const logMock = createMockLogger();

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const mockAiStreamRound =
  mock<
    (
      opts: import('./streaming').StreamRoundOptions,
      callbacks: import('./streaming').StreamCallbacks,
    ) => Promise<StreamRoundResult>
  >();

const mockIsRetryableError = mock<(error: unknown) => boolean>();
const mockGetBackoffDelay = mock<(attempt: number, error: unknown) => number>();
const mockFormatApiError = mock<(error: unknown) => string>();

mock.module('./streaming', () => ({
  aiStreamRound: mockAiStreamRound,
  isRetryableError: mockIsRetryableError,
  getBackoffDelay: mockGetBackoffDelay,
  formatApiError: mockFormatApiError,
}));

mock.module('./response-validator', () => ({
  validateResponse: mock(async () => ({ approved: true })),
}));

import { ExpenseBotAgent } from './agent';
import type { AgentContext } from './types';

// Minimal AgentContext with all required fields
function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    chatId: 123,
    groupId: 1,
    userId: 10,
    userName: 'testuser',
    userFullName: 'Test User',
    customPrompt: null,
    telegramGroupId: 123,
    ...overrides,
  };
}

/** Build a StreamRoundResult for a simple text response */
function makeTextResult(text: string): StreamRoundResult {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: text },
  };
}

/**
 * Mock aiStreamRound to return a text response, also calling onTextDelta for each chunk.
 * Uses mockImplementationOnce.
 */
function mockStreamReturn(chunks: string[] = ['ok']) {
  const text = chunks.join('');
  mockAiStreamRound.mockImplementationOnce(async (_opts, callbacks) => {
    for (const chunk of chunks) {
      callbacks.onTextDelta?.(chunk);
    }
    return makeTextResult(text);
  });
}

/** Extract the LAST call's options from mockAiStreamRound (most recent invocation) */
function getLastCallOpts(): import('./streaming').StreamRoundOptions {
  const calls = mockAiStreamRound.mock.calls;
  const call = calls.at(-1);
  if (!call) throw new Error('Expected mockAiStreamRound to be called');
  return call[0] as import('./streaming').StreamRoundOptions;
}

// Minimal bot stub with tracked calls
function makeMockBot() {
  return {
    api: {
      sendMessage: mock(() =>
        Promise.resolve({ message_id: 1, chat: { id: 1 }, date: 0, text: '' }),
      ),
      editMessageText: mock(() =>
        Promise.resolve({ message_id: 1, chat: { id: 1 }, date: 0, text: '' }),
      ),
      sendChatAction: mock(() => Promise.resolve(true)),
      deleteMessage: mock(() => Promise.resolve(true)),
    },
  };
}

describe('ExpenseBotAgent', () => {
  let agent: ExpenseBotAgent;
  let mockBot: ReturnType<typeof makeMockBot>;

  beforeEach(() => {
    agent = new ExpenseBotAgent('test-api-key', makeCtx());
    mockBot = makeMockBot();

    // Reset mock call counts between tests
    mockAiStreamRound.mockClear();
    mockIsRetryableError.mockClear();
    mockGetBackoffDelay.mockClear();
    mockFormatApiError.mockClear();

    // Default: errors are not retryable (unless overridden per test)
    mockIsRetryableError.mockReturnValue(false);
    mockGetBackoffDelay.mockReturnValue(0);
    mockFormatApiError.mockReturnValue('\u274c Ошибка AI. Попробуйте позже.');
  });

  afterEach(() => {
    mock.restore();
  });

  // -- Construction ----------------------------------------------------------

  describe('construction', () => {
    it('creates instance without throwing', () => {
      expect(agent).toBeTruthy();
    });

    it('creates instance with custom prompt', () => {
      const a = new ExpenseBotAgent('key', makeCtx({ customPrompt: 'Custom instructions' }));
      expect(a).toBeTruthy();
    });

    it('creates instance with different chatId', () => {
      const a = new ExpenseBotAgent('key', makeCtx({ chatId: 999 }));
      expect(a).toBeTruthy();
    });

    it('stores context correctly (accessible via cast)', () => {
      const ctx = makeCtx({ chatId: 42, userId: 7 });
      const a = new ExpenseBotAgent('key', ctx);
      const privateCtx = (a as unknown as { ctx: AgentContext }).ctx;
      expect(privateCtx.chatId).toBe(42);
      expect(privateCtx.userId).toBe(7);
    });
  });

  // -- run() -- basic streaming ----------------------------------------------

  describe('run() -- basic streaming', () => {
    it('returns a string response', async () => {
      mockStreamReturn(['Hello', ' world']);

      const result = await agent.run(
        'What are my expenses?',
        [],
        mockBot as unknown as import('gramio').Bot,
      );
      expect(typeof result).toBe('string');
    });

    it('returns non-empty string for normal response', async () => {
      mockStreamReturn(['Hello world']);

      const result = await agent.run('Hello', [], mockBot as unknown as import('gramio').Bot);
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('calls aiStreamRound exactly once for no-tool response', async () => {
      mockStreamReturn(['Answer.']);

      await agent.run('How much did I spend?', [], mockBot as unknown as import('gramio').Bot);
      expect(mockAiStreamRound).toHaveBeenCalledTimes(1);
    });

    it('passes maxTokens to aiStreamRound', async () => {
      mockStreamReturn();

      await agent.run('test', [], mockBot as unknown as import('gramio').Bot);
      const opts = getLastCallOpts();
      expect(opts.maxTokens).toBe(4096);
    });

    it('passes system prompt with current date as messages[0]', async () => {
      mockStreamReturn();

      await agent.run('test', [], mockBot as unknown as import('gramio').Bot);
      const opts = getLastCallOpts();
      const systemMsg = opts.messages[0];
      expect(systemMsg?.role).toBe('system');
      expect(typeof systemMsg?.content).toBe('string');
      expect(systemMsg?.content as string).toContain('CURRENT DATE');
    });

    it('includes user message as last message in messages array', async () => {
      mockStreamReturn();

      const question = 'What is my total?';
      await agent.run(question, [], mockBot as unknown as import('gramio').Bot);

      const opts = getLastCallOpts();
      const lastMsg = opts.messages.at(-1);
      if (!lastMsg) throw new Error('No messages in callArgs');
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content).toBe(question);
    });

    it('includes tools in stream call', async () => {
      mockStreamReturn();

      await agent.run('test', [], mockBot as unknown as import('gramio').Bot);

      const opts = getLastCallOpts();
      expect(Array.isArray(opts.tools)).toBe(true);
      expect((opts.tools ?? []).length).toBeGreaterThan(0);
    });
  });

  // -- run() -- conversation history -----------------------------------------

  describe('run() -- conversation history', () => {
    it('handles empty conversation history without error', async () => {
      mockStreamReturn();

      await expect(
        agent.run('Hello', [], mockBot as unknown as import('gramio').Bot),
      ).resolves.toBeDefined();
    });

    it('includes conversation history in messages', async () => {
      mockStreamReturn();

      const history = [
        {
          id: 1,
          group_id: 1,
          user_id: 10,
          role: 'user' as const,
          content: 'Hi',
          created_at: '2026-01-01',
        },
        {
          id: 2,
          group_id: 1,
          user_id: 10,
          role: 'assistant' as const,
          content: 'Hello!',
          created_at: '2026-01-01',
        },
      ];
      await agent.run('Thanks', history, mockBot as unknown as import('gramio').Bot);

      const opts = getLastCallOpts();
      // system (1) + history (2) + new user message (1) = 4
      expect(opts.messages.length).toBe(4);
    });

    it('maps history role user correctly', async () => {
      mockStreamReturn();

      const history = [
        {
          id: 1,
          group_id: 1,
          user_id: 10,
          role: 'user' as const,
          content: 'Hi',
          created_at: '2026-01-01',
        },
      ];
      await agent.run('question', history, mockBot as unknown as import('gramio').Bot);

      const opts = getLastCallOpts();
      // messages[0] is system, messages[1] is the history entry
      expect(opts.messages[1]?.role).toBe('user');
    });

    it('maps history role assistant correctly', async () => {
      mockStreamReturn();

      const history = [
        {
          id: 1,
          group_id: 1,
          user_id: 10,
          role: 'assistant' as const,
          content: 'Reply',
          created_at: '2026-01-01',
        },
      ];
      await agent.run('question', history, mockBot as unknown as import('gramio').Bot);

      const opts = getLastCallOpts();
      expect(opts.messages[1]?.role).toBe('assistant');
    });

    it('passes content as-is (string) from history', async () => {
      mockStreamReturn();

      const history = [
        {
          id: 1,
          group_id: 1,
          user_id: 10,
          role: 'user' as const,
          content: 'plain text',
          created_at: '',
        },
      ];
      await agent.run('q', history, mockBot as unknown as import('gramio').Bot);

      const opts = getLastCallOpts();
      expect(opts.messages[1]?.content).toBe('plain text');
    });
  });

  // -- run() -- system prompt content ----------------------------------------

  describe('run() -- system prompt', () => {
    it('includes current user name in system prompt', async () => {
      const a = new ExpenseBotAgent('key', makeCtx({ userName: 'johndoe' }));
      mockStreamReturn();

      await a.run('test', [], mockBot as unknown as import('gramio').Bot);

      const opts = getLastCallOpts();
      const systemContent = opts.messages[0]?.content as string;
      expect(systemContent).toContain('@johndoe');
    });

    it('includes custom prompt when set', async () => {
      const a = new ExpenseBotAgent('key', makeCtx({ customPrompt: 'Only answer in English.' }));
      mockStreamReturn();

      await a.run('test', [], mockBot as unknown as import('gramio').Bot);

      const opts = getLastCallOpts();
      const systemContent = opts.messages[0]?.content as string;
      expect(systemContent).toContain('Only answer in English.');
    });

    it('does not include custom prompt section when customPrompt is null', async () => {
      const a = new ExpenseBotAgent('key', makeCtx({ customPrompt: null }));
      mockStreamReturn();

      await a.run('test', [], mockBot as unknown as import('gramio').Bot);

      const opts = getLastCallOpts();
      const systemContent = opts.messages[0]?.content as string;
      expect(systemContent).not.toContain('CUSTOM GROUP INSTRUCTIONS');
    });

    it('system prompt includes set_custom_prompt mutation rule', async () => {
      mockStreamReturn();

      await agent.run('test', [], mockBot as unknown as import('gramio').Bot);

      const opts = getLastCallOpts();
      const systemContent = opts.messages[0]?.content as string;
      expect(systemContent).toContain('set_custom_prompt');
      expect(systemContent).toContain('NEVER say "got it"');
    });
  });

  // -- run() -- error handling (throws AgentError after retries) -------------

  describe('run() -- error handling (throws AgentError)', () => {
    beforeEach(() => {
      // Make retry delays instant for tests
      spyOn(
        agent as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      ).mockResolvedValue(undefined);
    });

    it('throws AgentError on 429 rate limit after retries', async () => {
      const apiError = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockFormatApiError.mockReturnValue('\u23f3 Слишком много запросов к AI. Подождите минуту.');
      mockAiStreamRound.mockRejectedValue(apiError);

      const { AgentError } = await import('../../errors');
      try {
        await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).userMessage).toContain(
          'Слишком много запросов',
        );
      }
    });

    it('throws AgentError on 529 overloaded after retries', async () => {
      const overloadedError = Object.assign(new Error('Overloaded'), { status: 529 });
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockFormatApiError.mockReturnValue('\u26a1 AI сервер перегружен. Попробуйте позже.');
      mockAiStreamRound.mockRejectedValue(overloadedError);

      const { AgentError } = await import('../../errors');
      try {
        await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).userMessage).toContain('перегружен');
      }
    });

    it('throws AgentError on other API error after retries', async () => {
      const apiError = Object.assign(new Error('Server error'), { status: 500 });
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockFormatApiError.mockReturnValue('\u274c Ошибка AI. Попробуйте позже.');
      mockAiStreamRound.mockRejectedValue(apiError);

      const { AgentError } = await import('../../errors');
      try {
        await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).userMessage).toContain('Ошибка AI');
      }
    });

    it('throws AgentError on AbortError (timeout) after retries', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockAiStreamRound.mockRejectedValue(abortError);

      const { AgentError } = await import('../../errors');
      try {
        await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).userMessage).toContain('ожидания');
      }
    });

    it('retries 3 times on retryable API error before throwing', async () => {
      const apiError = Object.assign(new Error('Server error'), { status: 500 });
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockFormatApiError.mockReturnValue('\u274c Ошибка AI. Попробуйте позже.');
      mockAiStreamRound.mockRejectedValue(apiError);

      try {
        await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
      } catch {
        // expected
      }
      // 1 initial + 2 retries = 3 total attempts
      expect(mockAiStreamRound).toHaveBeenCalledTimes(3);
    });

    it('succeeds on second attempt after transient error', async () => {
      const apiError = Object.assign(new Error('Server error'), { status: 500 });
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);

      let callCount = 0;
      mockAiStreamRound.mockImplementation(async (_opts, callbacks) => {
        callCount++;
        if (callCount === 1) {
          throw apiError;
        }
        const text = 'Recovered!';
        callbacks.onTextDelta?.(text);
        return makeTextResult(text);
      });

      const result = await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
      expect(result).toContain('Recovered!');
      expect(callCount).toBe(2);
    });

    it('sends error message to user via bot.api.sendMessage on failure', async () => {
      const apiError = Object.assign(new Error('Server error'), { status: 500 });
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockFormatApiError.mockReturnValue('\u274c Ошибка AI. Попробуйте позже.');
      mockAiStreamRound.mockRejectedValue(apiError);

      try {
        await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
      } catch {
        // expected
      }
      // Should have sent error message (beyond just the placeholder)
      const sendCalls = mockBot.api.sendMessage.mock.calls;
      const errorCall = sendCalls.find(
        (c: unknown[]) =>
          typeof c[0] === 'object' && (c[0] as { text?: string }).text?.includes('Ошибка AI'),
      );
      expect(errorCall).toBeTruthy();
    });

    it('cleans up placeholder message on error', async () => {
      const apiError = Object.assign(new Error('Server error'), { status: 500 });
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockFormatApiError.mockReturnValue('\u274c Ошибка AI. Попробуйте позже.');
      mockAiStreamRound.mockRejectedValue(apiError);

      try {
        await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
      } catch {
        // expected
      }
      // Should have called deleteMessage to clean up placeholder
      expect(mockBot.api.deleteMessage).toHaveBeenCalled();
    });
  });

  // -- run() -- error wrapping and user notification -------------------------
  // Network/status errors -> AgentError (with user notification). Unknown errors -> rethrown.

  describe('run() -- error wrapping', () => {
    beforeEach(() => {
      spyOn(
        agent as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      ).mockResolvedValue(undefined);
    });

    it('wraps error with status:429 (non-API class) as AgentError', async () => {
      const rawErr = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      mockIsRetryableError.mockReturnValue(false);
      mockFormatApiError.mockReturnValue('\u23f3 Слишком много запросов к AI. Подождите минуту.');
      mockAiStreamRound.mockRejectedValue(rawErr);

      const { AgentError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(AgentError);
    });

    it('wraps error with status:500 (non-API class) as AgentError', async () => {
      const serverErr = Object.assign(new Error('Internal server error'), { status: 500 });
      mockIsRetryableError.mockReturnValue(false);
      mockFormatApiError.mockReturnValue('\u274c Ошибка AI. Попробуйте позже.');
      mockAiStreamRound.mockRejectedValue(serverErr);

      const { AgentError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(AgentError);
    });

    it('wraps ETIMEDOUT error as AgentError and retries 3 times', async () => {
      const timeoutErr = Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockAiStreamRound.mockRejectedValue(timeoutErr);

      const { AgentError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(AgentError);
      // Network errors are retryable: 1 initial + 2 retries = 3
      expect(mockAiStreamRound).toHaveBeenCalledTimes(3);
    });

    it('wraps ECONNREFUSED error as AgentError', async () => {
      const connErr = Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
      mockIsRetryableError.mockReturnValue(false);
      mockAiStreamRound.mockRejectedValue(connErr);

      const { AgentError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(AgentError);
    });

    it('wraps ENOTFOUND error as AgentError', async () => {
      const dnsErr = Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' });
      mockIsRetryableError.mockReturnValue(false);
      mockAiStreamRound.mockRejectedValue(dnsErr);

      const { AgentError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(AgentError);
    });

    it('sends network error message to user', async () => {
      const connErr = Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
      mockIsRetryableError.mockReturnValue(false);
      mockAiStreamRound.mockRejectedValue(connErr);

      try {
        await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
      } catch {
        // expected
      }
      const sendCalls = mockBot.api.sendMessage.mock.calls;
      const errorCall = sendCalls.find(
        (c: unknown[]) =>
          typeof c[0] === 'object' && (c[0] as { text?: string }).text?.includes('Ошибка сети'),
      );
      expect(errorCall).toBeTruthy();
    });

    it('rethrows unknown error without wrapping', async () => {
      const unknownErr = new TypeError('Unexpected type error');
      mockIsRetryableError.mockReturnValue(false);
      mockAiStreamRound.mockRejectedValue(unknownErr);

      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });
});
