#!/usr/bin/env bun
/**
 * Replay historical AI traffic through the Claude slots of the fallback chains and report whether
 * Claude (Sonnet on the smart chain, Haiku on the fast chain) handles every real request shape.
 *
 * Sources (any combination):
 *   --logs <dir>  AI_DEBUG_LOGS output (logs/chats). Each agent run is replayed through the real
 *                 aiStreamRound: round 1 (system + history + message + TOOL_DEFINITIONS) on Sonnet,
 *                 round 2 with the historical tool results fed back, then the final text through
 *                 the real response validator (fast chain → Haiku).
 *   --db <path>   COPY of the production SQLite DB (migrations run on it; without --db an in-memory
 *                 DB is used). Confirmed bank transactions go through the real preFillTransactions
 *                 (fast chain → Haiku) and the suggested category is compared with the one the
 *                 user confirmed.
 *   --limit <n>   max agent runs and max transactions to replay (default 30).
 *
 * Every other provider is demoted via the circuit breaker so Claude is tried first, and a wrapped
 * fetch records which host/model actually answered each request — a step only counts as OK when
 * Anthropic answered it.
 *
 * Usage: bun run scripts/replay-ai-logs.ts --logs ./logs/chats --db /tmp/expenses-copy.db
 * Exit code 1 if any replayed request was not answered by Claude, or if nothing was replayed.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type OpenAI from 'openai';
import type { BankTransaction } from '../src/database/types';
import type { StreamRoundResult } from '../src/services/ai/streaming';

// ── CLI ─────────────────────────────────────────────────────────────────────

// The report is this script's product: write it to stdout, usage errors to stderr.
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

const LOGS_DIR = argValue('--logs');
const DB_PATH = argValue('--db');
const LIMIT = Number(argValue('--limit') ?? '30');

if (!LOGS_DIR && !DB_PATH) {
  fail('Usage: bun run scripts/replay-ai-logs.ts [--logs <dir>] [--db <copy.db>] [--limit N]');
  process.exit(2);
}
if (!Number.isInteger(LIMIT) || LIMIT <= 0) {
  fail(`--limit must be a positive integer, got "${argValue('--limit')}"`);
  process.exit(2);
}
// bun:sqlite would silently create an empty DB at a mistyped path and replay nothing.
if (DB_PATH && !existsSync(DB_PATH)) {
  fail(`--db file not found: ${DB_PATH}`);
  process.exit(2);
}
if (LOGS_DIR && !existsSync(LOGS_DIR)) {
  fail(`--logs directory not found: ${LOGS_DIR}`);
  process.exit(2);
}

// ── Env bootstrap ───────────────────────────────────────────────────────────
// env.ts validates required vars at import time. Locally only the Claude key may exist, so fill the
// rest with placeholders pointing at a closed port: a non-Claude attempt then fails fast instead of
// silently answering. On the server the real values are kept (and those providers are demoted).

const DEAD_URL = 'http://127.0.0.1:9/v1';
const PLACEHOLDERS: Record<string, string> = {
  BOT_TOKEN: 'replay',
  GOOGLE_CLIENT_ID: 'replay',
  GOOGLE_CLIENT_SECRET: 'replay',
  GOOGLE_REDIRECT_URI: 'http://localhost/callback',
  ANTHROPIC_API_KEY: 'replay',
  AI_BASE_URL: DEAD_URL,
  AI_MODEL: 'replay',
  AI_FAST_MODEL: 'replay',
  HF_TOKEN: 'replay',
  HF_BASE_URL: DEAD_URL,
  HF_MODEL: 'replay',
  HF_FAST_MODEL: 'replay',
  HF_VISION_MODEL: 'replay',
};
for (const [key, value] of Object.entries(PLACEHOLDERS)) {
  if (!process.env[key]) process.env[key] = value;
}
process.env['LOG_LEVEL'] ??= 'silent';
// The tool registry imports the database, which runs migrations on load: without --db use an
// in-memory DB so a logs-only run never touches ./data/expenses.db (the prod DB on the server).
process.env['DATABASE_PATH'] = DB_PATH ?? ':memory:';

// Dynamic imports: env.ts / database read process.env at module load, so they must load AFTER the
// bootstrap above — static imports are hoisted and would run first.
const { env } = await import('../src/config/env');
const { recordProviderRateLimit } = await import('../src/services/ai/provider-breaker');
const { aiStreamRound } = await import('../src/services/ai/streaming');
const { TOOL_DEFINITIONS } = await import('../src/services/ai/tools');
const { validateResponse } = await import('../src/services/ai/response-validator');

if (!env.CLAUDE_API_TOKEN) {
  fail('CLAUDE_API_TOKEN is not set — nothing to replay');
  process.exit(2);
}

const CLAUDE_HOST = new URL(env.CLAUDE_BASE_URL).host;

// Claude first: push every other endpoint to the back of the chain for the whole run.
for (const key of ['zai', 'hf']) {
  recordProviderRateLimit(key, Date.now(), 24 * 60 * 60_000);
}

// ── Fetch provenance ────────────────────────────────────────────────────────

interface FetchRecord {
  host: string;
  model: string;
  status: number | 'network-error';
  ms: number;
}

const fetchLog: FetchRecord[] = [];
const realFetch = globalThis.fetch;

function requestModel(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') return '?';
  try {
    const body: { model?: unknown } = JSON.parse(init.body);
    return typeof body.model === 'string' ? body.model : '?';
  } catch {
    return '?';
  }
}

globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const record: FetchRecord = {
      host: new URL(url).host,
      model: requestModel(init),
      status: 'network-error',
      ms: 0,
    };
    const start = Date.now();
    try {
      const response = await realFetch(input, init);
      record.status = response.status;
      return response;
    } finally {
      record.ms = Date.now() - start;
      fetchLog.push(record);
    }
  },
  { preconnect: realFetch.preconnect },
);

interface ViaClaudeResult<T> {
  value: T | null;
  ok: boolean;
  detail: string;
  ms: number;
}

/** Run one step and report whether Anthropic answered it with the expected model. */
async function viaClaude<T>(
  expectedModel: string,
  step: () => Promise<T>,
): Promise<ViaClaudeResult<T>> {
  const from = fetchLog.length;
  const start = Date.now();
  let value: T | null = null;
  let thrown = '';
  try {
    value = await step();
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  const ms = Date.now() - start;
  const calls = fetchLog.slice(from);
  const answered = calls.find((c) => c.status === 200);
  const ok =
    !thrown &&
    answered !== undefined &&
    answered.host === CLAUDE_HOST &&
    answered.model === expectedModel &&
    calls.every((c) => c.host === CLAUDE_HOST);
  const trail = calls.map((c) => `${c.host}/${c.model}:${c.status}`).join(' → ') || 'no request';
  return { value, ok, detail: thrown ? `${trail} | ${thrown.slice(0, 160)}` : trail, ms };
}

// ── Log parsing (format: src/services/ai/debug-logger.ts) ───────────────────

const SEPARATOR = '='.repeat(80);

interface LoggedToolCall {
  name: string;
  input: string;
}

interface LoggedToolResult {
  name: string;
  ok: boolean;
  body: string;
}

interface LoggedRound {
  toolCalls: LoggedToolCall[];
  toolResults: LoggedToolResult[];
}

interface LoggedRun {
  file: string;
  timestamp: string;
  message: string;
  systemPrompt: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  rounds: LoggedRound[];
  finalResponse: string | null;
}

const MARKER = /^(TOOL CALL: |TOOL RESULT: |AI TEXT:|## |={80}$)/;

function dedent(lines: string[]): string {
  return lines
    .map((l) => (l.startsWith('  ') ? l.slice(2) : l))
    .join('\n')
    .trim();
}

function isRunStart(lines: string[], idx: number): boolean {
  return lines[idx] === SEPARATOR && /^\[\d{4}-\d{2}-\d{2}T/.test(lines[idx + 1] ?? '');
}

/** Collect lines from `start` until the next marker (or run start); returns [lines, nextIdx]. */
function takeBlock(lines: string[], start: number): [string[], number] {
  const out: string[] = [];
  let j = start;
  while (j < lines.length && !MARKER.test(lines[j] ?? '') && !isRunStart(lines, j)) {
    out.push(lines[j] ?? '');
    j++;
  }
  return [out, j];
}

/**
 * Index of the `endMarker` line after `from`. A truncated log may lack the marker: consume the rest
 * instead of rewinding to -1.
 */
function sectionEnd(lines: string[], from: number, endMarker: string): number {
  const found = lines.indexOf(endMarker, from);
  return found < 0 ? lines.length : found;
}

/** Split the lines of a HISTORY section into `[user]` / `[assistant]` turns. */
function parseHistory(historyLines: string[]): LoggedRun['history'] {
  const turns: { role: 'user' | 'assistant'; content: string[] }[] = [];
  for (const h of historyLines) {
    const role = h.match(/^\[(user|assistant)\]$/)?.[1];
    if (role === 'user' || role === 'assistant') turns.push({ role, content: [] });
    else turns.at(-1)?.content.push(h);
  }
  return turns.map((t) => ({ role: t.role, content: t.content.join('\n') }));
}

/**
 * Read a run header starting at its separator: the timestamp and the MESSAGE (possibly multi-line).
 * Returns the index just past the header's closing separator.
 */
function parseRunHeader(
  lines: string[],
  start: number,
): { timestamp: string; message: string; next: number } {
  const timestamp = (lines[start + 1] ?? '').slice(1, -1);
  let i = start + 2; // separator, [timestamp]
  // Header lines (CHAT: …) precede MESSAGE:, which may span several lines up to the separator.
  while (i < lines.length && lines[i] !== SEPARATOR && !lines[i]?.startsWith('MESSAGE: ')) i++;
  const messageLines: string[] = [];
  while (i < lines.length && lines[i] !== SEPARATOR) messageLines.push(lines[i++] ?? '');
  i++; // closing separator of the header
  return { timestamp, message: messageLines.join('\n').replace(/^MESSAGE: /, ''), next: i };
}

/** Apply the body line at `i` to `run`; returns the index of the next line to examine. */
function applyBodyLine(lines: string[], i: number, run: LoggedRun): number {
  const line = lines[i] ?? '';
  if (line === '## SYSTEM PROMPT') {
    const end = sectionEnd(lines, i, '## END SYSTEM PROMPT');
    run.systemPrompt = lines.slice(i + 1, end).join('\n');
    return end + 1;
  }
  if (line.startsWith('## HISTORY')) {
    const end = sectionEnd(lines, i, '## END HISTORY');
    run.history.push(...parseHistory(lines.slice(i + 1, end)));
    return end + 1;
  }
  if (line.startsWith('## ROUND ')) {
    run.rounds.push({ toolCalls: [], toolResults: [] });
    return i + 1;
  }
  if (line.startsWith('TOOL CALL: ')) {
    const [block, next] = takeBlock(lines, i + 1);
    run.rounds.at(-1)?.toolCalls.push({ name: line.slice(11), input: dedent(block) });
    return next;
  }
  if (line.startsWith('TOOL RESULT: ')) {
    const [, name = '', status = ''] = line.match(/^TOOL RESULT: (.+) → (OK|ERROR)$/) ?? [];
    const [block, next] = takeBlock(lines, i + 1);
    run.rounds.at(-1)?.toolResults.push({ name, ok: status === 'OK', body: dedent(block) });
    return next;
  }
  if (line === '## FINAL') {
    // "Tools called: n", "Response (n chars):", then the indented response.
    const [block, next] = takeBlock(lines, i + 3);
    run.finalResponse = dedent(block);
    return next;
  }
  return i + 1;
}

function parseLogFile(file: string): LoggedRun[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const runs: LoggedRun[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!isRunStart(lines, i)) {
      i++;
      continue;
    }
    const header = parseRunHeader(lines, i);
    i = header.next;
    const run: LoggedRun = {
      file,
      timestamp: header.timestamp,
      message: header.message,
      systemPrompt: '',
      history: [],
      rounds: [],
      finalResponse: null,
    };
    while (i < lines.length && !isRunStart(lines, i)) i = applyBodyLine(lines, i, run);
    runs.push(run);
  }
  return runs;
}

function listLogFiles(dir: string): string[] {
  const out: string[] = [];
  // Dirent types do not follow symlinks, so a symlink loop in a rotated-log layout cannot recurse.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listLogFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.log')) out.push(full);
  }
  return out;
}

// ── Agent replay (Sonnet + Haiku validator) ─────────────────────────────────

const TOOL_NAMES = new Set(
  TOOL_DEFINITIONS.flatMap((t) => (t.type === 'function' ? [t.function.name] : [])),
);

interface StepIssue {
  run: string;
  step: string;
  detail: string;
}

const issues: StepIssue[] = [];
let stepsTotal = 0;
let stepsOk = 0;

function record(runLabel: string, step: string, ok: boolean, detail: string): void {
  stepsTotal++;
  if (ok) stepsOk++;
  else issues.push({ run: runLabel, step, detail });
}

function toolCallProblems(toolCalls: { name: string; arguments: string }[]): string[] {
  const problems: string[] = [];
  for (const tc of toolCalls) {
    if (!TOOL_NAMES.has(tc.name)) problems.push(`unknown tool ${tc.name}`);
    try {
      const parsed: unknown = JSON.parse(tc.arguments || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        problems.push(`${tc.name}: arguments are not an object`);
      }
    } catch {
      problems.push(`${tc.name}: malformed JSON arguments`);
    }
  }
  return problems;
}

type ClaudeRound = ViaClaudeResult<StreamRoundResult>;

/** One agent-loop round on the smart chain — same parameters as ExpenseBotAgent.runAgentLoop. */
function replayRound(messages: OpenAI.ChatCompletionMessageParam[]): Promise<ClaudeRound> {
  return viaClaude(env.CLAUDE_MODEL, () =>
    aiStreamRound({
      messages,
      tools: TOOL_DEFINITIONS,
      maxTokens: 4096,
      temperature: 0.3,
      chain: 'smart',
      purpose: 'replay',
      signal: AbortSignal.timeout(90_000),
    }),
  );
}

/** Record a round as OK only when Claude answered it and every tool call it made is well-formed. */
function recordRound(label: string, step: string, round: ClaudeRound): void {
  const problems = round.value ? toolCallProblems(round.value.toolCalls) : [];
  record(label, step, round.ok && problems.length === 0, [round.detail, ...problems].join(' | '));
}

function roundStatus(round: { ok: boolean; ms: number }): string {
  return round.ok ? `ok ${(round.ms / 1000).toFixed(1)}s` : 'FAIL';
}

/** Agreement = same "no tools" decision or at least one shared tool. */
function toolChoiceAgrees(histTools: string[], claudeTools: string[]): boolean {
  if (histTools.length === 0) return claudeTools.length === 0;
  return claudeTools.some((name) => histTools.includes(name));
}

function buildRunMessages(run: LoggedRun): OpenAI.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: run.systemPrompt },
    ...run.history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: run.message },
  ];
}

