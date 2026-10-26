// src/services/ai/agent.stall-guard.test.ts
// Tests for ExpenseBotAgent — stall guard nudge, handoff, forced answer and trajectory rows (HYP-1716)

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Bot } from 'gramio';
import {
  CHAIN,
  database,
  ExpenseBotAgent,
  firstAvailable,
  getLastCallOpts,
  logMock,
  makeCtx,
  makeMockBot,
  makeTextResult,
  makeToolCallResult,
  mockAiStreamRound,
  mockExecuteTool,
  mockIsRetryableError,
  mockNextProvider,
  mockOneConversionPerRound,
  mockStreamReturn,
  mockToolCallRound,
  mockValidateResponse,
  resetAgentMocks,
  resetStallGuardMocks,
  trajectories,
  trajectoryRounds,
} from './agent-test-harness';
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

  describe('run() -- stall guard: nudge, handoff, forced answer, trajectory (HYP-1716)', () => {
    const streamCalls = () => mockAiStreamRound.mock.calls.map(([opts]) => opts);
    const shownTexts = () => JSON.stringify(mockBot.api.editMessageText.mock.calls);

    beforeEach(() => {
      resetStallGuardMocks();
    });

    it('nudges after 4 one-at-a-time conversions, hands off twice, then forces the answer', async () => {
      const mentionAgent = new ExpenseBotAgent('key', makeCtx({ isMention: true }));
      const seen = mockOneConversionPerRound('Итого: 1 639 EUR');

      const result = await mentionAgent.run('Сумма в евро', [], mockBot as unknown as Bot);

      expect(result).toBe('Итого: 1 639 EUR');
      const calls = streamCalls();
      expect(calls).toHaveLength(14);
      // Nudge after round 4: same provider, a [SYSTEM] note after the tool result.
      expect(calls[4]?.excludeProviders).toEqual([]);
      expect(seen[4]?.lastMessage).toContain('going in circles');
      // Round 5 ignores the nudge → handoff: Groq is out for the rest of the run, history stays.
      expect(calls[5]?.excludeProviders).toEqual(['Groq (gpt-oss-120b)']);
      expect(seen[5]?.lastMessage).toContain('taking over');
      expect(seen[5]?.toolResults).toBe(5);
      // The new model starts clean: second handoff after 4 more such rounds (round 9).
      expect(calls[9]?.excludeProviders).toEqual(['Groq (gpt-oss-120b)', 'z.ai (glm-5.1)']);
      // After round 13 the ladder is spent: the forced round runs without the stalled providers.
      expect(calls[13]?.toolChoice).toBe('none');
      expect(calls[13]?.excludeProviders).toEqual(['Groq (gpt-oss-120b)', 'z.ai (glm-5.1)']);
      expect(shownTexts()).toContain('🔄 Передаю задачу z.ai (glm-5.1)…');
      expect(shownTexts()).toContain('🔄 Передаю задачу Claude (sonnet)…');
      expect(logMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ signal: 'cheap_tool_streak', from: 'Groq (gpt-oss-120b)' }),
        expect.stringContaining('handing'),
      );

      const [run] = trajectories();
      expect(run).toMatchObject({
        outcome: 'answered',
        is_mention: 1,
        tool_rounds: 13,
        tool_calls: 13,
        nudges: 1,
        handoffs: 2,
        providers: JSON.stringify(CHAIN.slice(0, 3)),
        answer_provider: 'Claude (sonnet)',
        finalize_reason: 'cheap_tool_streak',
      });
      const decisions = trajectoryRounds(run?.id ?? 0).map((r) => `${r.round}:${r.decision}`);
      expect(decisions.filter((d) => !d.endsWith(':continue'))).toEqual([
        '4:nudge',
        '5:handoff',
        '9:handoff',
        '13:finalize',
      ]);
    });

    it('forces the answer instead of handing off when no other provider is left', async () => {
      mockOneConversionPerRound('Итого');
      mockNextProvider.mockReturnValue(null);

      const result = await agent.run('Сумма в евро', [], mockBot as unknown as Bot);

      expect(result).toBe('Итого');
      const calls = streamCalls();
      // Nudge after round 4; round 5 ignores it and, with no provider left, the forced round runs.
      expect(calls).toHaveLength(6);
      expect(calls[5]?.toolChoice).toBe('none');
      expect(calls[5]?.excludeProviders).toEqual([]);
      expect(shownTexts()).not.toContain('Передаю задачу');
      expect(trajectories()[0]).toMatchObject({
        handoffs: 0,
        finalize_reason: 'cheap_tool_streak',
      });
    });

    it('stops a run that never stalls at 40 tool rounds with the forced answer', async () => {
      let n = 0;
      mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
        if (opts.toolChoice === 'none') {
          callbacks.onTextDelta?.('Добавил 40');
          return makeTextResult('Добавил 40');
        }
        n++;
        return {
          ...makeToolCallResult('add_expense'),
          toolCalls: [{ id: `c${n}`, name: 'add_expense', arguments: `{"n":${n}}` }],
        };
      });
      mockExecuteTool.mockImplementation(async (_name, input) => ({
        success: true,
        output: `added ${JSON.stringify(input)}`,
      }));

      const result = await agent.run('добавь всё', [], mockBot as unknown as Bot);

      expect(result).toBe('Добавил 40');
      expect(mockExecuteTool).toHaveBeenCalledTimes(40);
      expect(streamCalls()).toHaveLength(41);
      expect(getLastCallOpts().toolChoice).toBe('none');
      expect(trajectories()[0]).toMatchObject({
        tool_rounds: 40,
        nudges: 0,
        finalize_reason: 'round_cap',
      });
    });

    it('forces the answer once only the final-round reserve is left of the 240 s deadline', async () => {
      let clock = 1_000_000;
      spyOn(agent as unknown as { now: () => number }, 'now').mockImplementation(() => clock);
      const timerDelays: Array<number | undefined> = [];
      const realSetTimeout = globalThis.setTimeout;
      spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
        timerDelays.push(ms);
        return realSetTimeout(handler, ms);
      }) as typeof setTimeout);
      let n = 0;
      mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
        if (opts.toolChoice === 'none') {
          callbacks.onTextDelta?.('Что успел собрать');
          return makeTextResult('Что успел собрать');
        }
        n++;
        clock += 100_000;
        return {
          ...makeToolCallResult('get_expenses'),
          toolCalls: [{ id: `c${n}`, name: 'get_expenses', arguments: `{"page":${n}}` }],
        };
      });
      mockExecuteTool.mockImplementation(async (_name, input) => ({
        success: true,
        output: JSON.stringify(input),
      }));

      const result = await agent.run('все траты', [], mockBot as unknown as Bot);

      expect(result).toBe('Что успел собрать');
      // Round 1 ends at 100 s, round 2 at 200 s — past 240 − 45 s, so the forced round follows.
      expect(streamCalls()).toHaveLength(3);
      expect(getLastCallOpts().toolChoice).toBe('none');
      expect(timerDelays).toContain(240_000);
      expect(trajectories()[0]?.finalize_reason).toBe('time_budget');
    });

    it('records an answered run with hashed tool features and no text at all', async () => {
      mockToolCallRound('get_expenses', '{"period":"2026-10","summary_only":true}');
      mockStreamReturn(['Октябрь: 1 639 EUR']);

      await agent.run('Сколько потратили в октябре?', [], mockBot as unknown as Bot);

      const [run] = trajectories();
      expect(run).toMatchObject({
        outcome: 'answered',
        error_kind: null,
        is_mention: 0,
        tool_rounds: 1,
        tool_calls: 1,
        nudges: 0,
        handoffs: 0,
        providers: '["mock"]',
        answer_provider: 'mock',
        finalize_reason: null,
        follow_up_after_ms: null,
      });
      const rounds = trajectoryRounds(run?.id ?? 0);
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({
        round: 1,
        provider: 'mock',
        decision: 'continue',
        reason: null,
      });
      expect(JSON.parse(rounds[0]?.calls ?? '[]')).toEqual([
        {
          tool: 'get_expenses',
          argsHash: expect.any(String),
          resultHash: expect.any(String),
          isError: false,
        },
      ]);
      const stored = JSON.stringify([run, rounds]);
      for (const text of ['Сколько', '2026-10', 'summary_only', 'Октябрь', 'done']) {
        expect(stored).not.toContain(text);
      }
      expect(logMock.error).not.toHaveBeenCalled();
    });

    it.each([
      [
        'silent',
        () => mockStreamReturn(['[SKIP]']),
        { outcome: 'silent', error_kind: null, answer_provider: 'mock' },
      ],
      [
        'no_answer',
        () => {
          mockToolCallRound('get_expenses', '{"period":"2026-10"}');
          mockStreamReturn([]);
        },
        { outcome: 'no_answer', error_kind: null, answer_provider: 'mock' },
      ],
      [
        'error',
        () =>
          mockAiStreamRound.mockRejectedValue(Object.assign(new Error('down'), { status: 500 })),
        { outcome: 'error', error_kind: 'generic', answer_provider: null },
      ],
    ])('records the %s outcome', async (_label, arrange, expected) => {
      arrange();
      await agent.run('ну мы и потратили', [], mockBot as unknown as Bot).catch(() => undefined);
      expect(trajectories()).toEqual([expect.objectContaining(expected)]);
    });

    it('marks the previous run of the group as followed up when the next one starts within 5 minutes', async () => {
      let clock = 5_000_000;
      spyOn(agent as unknown as { now: () => number }, 'now').mockImplementation(() => clock);
      mockStreamReturn(['первый ответ']);
      await agent.run('вопрос', [], mockBot as unknown as Bot);
      clock += 90_000;
      mockStreamReturn(['второй ответ']);
      await agent.run('ты завис?', [], mockBot as unknown as Bot);

      const [first, second] = trajectories();
      expect(first?.follow_up_after_ms).toBe(90_000);
      expect(second?.follow_up_after_ms).toBeNull();
    });

    it('a failed trajectory write never changes the answer', async () => {
      spyOn(database.agentTrajectories, 'create').mockImplementation(() => {
        throw new Error('database is locked');
      });
      mockStreamReturn(['ответ']);

      const result = await agent.run('вопрос', [], mockBot as unknown as Bot);

      expect(result).toBe('ответ');
      expect(logMock.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('trajectory'),
      );
    });

    it('a retried attempt keeps the handed-off provider excluded', async () => {
      mockIsRetryableError.mockReturnValue(true);
      spyOn(
        agent as unknown as { sleep: (ms: number) => Promise<void> },
        'sleep',
      ).mockResolvedValue(undefined);
      let n = 0;
      let failed = false;
      mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
        const provider = firstAvailable(opts.excludeProviders) ?? 'none';
        if (n === 8 && !failed) {
          failed = true;
          throw Object.assign(new Error('unavailable'), { status: 503 });
        }
        if (n === 8) {
          callbacks.onTextDelta?.('Итого');
          return { ...makeTextResult('Итого'), providerUsed: provider };
        }
        n++;
        return {
          ...makeToolCallResult('calculate'),
          toolCalls: [{ id: `c${n}`, name: 'calculate', arguments: `{"expression":"${n} RSD"}` }],
          providerUsed: provider,
        };
      });
      mockExecuteTool.mockImplementation(async (_name, input) => ({
        success: true,
        output: `= ${JSON.stringify(input)}`,
      }));

      const result = await agent.run('Сумма в евро', [], mockBot as unknown as Bot);

      expect(result).toBe('Итого');
      // Handoff after round 8, then a 503 and a retry: the retry still skips Groq.
      expect(getLastCallOpts().excludeProviders).toEqual(['Groq (gpt-oss-120b)']);
      expect(logMock.warn).toHaveBeenCalledWith(expect.stringContaining('retrying'));
    });

    it('a forced answer stays an answer when the validator re-run then chooses [SKIP]', async () => {
      // Malformed arguments are not grounded tool use, so the forced answer still goes to the
      // validator; its re-run must not turn the forced run into silence.
      mockNextProvider.mockReturnValue(null);
      let rerun = false;
      mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
        if (rerun) {
          callbacks.onTextDelta?.('[SKIP]');
          return makeTextResult('[SKIP]');
        }
        if (opts.toolChoice === 'none') {
          rerun = true;
          callbacks.onTextDelta?.('Не знаю');
          return makeTextResult('Не знаю');
        }
        return {
          ...makeToolCallResult('calculate'),
          toolCalls: [{ id: 'c', name: 'calculate', arguments: '{"expression":' }],
        };
      });
      mockValidateResponse.mockResolvedValueOnce({ approved: false, reason: 'no tools' });

      const result = await agent.run('сумма в евро', [], mockBot as unknown as Bot);

      expect(result).toBe(NO_ANSWER_MESSAGE);
      expect(mockBot.api.deleteMessage).not.toHaveBeenCalled();
      // Nudge after the 3rd identical malformed call, the 4th ends the tool rounds (no provider
      // left); every malformed call counts as a tool call of its round.
      expect(trajectories()).toEqual([
        expect.objectContaining({
          outcome: 'no_answer',
          finalize_reason: 'repeated_call',
          tool_rounds: 4,
          tool_calls: 4,
        }),
      ]);
      expect(logMock.error).toHaveBeenCalledWith(expect.stringContaining('Malformed'));
    });

    it('cuts a tool round that runs into the final-round reserve and forces the answer in time', async () => {
      let clock = 0;
      spyOn(agent as unknown as { now: () => number }, 'now').mockImplementation(() => clock);
      let n = 0;
      mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
        if (opts.toolChoice === 'none') {
          callbacks.onTextDelta?.('Что успел собрать');
          return makeTextResult('Что успел собрать');
        }
        n++;
        if (n === 1) {
          clock = 194_950; // round 1 ends 50 ms before the reserve starts
          return {
            ...makeToolCallResult('get_expenses'),
            toolCalls: [{ id: 'c1', name: 'get_expenses', arguments: '{"page":1}' }],
          };
        }
        // Round 2: a slow provider that would run into the reserve hangs until its signal fires.
        return new Promise<StreamRoundResult>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      });

      const result = await agent.run('все траты', [], mockBot as unknown as Bot);

      expect(result).toBe('Что успел собрать');
      expect(streamCalls()).toHaveLength(3);
      expect(getLastCallOpts().toolChoice).toBe('none');
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
      expect(trajectories()[0]).toMatchObject({ finalize_reason: 'time_budget', tool_rounds: 1 });
    });

    // HYP-1717: the tool-round time limit also bounds tool execution, not only the model call.
    it('skips the remaining tool calls of a round once the final-round reserve is reached', async () => {
      let clock = 0;
      spyOn(agent as unknown as { now: () => number }, 'now').mockImplementation(() => clock);
      const seen: string[] = [];
      mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
        if (opts.toolChoice === 'none') {
          seen.push(JSON.stringify(opts.messages.filter((m) => m.role === 'tool')));
          callbacks.onTextDelta?.('Добавил одну');
          return makeTextResult('Добавил одну');
        }
        const calls = [
          { id: 'a1', name: 'add_expense', arguments: '{"n":1}' },
          { id: 'a2', name: 'add_expense', arguments: '{"n":2}' },
        ];
        return {
          text: '',
          toolCalls: calls,
          finishReason: 'tool_calls',
          assistantMessage: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.arguments },
            })),
          },
          providerUsed: 'mock',
        } satisfies StreamRoundResult;
      });
      mockExecuteTool.mockImplementation(async (_name, input) => {
        clock = 196_000; // the first, slow write ends inside the reserve
        return { success: true, output: `added ${JSON.stringify(input)}` };
      });

      const result = await agent.run('добавь две', [], mockBot as unknown as Bot);

      expect(result).toBe('Добавил одну');
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
      // The skipped call still gets a tool message (every tool_call id needs one), saying why.
      expect(seen[0]).toContain('added {\\"n\\":1}');
      expect(seen[0]).toContain('Not run: no time left');
      // Every tool_call id of the assistant message has exactly one tool reply.
      const history = getLastCallOpts().messages;
      const replyIds = history.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : []));
      expect(replyIds).toEqual(['a1', 'a2']);
      expect(getLastCallOpts().toolChoice).toBe('none');
      expect(streamCalls()).toHaveLength(2);
      expect(trajectories()[0]).toMatchObject({ finalize_reason: 'time_budget', tool_calls: 2 });
    });

    it('does not start a tool whose Telegram status update waited past the reserve', async () => {
      let clock = 0;
      spyOn(agent as unknown as { now: () => number }, 'now').mockImplementation(() => clock);
      // The status edit before the tool runs waits out a Telegram 429 until 199 s.
      mockBot.api.editMessageText.mockImplementation(async () => {
        clock = 199_000;
        return { message_id: 1, chat: { id: 1 }, date: 0, text: '' };
      });
      mockToolCallRound('add_expense', '{"amount":5}');
      mockAiStreamRound.mockImplementationOnce(async (opts, callbacks) => {
        callbacks.onTextDelta?.('Не успел');
        return makeTextResult(opts.toolChoice === 'none' ? 'Не успел' : 'unexpected');
      });

      const result = await agent.run('добавь', [], mockBot as unknown as Bot);

      expect(mockExecuteTool).not.toHaveBeenCalled();
      expect(result).toBe('Не успел');
      expect(getLastCallOpts().toolChoice).toBe('none');
    });

    it('the validator re-run gets only what is left of the run deadline, not a fresh 240 s', async () => {
      let clock = 0;
      spyOn(agent as unknown as { now: () => number }, 'now').mockImplementation(() => clock);
      const timerDelays: Array<number | undefined> = [];
      const realSetTimeout = globalThis.setTimeout;
      spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
        timerDelays.push(ms);
        return realSetTimeout(handler, ms);
      }) as typeof setTimeout);
      mockStreamReturn(['ответ без инструментов']);
      mockStreamReturn(['ответ после проверки']);
      mockValidateResponse.mockImplementationOnce(async () => {
        clock = 150_000; // a slow first answer plus the validator took 150 s
        return { approved: false, reason: 'no tools' };
      });

      const result = await agent.run('сколько потратили', [], mockBot as unknown as Bot);

      expect(result).toBe('ответ после проверки');
      expect(timerDelays.filter((ms) => ms === 240_000)).toHaveLength(1);
      expect(timerDelays).toContain(90_000);
    });
  });
});
