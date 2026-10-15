// Tests for the agent stall guard — each stall signal, the nudge → handoff → finalize ladder,
// the safety caps, replays of the 2026-10-12 prod incident runs and healthy runs that must pass.

import { describe, expect, it } from 'bun:test';
import {
  detectStall,
  FINAL_ROUND_RESERVE_MS,
  hashFeature,
  MAX_HANDOFFS,
  MAX_TOOL_ROUNDS,
  type RoundRecord,
  RUN_DEADLINE_MS,
  type StallDecision,
  StallGuard,
  type ToolCallRecord,
} from './stall-guard';

/** One call: `result` defaults to a value unique to the args, so distinct args mean new info. */
function call(
  tool: string,
  args: string,
  result = `r:${tool}:${args}`,
  isError = false,
): ToolCallRecord {
  return { tool, argsHash: args, resultHash: result, isError };
}

/** Round records numbered from 1, one second apart, all from one provider. */
function rounds(...calls: ToolCallRecord[][]): RoundRecord[] {
  return calls.map((c, i) => ({
    round: i + 1,
    provider: 'groq',
    elapsedMs: (i + 1) * 1000,
    calls: c,
  }));
}

/** Feed every round to a fresh guard and return the decisions in order. */
function replay(records: RoundRecord[], canHandoff = true): StallDecision[] {
  const guard = new StallGuard();
  return records.map((r) => guard.next(r, canHandoff));
}

/** 1-based rounds whose decision was `action`. */
function roundsWith(decisions: StallDecision[], action: StallDecision['action']): number[] {
  return decisions.flatMap((d, i) => (d.action === action ? [i + 1] : []));
}

const calc = (expr: string) => [call('calculate', expr)];

describe('detectStall', () => {
  it('fires repeated_call on the third identical call with the same result', () => {
    const r = rounds(calc('A'), calc('A'), [call('get_budgets', 'm')], calc('A'));
    expect(detectStall(r.slice(0, 2), 0)).toBeNull();
    expect(detectStall(r, 0)).toBe('repeated_call');
  });

  it('does not count the same args with a new result as a repeat', () => {
    const r = rounds(
      [call('get_budgets', 'm', 'v1')],
      [call('get_budgets', 'm', 'v2')],
      [call('get_budgets', 'm', 'v3')],
    );
    expect(detectStall(r, 0)).toBeNull();
  });

  it('fires cheap_tool_streak on the fourth calculate-only round in a row', () => {
    const r = rounds(calc('A'), calc('B'), calc('C'), calc('D'));
    expect(detectStall(r.slice(0, 3), 0)).toBeNull();
    expect(detectStall(r, 0)).toBe('cheap_tool_streak');
  });

  it('a round with another tool breaks the calculate streak', () => {
    const r = rounds(calc('A'), calc('B'), calc('C'), [call('get_budgets', 'm')], calc('D'));
    expect(detectStall(r, 0)).toBeNull();
  });

  it('several calculate calls in one round count as one round', () => {
    const r = rounds([call('calculate', 'A'), call('calculate', 'B'), call('calculate', 'C')]);
    expect(detectStall(r, 0)).toBeNull();
  });

  it('fires error_streak on the third round where every call failed', () => {
    const err = (args: string) => [call('add_expense', args, `e:${args}`, true)];
    const r = rounds(err('a'), err('b'), err('c'));
    expect(detectStall(r.slice(0, 2), 0)).toBeNull();
    expect(detectStall(r, 0)).toBe('error_streak');
  });

  it('a round with one successful call breaks the error streak', () => {
    const r = rounds(
      [call('calculate', 'a', 'e1', true)],
      [call('calculate', 'b', 'e2', true), call('get_exchange_rates', '{}')],
      [call('calculate', 'c', 'e3', true)],
    );
    expect(detectStall(r, 0)).toBeNull();
  });

  it('fires alternation on X, Y, X, Y', () => {
    const x = [call('get_expenses', 'p1')];
    const y = [call('get_budgets', 'm')];
    expect(detectStall(rounds(x, y, x), 0)).toBeNull();
    expect(detectStall(rounds(x, y, x, y), 0)).toBe('alternation');
  });

  it('fires no_new_info after three rounds whose results were all seen before', () => {
    const r = rounds(
      [call('get_expenses', 'p', 'R')],
      [call('get_expenses', 'p2', 'R')],
      [call('get_expenses', 'p3', 'R')],
      [call('get_expenses', 'p4', 'R')],
    );
    expect(detectStall(r.slice(0, 3), 0)).toBeNull();
    expect(detectStall(r, 0)).toBe('no_new_info');
  });

  it('only looks at rounds from the segment start, but remembers results seen before it', () => {
    const r = rounds(calc('A'), calc('B'), calc('C'), calc('D'), calc('E'));
    expect(detectStall(r, 0)).toBe('cheap_tool_streak');
    expect(detectStall(r, 4)).toBeNull();
  });
});

