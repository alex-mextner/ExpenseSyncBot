/** Agent trajectory repository — per-run and per-tool-round features of agent runs (stall-classifier dataset) */
import type { Database } from 'bun:sqlite';
import type { StallDecision, ToolCallRecord } from '../../services/ai/stall-guard';

/** How an agent run ended. `silent`: the model chose [SKIP] and nothing was shown. */
export type AgentRunOutcome = 'answered' | 'no_answer' | 'silent' | 'error';

export interface AgentTrajectoryRoundData {
  round: number;
  provider: string;
  elapsedMs: number;
  calls: ToolCallRecord[];
  decision: StallDecision['action'];
  /** The stall signal or finalize reason behind a decision other than `continue`. */
  reason: string | null;
}

export interface CreateAgentTrajectoryData {
  groupId: number;
  startedAt: number;
  finishedAt: number;
  outcome: AgentRunOutcome;
  errorKind: string | null;
  isMention: boolean;
  toolCalls: number;
  nudges: number;
  handoffs: number;
  /** Providers that answered a round, in first-use order. */
  providers: string[];
  answerProvider: string | null;
  finalizeReason: string | null;
  rounds: AgentTrajectoryRoundData[];
}

/**
 * The next question in a group within this window marks the previous run as followed up — the
 * cheap stand-in for "ты завис?" (the text itself is not stored).
 */
const FOLLOW_UP_WINDOW_MS = 5 * 60_000;

export class AgentTrajectoryRepository {
  constructor(private db: Database) {}

  /** Store a finished run with its tool rounds in one transaction; returns the run id. */
  create(data: CreateAgentTrajectoryData): number {
    return this.db.transaction(() => {
      const run = this.db
        .query<
          { id: number },
          [
            number,
            number,
            number,
            string,
            string | null,
            number,
            number,
            number,
            number,
            number,
            string,
            string | null,
            string | null,
          ]
        >(`
          INSERT INTO agent_trajectories (
            group_id, started_at, finished_at, outcome, error_kind, is_mention, tool_rounds,
            tool_calls, nudges, handoffs, providers, answer_provider, finalize_reason
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `)
        .get(
          data.groupId,
          data.startedAt,
          data.finishedAt,
          data.outcome,
          data.errorKind,
          data.isMention ? 1 : 0,
          data.rounds.length,
          data.toolCalls,
          data.nudges,
          data.handoffs,
          JSON.stringify(data.providers),
          data.answerProvider,
          data.finalizeReason,
        );
      if (!run) throw new Error('Failed to create agent trajectory');

      const insertRound = this.db.query<
        void,
        [number, number, string, number, string, string, string | null]
      >(`
        INSERT INTO agent_trajectory_rounds (
          trajectory_id, round, provider, elapsed_ms, calls, decision, reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const round of data.rounds) {
        insertRound.run(
          run.id,
          round.round,
          round.provider,
          round.elapsedMs,
          JSON.stringify(round.calls),
          round.decision,
          round.reason,
        );
      }
      return run.id;
    })();
  }

  /**
   * A new run starts in the group: if its latest run ended within the follow-up window and has no
   * follow-up yet, record the gap.
   */
  markFollowUp(groupId: number, now: number): void {
    this.db
      .query<void, [number, number, number]>(`
        UPDATE agent_trajectories
        SET follow_up_after_ms = ?1 - finished_at
        WHERE id = (
          SELECT id FROM agent_trajectories
          WHERE group_id = ?2 AND finished_at <= ?1
          ORDER BY finished_at DESC, id DESC
          LIMIT 1
        )
        AND follow_up_after_ms IS NULL
        AND ?1 - finished_at < ?3
      `)
      .run(now, groupId, FOLLOW_UP_WINDOW_MS);
  }
}
