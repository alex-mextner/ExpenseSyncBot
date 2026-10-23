/**
 * Model preset registry (stage B2): the models a role-routed chain (stage B3) may name, with the
 * request settings each was measured with, its price, and whether it has passed the qualification
 * gate. Same ids and field names as HyperCalendarBot.
 *
 * A preset is routable over several providers (`models` maps a provider id to the model id that
 * provider expects), so a chain entry `openrouter:glm53-flash-low` and `zai:glm53-flash-low` name
 * the same preset with different wire ids.
 *
 * Nothing here changes a legacy chain: `AI_SMART_CHAIN` / `AI_FAST_CHAIN` keep their own models.
 * The only legacy effect is the excluded list, which keeps retired models out of every chain.
 */

import type { ProviderId } from './provider-ids';

export const ROLES = ['planner', 'executor', 'repair'] as const;
export type Role = (typeof ROLES)[number];

/**
 * A preset takes a role only when its measured accuracy on that role is at least `rolePass` AND it
 * is right on every case of the labelled history (`historyPass` 1 = 100%). Owner decision, stage B plan §2.
 */
export const QUALIFICATION_GATE = { rolePass: 0.95, historyPass: 1 } as const;

/** Result of one qualification run: the commit it ran at and the two pass rates (0..1). */
export interface Qualification {
  sha: string;
  rolePass: number;
  historyPass: number;
}

export interface ModelPreset {
  id: string;
  /** Model id to send, per provider route; a provider not listed cannot serve this preset. */
  models: Partial<Record<ProviderId, string>>;
  /** Reasoning effort the preset was measured with; sent only where it was verified to work. */
  effort?: 'low' | 'medium' | 'high';
  temperature?: number;
  /** Ceiling for `max_tokens`. */
  maxOutputTokens?: number;
  /**
   * List price in USD per million tokens, valid for the `via` route only; `asOf` is the day it was
   * read. `null` = unknown, and a cost computed from it is NULL, never 0.
   */
  priceUsdPerMTok: { in: number; out: number; asOf: string; via: ProviderId } | null;
  /** Roles the preset is a candidate for. */
  roles: readonly Role[];
  /** `null` until a qualification run has passed the gate. */
  qualification: Qualification | null;
}

/**
 * Prices are OpenRouter's /models listing of 2026-10-23 (USD per token × 1e6). OpenRouter ids were
 * checked against the same listing. `claude-haiku-5-5` on the `claude` route has no price here: the
 * direct Anthropic rate was not read, so its cost stays unknown.
 */
const PRICE_AS_OF = '2026-10-23';

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'deepseek41-flash',
    models: { openrouter: 'deepseek/deepseek-v4.1-flash' },
    priceUsdPerMTok: { in: 0.3, out: 1.2, asOf: PRICE_AS_OF, via: 'openrouter' },
    roles: ['executor'],
    qualification: null,
  },
  {
    id: 'glm53-flash-low',
    models: { zai: 'glm-5.3-flash', openrouter: 'z-ai/glm-5.3-flash' },
    effort: 'low',
    temperature: 1,
    maxOutputTokens: 8192,
    priceUsdPerMTok: { in: 0.15, out: 0.5, asOf: PRICE_AS_OF, via: 'openrouter' },
    roles: ['planner', 'executor'],
    qualification: null,
  },
  {
    id: 'glm53-low',
    models: { zai: 'glm-5.3', openrouter: 'z-ai/glm-5.3' },
    effort: 'low',
    priceUsdPerMTok: { in: 0.079, out: 1.4, asOf: PRICE_AS_OF, via: 'openrouter' },
    roles: ['repair'],
    qualification: null,
  },
  {
    id: 'haiku',
    models: { claude: 'claude-haiku-5-5', openrouter: 'anthropic/claude-haiku-5.5' },
    priceUsdPerMTok: { in: 0.1, out: 0.5, asOf: PRICE_AS_OF, via: 'openrouter' },
    roles: ['planner', 'executor'],
    qualification: null,
  },
];

/**
 * Models that must never be served, whatever a chain, an env var or a fallback says. The owner
 * dropped GPT-OSS (every host) on 2026-09-27 after it failed the benchmark; small Qwen on Groq
 * invented numeric ids and was 4 h off on time zones.
 */
export const EXCLUDED_MODEL_PATTERNS: readonly RegExp[] = [/gpt-oss/i, /qwen3\.8-27b/i];

export function isExcludedModel(model: string): boolean {
  return EXCLUDED_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

export function findPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === id);
}

export function isQualifiedFor(preset: ModelPreset, role: Role): boolean {
  const q = preset.qualification;
  return (
    q !== null &&
    preset.roles.includes(role) &&
    q.rolePass >= QUALIFICATION_GATE.rolePass &&
    q.historyPass >= QUALIFICATION_GATE.historyPass
  );
}

interface PresetRequestParams {
  reasoning_effort?: 'low' | 'medium' | 'high';
  temperature: number;
  max_tokens: number;
}

/**
 * The request fields a preset overrides. `reasoning_effort` goes only to OpenRouter: measured on
 * 2026-10-23, `z-ai/glm-5.3-flash` answered a tool call in 0.54 s with it (1 reasoning token)
 * against 1.5 s without (28), and 9–13 s on a longer prompt; the other routes were not measured.
 */
export function presetRequestParams(
  preset: ModelPreset,
  provider: ProviderId,
  callerTemperature: number,
  callerMaxTokens: number,
): PresetRequestParams {
  return {
    ...(preset.effort && provider === 'openrouter' ? { reasoning_effort: preset.effort } : {}),
    temperature: preset.temperature ?? callerTemperature,
    max_tokens:
      preset.maxOutputTokens === undefined
        ? callerMaxTokens
        : Math.min(callerMaxTokens, preset.maxOutputTokens),
  };
}

/**
 * Cost of one attempt in micro-USD (1e-6 USD): tokens × the preset's list price per million tokens,
 * rounded to a whole micro-USD. The route is found by provider + model, so a legacy chain naming an
 * OpenRouter model is priced too. `null` = unknown — no preset or price for that route, or a token
 * count the provider did not report — and is never written as 0. List price, no cache discount:
 * an upper bound.
 */
export function computeCostMicroUsd(
  provider: string,
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  if (promptTokens === null || completionTokens === null) return null;
  const price = MODEL_PRESETS.find((p) =>
    Object.entries(p.models).some(([route, id]) => route === provider && id === model),
  )?.priceUsdPerMTok;
  if (!price || price.via !== provider) return null;
  const cost = Math.round(promptTokens * price.in + completionTokens * price.out);
  // An absurd count must not become an inexact or non-finite integer in the ledger: unknown instead.
  return Number.isSafeInteger(cost) ? cost : null;
}
