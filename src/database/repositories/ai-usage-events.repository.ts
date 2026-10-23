/** AI usage events repository — append-only, one row per provider attempt (no prompts, text, user or chat ids) */
import type { Database } from 'bun:sqlite';

/** Rows older than this are pruned (daily cron); reports cannot look further back. */
export const AI_USAGE_RETENTION_DAYS = 180;

export type AiUsageOutcome = 'ok' | 'error' | 'skipped';

/** What went wrong in an `error` attempt, derived from the SDK error's status/code/name — never its body. */
export type AiUsageErrorClass =
  | 'timeout'
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'server'
  | 'empty'
  | 'aborted'
  | 'bad_request'
  | 'other';

export interface AiUsageEventInput {
  /** Epoch ms (UTC) when the attempt started. */
  at: number;
  /** Endpoint key: 'zai' | 'claude' | 'hf' (historical rows may carry 'groq'). */
  provider: string;
  model: string;
  chain: string;
  /** What the call was for (agent, validator, ocr, …). */
  purpose: string;
  outcome: AiUsageOutcome;
  /** Set only on `error` rows. */
  errorClass: AiUsageErrorClass | null;
  /** HTTP status of an `error` row when the provider answered with one. */
  httpStatus: number | null;
  durationMs: number | null;
  /** NULL = the provider did not report it. A reported 0 stays 0. */
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  /** Random id shared by every attempt of one aiStreamRound call — links a failed attempt to its fallback. */
  requestId: string | null;
  /** Routing role of a role-routed attempt (stage B3); NULL = legacy chain or a row from before it. */
  role: string | null;
  /** Registry preset the slot ran, NULL when none. */
  preset: string | null;
  /**
   * Cost in micro-USD at list price (tokens × the preset's price). NULL = unknown — no price for the
   * route, or tokens not reported — never 0 for "don't know".
   */
  costMicroUsd: number | null;
}

export interface AiUsageEvent extends AiUsageEventInput {
  id: number;
}

interface AiUsageEventRow {
  id: number;
  at: number;
  provider: string;
  model: string;
  chain: string;
  purpose: string;
  outcome: AiUsageOutcome;
  error_class: AiUsageErrorClass | null;
  http_status: number | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  request_id: string | null;
  role: string | null;
  preset: string | null;
  cost_micro_usd: number | null;
}

export class AiUsageEventsRepository {
  constructor(private db: Database) {}

  /** Store a batch of attempts in one transaction; a rejected row rolls the whole batch back. */
  recordMany(events: readonly AiUsageEventInput[]): void {
    if (events.length === 0) return;
    const insert = this.db.query<
      void,
      [
        number,
        string,
        string,
        string,
        string,
        AiUsageOutcome,
        AiUsageErrorClass | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        string | null,
        string | null,
        string | null,
        number | null,
      ]
    >(`
      INSERT INTO ai_usage_events (
        at, provider, model, chain, purpose, outcome, error_class, http_status, duration_ms,
        prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, request_id,
        role, preset, cost_micro_usd
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const e of events) {
        insert.run(
          e.at,
          e.provider,
          e.model,
          e.chain,
          e.purpose,
          e.outcome,
          e.errorClass,
          e.httpStatus,
          e.durationMs,
          e.promptTokens,
          e.completionTokens,
          e.reasoningTokens,
          e.cachedTokens,
          e.requestId,
          e.role,
          e.preset,
          e.costMicroUsd,
        );
      }
    })();
  }

  /** Rows with `at >= sinceMs`, oldest first. */
  listSince(sinceMs: number): AiUsageEvent[] {
    return this.db
      .query<AiUsageEventRow, [number]>(
        'SELECT * FROM ai_usage_events WHERE at >= ? ORDER BY at, id',
      )
      .all(sinceMs)
      .map((r) => ({
        id: r.id,
        at: r.at,
        provider: r.provider,
        model: r.model,
        chain: r.chain,
        purpose: r.purpose,
        outcome: r.outcome,
        errorClass: r.error_class,
        httpStatus: r.http_status,
        durationMs: r.duration_ms,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        reasoningTokens: r.reasoning_tokens,
        cachedTokens: r.cached_tokens,
        requestId: r.request_id,
        role: r.role,
        preset: r.preset,
        costMicroUsd: r.cost_micro_usd,
      }));
  }

  /** Delete rows with `at < cutoffMs` (retention); returns how many were removed. */
  pruneOlderThan(cutoffMs: number): number {
    return this.db.query<void, [number]>('DELETE FROM ai_usage_events WHERE at < ?').run(cutoffMs)
      .changes;
  }
}
