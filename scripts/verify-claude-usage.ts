#!/usr/bin/env bun
/**
 * Live check that Claude answers through the bot's own code path and that the usage store records it.
 *
 * Runs three tiny requests through aiStreamRound / the real OCR extractor with every other provider
 * kept out of the chain (smart → Claude Sonnet, fast → Claude Haiku, ocr → Claude vision on a
 * synthetic receipt image), then reads the ai_usage_events rows the bot's recorder wrote and checks
 * that each request left an `ok` row for provider `claude` with reported token counts.
 *
 * CLAUDE_API_TOKEN must be in the environment (never on the command line). The usage rows go to a
 * temp SQLite file (or --db PATH) — never to ./data/expenses.db — so this is safe next to a live bot.
 *
 * Usage: CLAUDE_API_TOKEN=… bun scripts/verify-claude-usage.ts [--db PATH]
 * Exit code: 0 all three requests answered by Claude with a recorded ok row and tokens, 1 otherwise,
 * 2 usage/config error.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { ChainName } from '../src/services/ai/streaming';

// The report is this script's product: write it to stdout, problems to stderr.
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): void {
  process.stderr.write(`${line}\n`);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!process.env['CLAUDE_API_TOKEN']) {
  fail('CLAUDE_API_TOKEN is not set — nothing to verify');
  process.exit(2);
}

// ── Env bootstrap ───────────────────────────────────────────────────────────
// env.ts validates required vars at import time. Only the Claude key is needed here, so the rest are
// placeholders pointing at a closed port: a non-Claude attempt could only fail fast, never answer.
const DEAD_URL = 'http://127.0.0.1:9/v1';
const PLACEHOLDERS: Record<string, string> = {
  BOT_TOKEN: 'verify',
  GOOGLE_CLIENT_ID: 'verify',
  GOOGLE_CLIENT_SECRET: 'verify',
  GOOGLE_REDIRECT_URI: 'http://localhost/callback',
  ANTHROPIC_API_KEY: 'verify',
  AI_BASE_URL: DEAD_URL,
  AI_MODEL: 'verify',
  AI_FAST_MODEL: 'verify',
  HF_TOKEN: 'verify',
  HF_BASE_URL: DEAD_URL,
  HF_MODEL: 'verify',
  HF_FAST_MODEL: 'verify',
  HF_VISION_MODEL: 'verify',
};
for (const [key, value] of Object.entries(PLACEHOLDERS)) {
  // Forced, not `??=`: Bun auto-loads a cwd `.env`, whose real HF/z.ai values would let a failed
  // Claude vision call fall through to a billed HF request.
  process.env[key] = value;
}
// A Groq key in the environment would add a Groq slot; the chain is Claude-only either way
// (excludeProviders below), but keep the rows free of surprises.
process.env['GROQ_API_KEY'] = '';
process.env['LOG_LEVEL'] ??= 'silent';
const dbPath =
  argValue('--db') ?? path.join(mkdtempSync(path.join(tmpdir(), 'esb-usage-probe-')), 'probe.db');
process.env['DATABASE_PATH'] = dbPath;

// Dynamic imports: env.ts and the database read process.env at module load, so they must load AFTER
// the bootstrap above — static imports are hoisted and would run first.
const { database } = await import('../src/database');
const { aggregateUsage, formatUsageText } = await import('../src/services/ai/usage-report');
const { aiStreamRound, nextProvider } = await import('../src/services/ai/streaming');
const { flushAiUsageRecording } = await import('../src/services/ai/usage-recorder');
const { extractTextFromImageBuffer } = await import('../src/services/receipt/ocr-extractor');

interface UsageRow {
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
}

/** Rows written by this run only: a reused --db may hold rows from earlier runs. */
const runStartedAt = Date.now();

async function usageRows(): Promise<UsageRow[]> {
  await flushAiUsageRecording();
  return database.queryAll<UsageRow>(
    `SELECT provider, model, chain, purpose, outcome, error_class, http_status, duration_ms,
            prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens
     FROM ai_usage_events WHERE at >= ? ORDER BY id`,
    runStartedAt,
  );
}

