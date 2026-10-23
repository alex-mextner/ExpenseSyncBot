// Tests for the pure AI usage aggregation and its text / Telegram formatters.
import { describe, expect, test } from 'bun:test';
import type { AiUsageEvent } from '../../database/repositories/ai-usage-events.repository';
import { aggregateUsage, formatUsageTelegram, formatUsageText } from './usage-report';

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
