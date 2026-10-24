// Tests for the pure AI usage aggregation and its text / Telegram formatters.
import { describe, expect, test } from 'bun:test';
import type { AiUsageEvent } from '../../database/repositories/ai-usage-events.repository';
import {
  aggregateUsage,
  formatUsageTelegram,
  formatUsageText,
  outputTokensPerS,
} from './usage-report';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-23T12:00:00Z');
let nextId = 1;

function ev(over: Partial<AiUsageEvent> = {}): AiUsageEvent {
  return {
    id: nextId++,
    at: NOW - 1000,
    provider: 'zai',
    model: 'm1',
    chain: 'smart',
    purpose: 'agent',
    outcome: 'ok',
    errorClass: null,
    httpStatus: null,
    durationMs: null,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    cachedTokens: null,
    requestId: null,
    role: null,
    preset: null,
    costMicroUsd: null,
    firstTokenMs: null,
    generationMs: null,
    promptSize: null,
    ...over,
  };
}

const opts = { now: NOW, days: 7 };

describe('aggregateUsage', () => {
  test('ignores rows outside the window and sets since/until', () => {
    const r = aggregateUsage([ev(), ev({ at: NOW - 8 * DAY }), ev({ at: NOW - 7 * DAY })], opts);
    expect(r.since).toBe(NOW - 7 * DAY);
    expect(r.until).toBe(NOW);
    expect(r.windowDays).toBe(7);
    expect(r.models).toHaveLength(1);
    expect(r.models[0]?.attempts).toBe(2);
  });

  test('attempts = ok + error, skipped separate, success rate', () => {
    const r = aggregateUsage(
      [
        ev(),
        ev(),
        ev(),
        ev({ outcome: 'error', errorClass: 'server' }),
        ev({ outcome: 'skipped' }),
        ev({ outcome: 'skipped' }),
      ],
      opts,
    );
    const m = r.models[0];
    expect(m?.attempts).toBe(4);
    expect(m?.ok).toBe(3);
    expect(m?.errors).toBe(1);
    expect(m?.skipped).toBe(2);
    expect(m?.successRate).toBe(0.75);
  });

  test('success rate is null with zero attempts', () => {
    const r = aggregateUsage([ev({ outcome: 'skipped' })], opts);
    expect(r.models[0]?.successRate).toBeNull();
  });

  test('token handling: null stays null, 0 is a value, unknown counts only ok rows', () => {
    const r = aggregateUsage(
      [
        ev({ promptTokens: 100, completionTokens: 0 }),
        ev({ promptTokens: 50, completionTokens: null }),
        ev({ outcome: 'error', errorClass: 'timeout', promptTokens: null, completionTokens: null }),
        ev({ outcome: 'error', errorClass: 'timeout', promptTokens: 7 }),
      ],
      opts,
    );
    const t = r.models[0]?.tokens;
    expect(t?.prompt).toEqual({ sum: 157, rowsWithValue: 3, rowsUnknown: 0 });
    expect(t?.completion).toEqual({ sum: 0, rowsWithValue: 1, rowsUnknown: 1 });
    expect(t?.reasoning).toEqual({ sum: null, rowsWithValue: 0, rowsUnknown: 2 });
    expect(t?.cached.sum).toBeNull();
  });

  test('p50/p95 nearest-rank over ok attempts with duration only', () => {
    const events = Array.from({ length: 20 }, (_, i) => ev({ durationMs: (i + 1) * 100 }));
    events.push(ev({ outcome: 'error', errorClass: 'timeout', durationMs: 99_999 }));
    events.push(ev({ durationMs: null }));
    const m = aggregateUsage(events, opts).models[0];
    expect(m?.p50DurationMs).toBe(1000);
    expect(m?.p95DurationMs).toBe(1900);
  });

  test('p50/p95 null when no ok durations', () => {
    const m = aggregateUsage([ev({ durationMs: null })], opts).models[0];
    expect(m?.p50DurationMs).toBeNull();
    expect(m?.p95DurationMs).toBeNull();
  });

  test('error classes, first/last ok, last error', () => {
    const m = aggregateUsage(
      [
        ev({ at: NOW - 5000 }),
        ev({ at: NOW - 100 }),
        ev({ outcome: 'error', errorClass: 'rate_limit', at: NOW - 4000 }),
        ev({ outcome: 'error', errorClass: 'rate_limit', at: NOW - 3000 }),
        ev({ outcome: 'error', errorClass: 'server', at: NOW - 2000 }),
      ],
      opts,
    ).models[0];
    expect(m?.errorsByClass).toEqual({ rate_limit: 2, server: 1 });
    expect(m?.firstOkAt).toBe(NOW - 5000);
    expect(m?.lastOkAt).toBe(NOW - 100);
    expect(m?.lastError).toEqual({ errorClass: 'server', at: NOW - 2000 });
  });

  test('first/last ok and last error are null when absent', () => {
    const m = aggregateUsage([ev({ outcome: 'skipped' })], opts).models[0];
    expect(m?.firstOkAt).toBeNull();
    expect(m?.lastOkAt).toBeNull();
    expect(m?.lastError).toBeNull();
  });

  test('verdicts: explicit no_traffic for every known provider', () => {
    const r = aggregateUsage([ev()], opts);
    expect(r.verdicts.map((v) => [v.provider, v.status])).toEqual([
      ['zai', 'healthy'],
      ['claude', 'no_traffic'],
      ['hf', 'no_traffic'],
    ]);
  });

  test('verdicts: optional openrouter is listed only once it has traffic, after the default providers', () => {
    const r = aggregateUsage([ev(), ev({ provider: 'openrouter', model: 'deepseek/x' })], opts);
    expect(r.verdicts.map((v) => [v.provider, v.status])).toEqual([
      ['zai', 'healthy'],
      ['claude', 'no_traffic'],
      ['hf', 'no_traffic'],
      ['openrouter', 'healthy'],
    ]);
  });

  test('verdict statuses by success rate and skipped_only', () => {
    const many = (n: number, over: Partial<AiUsageEvent>) =>
      Array.from({ length: n }, () => ev(over));
    const r = aggregateUsage(
      [
        ...many(19, { provider: 'groq' }),
        ...many(1, { provider: 'groq', outcome: 'error', errorClass: 'server' }),
        ...many(3, { provider: 'zai', model: 'z' }),
        ...many(3, { provider: 'zai', model: 'z', outcome: 'error', errorClass: 'rate_limit' }),
        ...many(1, { provider: 'claude', model: 'c' }),
        ...many(3, { provider: 'claude', model: 'c', outcome: 'error', errorClass: 'auth' }),
        ...many(2, { provider: 'hf', model: 'h', outcome: 'skipped' }),
        ...many(1, { provider: 'other', model: 'o' }),
      ],
      opts,
    );
    const s = Object.fromEntries(r.verdicts.map((v) => [v.provider, v.status]));
    expect(s).toEqual({
      groq: 'healthy',
      zai: 'degraded',
      claude: 'failing',
      hf: 'skipped_only',
      other: 'healthy',
    });
    const hf = r.verdicts.find((v) => v.provider === 'hf');
    expect(hf?.skipped).toBe(2);
    expect(r.verdicts.map((v) => v.provider)).toEqual(['zai', 'claude', 'hf', 'groq', 'other']);
  });

  test('ordering: provider position, attempts desc, model name; unknown providers alphabetical last', () => {
    const r = aggregateUsage(
      [
        ev({ provider: 'zzz', model: 'a' }),
        ev({ provider: 'aaa', model: 'a' }),
        ev({ provider: 'hf', model: 'x' }),
        ev({ provider: 'groq', model: 'b' }),
        ev({ provider: 'groq', model: 'a' }),
        ev({ provider: 'groq', model: 'c' }),
        ev({ provider: 'groq', model: 'c' }),
        ev({ provider: 'zai', model: 'q' }),
      ],
      opts,
    );
    // 'groq' rows are historical (Groq is no longer a provider): they still render, after the known ones.
    expect(r.models.map((m) => `${m.provider}:${m.model}`)).toEqual([
      'zai:q',
      'hf:x',
      'aaa:a',
      'groq:c',
      'groq:a',
      'groq:b',
      'zzz:a',
    ]);
  });
});