/** The conversation after the historical round 1: its tool calls plus their logged results. */
function buildFollowUp(
  messages: OpenAI.ChatCompletionMessageParam[],
  histRound: LoggedRound,
): OpenAI.ChatCompletionMessageParam[] {
  return [
    ...messages,
    {
      role: 'assistant',
      content: null,
      tool_calls: histRound.toolCalls.map((tc, i) => ({
        id: `call_replay_${i}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.input || '{}' },
      })),
    },
    ...histRound.toolCalls.map((_, i) => {
      const result = histRound.toolResults[i];
      return {
        role: 'tool' as const,
        tool_call_id: `call_replay_${i}`,
        content: result ? (result.ok ? result.body : `Error: ${result.body}`) : 'Success',
      };
    }),
  ];
}

/**
 * Round 2 — feed the historical round-1 tool results back (bodies were clipped to 400 chars by
 * the debug logger, so this checks request shape and continuation, not answer quality).
 * `text` is Claude's answer when it finished without further tool calls.
 */
async function replayFollowUpRound(
  label: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  histRound: LoggedRound | undefined,
): Promise<{ status: string; text: string | null }> {
  if (!histRound || histRound.toolCalls.length === 0 || histRound.toolResults.length === 0) {
    return { status: 'skip', text: null };
  }
  const r2 = await replayRound(buildFollowUp(messages, histRound));
  recordRound(label, 'round2', r2);
  const finished = r2.value !== null && r2.value.toolCalls.length === 0;
  return { status: roundStatus(r2), text: finished ? (r2.value?.text ?? null) : null };
}

/** Validator (fast chain → Haiku) on Claude's final text, else on the historical final answer. */
async function replayValidator(
  label: string,
  run: LoggedRun,
  finalText: string,
  toolNames: { claude: string[]; hist: string[] },
): Promise<string> {
  const validatorInput = finalText || run.finalResponse || '';
  if (!validatorInput) return 'skip';
  const v = await viaClaude(env.CLAUDE_FAST_MODEL, () =>
    validateResponse({
      userMessage: run.message,
      toolCalls: finalText ? toolNames.claude.concat(toolNames.hist) : toolNames.hist,
      response: validatorInput,
    }),
  );
  record(label, 'validator', v.ok, v.detail);
  if (!v.ok) return 'FAIL';
  return v.value?.approved ? 'APPROVE' : 'REJECT';
}

interface AgentRunReport {
  r1Status: string;
  r2Status: string;
  validStatus: string;
  histTools: string[];
  claudeTools: string[];
}

function reportAgentRun(idx: number, run: LoggedRun, report: AgentRunReport, finalText: string): void {
  const { r1Status, r2Status, validStatus, histTools, claudeTools } = report;
  say(`${String(idx + 1).padEnd(3)} ${r1Status.padEnd(9)} ${r2Status.padEnd(9)} ${validStatus.padEnd(9)} ` +
    `[${histTools.join(',')}] → [${claudeTools.join(',')}] | ${run.message.replace(/\s+/g, ' ').slice(0, 70)}`);
  if (finalText) say(`    claude: ${finalText.replace(/\s+/g, ' ').slice(0, 160)}`);
}

/** Replay one logged run (round 1, round 2, validator), print its report line, tally tool choice. */
async function replayAgentRun(
  idx: number,
  run: LoggedRun,
  agreement: { agreed: number; comparable: number },
): Promise<void> {
  const label = `${path.basename(path.dirname(run.file))}/${path.basename(run.file)}@${run.timestamp}`;
  const messages = buildRunMessages(run);

  const r1 = await replayRound(messages);
  recordRound(label, 'round1', r1);

  const histRound = run.rounds[0];
  const histTools = histRound?.toolCalls.map((t) => t.name) ?? [];
  const claudeTools = r1.value?.toolCalls.map((t) => t.name) ?? [];
  if (r1.value) {
    agreement.comparable++;
    if (toolChoiceAgrees(histTools, claudeTools)) agreement.agreed++;
  }

  const r2 = await replayFollowUpRound(label, messages, histRound);
  const finalText = r2.text ?? (r1.value && claudeTools.length === 0 ? r1.value.text : '');
  const validStatus = await replayValidator(label, run, finalText, {
    claude: claudeTools,
    hist: histTools,
  });
  reportAgentRun(
    idx,
    run,
    { r1Status: roundStatus(r1), r2Status: r2.status, validStatus, histTools, claudeTools },
    finalText,
  );
}

async function replayAgentRuns(dir: string): Promise<void> {
  const files = listLogFiles(dir);
  const parsed = files.flatMap(parseLogFile);
  const runs = parsed
    .filter((r) => r.systemPrompt && r.message)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, LIMIT);

  // Separates "no logs" from "logs found but the debug-logger format drifted" when nothing replays.
  say(`\n=== Agent runs: ${files.length} .log files, ${parsed.length} runs parsed, ` +
    `${runs.length} replayed (newest first; skipped = no system prompt/message)`);
  say(`smart → ${env.CLAUDE_MODEL}, validator → ${env.CLAUDE_FAST_MODEL}`);
  say('#   R1        R2        VALID     hist-tools → claude-tools | message');

  const agreement = { agreed: 0, comparable: 0 };
  for (const [idx, run] of runs.entries()) await replayAgentRun(idx, run, agreement);

  if (agreement.comparable > 0) {
    say(`Round-1 tool choice agrees with history: ${agreement.agreed}/${agreement.comparable} ` +
      '(agreement = same "no tools" decision or at least one shared tool)');
  }
}

// ── Bank prefill replay (Haiku) ─────────────────────────────────────────────

interface HistoricalTx extends BankTransaction {
  group_id: number;
  /** Category of the linked expense, when the user confirmed the card into one. */
  confirmed_category: string | null;
}

/** Newest debit transactions plus the two reference categories to score the suggestion against. */
function loadHistoricalTx(database: {
  queryAll<T>(sql: string, limit: number): T[];
}): HistoricalTx[] {
  // References: the user-confirmed category (when linked) and the prefill_category the production
  // chain stored at the time ("прочее" is also its AI-failure default).
  return database.queryAll<HistoricalTx>(
    `SELECT bt.*, bc.group_id AS group_id, e.category AS confirmed_category
     FROM bank_transactions bt
     JOIN bank_connections bc ON bc.id = bt.connection_id
     LEFT JOIN expenses e ON e.id = bt.matched_expense_id
     WHERE bt.sign_type = 'debit'
     ORDER BY bt.id DESC
     LIMIT ?`,
    LIMIT,
  );
}

function groupTx(rows: HistoricalTx[]): Map<number, HistoricalTx[]> {
  const byGroup = new Map<number, HistoricalTx[]>();
  for (const row of rows) {
    const list = byGroup.get(row.group_id) ?? [];
    list.push(row);
    byGroup.set(row.group_id, list);
  }
  return byGroup;
}

interface PrefillTally {
  confirmedTotal: number;
  confirmedHits: number;
  prodTotal: number;
  prodHits: number;
  prodOther: number;
  haikuOther: number;
}

function sameCategory(a: string | null, b: string): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}

/** Count one transaction's suggestion against its confirmed and stored production categories. */
function tallyPrefill(tally: PrefillTally, tx: HistoricalTx, suggested: string): void {
  if (suggested === 'прочее') tally.haikuOther++;
  if (tx.confirmed_category !== null) {
    tally.confirmedTotal++;
    if (sameCategory(tx.confirmed_category, suggested)) tally.confirmedHits++;
  }
  if (tx.prefill_category !== null) {
    tally.prodTotal++;
    if (sameCategory(tx.prefill_category, suggested)) tally.prodHits++;
    if (tx.prefill_category === 'прочее') tally.prodOther++;
  }
}

function formatPrefillLine(tx: HistoricalTx, suggested: string): string {
  return (
    `${(tx.merchant_normalized ?? tx.merchant ?? '?').slice(0, 30).padEnd(30)} ` +
    `MCC ${String(tx.mcc ?? '-').padEnd(5)} ${String(tx.amount).padStart(9)} ${tx.currency} ` +
    `confirmed=${tx.confirmed_category ?? '—'} prod=${tx.prefill_category ?? '—'} haiku=${suggested}`
  );
}

function reportPrefillTally(tally: PrefillTally, total: number): void {
  say(`Haiku vs user-confirmed category: ${tally.confirmedHits}/${tally.confirmedTotal}; ` +
    `vs stored production prefill: ${tally.prodHits}/${tally.prodTotal}; ` +
    `"прочее": production ${tally.prodOther}/${tally.prodTotal}, Haiku ${tally.haikuOther}/${total}`);
}

async function replayPrefill(): Promise<void> {
  const { database } = await import('../src/database');
  const { preFillTransactions } = await import('../src/services/bank/prefill');

  const rows = loadHistoricalTx(database);
  say(`\n=== Bank prefill: ${rows.length} debit transactions → ${env.CLAUDE_FAST_MODEL}`);
  if (rows.length === 0) return;

  const tally: PrefillTally = {
    confirmedTotal: 0,
    confirmedHits: 0,
    prodTotal: 0,
    prodHits: 0,
    prodOther: 0,
    haikuOther: 0,
  };
  for (const [groupId, txs] of groupTx(rows)) {
    // One call per batch of 10 (PrefillResult batch size) so provenance maps to one request.
    for (let i = 0; i < txs.length; i += 10) {
      const batch = txs.slice(i, i + 10);
      const res = await viaClaude(env.CLAUDE_FAST_MODEL, () => preFillTransactions(batch, groupId));
      // preFillTransactions swallows AI errors and returns "прочее" — provenance is the only signal.
      record(`group ${groupId} batch ${i / 10 + 1}`, 'prefill', res.ok, res.detail);
      for (const [j, tx] of batch.entries()) {
        const suggested = res.value?.[j]?.category ?? '—';
        tallyPrefill(tally, tx, suggested);
        say(formatPrefillLine(tx, suggested));
      }
    }
  }
  reportPrefillTally(tally, rows.length);
}

// ── Main ────────────────────────────────────────────────────────────────────

if (LOGS_DIR) await replayAgentRuns(LOGS_DIR);
if (DB_PATH) await replayPrefill();

say(`\n=== Claude answered ${stepsOk}/${stepsTotal} replayed requests`);
for (const issue of issues) {
  say(`FAIL ${issue.step.padEnd(9)} ${issue.run}\n     ${issue.detail}`);
}
if (stepsTotal === 0) {
  say('Nothing was replayed — no parseable runs / confirmed transactions found');
  process.exit(1);
}
process.exit(issues.length > 0 ? 1 : 0);
