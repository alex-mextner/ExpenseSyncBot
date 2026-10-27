// src/services/ai/agent.errors.test.ts
// Tests for ExpenseBotAgent — retries, error classification, AgentError wrapping and admin paging

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Bot } from 'gramio';
import {
  ExpenseBotAgent,
  makeCtx,
  makeMockBot,
  makeTextResult,
  mockAiStreamRound,
  mockClassifyAiError,
  mockGetBackoffDelay,
  mockIsRetryableError,
  mockReportAiFailureToAdmin,
  mockStreamReturn,
  mockToolCallRound,
  resetAgentMocks,
} from './agent-test-harness';

describe('ExpenseBotAgent', () => {
  let agent: ExpenseBotAgent;
  let mockBot: ReturnType<typeof makeMockBot>;

  beforeEach(() => {
    agent = new ExpenseBotAgent('test-api-key', makeCtx());
    mockBot = makeMockBot();
    resetAgentMocks();
  });

  afterEach(() => {
    mock.restore();
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
      mockClassifyAiError.mockReturnValue({
        kind: 'rate_limit',
        userMessage: '\u23f3 Слишком много запросов к AI. Подождите минуту.',
      });
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
      mockClassifyAiError.mockReturnValue({
        kind: 'overloaded',
        userMessage: '\u26a1 AI сервер перегружен. Попробуйте позже.',
      });
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

    it('throws AgentError on provider 5xx (provider_down) after retries', async () => {
      const apiError = Object.assign(new Error('Server error'), { status: 500 });
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockClassifyAiError.mockReturnValue({
        kind: 'provider_down',
        userMessage:
          '⚠️ AI временно недоступен (сбой на стороне провайдера). Уже разбираемся — попробуй через минуту.',
      });
      mockAiStreamRound.mockRejectedValue(apiError);

      const { AgentError } = await import('../../errors');
      try {
        await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).userMessage).toContain(
          'временно недоступен',
        );
      }
    });

    it('throws AgentError on AbortError (timeout) after retries', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockClassifyAiError.mockReturnValue({
        kind: 'timeout',
        userMessage: '\u23f3 Время ожидания истекло. Попробуйте ещё раз.',
      });
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

    it('reports the failure to the admin (fire-and-forget) on a terminal error', async () => {
      const apiError = Object.assign(new Error('Server error'), { status: 500 });
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockAiStreamRound.mockRejectedValue(apiError);

      try {
        await agent.run('change currency', [], mockBot as unknown as import('gramio').Bot);
      } catch {
        // expected
      }
      expect(mockReportAiFailureToAdmin).toHaveBeenCalledTimes(1);
      const [input] = mockReportAiFailureToAdmin.mock.calls[0] as [
        { userMessage: string; error: unknown; telegramGroupId: number },
      ];
      expect(input.userMessage).toContain('change currency');
      expect(input.error).toBe(apiError);
    });

    it('does NOT report to the admin on a successful run', async () => {
      mockStreamReturn(['All good.']);
      await agent.run('hello', [], mockBot as unknown as import('gramio').Bot);
      expect(mockReportAiFailureToAdmin).not.toHaveBeenCalled();
    });

    it('cleans up placeholder message on error', async () => {
      const apiError = Object.assign(new Error('Server error'), { status: 500 });
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
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
      mockClassifyAiError.mockReturnValue({
        kind: 'rate_limit',
        userMessage: '\u23f3 Слишком много запросов к AI. Подождите минуту.',
      });
      mockAiStreamRound.mockRejectedValue(rawErr);

      const { AgentError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(AgentError);
    });

    it('wraps error with status:500 (non-API class) as AgentError', async () => {
      const serverErr = Object.assign(new Error('Internal server error'), { status: 500 });
      mockIsRetryableError.mockReturnValue(false);
      mockClassifyAiError.mockReturnValue({
        kind: 'provider_down',
        userMessage:
          '⚠️ AI временно недоступен (сбой на стороне провайдера). Уже разбираемся — попробуй через минуту.',
      });
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
      mockClassifyAiError.mockReturnValue({
        kind: 'provider_down',
        userMessage:
          '\u26a0\ufe0f AI временно недоступен (сбой на стороне провайдера). Уже разбираемся — попробуй через минуту.',
      });
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
      mockClassifyAiError.mockReturnValue({
        kind: 'provider_down',
        userMessage:
          '\u26a0\ufe0f AI временно недоступен (сбой на стороне провайдера). Уже разбираемся — попробуй через минуту.',
      });
      mockAiStreamRound.mockRejectedValue(connErr);

      const { AgentError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(AgentError);
    });

    it('wraps ENOTFOUND error as AgentError', async () => {
      const dnsErr = Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' });
      mockIsRetryableError.mockReturnValue(false);
      mockClassifyAiError.mockReturnValue({
        kind: 'provider_down',
        userMessage:
          '\u26a0\ufe0f AI временно недоступен (сбой на стороне провайдера). Уже разбираемся — попробуй через минуту.',
      });
      mockAiStreamRound.mockRejectedValue(dnsErr);

      const { AgentError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(AgentError);
    });

    it('sends network error message to user', async () => {
      const connErr = Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
      mockIsRetryableError.mockReturnValue(false);
      mockClassifyAiError.mockReturnValue({
        kind: 'provider_down',
        userMessage:
          '\u26a0\ufe0f AI временно недоступен (сбой на стороне провайдера). Уже разбираемся — попробуй через минуту.',
      });
      mockAiStreamRound.mockRejectedValue(connErr);

      try {
        await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
      } catch {
        // expected
      }
      const sendCalls = mockBot.api.sendMessage.mock.calls;
      const errorCall = sendCalls.find(
        (c: unknown[]) =>
          typeof c[0] === 'object' &&
          (c[0] as { text?: string }).text?.includes('временно недоступен'),
      );
      expect(errorCall).toBeTruthy();
    });

    it('rethrows unknown error without wrapping', async () => {
      const unknownErr = new TypeError('Unexpected type error');
      mockIsRetryableError.mockReturnValue(false);
      mockClassifyAiError.mockReturnValue(null);
      mockAiStreamRound.mockRejectedValue(unknownErr);

      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(TypeError);
      // A non-AI error is not an "AI failure" — it must not be reported to the admin.
      expect(mockReportAiFailureToAdmin).not.toHaveBeenCalled();
    });
  });

  // -- run() -- admin paging gate + user-facing string surfacing -------------
  // Only genuine failures (provider_down / generic) page the admin; transient/user-side classes
  // (rate_limit / overloaded / timeout) surface a user message but must NOT spam the operator.
  // The real error→message mapping is pinned in streaming.test.ts; here we assert the agent SENDS
  // the classified string to the user (via bot.api.sendMessage) and applies the paging gate.
  describe('run() -- admin paging gate and user message surfacing', () => {
    beforeEach(() => {
      spyOn(
        agent as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      ).mockResolvedValue(undefined);
      mockIsRetryableError.mockReturnValue(false); // go straight to the terminal catch
    });

    /** All text strings the agent sent to the user this run (placeholder + error message). */
    function sentText(): string[] {
      return mockBot.api.sendMessage.mock.calls
        .map((c: unknown[]) =>
          typeof c[0] === 'object' ? (c[0] as { text?: string }).text : undefined,
        )
        .filter((t): t is string => typeof t === 'string');
    }

    it('rate_limit (429): surfaces the rate-limit message and does NOT page the admin', async () => {
      mockClassifyAiError.mockReturnValue({
        kind: 'rate_limit',
        userMessage: '⏳ Слишком много запросов к AI. Подожди минуту.',
      });
      mockAiStreamRound.mockRejectedValue(Object.assign(new Error('429'), { status: 429 }));

      await agent
        .run('сколько я потратил', [], mockBot as unknown as import('gramio').Bot)
        .catch(() => {});

      expect(sentText().some((t) => t.includes('Слишком много запросов к AI'))).toBe(true);
      expect(mockReportAiFailureToAdmin).not.toHaveBeenCalled();
    });

    it('overloaded (529): surfaces the overloaded message and does NOT page the admin', async () => {
      mockClassifyAiError.mockReturnValue({
        kind: 'overloaded',
        userMessage: '⚡ AI сервер перегружен. Попробуй позже.',
      });
      mockAiStreamRound.mockRejectedValue(Object.assign(new Error('529'), { status: 529 }));

      await agent
        .run('сколько я потратил', [], mockBot as unknown as import('gramio').Bot)
        .catch(() => {});

      expect(sentText().some((t) => t.includes('перегружен'))).toBe(true);
      expect(mockReportAiFailureToAdmin).not.toHaveBeenCalled();
    });

    it('timeout (60s abort): surfaces the timeout message and does NOT page the admin', async () => {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      mockClassifyAiError.mockReturnValue({
        kind: 'timeout',
        userMessage: '⏳ Время ожидания истекло. Попробуй ещё раз.',
      });
      mockAiStreamRound.mockRejectedValue(abortErr);

      await agent
        .run('сколько я потратил', [], mockBot as unknown as import('gramio').Bot)
        .catch(() => {});

      expect(sentText().some((t) => t.includes('Время ожидания истекло'))).toBe(true);
      expect(mockReportAiFailureToAdmin).not.toHaveBeenCalled();
    });

    it('provider_down (connection/5xx): surfaces the outage message AND pages the admin', async () => {
      mockClassifyAiError.mockReturnValue({
        kind: 'provider_down',
        userMessage:
          '⚠️ AI временно недоступен (сбой на стороне провайдера). Уже разбираемся — попробуй через минуту.',
      });
      mockAiStreamRound.mockRejectedValue(Object.assign(new Error('down'), { code: 'ECONNRESET' }));

      await agent
        .run('сколько я потратил', [], mockBot as unknown as import('gramio').Bot)
        .catch(() => {});

      expect(sentText().some((t) => t.includes('временно недоступен'))).toBe(true);
      expect(mockReportAiFailureToAdmin).toHaveBeenCalledTimes(1);
    });

    it('exhausted-chain empty-response (generic): user gets the generic message AND the admin is paged (no silent rethrow)', async () => {
      // Regression for the empty-response bypass: classifyAiError now returns generic (not null) for
      // the "All N providers … chain failed" empty-response aggregate (pinned in streaming.test.ts),
      // so the agent surfaces a user message and pages the admin via the generic path instead of
      // rethrowing the raw aggregate after deleting the in-progress message.
      const emptyAggregate = new Error(
        'All 3 providers in smart chain failed: z.ai (glm): Provider z.ai (glm) returned empty ' +
          'response (no text, no tool calls) — treating as failure; Claude (c): returned empty ' +
          'response; HF (h): returned empty response',
      );
      mockClassifyAiError.mockReturnValue({
        kind: 'generic',
        userMessage: '❌ Ошибка AI. Попробуй позже.',
      });
      mockAiStreamRound.mockRejectedValue(emptyAggregate);

      const { AgentError } = await import('../../errors');
      await expect(
        agent.run('сколько я потратил', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(AgentError); // AgentError, NOT the raw aggregate rethrown

      expect(sentText().some((t) => t.includes('Ошибка AI'))).toBe(true);
      expect(mockReportAiFailureToAdmin).toHaveBeenCalledTimes(1);
    });

    it('an AI failure after tools keeps the work log and shows the error under it', async () => {
      // Owner 2026-10-12: the work log is always on top of a reply that used tools — a write tool
      // may already have changed data, so deleting the message would hide what was done.
      mockClassifyAiError.mockReturnValue({
        kind: 'rate_limit',
        userMessage: '⏳ Слишком много запросов к AI. Подожди минуту.',
      });
      mockAiStreamRound.mockRejectedValue(Object.assign(new Error('429'), { status: 429 }));
      mockToolCallRound('get_expenses', '{"period":"2026-10"}');

      await agent.run('сколько я потратил', [], mockBot as unknown as Bot).catch(() => {});

      expect(mockBot.api.deleteMessage).not.toHaveBeenCalled();
      const edits = mockBot.api.editMessageText.mock.calls as unknown as Array<[{ text: string }]>;
      const shown = edits.at(-1)?.[0].text ?? '';
      expect(shown.startsWith('<blockquote expandable>')).toBe(true);
      expect(shown).toContain('Загружаю расходы: 2026-10');
      expect(shown.endsWith('⏳ Слишком много запросов к AI. Подожди минуту.')).toBe(true);
    });

    it('a write tool, then AI errors through every retry: the work log still shows the write', async () => {
      mockIsRetryableError.mockReturnValue(true);
      mockClassifyAiError.mockReturnValue({
        kind: 'rate_limit',
        userMessage: '⏳ Слишком много запросов к AI. Подожди минуту.',
      });
      mockAiStreamRound.mockRejectedValue(Object.assign(new Error('429'), { status: 429 }));
      mockToolCallRound('add_expense', '{"amount":5,"currency":"EUR","category":"Еда"}');

      await agent.run('запиши 5 евро еда', [], mockBot as unknown as Bot).catch(() => {});

      expect(mockBot.api.deleteMessage).not.toHaveBeenCalled();
      const edits = mockBot.api.editMessageText.mock.calls as unknown as Array<[{ text: string }]>;
      const shown = edits.at(-1)?.[0].text ?? '';
      expect(shown).toContain('Записываю расход: 5 EUR, Еда');
      expect(shown.endsWith('⏳ Слишком много запросов к AI. Подожди минуту.')).toBe(true);
    });
  });
});
