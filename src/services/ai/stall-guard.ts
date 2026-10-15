/**
 * Stall guard for the agent tool loop: deterministic rules over per-round records that decide
 * whether the run continues, gets a nudge, moves to the next provider or must answer now.
 * Pure (no I/O); the thresholds are phase 0 of docs/specs/2026-10-13-agent-stall-guard.md.
 */

/**
 * Crash guard, not a working limit: the longest healthy prod run had 6 tool rounds (174 runs in
 * logs/chats up to 2026-10-12), and a bulk add of 15 expenses on a one-call-per-round model needs 15.
 */
export const MAX_TOOL_ROUNDS = 40;
/** Wall-clock deadline of one agent run, all rounds and retries included. */
export const RUN_DEADLINE_MS = 240_000;
/**
 * Time kept free for the forced final round. Equal to PER_PROVIDER_TIMEOUT_MS in streaming.ts, so
 * that round still gets one full provider attempt before the run deadline aborts it.
 */
export const FINAL_ROUND_RESERVE_MS = 45_000;
/**
 * The same call with the same result, this many times in a segment. The agent already answers the
 * second identical read with "already made, use the result" (#158); a third means the model ignored
 * that. 2026-10-12 11:55 and 11:58 repeated one conversion 4 and 3 times.
 */
export const REPEATED_CALL_LIMIT = 3;
/**
 * Rounds in a row made only of cheap tools — one conversion per round, the 2026-10-12 failure
 * (9 in a row, never answered). The longest such streak in the 171 healthy prod runs is 3.
 */
export const CHEAP_TOOL_STREAK_LIMIT = 4;
/** Rounds in a row where every call failed: two can be a typo and its fix, three are not. */
export const ERROR_STREAK_LIMIT = 3;
/** X, Y, X, Y over this many rounds (OpenHands' A/B loop pattern). */
export const ALTERNATION_ROUNDS = 4;
/** Rounds in a row whose every result was already in the context. */
export const STALE_ROUND_STREAK_LIMIT = 3;
/** Providers a run may move to before it has to answer with what it has. */
export const MAX_HANDOFFS = 2;
/**
 * Tools whose one-per-round use is the stall pattern. Write tools never belong here: adding 15
 * expenses one per round is legitimate work.
 */
export const CHEAP_TOOL_NAMES: Record<string, true> = { calculate: true };

/** One tool call of a round. Hashes are per-run seeded (hashFeature), so only equality matters. */
export interface ToolCallRecord {
  tool: string;
  argsHash: string;
  resultHash: string;
  isError: boolean;
}

/** A round that ran tools. `elapsedMs` counts from the start of the run. */
export interface RoundRecord {
  round: number;
  provider: string;
  elapsedMs: number;
  calls: ToolCallRecord[];
}

export type StallSignal =
  | 'repeated_call'
  | 'cheap_tool_streak'
  | 'error_streak'
  | 'alternation'
  | 'no_new_info';

/** Why the run must answer now: a safety cap, or a stall with no escalation left. */
export type FinalizeReason = 'round_cap' | 'time_budget' | StallSignal;

export type StallDecision =
  | { action: 'continue' }
  | { action: 'nudge' | 'handoff'; signal: StallSignal }
  | { action: 'finalize'; reason: FinalizeReason };

export interface GuardEntry extends RoundRecord {
  decision: StallDecision;
}

function callKey(call: ToolCallRecord): string {
  return `${call.tool}|${call.argsHash}|${call.resultHash}`;
}

/** Rounds at the end of `segment` that all satisfy `test`. */
function trailingCount<T>(segment: readonly T[], test: (item: T) => boolean): number {
  let count = 0;
  for (let i = segment.length - 1; i >= 0; i--) {
    const item = segment[i];
    if (item === undefined || !test(item)) break;
    count++;
  }
  return count;
}

/**
 * The stall signal raised by the latest round, or null. Streaks and repeats look only at the
 * segment (rounds from `segmentStart` on), so a model that was just nudged or just took over starts
 * clean; whether a result is new is judged against the whole run.
 */