describe('formatUsageText', () => {
  const report = aggregateUsage(
    [
      ev({ provider: 'groq', promptTokens: 12345, completionTokens: 4567, durationMs: 800 }),
      ev({ provider: 'groq', promptTokens: null }),
      ev({ outcome: 'error', errorClass: 'rate_limit', provider: 'zai', model: 'glm' }),
      ev({ outcome: 'error', errorClass: 'rate_limit', provider: 'zai', model: 'glm' }),
    ],
    opts,
  );
  const text = formatUsageText(report);

  test('contains table data, verdicts and legend', () => {
    expect(text).toContain('groq:m1');
    expect(text).toContain('2026-10-16');
    expect(text).toContain('2026-10-23');
    expect(text).toContain('claude: no traffic in the last 7 days');
    expect(text).toContain('groq: healthy');
    expect(text).toContain('zai: failing');
    expect(text).toContain('rate_limit×2');
    expect(text).toContain('Verdicts');
    expect(text).toContain('Legend');
  });

  test('tokens: sums with unknown marker, n/a when unknown', () => {
    expect(text).toContain('in 12,345 (?1) / out 4,567 (?1)');
    expect(text).toMatch(/zai:glm[\s\S]*in n\/a \/ out n\/a/);
  });

  test('never prints 0 tokens where unknown', () => {
    const t = formatUsageText(aggregateUsage([ev()], opts));
    expect(t).toContain('n/a');
    expect(t).not.toMatch(/in 0/);
    expect(t).not.toMatch(/out 0/);
  });

  test('uses the singular for a one-day window', () => {
    const t = formatUsageText(aggregateUsage([ev()], { now: opts.now, days: 1 }));
    expect(t).toContain('(last 1 day, UTC)');
    expect(t).toContain('claude: no traffic in the last 1 day');
    expect(t).not.toContain('1 days');
  });
});

