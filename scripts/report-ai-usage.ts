#!/usr/bin/env bun
/**
 * Read-only report of per-provider AI usage from the ai_usage_events table.
 *
 * Usage: bun scripts/report-ai-usage.ts [--days N] [--json] [--db PATH]
 *   --days N   window in days, integer 1..180 (default 7)
 *   --json     print the aggregated report as JSON instead of the text table
 *   --db PATH  SQLite file (default: $DATABASE_PATH, else ./data/expenses.db)
 *
 * Opens the DB read-only and never migrates; avoids src/config/env so no bot secrets are needed.
 * Exit codes: 0 ok, 1 ai_usage_events table missing, 2 usage error / DB file not found.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import {
  AI_USAGE_RETENTION_DAYS,
  AiUsageEventsRepository,
} from '../src/database/repositories/ai-usage-events.repository';
import { aggregateUsage, formatUsageText } from '../src/services/ai/usage-report';

// The report is this script's product: write it to stdout, errors to stderr.
function fail(line: string, code: number): never {
  process.stderr.write(`${line}\n`);
  process.exit(code);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const USAGE = 'Usage: bun scripts/report-ai-usage.ts [--days N] [--json] [--db PATH]';
const daysArg = argValue('--days') ?? '7';
const days = /^\d+$/.test(daysArg) ? Number(daysArg) : Number.NaN;
if (!Number.isInteger(days) || days < 1 || days > AI_USAGE_RETENTION_DAYS) {
  fail(
    `--days must be an integer between 1 and ${AI_USAGE_RETENTION_DAYS}, got "${daysArg}"\n${USAGE}`,
    2,
  );
}

const dbPath = argValue('--db') ?? process.env['DATABASE_PATH'] ?? './data/expenses.db';
// bun:sqlite would silently create an empty DB at a mistyped path.
if (!existsSync(dbPath)) fail(`Database file not found: ${dbPath}`, 2);

const db = new Database(dbPath, { readonly: true });
try {
  const now = Date.now();
  const events = new AiUsageEventsRepository(db).listSince(now - days * 86_400_000);
  const report = aggregateUsage(events, { now, days });
  process.stdout.write(
    `${process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatUsageText(report)}\n`,
  );
} catch (error) {
  if (error instanceof Error && error.message.includes('no such table')) {
    fail(
      `ai_usage_events not found in ${dbPath} — migration 053 has not run on that database yet`,
      1,
    );
  }
  throw error;
} finally {
  db.close();
}
