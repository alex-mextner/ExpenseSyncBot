// Pure aggregation of ai_usage_events rows into per-model stats and provider verdicts, plus the
// plain-text (CLI) and Telegram-HTML formatters. No DB, env or logger — callers pass the rows.
import type {
  AiUsageErrorClass,
  AiUsageEvent,
} from '../../database/repositories/ai-usage-events.repository';
import { escapeHtml } from '../../utils/html';
import { pluralize } from '../../utils/pluralize';
import { DEFAULT_PROVIDER_IDS, PROVIDER_IDS } from './provider-ids';

const DAY_MS = 86_400_000;
const TELEGRAM_MESSAGE_LIMIT = 4000;

export interface TokenTotals {
  sum: number | null;
  rowsWithValue: number;
  rowsUnknown: number;
}

/**
 * Cost in micro-USD over a set of rows. `sumMicroUsd` is null when no ok row had a known cost;
 * `rowsUnknown` counts ok rows whose cost is unknown (no price for the route, or tokens not
 * reported) — they are not in the sum, and unknown is never shown as zero.
 */
export interface CostTotals {
  sumMicroUsd: number | null;
  rowsWithValue: number;
  rowsUnknown: number;
}

export interface LastError {
  errorClass: AiUsageErrorClass;
  at: number;
}

export interface ModelUsageStats {
  provider: string;
  model: string;
  attempts: number;
  ok: number;
  errors: number;
  skipped: number;
  errorsByClass: Partial<Record<AiUsageErrorClass, number>>;
  successRate: number | null;
  tokens: {
    prompt: TokenTotals;
    completion: TokenTotals;
    reasoning: TokenTotals;
    cached: TokenTotals;
  };
  cost: CostTotals;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  durationRows: number;
  firstToken: FirstTokenStats;
  generationSpeed: GenerationSpeedStats;
  promptSize: PromptSizeStats;
  firstOkAt: number | null;
  lastOkAt: number | null;
  lastError: LastError | null;
}

/** Usage of one routing role on one provider; `role` is `legacy` for rows with no role (legacy chain). */
export interface RoleUsageStats {
  role: string;
  provider: string;
  attempts: number;
  ok: number;
  errors: number;
  successRate: number | null;
  tokens: { prompt: TokenTotals; completion: TokenTotals };
  cost: CostTotals;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  durationRows: number;
  firstToken: FirstTokenStats;
  generationSpeed: GenerationSpeedStats;
}

export type ProviderStatus = 'no_traffic' | 'skipped_only' | 'healthy' | 'degraded' | 'failing';

export interface ProviderVerdict {
  provider: string;
  status: ProviderStatus;
  attempts: number;
  ok: number;
  errors: number;
  skipped: number;
  successRate: number | null;
  lastOkAt: number | null;
  lastError: LastError | null;
}

export interface UsageReport {
  windowDays: number;
  since: number;
  until: number;
  models: ModelUsageStats[];
  /** Empty unless some row in the window carries a role. */
  roles: RoleUsageStats[];
  verdicts: ProviderVerdict[];
}

type TokenField = 'promptTokens' | 'completionTokens' | 'reasoningTokens' | 'cachedTokens';

function tokenTotals(rows: readonly AiUsageEvent[], field: TokenField): TokenTotals {
  let sum = 0;
  let rowsWithValue = 0;
  let rowsUnknown = 0;
  for (const row of rows) {
    const value = row[field];
    if (value !== null) {
      sum += value;
      rowsWithValue++;
    } else if (row.outcome === 'ok') {
      rowsUnknown++;
    }
  }
  return { sum: rowsWithValue === 0 ? null : sum, rowsWithValue, rowsUnknown };
}

function costTotals(rows: readonly AiUsageEvent[]): CostTotals {
  let sum = 0;
  let rowsWithValue = 0;
  let rowsUnknown = 0;
  for (const row of rows) {
    if (row.costMicroUsd !== null) {
      sum += row.costMicroUsd;
      rowsWithValue++;
    } else if (row.outcome === 'ok') {
      rowsUnknown++;
    }
  }
  return { sumMicroUsd: rowsWithValue === 0 ? null : sum, rowsWithValue, rowsUnknown };
}

