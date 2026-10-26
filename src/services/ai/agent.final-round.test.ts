// src/services/ai/agent.final-round.test.ts
// Tests for ExpenseBotAgent — multi-round runs, the forced final round, empty answers and [SKIP]

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Bot } from 'gramio';
import {
  aiDebugLogger,
  CHAIN,
  ExpenseBotAgent,
  firstAvailable,
  getLastCallOpts,
  logMock,
  makeCtx,
  makeMockBot,
  makeTextResult,
  makeToolCallResult,
  mockAiStreamRound,
  mockClassifyAiError,
  mockExecuteTool,
  mockGetBackoffDelay,
  mockIsRetryableError,
  mockStreamReturn,
  mockToolCallRound,
  mockValidateResponse,
  resetAgentMocks,
  TOOL_DEFINITIONS,
} from './agent-test-harness';
import { AiDebugRunContext } from './debug-logger';
import type { StreamRoundResult } from './streaming';
import { NO_ANSWER_MESSAGE } from './telegram-stream';

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

  // -- run() -- multi-round completion & overall timeout ---------------------

  describe('run() -- multi-round completion', () => {
    beforeEach(() => {
      mockExecuteTool.mockClear();
      spyOn(
        agent as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      ).mockResolvedValue(undefined);
    });

    it('completes a 3-round query (tool, tool, final text) without an overall abort', async () => {
      // Problem B regression: a legitimate multi-round query must finish. Each round
      // is a separate aiStreamRound call — the first two request tool calls, the third
      // returns the final answer. With mocks there is no real wall-clock delay, so this
      // guards that the tool loop completes across rounds and the agent returns the text.
      mockAiStreamRound
        .mockImplementationOnce(async () => makeToolCallResult('get_expenses'))
        .mockImplementationOnce(async () => makeToolCallResult('calculate'))
        .mockImplementationOnce(async (_opts, callbacks) => {
          const text = 'Final answer after 3 rounds';
          callbacks.onTextDelta?.(text);
          return makeTextResult(text);
        });

      const result = await agent.run(
        'How much did I spend last month?',
        [],
        mockBot as unknown as import('gramio').Bot,
      );

      expect(result).toContain('Final answer after 3 rounds');
      expect(mockAiStreamRound).toHaveBeenCalledTimes(3);
      expect(mockExecuteTool).toHaveBeenCalledTimes(2);
    });

    it('overall-deadline abort yields the timeout message, not the generic AI error', async () => {
      // Acceptance criterion 3: a truly-stuck run is bounded by the overall cap and
      // surfaces "Время ожидания истекло", NOT "Ошибка AI". The streaming layer throws
      // a plain Error with name='AbortError' when the overall signal fires.
      const abortError = new Error('AI overall deadline exceeded');
      abortError.name = 'AbortError';
      mockIsRetryableError.mockReturnValue(true);
      mockGetBackoffDelay.mockReturnValue(0);
      mockClassifyAiError.mockReturnValue({
        kind: 'timeout',
        userMessage: '⏳ Время ожидания истекло. Попробуйте ещё раз.',
      });
      mockAiStreamRound.mockRejectedValue(abortError);

      const { AgentError } = await import('../../errors');
      try {
        await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AgentError);
        expect((err as InstanceType<typeof AgentError>).userMessage).toContain('ожидания');
        expect((err as InstanceType<typeof AgentError>).userMessage).not.toContain('Ошибка AI');
      }
    });
  });

  // Prod incident 2026-10-12: a model without parallel tool calls spent every round on one
  // `calculate` each, hit the round cap and finished with empty text — the user got either
  // silence (non-mention → treated as [SKIP]) or a message made only of ✅ tool lines. Since
  // HYP-1716 such a run is nudged, handed off twice and then forced to answer.
  describe('run() -- forced final round and empty answers', () => {
    /**
     * Every round that offers tools gets another distinct calculate call back, answered by the
     * first provider the round did not exclude. Returns the providers that answered, per round.
     */
    function mockEndlessToolCalls(finalText: string) {
      const answeredBy: Array<{ provider: string; excluded: readonly string[] }> = [];
      let n = 0;
      mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
        const excluded = opts.excludeProviders ?? [];
        const provider = firstAvailable(excluded) ?? 'none';
        answeredBy.push({ provider, excluded });
        if (opts.toolChoice !== 'none') {
          n++;
          const args = JSON.stringify({ expression: `${n} RSD`, target_currency: 'EUR' });
          callbacks.onToolCallStart?.('calculate');
          return {
            text: '',
            toolCalls: [{ id: `call_${n}`, name: 'calculate', arguments: args }],
            finishReason: 'tool_calls',
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${n}`,
                  type: 'function',
                  function: { name: 'calculate', arguments: args },
                },
              ],
            },
            providerUsed: provider,
          } satisfies StreamRoundResult;
        }
        if (finalText) callbacks.onTextDelta?.(finalText);
        return { ...makeTextResult(finalText), providerUsed: provider };
      });
      return answeredBy;
    }

    function lastEditedText(): string {
      const calls = mockBot.api.editMessageText.mock.calls as unknown as Array<[{ text: string }]>;
      return calls.at(-1)?.[0].text ?? '';
    }

    beforeEach(() => {
      mockAiStreamRound.mockReset();
      logMock.warn.mockClear();
      logMock.info.mockClear();
      spyOn(
        agent as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      ).mockResolvedValue(undefined);
    });

    it('forces one final round with tool calls forbidden once the stall ladder runs out, and returns its text', async () => {
      const mentionAgent = new ExpenseBotAgent('key', makeCtx({ isMention: true }));
      const answeredBy = mockEndlessToolCalls('Итого: 1 000 EUR');

      const result = await mentionAgent.run(
        'Сумма по категориям в евро',
        [],
        mockBot as unknown as Bot,
      );

      expect(result).toBe('Итого: 1 000 EUR');
      const lastOpts = getLastCallOpts();
      // Tools stay declared (the history holds tool calls) but tool_choice forbids new ones.
      expect(lastOpts.toolChoice).toBe('none');
      expect(lastOpts.tools).toEqual(TOOL_DEFINITIONS);
      // The forced round tells the model to answer now from what it already gathered.
      expect(JSON.stringify(lastOpts.messages.at(-1))).toContain('[SYSTEM]');
      // The mocked tool returns the same result every time: nudge after round 4 (calculate
      // streak), round 5 ignores it → handoff; then every 3 rounds of nothing new — handoff
      // after 8, finalize after 11.
      expect(mockAiStreamRound).toHaveBeenCalledTimes(12);
      expect(logMock.warn).toHaveBeenCalled();
      // Each handoff really changed the model: no round was answered by an excluded provider.
      expect(answeredBy.every(({ provider, excluded }) => !excluded.includes(provider))).toBe(true);
      expect(new Set(answeredBy.map(({ provider }) => provider))).toEqual(
        new Set(CHAIN.slice(0, 3)),
      );
    });

    it('never runs a tool call the forced final round returns despite tool_choice none, and logs it', async () => {
      // A provider that ignores tool_choice 'none' must not get a tool executed past the cap.
      let n = 0;
      mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
        n++;
        if (opts.toolChoice === 'none') {
          callbacks.onTextDelta?.('Итого: 2001 EUR');
          return { ...makeToolCallResult('add_expense'), text: 'Итого: 2001 EUR' };
        }
        return {
          ...makeToolCallResult('calculate'),
          toolCalls: [{ id: `c${n}`, name: 'calculate', arguments: `{"expression":"${n}"}` }],
        };
      });

      const result = await agent.run('сумма в евро', [], mockBot as unknown as Bot);

      expect(result).toBe('Итого: 2001 EUR');
      expect(mockExecuteTool.mock.calls.map((c) => c[0])).not.toContain('add_expense');
      expect(mockExecuteTool).toHaveBeenCalledTimes(11);
      expect(logMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ toolCalls: ['add_expense'] }),
        expect.stringContaining('ignored'),
      );
    });

    it('never treats an empty answer after tool calls as [SKIP] — shows a failure message instead', async () => {
      // Default ctx is a non-mention run: before the fix this deleted the message silently.
      mockEndlessToolCalls('');

      const result = await agent.run(
        'Объедини по категориям и выведи сумму в евро',
        [],
        mockBot as unknown as Bot,
      );

      expect(mockBot.api.deleteMessage).not.toHaveBeenCalled();
      expect(result).toBe(NO_ANSWER_MESSAGE);
      // The shipped message carries the failure text, not only ✅ tool lines.
      expect(lastEditedText()).toContain(NO_ANSWER_MESSAGE);
    });

    it('replaces a [SKIP] emitted after tool calls in a mention with the failure message', async () => {
      const mentionAgent = new ExpenseBotAgent('key', makeCtx({ isMention: true }));
      mockToolCallRound('get_expenses');
      mockStreamReturn(['[SKIP]']);

      const result = await mentionAgent.run('сколько потратили?', [], mockBot as unknown as Bot);

      expect(result).toBe(NO_ANSWER_MESSAGE);
      expect(lastEditedText()).not.toContain('[SKIP]');
    });

    it('keeps an intentional [SKIP] from a non-mention run without tool calls silent', async () => {
      mockStreamReturn(['[SKIP]']);

      const result = await agent.run('надо будет обсудить', [], mockBot as unknown as Bot);

      expect(result).toBe('');
      expect(mockBot.api.deleteMessage).toHaveBeenCalled();
    });

    it('stays silent when the validator retry of a non-mention run emits [SKIP] (#108)', async () => {
      mockStreamReturn(['initial bad answer']);
      mockStreamReturn(['[SKIP]']);
      mockValidateResponse.mockResolvedValueOnce({ approved: false, reason: 'no tools' });

      const result = await agent.run('ну ок', [], mockBot as unknown as Bot);

      expect(result).toBe('');
      expect(mockBot.api.deleteMessage).toHaveBeenCalled();
    });

    it('keeps an explicit [SKIP] from a non-mention run that only read data silent', async () => {
      // Chatter the model looked into (a read) and then chose not to answer: nothing changed,
      // so silence is still the right outcome.
      mockToolCallRound('get_expenses', '{"period":"2026-10"}');
      mockStreamReturn(['[SKIP]']);

      const result = await agent.run('ну мы и потратили в октябре', [], mockBot as unknown as Bot);

      expect(result).toBe('');
      expect(mockBot.api.deleteMessage).toHaveBeenCalled();
    });

    it('shows the failure message for a non-mention [SKIP] after a write tool ran', async () => {
      // A write changed data — the user must see a reply, never a silent change.
      mockToolCallRound('add_expense', '{"amount":100}');
      mockStreamReturn(['[SKIP]']);

      const result = await agent.run('100 еда', [], mockBot as unknown as Bot);

      expect(result).toBe(NO_ANSWER_MESSAGE);
      expect(mockBot.api.deleteMessage).not.toHaveBeenCalled();
    });

    it('remembers a write from an attempt that failed and was retried — no silent [SKIP] after it', async () => {
      // Attempt 1 adds the expense, then the provider fails; the retry only reads and skips.
      mockIsRetryableError.mockReturnValue(true);
      mockToolCallRound('add_expense', '{"amount":100}');
      mockAiStreamRound.mockImplementationOnce(async () => {
        throw Object.assign(new Error('Server error'), { status: 500 });
      });
      mockToolCallRound('get_expenses', '{"period":"2026-10"}');
      mockStreamReturn(['[SKIP]']);

      const result = await agent.run('100 еда', [], mockBot as unknown as Bot);

      expect(mockExecuteTool.mock.calls.map((c) => c[0])).toEqual(['add_expense', 'get_expenses']);
      expect(result).toBe(NO_ANSWER_MESSAGE);
      expect(mockBot.api.deleteMessage).not.toHaveBeenCalled();
      expect(logMock.warn).toHaveBeenCalledWith(expect.stringContaining('retrying'));
    });

    it('shows the failure message when a non-mention run ends with no text after read-only tools', async () => {
      // Empty text is not the model choosing silence (prod 2026-10-12), even after reads only.
      mockToolCallRound('get_expenses', '{"period":"2026-10"}');
      mockStreamReturn([]);

      const result = await agent.run('сколько потратили', [], mockBot as unknown as Bot);

      expect(result).toBe(NO_ANSWER_MESSAGE);
      expect(mockBot.api.deleteMessage).not.toHaveBeenCalled();
    });

    it('shows the failure message for a non-mention [SKIP] from the forced final round', async () => {
      // The round cap was hit: the run is exhausted, not a choice to stay silent.
      mockEndlessToolCalls('[SKIP]');

      const result = await agent.run('сумма в евро', [], mockBot as unknown as Bot);

      expect(result).toBe(NO_ANSWER_MESSAGE);
      expect(mockBot.api.deleteMessage).not.toHaveBeenCalled();
    });

    it('returns the cached result for an identical repeated read-only tool call', async () => {
      mockToolCallRound('calculate', '{"expression":"52829.45 RSD","target_currency":"EUR"}');
      // Same call with reordered keys — still the same normalized arguments.
      mockToolCallRound('calculate', '{"target_currency":"EUR","expression":"52829.45 RSD"}');
      mockToolCallRound('calculate', '{"expression":"52829.45 RSD","target_currency":"EUR"}');
      mockStreamReturn(['450 EUR']);
      mockExecuteTool.mockResolvedValue({ success: true, output: '450 EUR' });

      const result = await agent.run('сколько в евро', [], mockBot as unknown as Bot);

      expect(result).toBe('450 EUR');
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
      const toolMessages = getLastCallOpts().messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(3);
      expect(String(toolMessages[0]?.content)).toBe('450 EUR');
      expect(String(toolMessages[1]?.content)).toContain('already');
      expect(String(toolMessages[1]?.content)).toContain('450 EUR');
      expect(String(toolMessages[2]?.content)).toContain('already');
    });

    it('re-executes a read tool after a mutating tool changed the data', async () => {
      mockToolCallRound('get_budgets', '{"month":"2026-10"}');
      mockToolCallRound('set_budget', '{"category":"Еда","amount":100}');
      mockToolCallRound('get_budgets', '{"month":"2026-10"}');
      mockStreamReturn(['Бюджет обновлён']);

      await agent.run('поставь бюджет', [], mockBot as unknown as Bot);

      expect(mockExecuteTool.mock.calls.map((c) => c[0])).toEqual([
        'get_budgets',
        'set_budget',
        'get_budgets',
      ]);
    });

    it('re-executes a read tool after another read pulled fresh data from Sheets', async () => {
      // get_expenses syncs expenses from Google Sheets first, so budget spending read before it
      // may be stale afterwards.
      mockToolCallRound('get_budgets', '{"month":"2026-10"}');
      mockToolCallRound('get_expenses', '{"period":"2026-10","summary_only":true}');
      mockToolCallRound('get_budgets', '{"month":"2026-10"}');
      mockStreamReturn(['Сводка']);

      await agent.run('бюджеты и траты', [], mockBot as unknown as Bot);

      expect(mockExecuteTool.mock.calls.map((c) => c[0])).toEqual([
        'get_budgets',
        'get_expenses',
        'get_budgets',
      ]);
    });

    it('logs the provider that actually answered each round', async () => {
      mockAiStreamRound.mockImplementationOnce(async (_opts, callbacks) => {
        callbacks.onTextDelta?.('ответ');
        return { ...makeTextResult('ответ'), providerUsed: 'Groq (openai/gpt-oss-120b)' };
      });

      await agent.run('вопрос', [], mockBot as unknown as Bot);

      const infoLogs = JSON.stringify(logMock.info.mock.calls);
      expect(infoLogs).toContain('Groq (openai/gpt-oss-120b)');
    });

    describe('chat debug log', () => {
      function spyDebugRun(): AiDebugRunContext {
        const runCtx = new AiDebugRunContext('/dev/null', 10, 123, 'testuser', 'Test User', 'q');
        spyOn(aiDebugLogger, 'createRunContext').mockReturnValue(runCtx);
        spyOn(runCtx, 'flush').mockImplementation(() => undefined);
        return runCtx;
      }

      it('is flushed when the run stays silent on [SKIP]', async () => {
        const runCtx = spyDebugRun();
        mockStreamReturn(['[SKIP]']);

        await agent.run('ок', [], mockBot as unknown as Bot);

        expect(runCtx.flush).toHaveBeenCalledTimes(1);
      });

      it('is flushed when the run fails with an AI error', async () => {
        const runCtx = spyDebugRun();
        mockAiStreamRound.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

        await expect(agent.run('вопрос', [], mockBot as unknown as Bot)).rejects.toThrow();

        expect(runCtx.flush).toHaveBeenCalledTimes(1);
        expect(logMock.error).toHaveBeenCalled();
      });
    });

    it('a failed forced final round shows the failure message instead of redoing every tool', async () => {
      mockIsRetryableError.mockReturnValue(true);
      // Each add_expense adds a new row (new result), so nothing stalls and the 40-round cap ends the run.
      mockExecuteTool.mockImplementation(async (_name, input) => ({
        success: true,
        output: `added ${JSON.stringify(input)}`,
      }));
      let n = 0;
      mockAiStreamRound.mockImplementation(async (opts) => {
        if (opts.toolChoice === 'none')
          throw Object.assign(new Error('overloaded'), { status: 529 });
        n++;
        return {
          ...makeToolCallResult('add_expense'),
          toolCalls: [{ id: `c${n}`, name: 'add_expense', arguments: `{"n":${n}}` }],
        };
      });

      const result = await agent.run('добавь всё', [], mockBot as unknown as Bot);

      expect(result).toBe(NO_ANSWER_MESSAGE);
      expect(mockExecuteTool).toHaveBeenCalledTimes(40);
      expect(logMock.warn).toHaveBeenCalled();
    });

    it.each([
      ['an AbortError', () => Object.assign(new Error('aborted'), { name: 'AbortError' })],
      // The round can also end with a provider error right as the deadline fires.
      ['a retryable 503', () => Object.assign(new Error('unavailable'), { status: 503 })],
    ])('a run-deadline abort during the forced final round ending in %s surfaces the timeout without a replay', async (_label, roundError) => {
      // Capture the run-deadline timer (RUN_DEADLINE_MS, 240 s) so the test can fire it mid-round.
      const deadlineHandlers: Array<() => void> = [];
      const realSetTimeout = globalThis.setTimeout;
      // Bun types setTimeout with overloads and __promisify__, which a plain function can't satisfy.
      const capturingSetTimeout = ((handler: () => void, ms?: number) => {
        if (ms === 240_000) deadlineHandlers.push(handler);
        return realSetTimeout(handler, ms);
      }) as typeof setTimeout;
      spyOn(globalThis, 'setTimeout').mockImplementation(capturingSetTimeout);
      mockIsRetryableError.mockReturnValue(true);
      mockClassifyAiError.mockImplementation((error) =>
        error instanceof Error && error.name === 'AbortError'
          ? { kind: 'timeout', userMessage: '⏳ Время ожидания истекло. Попробуй ещё раз.' }
          : { kind: 'generic', userMessage: '❌ Ошибка AI. Попробуй позже.' },
      );
      mockExecuteTool.mockImplementation(async (_name, input) => ({
        success: true,
        output: `added ${JSON.stringify(input)}`,
      }));
      let n = 0;
      mockAiStreamRound.mockImplementation(async (opts) => {
        if (opts.toolChoice === 'none') {
          for (const fire of deadlineHandlers) fire();
          throw roundError();
        }
        n++;
        return {
          ...makeToolCallResult('add_expense'),
          toolCalls: [{ id: `c${n}`, name: 'add_expense', arguments: `{"n":${n}}` }],
        };
      });

      const { AgentError } = await import('../../errors');
      const error = await agent.run('добавь всё', [], mockBot as unknown as Bot).catch((e) => e);

      expect(error).toBeInstanceOf(AgentError);
      expect((error as InstanceType<typeof AgentError>).userMessage).toContain('ожидания');
      // No replay: 40 tool rounds + the forced round, every add_expense ran once.
      expect(mockAiStreamRound).toHaveBeenCalledTimes(41);
      expect(mockExecuteTool).toHaveBeenCalledTimes(40);
      expect(logMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'timeout' }),
        expect.stringContaining('AI run failed'),
      );
    });
  });
});
