/**
 * Role-based routing config (stage B3; same env names and semantics as HyperCalendarBot).
 *
 * `AI_ROUTING=legacy` (default) leaves every chain as it is. With `AI_ROUTING=roles` an agent round
 * runs on the chain of its role (`AI_PLANNER_CHAIN` / `AI_EXECUTOR_CHAIN` / `AI_REPAIR_CHAIN`),
 * optionally only for the Telegram users listed in `AI_ROUTING_USER_IDS` (a canary). A chain entry
 * is `provider` (the provider's own configured model) or `provider:preset` (a registry preset
 * routed over that provider; it must be qualified for the role to be used).
 *
 * Imports only leaf modules, so `config/env.ts` can parse with it.
 */

import { isExcludedModel, MODEL_PRESETS, type ModelPreset } from './model-presets';
import { PROVIDER_IDS, type ProviderId } from './provider-ids';

export type RoutingMode = 'legacy' | 'roles';

export interface RoleChainEntry {
  provider: ProviderId;
  /** `null` = the provider's own configured model. */
  preset: ModelPreset | null;
}

/** Most Telegram ids a canary list may hold — the bound HyperCalendarBot applies to its own lists. */
const MAX_ROUTING_USER_IDS = 100;

export function parseRoutingMode(raw: string | undefined): RoutingMode {
  if (!raw) return 'legacy';
  if (raw === 'legacy' || raw === 'roles') return raw;
  throw new Error('AI_ROUTING must be legacy or roles');
}

export function parseRoutingUserIds(raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((part) => part.trim());
  if (
    raw.length > 1800 ||
    parts.length > MAX_ROUTING_USER_IDS ||
    parts.some((part) => !/^[1-9][0-9]*$/.test(part) || !Number.isSafeInteger(Number(part)))
  ) {
    throw new Error(
      `AI_ROUTING_USER_IDS must be at most ${MAX_ROUTING_USER_IDS} positive safe integer Telegram user IDs`,
    );
  }
  return [...new Set(parts.map(Number))];
}

/** Roles routing is on for a user: the mode is `roles` and the canary list, if any, names them. */
export function rolesRoutingAppliesTo(
  mode: RoutingMode,
  userIds: readonly number[] | undefined,
  telegramUserId: number,
): boolean {
  return mode === 'roles' && (!userIds || userIds.includes(telegramUserId));
}

/**
 * Parses one role chain (`provider[:preset],…`). A bad entry is dropped and described in
 * `problems` for the caller to log; duplicates keep their first position.
 */
export function parseRoleChain(
  raw: string | undefined,
  registry: readonly ModelPreset[] = MODEL_PRESETS,
): { entries: RoleChainEntry[]; problems: string[] } {
  const entries: RoleChainEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const text = part.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const [providerText = '', presetId] = text.split(':');
    const provider = PROVIDER_IDS.find((id): id is ProviderId => id === providerText);
    if (!provider) {
      problems.push(`unknown provider in "${text}"`);
      continue;
    }
    if (presetId === undefined) {
      entries.push({ provider, preset: null });
      continue;
    }
    const preset = registry.find((p) => p.id === presetId);
    if (!preset) {
      problems.push(`unknown preset "${presetId}" in "${text}"`);
      continue;
    }
    const model = preset.models[provider];
    if (!model) {
      problems.push(`preset "${presetId}" has no route over ${provider}: "${text}"`);
      continue;
    }
    if (isExcludedModel(model)) {
      problems.push(`"${text}" names an excluded model`);
      continue;
    }
    entries.push({ provider, preset });
  }
  return { entries, problems };
}