/** Every slot of the chain except Claude's, by walking the chain with the public nextProvider(). */
function nonClaudeSlots(chain: ChainName): string[] {
  const all: string[] = [];
  for (let name = nextProvider(chain, all); name; name = nextProvider(chain, all)) all.push(name);
  return all.filter((name) => !name.startsWith('Claude ('));
}

function cell(value: number | null): string {
  return value === null ? 'null' : String(value);
}

interface Check {
  label: string;
  chain: string;
  purpose: string;
  answer: string;
}

const checks: Check[] = [];
const problems: string[] = [];

async function textProbe(chain: 'smart' | 'fast'): Promise<void> {
  const result = await aiStreamRound({
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 200,
    chain,
    purpose: 'probe',
    excludeProviders: nonClaudeSlots(chain),
  });
  checks.push({
    label: `${chain} text`,
    chain,
    purpose: 'probe',
    answer: `${result.providerUsed}: ${result.text.trim().slice(0, 60)}`,
  });
}

async function visionProbe(): Promise<void> {
  const svg =
    '<svg width="520" height="140" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="100%" height="100%" fill="white"/>' +
    '<text x="24" y="90" font-size="56" font-family="DejaVu Sans, sans-serif" fill="black">TOTAL 12.50</text></svg>';
  const jpeg = await sharp(Buffer.from(svg)).jpeg().toBuffer();
  const text = await extractTextFromImageBuffer(jpeg);
  checks.push({
    label: 'ocr vision',
    chain: 'ocr',
    purpose: 'ocr',
    answer: `OCR read: ${text.trim().slice(0, 60)}`,
  });
  if (!text.includes('12.50'))
    problems.push(
      `ocr: the synthetic receipt text "TOTAL 12.50" was not read back (got "${text.trim().slice(0, 60)}")`,
    );
}

say(`usage rows go to ${dbPath}`);
for (const run of [() => textProbe('smart'), () => textProbe('fast'), () => visionProbe()]) {
  try {
    await run();
  } catch (error) {
    problems.push(
      `request failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
    );
  }
}

const rows = await usageRows();
say('');
say(
  'chain  purpose  provider  model                 outcome  error       ms     in     out    reasoning  cached',
);
for (const r of rows) {
  say(
    [
      r.chain.padEnd(6),
      r.purpose.padEnd(8),
      r.provider.padEnd(9),
      r.model.padEnd(21),
      r.outcome.padEnd(8),
      (r.error_class ?? '-').padEnd(11),
      cell(r.duration_ms).padEnd(6),
      cell(r.prompt_tokens).padEnd(6),
      cell(r.completion_tokens).padEnd(6),
      cell(r.reasoning_tokens).padEnd(10),
      cell(r.cached_tokens),
    ].join(' '),
  );
}

for (const check of checks) {
  say(`${check.label}: ${check.answer}`);
  const okRow = rows.find(
    (r) =>
      r.chain === check.chain &&
      r.purpose === check.purpose &&
      r.provider === 'claude' &&
      r.outcome === 'ok',
  );
  if (!okRow)
    problems.push(`${check.label}: no ok row for provider claude in chain ${check.chain}`);
  else if (okRow.prompt_tokens === null || okRow.completion_tokens === null) {
    problems.push(
      `${check.label}: the ok row has no reported tokens (in=${cell(okRow.prompt_tokens)} out=${cell(okRow.completion_tokens)})`,
    );
  }
}
const strangers = rows.filter((r) => r.provider !== 'claude' && r.outcome !== 'skipped');
if (strangers.length > 0)
  problems.push(
    `${strangers.length} non-Claude attempt(s) were made: ${strangers.map((r) => r.provider).join(', ')}`,
  );

say('');
say(
  formatUsageText(
    aggregateUsage(database.aiUsageEvents.listSince(runStartedAt), { now: Date.now(), days: 1 }),
  ),
);

if (problems.length > 0) {
  fail(`\nFAIL:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
say(
  '\nOK: Claude answered all three requests through the bot code path and each left an ok row with tokens',
);
process.exit(0);
