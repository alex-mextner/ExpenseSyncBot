// Tests for AiUsageEventsRepository and migrations 053 / 054 / 055 — append-only attempt rows, nullable tokens and timing, retention prune

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb } from '../../test-utils/db';
import { type AiUsageEventInput, AiUsageEventsRepository } from './ai-usage-events.repository';

let db: Database;
let repo: AiUsageEventsRepository;

const NOW = 1_760_000_000_000;
const DAY_MS = 86_400_000;

interface RawRow {
  id: number;
  at: number;
  provider: string;
  model: string;
  chain: string;
  purpose: string;
  outcome: string;
  error_class: string | null;
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
  first_token_ms: number | null;
  generation_ms: number | null;
  system_prompt_tokens: number | null;
  tool_catalog_tokens: number | null;
  history_tokens: number | null;
  user_tokens: number | null;
  tool_count: number | null;
  message_count: number | null;
}

function okEvent(overrides: Partial<AiUsageEventInput> = {}): AiUsageEventInput {
  return {
    at: NOW,
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    chain: 'smart',
    purpose: 'agent',
    outcome: 'ok',
    errorClass: null,
    httpStatus: null,
    durationMs: 1_200,
    promptTokens: 100,
    completionTokens: 20,
    reasoningTokens: null,
    cachedTokens: null,
    requestId: 'req-1',
    role: null,
    preset: null,
    costMicroUsd: null,
    firstTokenMs: null,
    generationMs: null,
    promptSize: null,
    ...overrides,
  };
}

function rawRows(): RawRow[] {
  return db.query<RawRow, []>('SELECT * FROM ai_usage_events ORDER BY id').all();
}

