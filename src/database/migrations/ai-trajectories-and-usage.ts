// Migrations 052-055: agent trajectories and AI usage events.
// Split out of schema.ts so no single file carries the whole migration history. List order and
// migration names are the contract with already-migrated databases and must not change.

import { migrationLogger as logger } from './migration-logger';
import type { Migration } from './types';

export const aiTrajectoryAndUsageMigrations: Migration[] = [
  {
    // Phase 0 of the agent stall guard (docs/specs/2026-10-13-agent-stall-guard.md): per-run and
    // per-tool-round features for training the stall classifier. No message text, arguments or
    // results — only tool names, per-run-seeded hashes, providers, timings and decisions.
    name: '052_create_agent_trajectories',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS agent_trajectories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            started_at INTEGER NOT NULL,
            finished_at INTEGER NOT NULL,
            outcome TEXT NOT NULL CHECK (outcome IN ('answered', 'no_answer', 'silent', 'error')),
            error_kind TEXT,
            is_mention INTEGER NOT NULL,
            tool_rounds INTEGER NOT NULL,
            tool_calls INTEGER NOT NULL,
            nudges INTEGER NOT NULL,
            handoffs INTEGER NOT NULL,
            providers TEXT NOT NULL,
            answer_provider TEXT,
            finalize_reason TEXT,
            follow_up_after_ms INTEGER
          )
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_agent_trajectories_group_finished
          ON agent_trajectories(group_id, finished_at)
        `);
      db.exec(`
          CREATE TABLE IF NOT EXISTS agent_trajectory_rounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trajectory_id INTEGER NOT NULL REFERENCES agent_trajectories(id) ON DELETE CASCADE,
            round INTEGER NOT NULL,
            provider TEXT NOT NULL,
            elapsed_ms INTEGER NOT NULL,
            calls TEXT NOT NULL,
            decision TEXT NOT NULL,
            reason TEXT
          )
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_agent_trajectory_rounds_trajectory
          ON agent_trajectory_rounds(trajectory_id)
        `);
      logger.info('✓ Created agent trajectory tables');
    },
  },
  {
    // Durable per-provider AI usage: one row per provider attempt of aiStreamRound (ok, error,
    // or skipped before any request). Token columns are NULL when the provider did not report
    // usage — NULL is "unknown", never 0. No prompts, completions, user ids or chat ids.
    name: '053_create_ai_usage_events',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS ai_usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at INTEGER NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            chain TEXT NOT NULL,
            purpose TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'skipped')),
            error_class TEXT,
            http_status INTEGER,
            duration_ms INTEGER,
            prompt_tokens INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
            completion_tokens INTEGER CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
            reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
            cached_tokens INTEGER CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
            request_id TEXT,
            CHECK (outcome = 'error' OR (error_class IS NULL AND http_status IS NULL))
          )
        `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_events_at ON ai_usage_events(at)`);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_ai_usage_events_provider_at
          ON ai_usage_events(provider, at)
        `);
      logger.info('✓ Created ai_usage_events table');
    },
  },
  {
    // Stage B4: which routing role and registry preset served an attempt, and what it cost.
    // All three are NULL on legacy-chain rows and on every row written before this migration;
    // cost_micro_usd is NULL whenever the price or the token counts are unknown — never 0 for
    // "don't know". Appended, never renumbered (HyperCalendarBot keeps its own numbering).
    name: '054_add_role_preset_cost_to_ai_usage_events',
    up: (db) => {
      db.exec(`ALTER TABLE ai_usage_events ADD COLUMN role TEXT`);
      db.exec(`ALTER TABLE ai_usage_events ADD COLUMN preset TEXT`);
      db.exec(`
          ALTER TABLE ai_usage_events
          ADD COLUMN cost_micro_usd INTEGER CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0)
        `);
      logger.info('✓ Added role, preset and cost to ai_usage_events');
    },
  },
  {
    // Speed telemetry: first_token_ms is request start → first content/tool-call delta of an ok
    // attempt; generation_ms is first → last such delta. Tokens per second is NOT stored: it is
    // derived at read time from generation_ms and the token columns. NULL = not measured (error,
    // empty or skipped attempt, or a row from before this migration) — never 0 for "unknown".
    // Prompt size: system_prompt_tokens, tool_catalog_tokens, history_tokens, user_tokens are
    // character-based ESTIMATES of the request components (the provider's prompt_tokens stays the
    // truth), tool_count / message_count are exact. NULL on skipped attempts and old rows.
    // Same column names as HyperCalendarBot's ai_usage_events; numbering is per repo.
    name: '055_add_timing_and_prompt_size_to_ai_usage_events',
    up: (db) => {
      for (const column of [
        'first_token_ms',
        'generation_ms',
        'system_prompt_tokens',
        'tool_catalog_tokens',
        'history_tokens',
        'user_tokens',
        'tool_count',
        'message_count',
      ]) {
        db.exec(
          `ALTER TABLE ai_usage_events ADD COLUMN ${column} INTEGER CHECK (${column} IS NULL OR ${column} >= 0)`,
        );
      }
      logger.info('✓ Added timing and prompt-size columns to ai_usage_events');
    },
  },
];
