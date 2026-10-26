// Exact-output tests for formatUsageText: the text report is read by humans (and pasted into
// tickets), so every line of the model, role, verdict and legend sections is pinned verbatim.
import { describe, expect, test } from 'bun:test';
import type { AiUsageEvent } from '../../database/repositories/ai-usage-events.repository';
import { aggregateUsage, formatUsageText } from './usage-report';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const opts = { now: NOW, days: 7 };
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

describe('formatUsageText exact output', () => {
  const events = [
    ev({
      role: 'executor',
      provider: 'openrouter',
      model: 'x/y',
      promptTokens: 5000,
      completionTokens: 200,
      reasoningTokens: 50,
      cachedTokens: 1000,
      durationMs: 2500,
      firstTokenMs: 400,
      generationMs: 2000,
      costMicroUsd: 300,
      promptSize: {
        systemPromptTokens: 100,
        toolCatalogTokens: 700,
        historyTokens: 100,
        userTokens: 100,
        toolCount: 20,
        messageCount: 5,
      },
    }),
    ev({
      outcome: 'error',
      errorClass: 'rate_limit',
      provider: 'openrouter',
      model: 'x/y',
      role: 'executor',
      at: NOW - 5000,
    }),
    ev({ outcome: 'error', errorClass: 'server', provider: 'zai', at: NOW - 9000 }),
    ev({ outcome: 'skipped', provider: 'zai' }),
  ];
  const lines = formatUsageText(aggregateUsage(events, opts)).split('\n');
  const legendAt = lines.indexOf('Legend');

  test('header, model blocks (optional reasoning/cached/errors lines), roles and verdicts', () => {
    expect(lines.slice(0, legendAt)).toEqual([
      'AI usage, 2026-10-16 .. 2026-10-23 (last 7 days, UTC)',
      '',
      'zai:m1',
      '  attempts 1  ok 0  err 1  skipped 1  success 0%',
      '  latency p50 n/a  p95 n/a',
      '  first token p50 n/a  p95 n/a  (n=0)',
      '  speed p50 n/a  p95 n/a  (n=0)',
      '  prompt est. p50 n/a  p95 n/a  tools n/a  (n=0)',
      '  tokens in n/a / out n/a',
      '  cost n/a',
      '  errors by class: server×1',
      '  first ok n/a  last ok n/a',
      '  last error server @ 2026-10-23T11:59Z',
      '',
      'openrouter:x/y',
      '  attempts 2  ok 1  err 1  skipped 0  success 50%',
      '  latency p50 2.5s  p95 2.5s',
      '  first token p50 400ms  p95 400ms  (n=1)',
      '  speed p50 75.0 tok/s  p95 75.0 tok/s  (n=1)',
      '  prompt est. p50 1,000  p95 1,000  tools 70.0%  (n=1)',
      '  tokens in 5,000 / out 200 / reasoning 50 / cached 1,000',
      '  cost $0.0003',
      '  errors by class: rate_limit×1',
      '  first ok 2026-10-23T11:59Z  last ok 2026-10-23T11:59Z',
      '  last error rate_limit @ 2026-10-23T11:59Z',
      '',
      'By role',
      '  executor / openrouter: 1/2 ok (50%), p50 2.5s, p95 2.5s, first token p50 400ms, speed p50 75.0 tok/s, tokens in 5,000 / out 200, cost $0.0003',
      '  legacy / zai: 0/1 ok (0%), p50 n/a, p95 n/a, first token p50 n/a, speed p50 n/a, tokens in n/a / out n/a, cost n/a',
      '',
      'Verdicts',
      '  zai: failing — 0/1 ok (0%), last error server @ 2026-10-23T11:59Z',
      '  claude: no traffic in the last 7 days',
      '  hf: no traffic in the last 7 days',
      '  openrouter: degraded — 1/2 ok (50%), last ok 2026-10-23T11:59Z, last error rate_limit @ 2026-10-23T11:59Z',
      '',
    ]);
  });

  test('the legend closes the report: eight lines after a blank separator', () => {
    const legend = lines.slice(legendAt);
    expect(legend).toHaveLength(8);
    expect(legend[0]).toBe('Legend');
    expect(legend[1]).toBe(
      '  attempts = requests really sent (ok + err); skipped are not attempts. success = ok / attempts.',
    );
    expect(legend[7]).toBe(
      '  legacy = attempts on the AI_SMART_CHAIN / AI_FAST_CHAIN chains, not role-routed.',
    );
  });

  test('an empty window says so, has no By role section and still lists verdicts', () => {
    const empty = formatUsageText(aggregateUsage([], { now: NOW, days: 1 })).split('\n');
    expect(empty.slice(0, 6)).toEqual([
      'AI usage, 2026-10-22 .. 2026-10-23 (last 1 day, UTC)',
      '',
      'No rows in this window.',
      '',
      'Verdicts',
      '  zai: no traffic in the last 1 day',
    ]);
    expect(empty).not.toContain('By role');
  });

  test('a model with no errors omits the error-class line; no reasoning/cached omits those parts', () => {
    const quiet = formatUsageText(
      aggregateUsage([ev({ promptTokens: 1, completionTokens: 2 })], opts),
    );
    expect(quiet).not.toContain('errors by class');
    expect(quiet).toContain('  tokens in 1 / out 2\n');
    expect(quiet).toContain('  last error none');
  });
});