beforeAll(() => {
  db = createTestDb();
  repo = new AiUsageEventsRepository(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec('DELETE FROM ai_usage_events');
});

describe('migration 053_create_ai_usage_events', () => {
  it('is recorded as applied, followed by 054 and 055 — migrations are only ever appended', () => {
    const names = db
      .query<{ name: string }, []>('SELECT name FROM migrations ORDER BY id')
      .all()
      .map((m) => m.name);
    const at = names.indexOf('053_create_ai_usage_events');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(names[at + 1]).toBe('054_add_role_preset_cost_to_ai_usage_events');
    expect(names[at + 2]).toBe('055_add_timing_and_prompt_size_to_ai_usage_events');
    expect(names.at(-1)).toBe('055_add_timing_and_prompt_size_to_ai_usage_events');
  });

  it('creates the table with exactly the usage columns and no user-identifying column', () => {
    const columns = db
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('ai_usage_events')`)
      .all()
      .map((c) => c.name);
    expect(columns).toEqual([
      'id',
      'at',
      'provider',
      'model',
      'chain',
      'purpose',
      'outcome',
      'error_class',
      'http_status',
      'duration_ms',
      'prompt_tokens',
      'completion_tokens',
      'reasoning_tokens',
      'cached_tokens',
      'request_id',
      'role',
      'preset',
      'cost_micro_usd',
      'first_token_ms',
      'generation_ms',
      'system_prompt_tokens',
      'tool_catalog_tokens',
      'history_tokens',
      'user_tokens',
      'tool_count',
      'message_count',
    ]);
  });

  it('indexes (at) and (provider, at)', () => {
    const indexes = db
      .query<{ name: string }, []>(`SELECT name FROM pragma_index_list('ai_usage_events')`)
      .all()
      .map((i) => i.name);
    expect(indexes).toContain('idx_ai_usage_events_at');
    expect(indexes).toContain('idx_ai_usage_events_provider_at');
    const providerAt = db
      .query<{ name: string }, []>(
        `SELECT name FROM pragma_index_info('idx_ai_usage_events_provider_at')`,
      )
      .all()
      .map((c) => c.name);
    expect(providerAt).toEqual(['provider', 'at']);
  });
});

describe('AiUsageEventsRepository', () => {
  describe('recordMany', () => {
    it('stores every attempt field', () => {
      repo.recordMany([
        okEvent({ reasoningTokens: 7, cachedTokens: 40 }),
        okEvent({
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
          outcome: 'error',
          errorClass: 'rate_limit',
          httpStatus: 429,
          durationMs: 80,
          promptTokens: null,
          completionTokens: null,
        }),
      ]);

      const [first, second] = rawRows();
      expect(first).toMatchObject({
        at: NOW,
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        chain: 'smart',
        purpose: 'agent',
        outcome: 'ok',
        error_class: null,
        http_status: null,
        duration_ms: 1_200,
        prompt_tokens: 100,
        completion_tokens: 20,
        reasoning_tokens: 7,
        cached_tokens: 40,
        request_id: 'req-1',
      });
      expect(second).toMatchObject({
        provider: 'groq',
        outcome: 'error',
        error_class: 'rate_limit',
        http_status: 429,
        prompt_tokens: null,
        completion_tokens: null,
      });
    });

    it('keeps unknown token counts NULL and a reported zero as 0', () => {
      repo.recordMany([
        okEvent({
          promptTokens: null,
          completionTokens: null,
          reasoningTokens: null,
          cachedTokens: null,
        }),
        okEvent({ promptTokens: 12, completionTokens: 3, reasoningTokens: 0, cachedTokens: 0 }),
      ]);

      const [unknown, reportedZero] = rawRows();
      expect(unknown).toMatchObject({
        prompt_tokens: null,
        completion_tokens: null,
        reasoning_tokens: null,
        cached_tokens: null,
      });
      expect(reportedZero).toMatchObject({
        prompt_tokens: 12,
        completion_tokens: 3,
        reasoning_tokens: 0,
        cached_tokens: 0,
      });
    });

    it('stores role, preset and cost, and keeps them NULL for legacy rows', () => {
      repo.recordMany([
        okEvent({ role: 'executor', preset: 'glm53-flash-low', costMicroUsd: 124 }),
        okEvent({ costMicroUsd: 0 }),
        okEvent(),
      ]);
      const [roleRouted, freeCall, legacy] = rawRows();
      expect(roleRouted).toMatchObject({
        role: 'executor',
        preset: 'glm53-flash-low',
        cost_micro_usd: 124,
      });
      expect(freeCall).toMatchObject({ role: null, preset: null, cost_micro_usd: 0 });
      expect(legacy).toMatchObject({ role: null, preset: null, cost_micro_usd: null });
    });

    it('stores first-token and generation timing, and keeps unknown timing NULL', () => {
      repo.recordMany([
        okEvent({ firstTokenMs: 640, generationMs: 2_100 }),
        okEvent({ firstTokenMs: 300, generationMs: 0 }),
        okEvent({ firstTokenMs: null, generationMs: null }),
      ]);
      const [timed, oneDelta, unknown] = rawRows();
      expect(timed).toMatchObject({ first_token_ms: 640, generation_ms: 2_100 });
      expect(oneDelta).toMatchObject({ first_token_ms: 300, generation_ms: 0 });
      expect(unknown).toMatchObject({ first_token_ms: null, generation_ms: null });
      expect(repo.listSince(0).map((e) => [e.firstTokenMs, e.generationMs])).toEqual([
        [640, 2_100],
        [300, 0],
        [null, null],
      ]);
    });

    it('stores the estimated prompt size by component and reads it back; NULL stays null', () => {
      const promptSize = {
        systemPromptTokens: 900,
        toolCatalogTokens: 7_000,
        historyTokens: 2_500,
        userTokens: 40,
        toolCount: 21,
        messageCount: 9,
      };
      repo.recordMany([okEvent({ promptSize }), okEvent({ promptSize: null })]);
      const [sized, unsized] = rawRows();
      expect(sized).toMatchObject({
        system_prompt_tokens: 900,
        tool_catalog_tokens: 7_000,
        history_tokens: 2_500,
        user_tokens: 40,
        tool_count: 21,
        message_count: 9,
      });
      expect(unsized).toMatchObject({ system_prompt_tokens: null, tool_count: null });
      expect(repo.listSince(0).map((e) => e.promptSize)).toEqual([promptSize, null]);
    });

    it('reads rows of a database older than migration 055 as NULL timing', () => {
      const old = new Database(':memory:');
      old.exec(`
        CREATE TABLE ai_usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, provider TEXT NOT NULL,
          model TEXT NOT NULL, chain TEXT NOT NULL, purpose TEXT NOT NULL, outcome TEXT NOT NULL,
          error_class TEXT, http_status INTEGER, duration_ms INTEGER, prompt_tokens INTEGER,
          completion_tokens INTEGER, reasoning_tokens INTEGER, cached_tokens INTEGER,
          request_id TEXT, role TEXT, preset TEXT, cost_micro_usd INTEGER
        )
      `);
      old.exec(
        `INSERT INTO ai_usage_events (at, provider, model, chain, purpose, outcome, duration_ms)
         VALUES (${NOW}, 'claude', 'm', 'smart', 'agent', 'ok', 900)`,
      );
      const [row] = new AiUsageEventsRepository(old).listSince(0);
      old.close();
      expect(row).toMatchObject({ durationMs: 900, firstTokenMs: null, generationMs: null });
    });

    it('rejects a negative cost', () => {
      expect(() => repo.recordMany([okEvent({ costMicroUsd: -1 })])).toThrow();
    });

    it('stores a skipped attempt with no duration', () => {
      repo.recordMany([
        okEvent({
          outcome: 'skipped',
          durationMs: null,
          promptTokens: null,
          completionTokens: null,
        }),
      ]);
      expect(rawRows()[0]).toMatchObject({ outcome: 'skipped', duration_ms: null });
    });

    it('writes nothing for an empty batch', () => {
      repo.recordMany([]);
      expect(rawRows()).toHaveLength(0);
    });

    it('is all-or-nothing: a rejected row rolls the whole batch back', () => {
      const bad = okEvent();
      Object.assign(bad, { outcome: 'maybe' });
      expect(() => repo.recordMany([okEvent(), bad])).toThrow();
      expect(rawRows()).toHaveLength(0);
    });

    it('rejects an error class on a row that is not an error', () => {
      expect(() => repo.recordMany([okEvent({ errorClass: 'timeout' })])).toThrow();
      expect(() => repo.recordMany([okEvent({ httpStatus: 500 })])).toThrow();
    });

    it('rejects a negative token count', () => {
      expect(() => repo.recordMany([okEvent({ promptTokens: -1 })])).toThrow();
    });
  });

  describe('listSince', () => {
    it('returns the rows at or after the cutoff, oldest first, with ids', () => {
      repo.recordMany([
        okEvent({ at: NOW - 3 * DAY_MS, requestId: 'old' }),
        okEvent({ at: NOW - 1 * DAY_MS, requestId: 'newer' }),
        okEvent({ at: NOW - 2 * DAY_MS, requestId: 'mid' }),
      ]);

      const rows = repo.listSince(NOW - 2 * DAY_MS);
      expect(rows.map((r) => r.requestId)).toEqual(['mid', 'newer']);
      expect(rows[0]?.id).toBeGreaterThan(0);
      expect(rows[0]).toMatchObject({
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        outcome: 'ok',
        errorClass: null,
        promptTokens: 100,
        reasoningTokens: null,
        role: null,
        preset: null,
        costMicroUsd: null,
        firstTokenMs: null,
        generationMs: null,
      });
    });

    it('reads role, preset and cost back', () => {
      repo.recordMany([okEvent({ role: 'repair', preset: 'glm53-low', costMicroUsd: 9 })]);
      expect(repo.listSince(0)[0]).toMatchObject({
        role: 'repair',
        preset: 'glm53-low',
        costMicroUsd: 9,
      });
    });
  });

  describe('pruneOlderThan', () => {
    it('deletes only rows older than the cutoff and returns how many', () => {
      repo.recordMany([
        okEvent({ at: NOW - 200 * DAY_MS, requestId: 'ancient' }),
        okEvent({ at: NOW - 181 * DAY_MS, requestId: 'expired' }),
        okEvent({ at: NOW - 180 * DAY_MS, requestId: 'boundary' }),
        okEvent({ at: NOW - 1 * DAY_MS, requestId: 'fresh' }),
      ]);

      const removed = repo.pruneOlderThan(NOW - 180 * DAY_MS);

      expect(removed).toBe(2);
      expect(rawRows().map((r) => r.request_id)).toEqual(['boundary', 'fresh']);
    });

    it('returns 0 when nothing is old enough', () => {
      repo.recordMany([okEvent({ at: NOW })]);
      expect(repo.pruneOlderThan(NOW - DAY_MS)).toBe(0);
      expect(rawRows()).toHaveLength(1);
    });
  });
});
