// src/services/ai/agent.stall-guard-qa.test.ts
// Tests for ExpenseBotAgent — stage-QA regressions: reasoning leaks, partial-page totals, role routing, tool schema modes, invented amounts

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Bot } from 'gramio';
import {
  ExpenseBotAgent,
  env,
  firstAvailable,
  getLastCallOpts,
  logMock,
  makeCtx,
  makeMockBot,
  makeTextResult,
  makeToolCallResult,
  mockAiStreamRound,
  mockExecuteTool,
  mockNextProvider,
  mockStreamReturn,
  mockToolCallRound,
  mockToolCallsRound,
  mockValidateResponse,
  resetAgentMocks,
  resetStallGuardMocks,
  TOOL_DEFINITIONS,
  trajectories,
  trajectoryRounds,
} from './agent-test-harness';
import type { StreamRoundResult } from './streaming';
import { buildStaticSystemPrompt } from './system-prompt';
import { HYBRID_CORE_TOOLS } from './tool-exposure';

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
    beforeEach(() => {
      resetStallGuardMocks();
    });

    // Stage QA of PR #170 (b), 2026-10-15 05:10 UTC: Groq gpt-oss-120b wrote its own notes about
    // the conversation into the answer, between a cut-off list and the real one.
    describe('PR #170: model reasoning inside the answer', () => {
      const LEAKED =
        "• <b>Путешествия</b>: <b>2798.61 EUR</b>\n• <b>Эда</b>: <b>625.\n\nWe have a conversation where the user repeatedly asks for totals per category. The assistant finally called get_expenses with summary_only true and got the data. However the final answer is incomplete. Need to correct.\n\nLet's produce final answer.• <b>Путешествия</b>: <b>2798.61 EUR</b>\n• <b>Еда</b>: <b>625.68 EUR</b>";
      const CLEAN = '• <b>Путешествия</b>: <b>2798.61 EUR</b>\n• <b>Еда</b>: <b>625.68 EUR</b>';

      it('re-runs once without the leaked text and returns the clean answer', async () => {
        mockToolCallRound(
          'get_expenses',
          '{"period":"2026-05","summary_only":true,"currency":"EUR"}',
        );
        mockStreamReturn([LEAKED]);
        mockStreamReturn([CLEAN]);

        const result = await agent.run(
          'mxtnr: сколько в евро потрачено в мае 2026 по каждой категории',
          [],
          mockBot as unknown as Bot,
        );

        expect(result).toBe(CLEAN);
        expect(mockAiStreamRound).toHaveBeenCalledTimes(3);
        const rerun = getLastCallOpts().messages;
        expect(String(rerun.at(-1)?.content)).toContain('internal notes');
        // The leaked reasoning is not fed back to the model.
        expect(JSON.stringify(rerun)).not.toContain('We have a conversation');
        // The tool results stay, so the re-run can answer without calling tools again.
        expect(rerun.filter((m) => m.role === 'tool')).toHaveLength(1);
        expect(logMock.warn).toHaveBeenCalledWith(
          expect.objectContaining({ leak: expect.stringContaining('The assistant') }),
          expect.stringContaining('reasoning'),
        );
        expect(mockValidateResponse).not.toHaveBeenCalled();
      });

      it('takes the leaked text off the screen before the re-run streams', async () => {
        let shownDuringRerun = '';
        mockStreamReturn([LEAKED]);
        mockAiStreamRound.mockImplementationOnce(async (_opts, callbacks) => {
          const edits = mockBot.api.editMessageText.mock.calls as unknown as Array<
            [{ text: string }]
          >;
          shownDuringRerun = edits.at(-1)?.[0].text ?? '';
          callbacks.onTextDelta?.(CLEAN);
          return makeTextResult(CLEAN);
        });

        await agent.run('mxtnr: а сколько на еду?', [], mockBot as unknown as Bot);

        expect(shownDuringRerun).not.toContain('We have a conversation');
        expect(shownDuringRerun).toContain('⏳');
      });

      it('a tool-free re-run answer still goes through the validator', async () => {
        mockStreamReturn([LEAKED]);
        mockStreamReturn([CLEAN]);

        const result = await agent.run('mxtnr: а сколько на еду?', [], mockBot as unknown as Bot);

        expect(result).toBe(CLEAN);
        expect(mockAiStreamRound).toHaveBeenCalledTimes(2);
        // The leaked first answer is never validated; the clean re-run is, like any tool-free answer.
        expect(mockValidateResponse).toHaveBeenCalledTimes(1);
        expect(mockValidateResponse.mock.calls[0]?.[0].response).toBe(CLEAN);
      });

      it('a validator re-run that leaks reasoning gets the leak re-run too', async () => {
        mockStreamReturn(['Итого: 100 EUR']);
        mockValidateResponse.mockResolvedValueOnce({ approved: false, reason: 'no tools' });
        mockToolCallRound('get_expenses', '{"period":"2026-05","summary_only":true}');
        mockStreamReturn([LEAKED]);
        mockStreamReturn([CLEAN]);

        const result = await agent.run('mxtnr: сколько на еду?', [], mockBot as unknown as Bot);

        expect(result).toBe(CLEAN);
        expect(mockAiStreamRound).toHaveBeenCalledTimes(4);
        expect(String(getLastCallOpts().messages.at(-1)?.content)).toContain('internal notes');
      });

      it('a leak after a write is re-run without tools, so the write never runs twice', async () => {
        mockToolCallRound('add_expense', '{"amount":5,"currency":"EUR","category":"Еда"}');
        mockStreamReturn([LEAKED]);
        // A tool-allowed re-run would repeat the write here.
        mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
          if (opts.toolChoice === 'none') {
            callbacks.onTextDelta?.('Записал 5 EUR в Еду.');
            return makeTextResult('Записал 5 EUR в Еду.');
          }
          return {
            ...makeToolCallResult('add_expense'),
            toolCalls: [{ id: 'again', name: 'add_expense', arguments: '{"amount":5}' }],
          };
        });

        const result = await agent.run('mxtnr: 5 евро еда', [], mockBot as unknown as Bot);

        expect(result).toBe('Записал 5 EUR в Еду.');
        expect(mockExecuteTool).toHaveBeenCalledTimes(1);
        expect(getLastCallOpts().toolChoice).toBe('none');
      });

      it('after a forced answer the re-run stays tool-free', async () => {
        // Stall ladder spent (no provider left): the forced answer leaks reasoning.
        mockNextProvider.mockReturnValue(null);
        let forced = 0;
        let n = 0;
        mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
          if (opts.toolChoice === 'none') {
            forced++;
            const text = forced === 1 ? LEAKED : CLEAN;
            callbacks.onTextDelta?.(text);
            return makeTextResult(text);
          }
          n++;
          return {
            ...makeToolCallResult('calculate'),
            toolCalls: [{ id: `c${n}`, name: 'calculate', arguments: `{"expression":"${n}"}` }],
          };
        });

        const result = await agent.run('mxtnr: сумма в евро', [], mockBot as unknown as Bot);

        expect(result).toBe(CLEAN);
        // The re-run goes straight to a forced round: no new tool rounds after the guard stopped them.
        const calls = mockAiStreamRound.mock.calls.map(([opts]) => opts.toolChoice);
        expect(calls.slice(-2)).toEqual(['none', 'none']);
        expect(mockExecuteTool).toHaveBeenCalledTimes(n);
        expect(n).toBe(5);
      });

      it('re-runs only once: a second leak is surfaced and logged', async () => {
        mockToolCallRound('get_expenses', '{"period":"2026-05","summary_only":true}');
        mockStreamReturn([LEAKED]);
        mockStreamReturn([LEAKED]);

        const result = await agent.run(
          'mxtnr: сколько по категориям?',
          [],
          mockBot as unknown as Bot,
        );

        expect(result).toBe(LEAKED);
        expect(mockAiStreamRound).toHaveBeenCalledTimes(3);
        expect(logMock.warn).toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('still contains'),
        );
      });

      it('a clean Russian answer is not re-run', async () => {
        mockToolCallRound('get_expenses', '{"period":"2026-05","summary_only":true}');
        mockStreamReturn([CLEAN]);

        await agent.run('mxtnr: сколько по категориям?', [], mockBot as unknown as Bot);

        expect(mockAiStreamRound).toHaveBeenCalledTimes(2);
        expect(logMock.warn).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('reasoning'),
        );
      });
    });

    // Stage QA of PR #170 (2026-10-15): «посчитай отдельно через calculate каждую трату мая 2026
    // в евро и сложи». The model read get_expenses page 1 of 8 (page_size 8), made 4 calculate
    // calls, was nudged, made one more and answered the partial sum as the May total.
    describe('PR #170: partial page summed as the total', () => {
      // The detail header get_expenses now produces (tool-executor.test.ts pins the real format).
      const PAGE_1_OF_8 = [
        'Period: 2026-05-01 to 2026-05-31',
        'Showing 1–8 of 63 expenses (page 1 of 8)',
        'Total for all 63 expenses: 8561.59 EUR',
        'More pages: 2–8 are not shown. For totals use the "Total for all" line above (or get_expenses with summary_only: true) — never add up the rows of one page as the total. For the individual rows call get_expenses again with page=2 … page=8 with page_size=8 and the same filters.',
        '',
        '[id:1] 2026-05-31 | Еда | 105.00 RSD (EUR 0.89 EUR) | (no comment)',
      ].join('\n');

      function mockQaRun(nextProviderAvailable = true) {
        const seen: Array<{ provider: string; lastMessage: string; toolMessages: string }> = [];
        if (!nextProviderAvailable) mockNextProvider.mockReturnValue(null);
        let toolRounds = 0;
        mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
          const provider = firstAvailable(opts.excludeProviders) ?? 'none';
          seen.push({
            provider,
            lastMessage: String(opts.messages.at(-1)?.content),
            toolMessages: JSON.stringify(opts.messages.filter((m) => m.role === 'tool')),
          });
          if (opts.toolChoice === 'none' || !provider.startsWith('Groq')) {
            callbacks.onTextDelta?.('Итого за май: 8561.59 EUR');
            return { ...makeTextResult('Итого за май: 8561.59 EUR'), providerUsed: provider };
          }
          toolRounds++;
          const [name, args] =
            toolRounds === 1
              ? ['get_expenses', '{"period":"2026-05","page":1,"page_size":8}']
              : ['calculate', `{"expression":"${toolRounds * 100} RSD","target_currency":"EUR"}`];
          return {
            text: '',
            toolCalls: [{ id: `c${toolRounds}`, name, arguments: args }],
            finishReason: 'tool_calls',
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: `c${toolRounds}`, type: 'function', function: { name, arguments: args } },
              ],
            },
            providerUsed: provider,
          } satisfies StreamRoundResult;
        });
        mockExecuteTool.mockImplementation(async (name, input) => ({
          success: true,
          output: name === 'get_expenses' ? PAGE_1_OF_8 : `= ${JSON.stringify(input)}`,
        }));
        return seen;
      }

      it('the nudge after page 1 + 4 calculate points at the all-pages total, and the ignored nudge hands off', async () => {
        const seen = mockQaRun();

        await agent.run('посчитай каждую трату мая в евро и сложи', [], mockBot as unknown as Bot);

        // Round 5 (4th calculate) → nudge; round 6 (5th calculate) ignores it → handoff.
        const afterNudge = seen[5];
        expect(afterNudge?.lastMessage).toContain('going in circles');
        expect(afterNudge?.lastMessage).toContain('summary_only and currency');
        expect(afterNudge?.lastMessage).toContain('read all the pages');
        expect(afterNudge?.lastMessage).toContain(
          'never present a sum of part of the data as the total',
        );
        expect(afterNudge?.lastMessage).toContain('"Total for all"');
        // The authoritative total is in the tool results the nudged model sees.
        expect(afterNudge?.toolMessages).toContain('Total for all 63 expenses: 8561.59 EUR');
        const afterHandoff = seen[6];
        expect(afterHandoff?.provider).toBe('z.ai (glm-5.1)');
        expect(afterHandoff?.lastMessage).toContain('taking over');
        expect(afterHandoff?.lastMessage).toContain('"Total for all"');
        expect(afterHandoff?.toolMessages).toContain('Total for all 63 expenses: 8561.59 EUR');
        const decisions = trajectoryRounds(trajectories()[0]?.id ?? 0).map(
          (r) => `${r.round}:${r.decision}:${r.reason}`,
        );
        expect(decisions.filter((d) => !d.includes(':continue:'))).toEqual([
          '5:nudge:cheap_tool_streak',
          '6:handoff:cheap_tool_streak',
        ]);
      });

      describe('role routing (AI_ROUTING)', () => {
        const rolesOfRun = () => mockAiStreamRound.mock.calls.map(([opts]) => opts.role);

        afterEach(() => {
          env.AI_ROUTING = 'legacy';
          env.AI_ROUTING_USER_IDS = undefined;
        });

        it('legacy mode (the default) never sets a role', async () => {
          mockQaRun();
          await agent.run(
            'посчитай каждую трату мая в евро и сложи',
            [],
            mockBot as unknown as Bot,
          );
          expect(rolesOfRun().every((role) => role === undefined)).toBe(true);
        });

        it('roles mode: executor rounds, repair from the stall nudge on, including the forced answer', async () => {
          env.AI_ROUTING = 'roles';
          mockQaRun(false);
          await agent.run(
            'посчитай каждую трату мая в евро и сложи',
            [],
            mockBot as unknown as Bot,
          );
          const roles = rolesOfRun();
          // Rounds 1-5 are plain tool rounds; the nudge after round 5 turns the run to repair.
          expect(roles.slice(0, 5)).toEqual(Array(5).fill('executor'));
          expect(roles.slice(5).length).toBeGreaterThan(0);
          expect(roles.slice(5).every((role) => role === 'repair')).toBe(true);
          expect(roles.at(-1)).toBe('repair');
        });

        it('the handoff target is looked up on the repair chain', async () => {
          env.AI_ROUTING = 'roles';
          mockQaRun();
          await agent.run(
            'посчитай каждую трату мая в евро и сложи',
            [],
            mockBot as unknown as Bot,
          );
          expect(mockNextProvider.mock.calls.some(([, , role]) => role === 'repair')).toBe(true);
        });

        it('the canary list keeps other users on the legacy chain', async () => {
          env.AI_ROUTING = 'roles';
          env.AI_ROUTING_USER_IDS = [1234];
          mockQaRun();
          await agent.run(
            'посчитай каждую трату мая в евро и сложи',
            [],
            mockBot as unknown as Bot,
          );
          expect(rolesOfRun().every((role) => role === undefined)).toBe(true);

          mockAiStreamRound.mockReset();
          env.AI_ROUTING_USER_IDS = [99];
          mockQaRun();
          await agent.run(
            'посчитай каждую трату мая в евро и сложи',
            [],
            mockBot as unknown as Bot,
          );
          expect(rolesOfRun()[0]).toBe('executor');
        });
      });

      describe('tool schema mode (AI_TOOL_SCHEMA_MODE, #203)', () => {
        const toolNameOf = (tool: (typeof TOOL_DEFINITIONS)[number]): string =>
          tool.type === 'function' ? tool.function.name : tool.type;
        const toolNamesOfCall = (index: number): string[] =>
          (mockAiStreamRound.mock.calls[index]?.[0].tools ?? []).map(toolNameOf);
        const systemOfCall = (index: number): string =>
          mockAiStreamRound.mock.calls[index]?.[0].messages[0]?.content as string;

        afterEach(() => {
          env.AI_TOOL_SCHEMA_MODE = 'full';
          env.AI_TOOL_SCHEMA_USER_IDS = undefined;
        });

        it('full mode (the default) sends every schema and no tool index', async () => {
          mockStreamReturn();
          await agent.run('привет', [], mockBot as unknown as Bot);
          expect(toolNamesOfCall(0)).toEqual(TOOL_DEFINITIONS.map(toolNameOf));
          expect(systemOfCall(0)).not.toContain('TOOL INDEX');
          expect(toolNamesOfCall(0)).not.toContain('discover_tools');
        });

        it('hybrid mode: round 1 carries the core and discover_tools, the index lists the rest', async () => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          mockStreamReturn();
          await agent.run('привет', [], mockBot as unknown as Bot);
          expect(toolNamesOfCall(0)).toEqual(['discover_tools', ...HYBRID_CORE_TOOLS]);
          const system = systemOfCall(0);
          expect(system).toContain('## TOOL INDEX');
          expect(system).toContain('- update_group_setting:');
          expect(system).not.toContain('- get_expenses:');
          expect(system.startsWith(buildStaticSystemPrompt())).toBe(true);
        });

        it('discover_tools loads a schema for the next round and runs no tool', async () => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          mockToolCallRound('discover_tools', '{"tools":["get_categories"]}');
          mockToolCallRound('get_categories');
          mockStreamReturn(['Категории: еда']);

          await agent.run('какие категории', [], mockBot as unknown as Bot);

          expect(toolNamesOfCall(0)).not.toContain('get_categories');
          expect(toolNamesOfCall(1)).toEqual([
            'discover_tools',
            ...HYBRID_CORE_TOOLS,
            'get_categories',
          ]);
          expect(mockExecuteTool.mock.calls.map((call) => call[0])).toEqual(['get_categories']);
          expect(mockAiStreamRound).toHaveBeenCalledTimes(3);
        });

        it('a tool called before its schema was loaded is rejected, not run, and loaded for the next round', async () => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          mockToolCallRound('update_group_setting', '{"setting":"default_currency","value":"EUR"}');
          mockStreamReturn(['Готово']);

          await agent.run('поставь евро', [], mockBot as unknown as Bot);

          expect(mockExecuteTool).not.toHaveBeenCalled();
          expect(toolNamesOfCall(1)).toContain('update_group_setting');
          const toolMessage = mockAiStreamRound.mock.calls[1]?.[0].messages.find(
            (message) => message.role === 'tool',
          );
          expect(String(toolMessage?.content)).toContain('TOOL_SCHEMA_NOT_EXPOSED');
        });

        it('discover_tools and the tool it loads in one round: the call is rejected, the schema counts from the next round', async () => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          mockToolCallsRound([
            ['discover_tools', '{"tools":["update_group_setting"]}'],
            ['update_group_setting', '{"setting":"default_currency","value":"EUR"}'],
          ]);
          mockStreamReturn(['Готово']);

          await agent.run('поставь евро', [], mockBot as unknown as Bot);

          expect(mockExecuteTool).not.toHaveBeenCalled();
          expect(toolNamesOfCall(1)).toContain('update_group_setting');
        });

        it('the same unloaded tool twice in one round: neither call runs', async () => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          mockToolCallsRound([
            ['update_group_setting', '{"setting":"default_currency","value":"EUR"}'],
            ['update_group_setting', '{"setting":"default_currency","value":"USD"}'],
          ]);
          mockStreamReturn(['Готово']);

          await agent.run('поставь евро', [], mockBot as unknown as Bot);

          expect(mockExecuteTool).not.toHaveBeenCalled();
        });

        it('a rejected call is not a data tool call: the answer is still validated', async () => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          mockToolCallRound('update_group_setting', '{"setting":"default_currency","value":"EUR"}');
          mockStreamReturn(['Готово']);

          await agent.run('поставь евро', [], mockBot as unknown as Bot);

          expect(mockValidateResponse).toHaveBeenCalledTimes(1);
        });

        it('a rejected read-only tool runs on its retry (the rejection is never cached)', async () => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          mockToolCallRound('get_categories', '{}');
          mockToolCallRound('get_categories', '{}');
          mockStreamReturn(['Вот категории']);

          await agent.run('какие категории', [], mockBot as unknown as Bot);

          expect(mockExecuteTool.mock.calls.map((call) => call[0])).toEqual(['get_categories']);
        });

        it('malformed arguments for a tool that is not loaded still load it for the next round', async () => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          mockToolCallRound('update_group_setting', '{"setting":');
          mockStreamReturn(['Не получилось']);

          await agent.run('поставь евро', [], mockBot as unknown as Bot);

          expect(mockExecuteTool).not.toHaveBeenCalled();
          expect(toolNamesOfCall(1)).toContain('update_group_setting');
        });

        it('arguments "null" (a no-argument call from some backends) run the tool with an empty object', async () => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          mockToolCallRound('get_expenses', 'null');
          mockStreamReturn(['Вот']);

          await agent.run('траты', [], mockBot as unknown as Bot);

          expect(mockExecuteTool.mock.calls.map((call) => [call[0], call[1]])).toEqual([
            ['get_expenses', {}],
          ]);
        });

        it.each([
          ['discover_tools', '5'],
          ['discover_tools', '[]'],
          ['add_expense', '[]'],
        ])('%s with arguments that are valid JSON but not an object (%s) is malformed, not executed', async (tool, args) => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          mockToolCallRound(tool, args);
          mockStreamReturn(['Не получилось']);

          await agent.run('какие категории', [], mockBot as unknown as Bot);

          expect(mockExecuteTool).not.toHaveBeenCalled();
          const toolMessage = mockAiStreamRound.mock.calls[1]?.[0].messages.find(
            (message) => message.role === 'tool',
          );
          expect(String(toolMessage?.content)).toContain('Malformed arguments');
        });

        it('a discover-only run is still validated: discovery is not a data tool call', async () => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          mockToolCallRound('discover_tools', '{"tools":["get_categories"]}');
          mockStreamReturn(['Вот категории']);

          await agent.run('какие категории', [], mockBot as unknown as Bot);

          expect(mockValidateResponse).toHaveBeenCalledTimes(1);
        });

        it('the canary list keeps other users on the full catalog', async () => {
          env.AI_TOOL_SCHEMA_MODE = 'hybrid';
          env.AI_TOOL_SCHEMA_USER_IDS = [1234];
          mockStreamReturn();
          await agent.run('привет', [], mockBot as unknown as Bot);
          expect(toolNamesOfCall(0)).toEqual(TOOL_DEFINITIONS.map(toolNameOf));

          mockAiStreamRound.mockClear();
          env.AI_TOOL_SCHEMA_USER_IDS = [99];
          mockStreamReturn();
          await agent.run('привет', [], mockBot as unknown as Bot);
          expect(toolNamesOfCall(0)[0]).toBe('discover_tools');
        });
      });

      it('the forced final round tells the model not to present a partial sum as the total', async () => {
        const seen = mockQaRun(false);

        await agent.run('посчитай каждую трату мая в евро и сложи', [], mockBot as unknown as Bot);

        const forced = seen.at(-1);
        expect(forced?.lastMessage).toContain('tool-call limit');
        expect(forced?.lastMessage).toContain('"More pages"');
        expect(forced?.lastMessage).toContain('"Total for all"');
        expect(forced?.lastMessage).toContain(
          'never present a sum of part of the data as the total',
        );
        expect(forced?.toolMessages).toContain('Total for all 63 expenses: 8561.59 EUR');
      });
    });

    // #166, stage QA 2026-10-15 01:41 UTC: Groq called calculate {"expression":"1 USD",
    // "target_currency":"EUR"} 7 times in a row after get_expenses (all RSD), hit the old cap, and
    // the forced answer invented USD amounts.
    describe('#166: identical calculate repeats and invented amounts', () => {
      const RSD_EXPENSES =
        '[id:1] 2026-05-01 | Еда | 1200.00 RSD\n[id:2] 2026-05-02 | Дом | 8000.00 RSD';

      function mockStageRun(finalText: string, nextProviderAvailable = true) {
        const seen: Array<{
          provider: string;
          lastMessage: string;
          toolChoice: string | undefined;
        }> = [];
        if (!nextProviderAvailable) mockNextProvider.mockReturnValue(null);
        mockAiStreamRound.mockImplementation(async (opts, callbacks) => {
          const provider = firstAvailable(opts.excludeProviders) ?? 'none';
          seen.push({
            provider,
            lastMessage: JSON.stringify(opts.messages.at(-1)),
            toolChoice: opts.toolChoice,
          });
          const toolRounds = seen.filter((s) => s.toolChoice !== 'none').length;
          if (opts.toolChoice === 'none' || !provider.startsWith('Groq')) {
            callbacks.onTextDelta?.(finalText);
            return { ...makeTextResult(finalText), providerUsed: provider };
          }
          const [name, args] =
            toolRounds === 1
              ? ['get_expenses', '{"period":"2026-05"}']
              : ['calculate', '{"expression":"1 USD","target_currency":"EUR"}'];
          return {
            text: '',
            toolCalls: [{ id: `c${toolRounds}`, name, arguments: args }],
            finishReason: 'tool_calls',
            assistantMessage: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: `c${toolRounds}`, type: 'function', function: { name, arguments: args } },
              ],
            },
            providerUsed: provider,
          } satisfies StreamRoundResult;
        });
        mockExecuteTool.mockImplementation(async (name) => ({
          success: true,
          output: name === 'get_expenses' ? RSD_EXPENSES : '0.89 EUR',
        }));
        return seen;
      }

      it('nudges at round 4 and hands the run to the next model when round 5 repeats again', async () => {
        const seen = mockStageRun('Итого: 9200 RSD');

        const result = await agent.run('сделай отдельный calculate', [], mockBot as unknown as Bot);

        expect(result).toBe('Итого: 9200 RSD');
        // get_expenses + 3 identical calculate → nudge; the 4th ignores it → handoff; z.ai answers.
        expect(seen).toHaveLength(6);
        expect(seen[4]?.lastMessage).toContain('going in circles');
        expect(seen[5]?.lastMessage).toContain('taking over');
        expect(seen[5]?.provider).toBe('z.ai (glm-5.1)');
        // The repeats come from the cache: the conversion ran once.
        expect(mockExecuteTool.mock.calls.map((c) => c[0])).toEqual(['get_expenses', 'calculate']);
        const decisions = trajectoryRounds(trajectories()[0]?.id ?? 0).map(
          (r) => `${r.round}:${r.decision}:${r.reason}`,
        );
        expect(decisions.filter((d) => !d.includes(':continue:'))).toEqual([
          '4:nudge:repeated_call',
          '5:handoff:repeated_call',
        ]);
      });

      it('the forced final round forbids amounts that are not in the tool results and allows summing those that are', async () => {
        const seen = mockStageRun('Итого: 9200 RSD', false);

        await agent.run('сделай отдельный calculate', [], mockBot as unknown as Bot);

        const forced = seen.find((s) => s.toolChoice === 'none');
        expect(forced?.lastMessage).toContain(
          'Never write an amount or a currency that is not in the tool results',
        );
        expect(forced?.lastMessage).toContain(
          'Adding up amounts that ARE in the tool results is allowed here',
        );
      });

      it.each([
        '1 USD → 0.89 EUR, 700 USD → 623 EUR',
        '700\u00a0USD = 623 EUR',
        'USD\u202f700 = 623 EUR',
        '700  USD = 623 EUR',
        'USD 700 = 623 EUR',
        '$700 = 623 EUR',
        'USD -700 = EUR -623',
      ])('warns when the forced answer names a currency no tool result had: %s', async (answer) => {
        mockStageRun(answer, false);

        await agent.run('сделай отдельный calculate', [], mockBot as unknown as Bot);

        expect(logMock.warn).toHaveBeenCalledWith(
          expect.objectContaining({ currencies: ['USD'] }),
          expect.stringContaining('not in any tool result'),
        );
      });

      it('an amount with a currency symbol in a tool result counts as evidence', async () => {
        mockStageRun('Подписка: $10', false);
        mockExecuteTool.mockImplementation(async (name) => ({
          success: true,
          output: name === 'get_expenses' ? RSD_EXPENSES : 'Netflix: 10.00 $ / month',
        }));

        await agent.run('сделай отдельный calculate', [], mockBot as unknown as Bot);

        expect(logMock.warn).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('not in any tool result'),
        );
      });

      it('an error result listing every currency is no evidence for an invented amount', async () => {
        mockStageRun('700 USD', false);
        mockExecuteTool.mockImplementation(async (name) =>
          name === 'get_expenses'
            ? { success: false, error: 'Unknown currency "US". Supported: USD, EUR, RSD, RUB' }
            : { success: true, output: '0.89 EUR' },
        );

        await agent.run('сделай отдельный calculate', [], mockBot as unknown as Bot);

        expect(logMock.warn).toHaveBeenCalledWith(
          expect.objectContaining({ currencies: ['USD'] }),
          expect.stringContaining('not in any tool result'),
        );
      });

      it('does not warn when every currency of the forced answer came from a tool result', async () => {
        mockStageRun('Итого: 9200 RSD (0.89 EUR за доллар)', false);

        await agent.run('сделай отдельный calculate', [], mockBot as unknown as Bot);

        expect(logMock.warn).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('not in any tool result'),
        );
      });
    });
  });
});