/** Nearest-rank percentile over an ascending-sorted series. */
function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  // The epsilon guards against q*n landing a hair above an integer (0.95 * 20).
  const index = Math.max(0, Math.ceil(q * sorted.length - 1e-9) - 1);
  return sorted[index] ?? null;
}

function providerRank(provider: string): number {
  const i = (PROVIDER_IDS as readonly string[]).indexOf(provider);
  return i === -1 ? PROVIDER_IDS.length : i;
}

function compareProviders(a: string, b: string): number {
  return providerRank(a) - providerRank(b) || a.localeCompare(b);
}

interface Counts {
  attempts: number;
  ok: number;
  errors: number;
  skipped: number;
  lastOkAt: number | null;
  lastError: LastError | null;
}

function tally(rows: readonly AiUsageEvent[]): Counts {
  let ok = 0;
  let errors = 0;
  let skipped = 0;
  let lastOkAt: number | null = null;
  let lastError: LastError | null = null;
  for (const row of rows) {
    if (row.outcome === 'ok') {
      ok++;
      if (lastOkAt === null || row.at > lastOkAt) lastOkAt = row.at;
    } else if (row.outcome === 'error') {
      errors++;
      if (row.errorClass !== null && (lastError === null || row.at > lastError.at)) {
        lastError = { errorClass: row.errorClass, at: row.at };
      }
    } else {
      skipped++;
    }
  }
  return { attempts: ok + errors, ok, errors, skipped, lastOkAt, lastError };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function statusOf(c: Counts, successRate: number | null): ProviderStatus {
  if (successRate === null) return c.skipped > 0 ? 'skipped_only' : 'no_traffic';
  if (successRate >= 0.95) return 'healthy';
  if (successRate >= 0.5) return 'degraded';
  return 'failing';
}

/** A generation window shorter than this is timer noise: it would turn a few tokens into an absurd rate. */
const MIN_GENERATION_MS = 50;

/**
 * Visible output tokens per second of one attempt: (completion − reasoning) × 1000 / generationMs.
 * Reasoning tokens are billed inside completion_tokens but are not streamed in the generation
 * window, so they are left out when reported. NULL when the window or the completion count is
 * unknown, the window is under 50 ms, or nothing visible is left — unknown is never 0.
 */
export function outputTokensPerS(
  row: Pick<AiUsageEvent, 'generationMs' | 'completionTokens' | 'reasoningTokens'>,
): number | null {
  if (row.generationMs === null || row.completionTokens === null) return null;
  if (row.generationMs < MIN_GENERATION_MS) return null;
  const visible = row.completionTokens - (row.reasoningTokens ?? 0);
  return visible > 0 ? (visible * 1000) / row.generationMs : null;
}

export interface FirstTokenStats {
  /** ok rows that had a first-token time; the rest are unknown, not zero. */
  rows: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface GenerationSpeedStats {
  /** ok rows with a usable tokens-per-second value. */
  rows: number;
  p50TokensPerS: number | null;
  p95TokensPerS: number | null;
}

interface SpeedStats {
  /** ok rows that had a total duration (the denominator of p50DurationMs / p95DurationMs). */
  durationRows: number;
  firstToken: FirstTokenStats;
  generationSpeed: GenerationSpeedStats;
}

/**
 * Estimated request size of the attempts that sent a request (ok and error, never skipped), from
 * character-based estimates — the provider's promptTokens stays the truth. `p50`/`p95Tokens` are
 * over the sum of the four components; `toolCatalogShare` is sum(tool catalog) / sum(total).
 */
export interface PromptSizeStats {
  rows: number;
  p50Tokens: number | null;
  p95Tokens: number | null;
  toolCatalogShare: number | null;
  /** per-component median, to see which part dominates and what compaction changed. */
  p50: {
    system: number | null;
    toolCatalog: number | null;
    history: number | null;
    user: number | null;
  };
}

function promptSizeStats(rows: readonly AiUsageEvent[]): PromptSizeStats {
  const sizes = rows.flatMap((r) =>
    r.outcome !== 'skipped' && r.promptSize ? [r.promptSize] : [],
  );
  const sorted = (pick: (s: (typeof sizes)[number]) => number) =>
    sizes.map(pick).sort((a, b) => a - b);
  const totals = sorted(
    (s) => s.systemPromptTokens + s.toolCatalogTokens + s.historyTokens + s.userTokens,
  );
  const totalSum = totals.reduce((sum, t) => sum + t, 0);
  const toolSum = sizes.reduce((sum, s) => sum + s.toolCatalogTokens, 0);
  return {
    rows: sizes.length,
    p50Tokens: percentile(totals, 0.5),
    p95Tokens: percentile(totals, 0.95),
    toolCatalogShare: totalSum > 0 ? toolSum / totalSum : null,
    p50: {
      system: percentile(
        sorted((s) => s.systemPromptTokens),
        0.5,
      ),
      toolCatalog: percentile(
        sorted((s) => s.toolCatalogTokens),
        0.5,
      ),
      history: percentile(
        sorted((s) => s.historyTokens),
        0.5,
      ),
      user: percentile(
        sorted((s) => s.userTokens),
        0.5,
      ),
    },
  };
}

/** Speed percentiles (nearest-rank) over successful attempts that have the value. */
function speedStats(okRows: readonly AiUsageEvent[]): SpeedStats {
  const firstTokens = okRows
    .flatMap((r) => (r.firstTokenMs === null ? [] : [r.firstTokenMs]))
    .sort((a, b) => a - b);
  const rates = okRows
    .flatMap((r) => {
      const rate = outputTokensPerS(r);
      return rate === null ? [] : [rate];
    })
    .sort((a, b) => a - b);
  return {
    durationRows: okRows.filter((r) => r.durationMs !== null).length,
    firstToken: {
      rows: firstTokens.length,
      p50Ms: percentile(firstTokens, 0.5),
      p95Ms: percentile(firstTokens, 0.95),
    },
    generationSpeed: {
      rows: rates.length,
      p50TokensPerS: percentile(rates, 0.5),
      p95TokensPerS: percentile(rates, 0.95),
    },
  };
}

const LEGACY_ROLE = 'legacy';
const ROLE_ORDER: readonly string[] = ['planner', 'executor', 'repair', LEGACY_ROLE];

function roleStats(role: string, provider: string, rows: readonly AiUsageEvent[]): RoleUsageStats {
  const c = tally(rows);
  const durations = rows
    .flatMap((r) => (r.outcome === 'ok' && r.durationMs !== null ? [r.durationMs] : []))
    .sort((a, b) => a - b);
  return {
    role,
    provider,
    attempts: c.attempts,
    ok: c.ok,
    errors: c.errors,
    successRate: c.attempts === 0 ? null : c.ok / c.attempts,
    tokens: {
      prompt: tokenTotals(rows, 'promptTokens'),
      completion: tokenTotals(rows, 'completionTokens'),
    },
    cost: costTotals(rows),
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    ...speedStats(rows.filter((r) => r.outcome === 'ok')),
  };
}

function modelStats(
  provider: string,
  model: string,
  rows: readonly AiUsageEvent[],
): ModelUsageStats {
  const c = tally(rows);
  const okRows = rows.filter((r) => r.outcome === 'ok');
  const durations = okRows
    .flatMap((r) => (r.durationMs === null ? [] : [r.durationMs]))
    .sort((a, b) => a - b);
  const errorsByClass: Partial<Record<AiUsageErrorClass, number>> = {};
  for (const row of rows) {
    if (row.outcome === 'error' && row.errorClass !== null) {
      errorsByClass[row.errorClass] = (errorsByClass[row.errorClass] ?? 0) + 1;
    }
  }
  return {
    provider,
    model,
    attempts: c.attempts,
    ok: c.ok,
    errors: c.errors,
    skipped: c.skipped,
    errorsByClass,
    successRate: c.attempts === 0 ? null : c.ok / c.attempts,
    tokens: {
      prompt: tokenTotals(rows, 'promptTokens'),
      completion: tokenTotals(rows, 'completionTokens'),
      reasoning: tokenTotals(rows, 'reasoningTokens'),
      cached: tokenTotals(rows, 'cachedTokens'),
    },
    cost: costTotals(rows),
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    ...speedStats(okRows),
    promptSize: promptSizeStats(rows),
    firstOkAt:
      okRows.length === 0
        ? null
        : okRows.reduce((min, r) => Math.min(min, r.at), Number.POSITIVE_INFINITY),
    lastOkAt: c.lastOkAt,
    lastError: c.lastError,
  };
}

export function aggregateUsage(
  events: readonly AiUsageEvent[],
  opts: { now: number; days: number },
): UsageReport {
  const since = opts.now - opts.days * DAY_MS;
  const inWindow = events.filter((e) => e.at >= since);

  const models: ModelUsageStats[] = [];
  for (const rows of groupBy(inWindow, (e) => `${e.provider}\u0000${e.model}`).values()) {
    const first = rows[0];
    if (first) models.push(modelStats(first.provider, first.model, rows));
  }
  models.sort(
    (a, b) =>
      compareProviders(a.provider, b.provider) ||
      b.attempts - a.attempts ||
      a.model.localeCompare(b.model),
  );

  // Roles exist only on rows written by role routing; without any, the legacy report is unchanged.
  // Skipped rows are not attempts and carry no latency, so they stay out of the role view.
  const roleRows = inWindow.filter((e) => e.outcome !== 'skipped');
  const roles = roleRows.some((e) => e.role !== null)
    ? [...groupBy(roleRows, (e) => `${e.role ?? LEGACY_ROLE}\u0000${e.provider}`).values()]
        .flatMap((rows) =>
          rows[0] ? [roleStats(rows[0].role ?? LEGACY_ROLE, rows[0].provider, rows)] : [],
        )
        .sort(
          (a, b) =>
            ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
            compareProviders(a.provider, b.provider),
        )
    : [];

  const byProvider = groupBy(inWindow, (e) => e.provider);
  const providers = [...new Set<string>([...DEFAULT_PROVIDER_IDS, ...byProvider.keys()])].sort(
    compareProviders,
  );
  const verdicts = providers.map((provider): ProviderVerdict => {
    const c = tally(byProvider.get(provider) ?? []);
    const successRate = c.attempts === 0 ? null : c.ok / c.attempts;
    return {
      provider,
      status: statusOf(c, successRate),
      attempts: c.attempts,
      ok: c.ok,
      errors: c.errors,
      skipped: c.skipped,
      successRate,
      lastOkAt: c.lastOkAt,
      lastError: c.lastError,
    };
  });

  return { windowDays: opts.days, since, until: opts.now, models, roles, verdicts };
}

// ── Formatting helpers ─────────────────────────────────────────────────────

const intFmt = new Intl.NumberFormat('en-US');

function tokenCount(value: number | null): string {
  return value === null ? 'n/a' : intFmt.format(value);
}

/** `70.0%` of the estimated prompt, `n/a` when no row was estimated. */
function share(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/** Floor, not round: 94.6% must not read as 95% next to a "degraded" verdict. */
function pct(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.floor(rate * 1000) / 10}%`;
}

function isoMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function duration(ms: number | null, secondsUnit: string, msUnit: string): string {
  if (ms === null) return 'n/a';
  return ms < 1000 ? `${ms}${msUnit}` : `${(ms / 1000).toFixed(1)}${secondsUnit}`;
}

/** `50.0 tok/s`, `n/a` when no row had both a window and a token count. */
function tokensPerS(value: number | null, unit: string): string {
  return value === null ? 'n/a' : `${value.toFixed(1)} ${unit}`;
}

function errorClasses(m: ModelUsageStats): string {
  return Object.entries(m.errorsByClass)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cls, n]) => `${cls}×${n}`)
    .join(' ');
}

/** `12,345` / `n/a`, with `(?N)` appended when N successful calls did not report usage. */
function tokenValue(t: TokenTotals): string {
  const base = t.sum === null ? 'n/a' : intFmt.format(t.sum);
  return t.rowsUnknown > 0 ? `${base} (?${t.rowsUnknown})` : base;
}

/** `$0.0003`, `<$0.0001` for a sub-0.1-milli-dollar sum, `n/a` when unknown, `(?N)` for N ok calls without a cost. */
function costValue(c: CostTotals): string {
  let base = 'n/a';
  if (c.sumMicroUsd !== null) {
    base =
      c.sumMicroUsd > 0 && c.sumMicroUsd < 100
        ? '<$0.0001'
        : `$${(c.sumMicroUsd / 1e6).toFixed(4)}`;
  }
  return c.rowsUnknown > 0 ? `${base} (?${c.rowsUnknown})` : base;
}

function tokenSummary(m: ModelUsageStats, inLabel: string, outLabel: string): string {
  return `${inLabel} ${tokenValue(m.tokens.prompt)} / ${outLabel} ${tokenValue(m.tokens.completion)}`;
}

// ── Text (CLI) ─────────────────────────────────────────────────────────────

function dayWord(days: number): string {
  return days === 1 ? 'day' : 'days';
}

function verdictText(v: ProviderVerdict, days: number): string {
  if (v.status === 'no_traffic') {
    return `${v.provider}: no traffic in the last ${days} ${dayWord(days)}`;
  }
  if (v.status === 'skipped_only') {
    return `${v.provider}: skipped only — ${v.skipped} skipped, no request was sent in the last ${days} ${dayWord(days)}`;
  }
  const parts = [`${v.ok}/${v.attempts} ok (${pct(v.successRate)})`];
  if (v.lastOkAt !== null) parts.push(`last ok ${isoMinute(v.lastOkAt)}`);
  if (v.lastError)
    parts.push(`last error ${v.lastError.errorClass} @ ${isoMinute(v.lastError.at)}`);
  return `${v.provider}: ${v.status} — ${parts.join(', ')}`;
}

const USAGE_TEXT_LEGEND = [
  'Legend',
  '  attempts = requests really sent (ok + err); skipped are not attempts. success = ok / attempts.',
  '  latency percentiles (nearest-rank) cover ok attempts only.',
  '  first token = request start to the first content/tool delta; speed = (completion - reasoning tokens) x 1000 / generation ms (first to last delta, windows < 50 ms not counted); n = ok rows with a value, unknown is not zero.',
  '  prompt est. = character-based ESTIMATES of the request (system + tool catalog + history + user) over attempts that sent one; promptTokens from the provider stays the truth. tools = share of the tool catalog in it.',
  '  n/a = provider reported no usage; (?N) = N successful calls without usage, not counted in the sum.',
  '  cost = tokens x list price of a priced route (a known upper bound); n/a = no price or no usage, never zero.',
  '  legacy = attempts on the AI_SMART_CHAIN / AI_FAST_CHAIN chains, not role-routed.',
];

/** One model's plain-text block, ending with the blank separator line. */
function modelTextLines(m: ModelUsageStats): string[] {
  const lines = [
    `${m.provider}:${m.model}`,
    `  attempts ${m.attempts}  ok ${m.ok}  err ${m.errors}  skipped ${m.skipped}  success ${pct(m.successRate)}`,
    `  latency p50 ${duration(m.p50DurationMs, 's', 'ms')}  p95 ${duration(m.p95DurationMs, 's', 'ms')}`,
    `  first token p50 ${duration(m.firstToken.p50Ms, 's', 'ms')}  p95 ${duration(m.firstToken.p95Ms, 's', 'ms')}  (n=${m.firstToken.rows})`,
    `  speed p50 ${tokensPerS(m.generationSpeed.p50TokensPerS, 'tok/s')}  p95 ${tokensPerS(m.generationSpeed.p95TokensPerS, 'tok/s')}  (n=${m.generationSpeed.rows})`,
    `  prompt est. p50 ${tokenCount(m.promptSize.p50Tokens)}  p95 ${tokenCount(m.promptSize.p95Tokens)}  tools ${share(m.promptSize.toolCatalogShare)}  (n=${m.promptSize.rows})`,
  ];
  let tokens = `  tokens ${tokenSummary(m, 'in', 'out')}`;
  if (m.tokens.reasoning.sum !== null) tokens += ` / reasoning ${tokenValue(m.tokens.reasoning)}`;
  if (m.tokens.cached.sum !== null) tokens += ` / cached ${tokenValue(m.tokens.cached)}`;
  lines.push(tokens, `  cost ${costValue(m.cost)}`);
  if (m.errors > 0) lines.push(`  errors by class: ${errorClasses(m)}`);
  lines.push(
    `  first ok ${m.firstOkAt === null ? 'n/a' : isoMinute(m.firstOkAt)}  last ok ${m.lastOkAt === null ? 'n/a' : isoMinute(m.lastOkAt)}`,
    `  last error ${m.lastError ? `${m.lastError.errorClass} @ ${isoMinute(m.lastError.at)}` : 'none'}`,
    '',
  );
  return lines;
}

/** The "By role" section (header, one line per role, trailing blank line). */
function roleTextLines(roles: readonly RoleUsageStats[]): string[] {
  const lines = ['By role'];
  for (const r of roles) {
    lines.push(
      `  ${r.role} / ${r.provider}: ${r.ok}/${r.attempts} ok (${pct(r.successRate)}), p50 ${duration(r.p50DurationMs, 's', 'ms')}, p95 ${duration(r.p95DurationMs, 's', 'ms')}, first token p50 ${duration(r.firstToken.p50Ms, 's', 'ms')}, speed p50 ${tokensPerS(r.generationSpeed.p50TokensPerS, 'tok/s')}, tokens in ${tokenValue(r.tokens.prompt)} / out ${tokenValue(r.tokens.completion)}, cost ${costValue(r.cost)}`,
    );
  }
  lines.push('');
  return lines;
}

export function formatUsageText(report: UsageReport): string {
  const lines = [
    `AI usage, ${isoDate(report.since)} .. ${isoDate(report.until)} (last ${report.windowDays} ${dayWord(report.windowDays)}, UTC)`,
    '',
  ];
  if (report.models.length === 0) lines.push('No rows in this window.', '');
  for (const m of report.models) lines.push(...modelTextLines(m));
  if (report.roles.length > 0) lines.push(...roleTextLines(report.roles));
  lines.push('Verdicts');
  for (const v of report.verdicts) lines.push(`  ${verdictText(v, report.windowDays)}`);
  lines.push('', ...USAGE_TEXT_LEGEND);
  return lines.join('\n');
}

// ── Telegram (Russian, HTML) ───────────────────────────────────────────────

const STATUS_EMOJI: Record<ProviderStatus, string> = {
  healthy: '✅',
  degraded: '⚠️',
  failing: '❌',
  no_traffic: '💤',
  skipped_only: '💤',
};

function verdictTelegram(v: ProviderVerdict, days: number): string {
  const name = escapeHtml(v.provider);
  const emoji = STATUS_EMOJI[v.status];
  if (v.status === 'no_traffic') {
    return `${emoji} ${name} — нет запросов за ${days} ${pluralize(days, 'день', 'дня', 'дней')}`;
  }
  if (v.status === 'skipped_only') {
    return `${emoji} ${name} — только пропуски (${v.skipped}), запросы не уходили`;
  }
  let line = `${emoji} ${name} — ${v.ok}/${v.attempts} ок (${pct(v.successRate)})`;
  if (v.lastOkAt !== null) line += `, последний ок ${isoMinute(v.lastOkAt)}`;
  if (v.lastError) line += `, ошибка ${v.lastError.errorClass} ${isoMinute(v.lastError.at)}`;
  return line;
}

function modelBlock(m: ModelUsageStats): string {
  const counts = [
    `${m.attempts} ${pluralize(m.attempts, 'запрос', 'запроса', 'запросов')}`,
    `${m.ok} ок`,
    `${m.errors} ${pluralize(m.errors, 'ошибка', 'ошибки', 'ошибок')}`,
  ].join(' · ');
  const lines = [
    counts,
    `успех ${pct(m.successRate)} · p50 ${duration(m.p50DurationMs, 'с', 'мс')} · p95 ${duration(m.p95DurationMs, 'с', 'мс')}`,
    `до 1-го токена p50 ${duration(m.firstToken.p50Ms, 'с', 'мс')} · p95 ${duration(m.firstToken.p95Ms, 'с', 'мс')} (n=${m.firstToken.rows})`,
    `скорость p50 ${tokensPerS(m.generationSpeed.p50TokensPerS, 'ток/с')} · p95 ${tokensPerS(m.generationSpeed.p95TokensPerS, 'ток/с')} (n=${m.generationSpeed.rows})`,
    `промпт (оценка) p50 ${tokenCount(m.promptSize.p50Tokens)} · p95 ${tokenCount(m.promptSize.p95Tokens)} · каталог тулов ${share(m.promptSize.toolCatalogShare)} (n=${m.promptSize.rows})`,
    tokenSummary(m, 'вх', 'исх'),
    `стоимость ${costValue(m.cost)}`,
  ];
  if (m.tokens.reasoning.sum !== null || m.tokens.cached.sum !== null) {
    lines.push(`рассужд. ${tokenValue(m.tokens.reasoning)} · кэш ${tokenValue(m.tokens.cached)}`);
  }
  if (m.skipped > 0) {
    lines.push(`${m.skipped} ${pluralize(m.skipped, 'пропуск', 'пропуска', 'пропусков')}`);
  }
  if (m.errors > 0) lines.push(`ошибки: ${errorClasses(m)}`);
  if (m.lastError)
    lines.push(`посл. ошибка: ${m.lastError.errorClass} ${isoMinute(m.lastError.at)}`);
  return `<b>${escapeHtml(m.provider)} · ${escapeHtml(m.model)}</b>\n<pre>${escapeHtml(lines.join('\n'))}</pre>`;
}

function rolesBlock(roles: readonly RoleUsageStats[]): string {
  const lines = roles.map(
    (r) =>
      `${r.role} · ${r.provider}: ${r.ok}/${r.attempts} ок · p50 ${duration(r.p50DurationMs, 'с', 'мс')} · p95 ${duration(r.p95DurationMs, 'с', 'мс')} · 1-й токен p50 ${duration(r.firstToken.p50Ms, 'с', 'мс')} · ${tokensPerS(r.generationSpeed.p50TokensPerS, 'ток/с')} · ${costValue(r.cost)}`,
  );
  return `<b>По ролям</b>\n<pre>${escapeHtml(lines.join('\n'))}</pre>`;
}

export function formatUsageTelegram(report: UsageReport): string[] {
  const days = report.windowDays;
  const period = `${days} ${pluralize(days, 'день', 'дня', 'дней')}`;
  if (report.models.length === 0) {
    return [`📊 За ${period} нет данных об AI-запросах.`];
  }
  const header = [
    `<b>📊 AI-статистика за ${period}</b>`,
    '',
    ...report.verdicts.map((v) => verdictTelegram(v, days)),
  ].join('\n');

  const messages: string[] = [];
  let current = header;
  const blocks = report.models.map(modelBlock);
  if (report.roles.length > 0) blocks.unshift(rolesBlock(report.roles));
  for (const block of blocks) {
    if (current.length + 2 + block.length > TELEGRAM_MESSAGE_LIMIT) {
      messages.push(current);
      current = block;
    } else {
      current += `\n\n${block}`;
    }
  }
  messages.push(current);
  return messages;
}
