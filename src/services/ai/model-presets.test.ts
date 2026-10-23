// Tests for the model preset registry: the table itself, the excluded list and the qualification gate.

import { describe, expect, it } from 'bun:test';
import {
  computeCostMicroUsd,
  EXCLUDED_MODEL_PATTERNS,
  findPreset,
  isExcludedModel,
  isQualifiedFor,
  MODEL_PRESETS,
  type ModelPreset,
  presetRequestParams,
  QUALIFICATION_GATE,
  ROLES,
} from './model-presets';
import { PROVIDER_IDS } from './provider-ids';

function preset(over: Partial<ModelPreset> = {}): ModelPreset {
  return {
    id: 'test',
    models: { openrouter: 'vendor/test' },
    roles: ['executor'],
    priceUsdPerMTok: null,
    qualification: null,
    ...over,
  };
}

describe('MODEL_PRESETS', () => {
  it('seeds the four candidates under their agreed ids', () => {
    expect(MODEL_PRESETS.map((p) => p.id)).toEqual([
      'deepseek41-flash',
      'glm53-flash-low',
      'glm53-low',
      'haiku',
    ]);
  });

  it('has unique ids and only known providers with non-empty model ids', () => {
    expect(new Set(MODEL_PRESETS.map((p) => p.id)).size).toBe(MODEL_PRESETS.length);
    for (const p of MODEL_PRESETS) {
      const routes = Object.entries(p.models);
      expect(routes.length).toBeGreaterThan(0);
      for (const [provider, model] of routes) {
        expect(PROVIDER_IDS as readonly string[]).toContain(provider);
        expect(model).toBeTruthy();
      }
      expect(p.roles.length).toBeGreaterThan(0);
      for (const role of p.roles) expect(ROLES).toContain(role);
    }
  });

  it('carries the exact OpenRouter ids probed on 2026-10-23', () => {
    expect(findPreset('deepseek41-flash')?.models.openrouter).toBe('deepseek/deepseek-v4.1-flash');
    expect(findPreset('glm53-flash-low')?.models.openrouter).toBe('z-ai/glm-5.3-flash');
    expect(findPreset('glm53-low')?.models.openrouter).toBe('z-ai/glm-5.3');
    expect(findPreset('haiku')?.models.openrouter).toBe('anthropic/claude-haiku-5.5');
  });

  it('keeps every price explicit: per-million rates, a date and the provider it is valid for', () => {
    for (const p of MODEL_PRESETS) {
      const price = p.priceUsdPerMTok;
      expect(price).not.toBeNull();
      if (!price) continue;
      expect(price.in).toBeGreaterThan(0);
      expect(price.out).toBeGreaterThan(0);
      expect(price.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.models[price.via]).toBeTruthy();
    }
  });

  it('has no qualified preset until a qualification run has passed the gate', () => {
    for (const p of MODEL_PRESETS) {
      expect(p.qualification).toBeNull();
      for (const role of ROLES) expect(isQualifiedFor(p, role)).toBe(false);
    }
  });

  it('never lists an excluded model as a preset route', () => {
    for (const p of MODEL_PRESETS) {
      for (const model of Object.values(p.models)) expect(isExcludedModel(model)).toBe(false);
    }
  });

  it('findPreset returns undefined for an unknown id', () => {
    expect(findPreset('nope')).toBeUndefined();
  });
});