export function detectStall(
  rounds: readonly RoundRecord[],
  segmentStart: number,
): StallSignal | null {
  const segment = rounds.slice(segmentStart);
  const latest = segment.at(-1);
  if (!latest) return null;

  const keyCounts = new Map<string, number>();
  for (const round of segment) {
    for (const call of round.calls) {
      const key = callKey(call);
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
  }
  if (latest.calls.some((call) => (keyCounts.get(callKey(call)) ?? 0) >= REPEATED_CALL_LIMIT)) {
    return 'repeated_call';
  }

  const cheapStreak = trailingCount(
    segment,
    (round) =>
      round.calls.length > 0 && round.calls.every((call) => CHEAP_TOOL_NAMES[call.tool] === true),
  );
  if (cheapStreak >= CHEAP_TOOL_STREAK_LIMIT) return 'cheap_tool_streak';

  const errorStreak = trailingCount(
    segment,
    (round) => round.calls.length > 0 && round.calls.every((call) => call.isError),
  );
  if (errorStreak >= ERROR_STREAK_LIMIT) return 'error_streak';

  const signatures = segment
    .slice(-ALTERNATION_ROUNDS)
    .map((round) => round.calls.map(callKey).sort().join(';'));
  if (
    signatures.length === ALTERNATION_ROUNDS &&
    signatures.every((sig, i) => sig === signatures[i % 2]) &&
    signatures[0] !== signatures[1]
  ) {
    return 'alternation';
  }

  const seen = new Set<string>();
  const stale = rounds.map((round) => {
    let allSeen = round.calls.length > 0;
    for (const call of round.calls) {
      if (!seen.has(call.resultHash)) allSeen = false;
      seen.add(call.resultHash);
    }
    return allSeen;
  });
  if (trailingCount(stale.slice(segmentStart), (isStale) => isStale) >= STALE_ROUND_STREAK_LIMIT) {
    return 'no_new_info';
  }

  return null;
}

/**
 * Per-run ladder over detectStall: the safety caps first, then the first signal of the run gets a
 * nudge, later ones a handoff while one is allowed and possible, else the run must answer.
 * Every decision other than `continue` starts a new segment.
 */
export class StallGuard {
  private readonly recorded: GuardEntry[] = [];
  private segmentStart = 0;
  private nudgeCount = 0;
  private handoffCount = 0;

  /** Record a finished tool round; `canHandoff` says whether another provider is left. */
  next(round: RoundRecord, canHandoff: boolean): StallDecision {
    const rounds: RoundRecord[] = [...this.recorded, round];
    const decision = this.decide(rounds, round, canHandoff);
    this.recorded.push({ ...round, decision });
    if (decision.action !== 'continue') this.segmentStart = this.recorded.length;
    if (decision.action === 'nudge') this.nudgeCount++;
    if (decision.action === 'handoff') this.handoffCount++;
    return decision;
  }

  private decide(rounds: RoundRecord[], latest: RoundRecord, canHandoff: boolean): StallDecision {
    if (rounds.length >= MAX_TOOL_ROUNDS) return { action: 'finalize', reason: 'round_cap' };
    if (latest.elapsedMs >= RUN_DEADLINE_MS - FINAL_ROUND_RESERVE_MS) {
      return { action: 'finalize', reason: 'time_budget' };
    }
    const signal = detectStall(rounds, this.segmentStart);
    if (!signal) return { action: 'continue' };
    if (this.nudgeCount === 0) return { action: 'nudge', signal };
    if (this.handoffCount < MAX_HANDOFFS && canHandoff) return { action: 'handoff', signal };
    return { action: 'finalize', reason: signal };
  }

  get entries(): readonly GuardEntry[] {
    return this.recorded;
  }

  get nudges(): number {
    return this.nudgeCount;
  }

  get handoffs(): number {
    return this.handoffCount;
  }
}

/**
 * Feature hash of tool arguments or a tool result. Seeded per run: equal values stay equal within
 * the run, while a stored hash cannot be matched to an amount by hashing guesses without the seed.
 */
export function hashFeature(text: string, seed: number): string {
  return Bun.hash(text, seed).toString(36);
}
