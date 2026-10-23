// Pure aggregation of ai_usage_events rows into per-model stats and provider verdicts, plus the
// plain-text (CLI) and Telegram-HTML formatters. No DB, env or logger — callers pass the rows.
import type {
  AiUsageErrorClass,
  AiUsageEvent,
} from '../../database/repositories/ai-usage-events.repository';
import { escapeHtml } from '../../utils/html';
import { pluralize } from '../../utils/pluralize';
import { PROVIDER_IDS } from './provider-ids';

export const KNOWN_PROVIDERS = PROVIDER_IDS;

const DAY_MS = 86_400_000;
const TELEGRAM_MESSAGE_LIMIT = 4000;

export interface TokenTotals {
  sum: number | null;
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
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  firstOkAt: number | null;
  lastOkAt: number | null;
  lastError: LastError | null;
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

/** Nearest-rank percentile over an ascending-sorted series. */
function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  // The epsilon guards against q*n landing a hair above an integer (0.95 * 20).
  const index = Math.max(0, Math.ceil(q * sorted.length - 1e-9) - 1);
  return sorted[index] ?? null;
}

function providerRank(provider: string): number {
  const i = (KNOWN_PROVIDERS as readonly string[]).indexOf(provider);
  return i === -1 ? KNOWN_PROVIDERS.length : i;
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
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
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

  const byProvider = groupBy(inWindow, (e) => e.provider);
  const providers = [...new Set<string>([...KNOWN_PROVIDERS, ...byProvider.keys()])].sort(
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

  return { windowDays: opts.days, since, until: opts.now, models, verdicts };
}

// ── Formatting helpers ─────────────────────────────────────────────────────

const intFmt = new Intl.NumberFormat('en-US');

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

export function formatUsageText(report: UsageReport): string {
  const lines = [
    `AI usage, ${isoDate(report.since)} .. ${isoDate(report.until)} (last ${report.windowDays} ${dayWord(report.windowDays)}, UTC)`,
    '',
  ];
  if (report.models.length === 0) lines.push('No rows in this window.', '');
  for (const m of report.models) {
    lines.push(
      `${m.provider}:${m.model}`,
      `  attempts ${m.attempts}  ok ${m.ok}  err ${m.errors}  skipped ${m.skipped}  success ${pct(m.successRate)}`,
      `  latency p50 ${duration(m.p50DurationMs, 's', 'ms')}  p95 ${duration(m.p95DurationMs, 's', 'ms')}`,
    );
    let tokens = `  tokens ${tokenSummary(m, 'in', 'out')}`;
    if (m.tokens.reasoning.sum !== null) tokens += ` / reasoning ${tokenValue(m.tokens.reasoning)}`;
    if (m.tokens.cached.sum !== null) tokens += ` / cached ${tokenValue(m.tokens.cached)}`;
    lines.push(tokens);
    if (m.errors > 0) lines.push(`  errors by class: ${errorClasses(m)}`);
    lines.push(
      `  first ok ${m.firstOkAt === null ? 'n/a' : isoMinute(m.firstOkAt)}  last ok ${m.lastOkAt === null ? 'n/a' : isoMinute(m.lastOkAt)}`,
      `  last error ${m.lastError ? `${m.lastError.errorClass} @ ${isoMinute(m.lastError.at)}` : 'none'}`,
      '',
    );
  }
  lines.push('Verdicts');
  for (const v of report.verdicts) lines.push(`  ${verdictText(v, report.windowDays)}`);
  lines.push(
    '',
    'Legend',
    '  attempts = requests really sent (ok + err); skipped are not attempts. success = ok / attempts.',
    '  latency percentiles (nearest-rank) cover ok attempts only.',
    '  n/a = provider reported no usage; (?N) = N successful calls without usage, not counted in the sum.',
  );
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
    tokenSummary(m, 'вх', 'исх'),
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
  for (const block of report.models.map(modelBlock)) {
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