describe('StallGuard ladder', () => {
  it('nudges on the first signal, hands off on the next ones, then finalizes', () => {
    // 13 one-at-a-time calculate rounds with distinct expressions
    const decisions = replay(rounds(...Array.from({ length: 13 }, (_, i) => calc(`x${i}`))));

    expect(decisions[3]).toEqual({ action: 'nudge', signal: 'cheap_tool_streak' });
    // The round right after the nudge keeps the pattern: the nudge was ignored → handoff.
    expect(decisions[4]).toEqual({ action: 'handoff', signal: 'cheap_tool_streak' });
    // A model that took over starts clean: 4 more such rounds before the next step.
    expect(decisions[8]).toEqual({ action: 'handoff', signal: 'cheap_tool_streak' });
    expect(decisions[12]).toEqual({ action: 'finalize', reason: 'cheap_tool_streak' });
    expect(roundsWith(decisions, 'continue')).toEqual([1, 2, 3, 6, 7, 8, 10, 11, 12]);
    expect(MAX_HANDOFFS).toBe(2);
  });

  // Stage QA 2026-10-15 (PR #170): after the nudge the next round continued the same pattern and
  // the guard counted it as a fresh start. A nudge no longer resets the segment; a handoff does.
  it('escalates when the round after a nudge continues the calculate streak', () => {
    const decisions = replay(
      rounds(
        [call('get_expenses', 'page1')],
        calc('A'),
        calc('B'),
        calc('C'),
        calc('D'),
        calc('E'),
      ),
    );
    expect(decisions[4]).toEqual({ action: 'nudge', signal: 'cheap_tool_streak' });
    expect(decisions[5]).toEqual({ action: 'handoff', signal: 'cheap_tool_streak' });
  });

  it('escalates when the round after a nudge again brings nothing new', () => {
    const page = (n: number) => [call('get_expenses', `p${n}`, 'same rows')];
    const decisions = replay(rounds(page(1), page(2), page(3), page(4), page(5)));
    expect(decisions[3]).toEqual({ action: 'nudge', signal: 'no_new_info' });
    expect(decisions[4]).toEqual({ action: 'handoff', signal: 'no_new_info' });
  });

  it('a round after the nudge that changes course (reads the next page) continues', () => {
    const decisions = replay(
      rounds(
        [call('get_expenses', 'page1')],
        calc('A'),
        calc('B'),
        calc('C'),
        calc('D'),
        [call('get_expenses', 'page2')],
        [call('get_expenses', 'page3')],
      ),
    );
    expect(decisions[4]).toEqual({ action: 'nudge', signal: 'cheap_tool_streak' });
    expect(roundsWith(decisions, 'continue')).toEqual([1, 2, 3, 4, 6, 7]);
  });

  it('finalizes instead of handing off when no other provider is left', () => {
    const decisions = replay(rounds(...Array.from({ length: 5 }, (_, i) => calc(`x${i}`))), false);
    expect(decisions[3]).toEqual({ action: 'nudge', signal: 'cheap_tool_streak' });
    expect(decisions[4]).toEqual({ action: 'finalize', reason: 'cheap_tool_streak' });
  });

  it('counts nudges and handoffs and keeps every round with its decision', () => {
    const guard = new StallGuard();
    for (const r of rounds(...Array.from({ length: 5 }, (_, i) => calc(`x${i}`))))
      guard.next(r, true);
    expect(guard.nudges).toBe(1);
    expect(guard.handoffs).toBe(1);
    expect(guard.entries).toHaveLength(5);
    expect(guard.entries[3]?.decision).toEqual({ action: 'nudge', signal: 'cheap_tool_streak' });
    expect(guard.entries[3]?.calls[0]?.argsHash).toBe('x3');
  });

  it('finalizes at the round cap even when nothing stalls', () => {
    const records = rounds(
      ...Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => [call('add_expense', `e${i}`)]),
    );
    const decisions = replay(records);
    expect(MAX_TOOL_ROUNDS).toBe(40);
    expect(decisions.at(-1)).toEqual({ action: 'finalize', reason: 'round_cap' });
    expect(roundsWith(decisions, 'continue')).toHaveLength(MAX_TOOL_ROUNDS - 1);
  });

  it('finalizes once the run leaves only the final-round reserve before the deadline', () => {
    expect(RUN_DEADLINE_MS).toBe(240_000);
    expect(FINAL_ROUND_RESERVE_MS).toBe(45_000);
    const guard = new StallGuard();
    const at = (round: number, elapsedMs: number): RoundRecord => ({
      round,
      provider: 'groq',
      elapsedMs,
      calls: [call('get_expenses', `p${round}`)],
    });
    expect(guard.next(at(1, 194_999), true)).toEqual({ action: 'continue' });
    expect(guard.next(at(2, 195_000), true)).toEqual({ action: 'finalize', reason: 'time_budget' });
  });
});