describe('formatUsageTelegram', () => {
  test('escapes model names', () => {
    const msgs = formatUsageTelegram(aggregateUsage([ev({ model: 'Qwen/<b>x</b>' })], opts));
    const all = msgs.join('\n');
    expect(all).toContain('Qwen/&lt;b&gt;x&lt;/b&gt;');
    expect(all).not.toContain('Qwen/<b>x');
  });

  test('verdict lines first with emoji', () => {
    const [first] = formatUsageTelegram(aggregateUsage([ev()], opts));
    expect(first).toContain('✅');
    expect(first).toContain('💤');
    expect((first ?? '').indexOf('✅')).toBeLessThan((first ?? '').indexOf('m1'));
  });

  test('60 models split into messages <= 4000 chars with balanced tags', () => {
    const events = Array.from({ length: 60 }, (_, i) =>
      ev({
        model: `org/model-number-${i}-with-a-long-name`,
        promptTokens: 123456,
        completionTokens: 7890,
        durationMs: 1234,
      }),
    );
    const msgs = formatUsageTelegram(aggregateUsage(events, opts));
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(4000);
      expect((m.match(/<pre>/g) ?? []).length).toBe((m.match(/<\/pre>/g) ?? []).length);
      expect((m.match(/<b>/g) ?? []).length).toBe((m.match(/<\/b>/g) ?? []).length);
    }
    expect(msgs.join('\n')).toContain('model-number-59');
  });

  test('empty window yields one no-data message', () => {
    const msgs = formatUsageTelegram(aggregateUsage([], opts));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('нет данных');
  });

  test('unknown tokens render n/a, not 0', () => {
    const all = formatUsageTelegram(aggregateUsage([ev()], opts)).join('\n');
    expect(all).toContain('n/a');
    expect(all).not.toMatch(/вх 0/);
  });
});

