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

/** Character-based estimate of one request's size by component; see `estimatePromptSize`. */
export interface AiPromptSize {
  /** system / developer messages. */
  systemPromptTokens: number;
  /** JSON of the tool definitions; 0 when the round sends none. */
  toolCatalogTokens: number;
  /** every other message before the final user turn, tool calls and tool results included. */
  historyTokens: number;
  /** the last message when it is from the user, else 0. */
  userTokens: number;
  toolCount: number;
  messageCount: number;
}

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
  /**
   * Request start to the first content or tool-call delta of the attempt, ms. NULL = not measured
   * (failed, empty or skipped attempt, or a row from before migration 055).
   */
  firstTokenMs: number | null;
  /**
   * First to last content or tool-call delta, ms (0 for a one-delta answer). Visible output tokens
   * per second = (completionTokens − reasoningTokens) × 1000 / generationMs; see usage-report.
   */
  generationMs: number | null;
  /**
   * Estimated size of the request by component (character-based estimate, never the provider's
   * count — promptTokens stays the truth). NULL = not estimated: a skipped attempt, or a row from
   * before migration 055. No prompt text is stored.
   */
  promptSize: AiPromptSize | null;
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
  /** Absent on a database older than migration 055 (read as NULL). */
  first_token_ms?: number | null;
  generation_ms?: number | null;
  system_prompt_tokens?: number | null;
  tool_catalog_tokens?: number | null;
  history_tokens?: number | null;
  user_tokens?: number | null;
  tool_count?: number | null;
  message_count?: number | null;
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
        number | null,
        number | null,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
      ]
    >(`
      INSERT INTO ai_usage_events (
        at, provider, model, chain, purpose, outcome, error_class, http_status, duration_ms,
        first_token_ms, generation_ms, prompt_tokens, completion_tokens, reasoning_tokens,
        cached_tokens, request_id, role, preset, cost_micro_usd, system_prompt_tokens,
        tool_catalog_tokens, history_tokens, user_tokens, tool_count, message_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          e.firstTokenMs,
          e.generationMs,
          e.promptTokens,
          e.completionTokens,
          e.reasoningTokens,
          e.cachedTokens,
          e.requestId,
          e.role,
          e.preset,
          e.costMicroUsd,
          e.promptSize?.systemPromptTokens ?? null,
          e.promptSize?.toolCatalogTokens ?? null,
          e.promptSize?.historyTokens ?? null,
          e.promptSize?.userTokens ?? null,
          e.promptSize?.toolCount ?? null,
          e.promptSize?.messageCount ?? null,
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
        firstTokenMs: r.first_token_ms ?? null,
        generationMs: r.generation_ms ?? null,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        reasoningTokens: r.reasoning_tokens,
        cachedTokens: r.cached_tokens,
        requestId: r.request_id,
        role: r.role,
        preset: r.preset,
        costMicroUsd: r.cost_micro_usd,
        promptSize:
          r.system_prompt_tokens == null ||
          r.tool_catalog_tokens == null ||
          r.history_tokens == null ||
          r.user_tokens == null ||
          r.tool_count == null ||
          r.message_count == null
            ? null
            : {
                systemPromptTokens: r.system_prompt_tokens,
                toolCatalogTokens: r.tool_catalog_tokens,
                historyTokens: r.history_tokens,
                userTokens: r.user_tokens,
                toolCount: r.tool_count,
                messageCount: r.message_count,
              },
      }));
  }

  /** Delete rows with `at < cutoffMs` (retention); returns how many were removed. */
  pruneOlderThan(cutoffMs: number): number {
    return this.db.query<void, [number]>('DELETE FROM ai_usage_events WHERE at < ?').run(cutoffMs)
      .changes;
  }
}