describe('isExcludedModel', () => {
  it.each([
    'openai/gpt-oss-120b',
    'gpt-oss-20b',
    'GPT-OSS-120B',
    'qwen/qwen3.8-27b',
  ])('excludes %s', (model) => {
    expect(isExcludedModel(model)).toBe(true);
  });

  it.each([
    'glm-5.3-flash',
    'deepseek/deepseek-v4.1-flash',
    'claude-sonnet-5-5',
    'Qwen/Qwen3-235B-A22B',
    'meta-llama/Llama-3.3-70B-Instruct',
  ])('keeps %s', (model) => {
    expect(isExcludedModel(model)).toBe(false);
  });

  it('exposes the patterns it applies', () => {
    expect(EXCLUDED_MODEL_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('isQualifiedFor', () => {
  const passing = { sha: 'abc1234', rolePass: QUALIFICATION_GATE.rolePass, historyPass: 1 };

  it('needs a qualification record', () => {
    expect(isQualifiedFor(preset(), 'executor')).toBe(false);
  });

  it('passes exactly at the gate: >= 95% own-role and 100% on the labelled history', () => {
    expect(QUALIFICATION_GATE).toEqual({ rolePass: 0.95, historyPass: 1 });
    expect(isQualifiedFor(preset({ qualification: passing }), 'executor')).toBe(true);
  });

  it('fails below the role threshold', () => {
    expect(
      isQualifiedFor(preset({ qualification: { ...passing, rolePass: 0.949 } }), 'executor'),
    ).toBe(false);
  });

  it('fails when a single history case is wrong', () => {
    expect(
      isQualifiedFor(preset({ qualification: { ...passing, historyPass: 0.999 } }), 'executor'),
    ).toBe(false);
  });

  it('is per role: a preset qualified for executor is not thereby allowed to repair', () => {
    const p = preset({ roles: ['executor'], qualification: passing });
    expect(isQualifiedFor(p, 'repair')).toBe(false);
  });
});

describe('presetRequestParams', () => {
  const flash = preset({ effort: 'low', temperature: 1, maxOutputTokens: 8192 });

  it('sends reasoning_effort on OpenRouter, where it was measured to cut latency', () => {
    expect(presetRequestParams(flash, 'openrouter', 0.3, 4096)).toEqual({
      reasoning_effort: 'low',
      temperature: 1,
      max_tokens: 4096,
    });
  });

  it('does not invent an effort field for providers it was not measured on', () => {
    expect(presetRequestParams(flash, 'zai', 0.3, 4096)).toEqual({
      temperature: 1,
      max_tokens: 4096,
    });
  });

  it('the preset temperature overrides the caller default; without one the caller keeps it', () => {
    expect(presetRequestParams(preset(), 'openrouter', 0.3, 4096)).toEqual({
      temperature: 0.3,
      max_tokens: 4096,
    });
  });

  it('caps max_tokens at the preset ceiling and never raises a smaller caller budget', () => {
    expect(presetRequestParams(flash, 'openrouter', 0.3, 20_000).max_tokens).toBe(8192);
    expect(presetRequestParams(flash, 'openrouter', 0.3, 200).max_tokens).toBe(200);
  });
});

describe('computeCostMicroUsd', () => {
  // deepseek41-flash on OpenRouter: $0.30 in / $1.20 out per million tokens = 0.30 / 1.20 µUSD per token.
  const MODEL = 'deepseek/deepseek-v4.1-flash';

  it('prices tokens at the list rate of the route, in whole micro-USD', () => {
    expect(computeCostMicroUsd('openrouter', MODEL, 1_000_000, 1_000_000)).toBe(1_500_000);
    expect(computeCostMicroUsd('openrouter', MODEL, 352, 15)).toBe(124); // 105.6 + 18 = 123.6
  });

  it('a reported zero costs 0, which is not the same as unknown', () => {
    expect(computeCostMicroUsd('openrouter', MODEL, 0, 0)).toBe(0);
  });

  it('is unknown (null) when either token count was not reported', () => {
    expect(computeCostMicroUsd('openrouter', MODEL, null, 15)).toBeNull();
    expect(computeCostMicroUsd('openrouter', MODEL, 352, null)).toBeNull();
  });

  it('is unknown rather than inexact when the product leaves the safe integer range', () => {
    expect(
      computeCostMicroUsd('openrouter', MODEL, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    ).toBeNull();
  });

  it('is unknown for a model or route the registry has no price for', () => {
    expect(computeCostMicroUsd('openrouter', 'vendor/unlisted', 10, 10)).toBeNull();
    expect(computeCostMicroUsd('zai', 'glm-5.3-flash', 10, 10)).toBeNull(); // priced via openrouter only
    expect(computeCostMicroUsd('claude', 'claude-sonnet-5-5', 10, 10)).toBeNull();
  });
});