describe('cost and roles (stage B4)', () => {
  const OR = { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' };

  test('model cost sums the known rows and counts the unknown ones, like tokens', () => {
    const r = aggregateUsage(
      [
        ev({ ...OR, costMicroUsd: 100 }),
        ev({ ...OR, costMicroUsd: 200 }),
        ev({ ...OR, costMicroUsd: null }),
      ],
      opts,
    );
    expect(r.models[0]?.cost).toEqual({ sumMicroUsd: 300, rowsWithValue: 2, rowsUnknown: 1 });
  });

  test('a model with no known cost is unknown (null), and a known zero stays 0', () => {
    const unknown = aggregateUsage([ev({ costMicroUsd: null })], opts);
    expect(unknown.models[0]?.cost).toEqual({
      sumMicroUsd: null,
      rowsWithValue: 0,
      rowsUnknown: 1,
    });
    const zero = aggregateUsage([ev({ costMicroUsd: 0 })], opts);
    expect(zero.models[0]?.cost).toEqual({ sumMicroUsd: 0, rowsWithValue: 1, rowsUnknown: 0 });
  });

  test('skipped and failed attempts do not count as unknown cost', () => {
    const r = aggregateUsage(
      [
        ev({ costMicroUsd: 5 }),
        ev({ outcome: 'skipped', durationMs: null }),
        ev({ outcome: 'error', errorClass: 'server', httpStatus: 500 }),
      ],
      opts,
    );
    expect(r.models[0]?.cost).toEqual({ sumMicroUsd: 5, rowsWithValue: 1, rowsUnknown: 0 });
  });

  test('roles: one row per role and provider, p50/p95 over ok attempts, legacy last', () => {
    const rows = [
      ...[1000, 2000, 3000, 4000].map((durationMs) =>
        ev({ ...OR, role: 'executor', preset: 'deepseek41-flash', durationMs, costMicroUsd: 10 }),
      ),
      ev({ ...OR, role: 'executor', outcome: 'error', errorClass: 'timeout', durationMs: 9000 }),
      ev({ provider: 'claude', role: 'repair', durationMs: 700, costMicroUsd: null }),
      ev({ provider: 'zai', role: null, durationMs: 500 }),
    ];
    const { roles } = aggregateUsage(rows, opts);
    expect(roles.map((x) => [x.role, x.provider])).toEqual([
      ['executor', 'openrouter'],
      ['repair', 'claude'],
      ['legacy', 'zai'],
    ]);
    const executor = roles[0];
    expect(executor).toMatchObject({
      attempts: 5,
      ok: 4,
      errors: 1,
      p50DurationMs: 2000,
      p95DurationMs: 4000,
    });
    expect(executor?.cost).toEqual({ sumMicroUsd: 40, rowsWithValue: 4, rowsUnknown: 0 });
    expect(roles[1]?.cost).toEqual({ sumMicroUsd: null, rowsWithValue: 0, rowsUnknown: 1 });
  });

  test('text: cost per model and a By role section; unknown prints n/a, never $0', () => {
    const text = formatUsageText(
      aggregateUsage(
        [
          ev({ ...OR, role: 'executor', costMicroUsd: 300 }),
          ev({ provider: 'claude', role: null, costMicroUsd: null }),
        ],
        opts,
      ),
    );
    expect(text).toContain('cost $0.0003');
    expect(text).toContain('cost n/a (?1)');
    expect(text).toContain('By role');
    expect(text).toContain('executor / openrouter');
    expect(text).toContain('legacy / claude');
    expect(text).not.toContain('$0.0000');
  });

  test('telegram: cost and the roles block, escaped', () => {
    const all = formatUsageTelegram(
      aggregateUsage([ev({ ...OR, role: 'executor', costMicroUsd: 300 })], opts),
    ).join('\n');
    expect(all).toContain('стоимость $0.0003');
    expect(all).toContain('По ролям');
    expect(all).toContain('executor · openrouter');
  });

  test('no roles block when nothing carries a role, so legacy-only reports stay as they were', () => {
    const all = formatUsageTelegram(aggregateUsage([ev({ costMicroUsd: null })], opts)).join('\n');
    expect(all).not.toContain('По ролям');
    expect(formatUsageText(aggregateUsage([ev()], opts))).not.toContain('By role');
  });
});

describe('speed: first token and generation tokens per second', () => {
  const timed = (over: Partial<AiUsageEvent> = {}) =>
    ev({
      durationMs: 3_000,
      firstTokenMs: 800,
      generationMs: 2_000,
      completionTokens: 100,
      reasoningTokens: null,
      ...over,
    });

  test('outputTokensPerS = completion tokens x 1000 / generation ms', () => {
    expect(outputTokensPerS(timed())).toBe(50);
  });

  test('hidden reasoning tokens are not counted as generated in the window', () => {
    expect(outputTokensPerS(timed({ completionTokens: 300, reasoningTokens: 200 }))).toBe(50);
  });

  test('unknown inputs and too-short windows give null, never 0 or Infinity', () => {
    expect(outputTokensPerS(timed({ generationMs: null }))).toBeNull();
    expect(outputTokensPerS(timed({ completionTokens: null }))).toBeNull();
    expect(outputTokensPerS(timed({ generationMs: 49 }))).toBeNull();
    expect(outputTokensPerS(timed({ generationMs: 0 }))).toBeNull();
    expect(outputTokensPerS(timed({ completionTokens: 10, reasoningTokens: 10 }))).toBeNull();
    expect(outputTokensPerS(timed({ generationMs: 50, completionTokens: 5 }))).toBe(100);
  });

  test('model stats: percentiles over ok rows with a value, with row counts; unknown is not zero', () => {
    const r = aggregateUsage(
      [
        timed({ firstTokenMs: 500, generationMs: 1_000, completionTokens: 40 }), // 40 tok/s
        timed({ firstTokenMs: 900, generationMs: 1_000, completionTokens: 80 }), // 80 tok/s
        timed({ firstTokenMs: 700, generationMs: 1_000, completionTokens: 60 }), // 60 tok/s
        timed({ firstTokenMs: null, generationMs: null }),
        timed({ outcome: 'error', errorClass: 'server', firstTokenMs: 99, generationMs: 999 }),
      ],
      opts,
    );
    const m = r.models[0];
    expect(m?.durationRows).toBe(4);
    expect(m?.firstToken).toEqual({ rows: 3, p50Ms: 700, p95Ms: 900 });
    expect(m?.generationSpeed).toEqual({ rows: 3, p50TokensPerS: 60, p95TokensPerS: 80 });
  });

  test('no measured rows: rows 0 and null percentiles', () => {
    const m = aggregateUsage([ev({ durationMs: 1_000 })], opts).models[0];
    expect(m?.firstToken).toEqual({ rows: 0, p50Ms: null, p95Ms: null });
    expect(m?.generationSpeed).toEqual({ rows: 0, p50TokensPerS: null, p95TokensPerS: null });
  });

  test('role stats carry the same speed fields', () => {
    const r = aggregateUsage([timed({ role: 'executor' })], opts);
    expect(r.roles[0]?.firstToken).toEqual({ rows: 1, p50Ms: 800, p95Ms: 800 });
    expect(r.roles[0]?.generationSpeed.p50TokensPerS).toBe(50);
    expect(r.roles[0]?.durationRows).toBe(1);
  });

  test('text shows TTFT and tok/s with n, and n/a when nothing was measured', () => {
    const text = formatUsageText(aggregateUsage([timed(), timed()], opts));
    expect(text).toContain('first token p50 800ms  p95 800ms  (n=2)');
    expect(text).toContain('speed p50 50.0 tok/s  p95 50.0 tok/s  (n=2)');
    const none = formatUsageText(aggregateUsage([ev()], opts));
    expect(none).toContain('first token p50 n/a  p95 n/a  (n=0)');
    expect(none).toContain('speed p50 n/a  p95 n/a  (n=0)');
  });

  test('telegram shows them in Russian', () => {
    const all = formatUsageTelegram(aggregateUsage([timed({ role: 'executor' })], opts)).join('\n');
    expect(all).toContain('до 1-го токена p50 800мс · p95 800мс (n=1)');
    expect(all).toContain('скорость p50 50.0 ток/с · p95 50.0 ток/с (n=1)');
  });
});

describe('prompt size (estimates)', () => {
  const sized = (system: number, tools: number, history: number, user: number, over = {}) =>
    ev({
      promptSize: {
        systemPromptTokens: system,
        toolCatalogTokens: tools,
        historyTokens: history,
        userTokens: user,
        toolCount: 20,
        messageCount: 5,
      },
      ...over,
    });

  test('model stats: p50/p95 of the total, per-component p50, and the tool-catalog share', () => {
    const m = aggregateUsage(
      [
        sized(100, 700, 100, 100), // total 1000, tools 70%
        sized(100, 700, 700, 100), // total 1600
        sized(100, 700, 1_100, 100), // total 2000
        ev(), // no estimate: not counted
        sized(1, 1, 1, 1, { outcome: 'error', errorClass: 'server' }), // failed attempts still sent the prompt
        sized(9, 9, 9, 9, { outcome: 'skipped' }), // skipped never sent one
      ],
      opts,
    ).models[0];
    expect(m?.promptSize.rows).toBe(4);
    expect(m?.promptSize.p50Tokens).toBe(1_000);
    expect(m?.promptSize.p95Tokens).toBe(2_000);
    expect(m?.promptSize.p50).toEqual({ system: 100, toolCatalog: 700, history: 100, user: 100 });
    // (700*3 + 1) / (1000 + 1600 + 2000 + 4)
    expect(m?.promptSize.toolCatalogShare).toBeCloseTo(2_101 / 4_604, 6);
  });

  test('no estimated rows: rows 0 and null stats, never 0', () => {
    const m = aggregateUsage([ev()], opts).models[0];
    expect(m?.promptSize).toEqual({
      rows: 0,
      p50Tokens: null,
      p95Tokens: null,
      toolCatalogShare: null,
      p50: { system: null, toolCatalog: null, history: null, user: null },
    });
  });

  test('text and telegram show size and tool-catalog share with n, flagged as estimates', () => {
    const report = aggregateUsage([sized(100, 700, 100, 100)], opts);
    const text = formatUsageText(report);
    expect(text).toContain('prompt est. p50 1,000  p95 1,000  tools 70.0%  (n=1)');
    expect(text).toContain('ESTIMATES');
    const tg = formatUsageTelegram(report).join('\n');
    expect(tg).toContain('промпт (оценка) p50 1,000 · p95 1,000 · каталог тулов 70.0% (n=1)');
    const none = formatUsageText(aggregateUsage([ev()], opts));
    expect(none).toContain('prompt est. p50 n/a  p95 n/a  tools n/a  (n=0)');
  });
});