// Prod 2026-10-12, Lena's chat (logs/chats/-1003207640556/2026-10-12_11-51-56.log): Groq
// gpt-oss-120b, one tool call per round, the old 10-round cap, no answer in all three runs.
// Letters stand for distinct `calculate` expressions; a repeated letter repeats the same call
// (the agent's cache returns the same result, so the result repeats too).
describe('replays of the 2026-10-12 incident', () => {
  const lenaRun = (...letters: string[]) =>
    rounds(
      [call('get_expenses', '{"period":"2026-10","summary_only":true}')],
      ...letters.map(calc),
    );

  it.each([
    [
      '11:53, nine distinct conversions',
      lenaRun('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'),
      5,
      [6, 10],
    ],
    [
      '11:55, A four times then more',
      lenaRun('A', 'A', 'A', 'A', 'B', 'C', 'B', 'D', 'E'),
      4,
      [5, 9],
    ],
    ['11:58, B repeated', lenaRun('A', 'B', 'B', 'B', 'C', 'B', 'X', 'D', 'E'), 5, [6, 10]],
  ])('%s: nudge, the ignored nudge hands off right away', (_label, records, nudgeAt, handoffsAt) => {
    const decisions = replay(records);
    expect(roundsWith(decisions, 'nudge')).toEqual([nudgeAt]);
    expect(roundsWith(decisions, 'handoff')).toEqual(handoffsAt);
    expect(roundsWith(decisions, 'finalize')).toEqual([]);
  });
});

describe('healthy runs never trigger', () => {
  it.each([
    [
      'six different tools',
      rounds(
        [call('get_group_settings', '{}')],
        [call('get_expenses', '{"period":"2026-10","summary_only":true}')],
        [call('get_budgets', '{"month":"2026-10"}')],
        [call('get_expenses', '{"page":2,"period":"2026-10"}')],
        calc('450-424.59'),
        [call('render_table', 't')],
      ),
    ],
    [
      'bulk add of 15 expenses, one per round',
      rounds(...Array.from({ length: 15 }, (_, i) => [call('add_expense', `{"amount":${i + 1}}`)])),
    ],
    [
      'bulk budget: re-read after every write',
      rounds(
        ...['Еда', 'Дом', 'Кафе', 'Такси'].flatMap((cat, i) => [
          [call('get_budgets', '{"month":"2026-10"}', `budgets-v${i}`)],
          [call('set_budget', `{"category":"${cat}"}`)],
        ]),
      ),
    ],
    [
      'five pages of expenses',
      rounds(...Array.from({ length: 5 }, (_, i) => [call('get_expenses', `{"page":${i + 1}}`)])),
    ],
    [
      'three conversions in a row',
      rounds(calc('A'), calc('B'), calc('C'), [call('render_table', 't')]),
    ],
  ])('%s', (_label, records) => {
    expect(roundsWith(replay(records), 'continue')).toHaveLength(records.length);
  });
});

describe('hashFeature', () => {
  it('is stable for the same text and seed and differs across seeds', () => {
    expect(hashFeature('52829.45 RSD', 7)).toBe(hashFeature('52829.45 RSD', 7));
    expect(hashFeature('52829.45 RSD', 7)).not.toBe(hashFeature('52829.45 RSD', 8));
    expect(hashFeature('52829.45 RSD', 7)).not.toBe(hashFeature('49846.35 RSD', 7));
    expect(hashFeature('52829.45 RSD', 7)).not.toContain('52829');
  });
});
