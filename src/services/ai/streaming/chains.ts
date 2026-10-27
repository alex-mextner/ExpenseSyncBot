/**
 * Chain builders: which provider slots a round on the smart, fast or OCR chain (or a routed role)
 * would try, and in which order. Lazy — env is read on each build so tests can mock env per-test.
 * An unusable entry is skipped and logged once per process (the chain is rebuilt every round).
 */

import type OpenAI from 'openai';
import { type ChainOrder, env } from '../../../config/env';
import { createLogger } from '../../../utils/logger';
import { claudeClient, hfClient, openrouterClient, zaiClient } from '../clients';
import { isExcludedModel, isQualifiedFor, type Role } from '../model-presets';
import { orderByHealth } from '../provider-breaker';
import type { ProviderId } from '../provider-ids';
import type { RoleChainEntry } from '../role-routing';
import { streamingSlot } from './slot';
import type { ChainName, ProviderSlot } from './types';

const logger = createLogger('ai-streaming');

/** What a provider needs before it can be put in a text chain: both must be set. */
interface ProviderAvailability {
  model: string;
  apiKey: string;
}

const TEXT_PROVIDER_LABELS: Record<ProviderId, string> = {
  zai: 'z.ai',
  claude: 'Claude',
  hf: 'HF',
  openrouter: 'OpenRouter',
};

// Resolved at call time, not captured: tests replace the client factories after import.
const TEXT_PROVIDER_CLIENTS: Record<ProviderId, () => OpenAI> = {
  zai: () => zaiClient(),
  claude: () => claudeClient(),
  hf: () => hfClient(),
  openrouter: () => openrouterClient(),
};

const loggedSkips = new Set<string>();

/** Runs `log` the first time `marker` is seen in this process, so a rebuilt chain does not repeat itself. */
function logOnce(marker: string, log: () => void): void {
  if (loggedSkips.has(marker)) return;
  loggedSkips.add(marker);
  log();
}

/** One provider of a text chain, or null (logged once) when it is excluded or not configured. */
function textSlotFor(
  kind: 'smart' | 'fast',
  provider: ProviderId,
  { model, apiKey }: ProviderAvailability,
  named: boolean,
): ProviderSlot | null {
  if (model && isExcludedModel(model)) {
    logOnce(`${kind}:${provider}:excluded:${model}`, () =>
      logger.warn(
        { chain: kind, provider, model },
        '[AI_STREAM] Model is on the excluded list — skipping it',
      ),
    );
    return null;
  }
  if (!model || !apiKey) {
    logOnce(`${kind}:${provider}:${!!model}:${!!apiKey}`, () =>
      logUnconfiguredProvider(
        { chain: kind, provider, hasModel: !!model, hasKey: !!apiKey },
        named,
      ),
    );
    return null;
  }
  return streamingSlot(
    `${TEXT_PROVIDER_LABELS[provider]} (${model})`,
    provider,
    TEXT_PROVIDER_CLIENTS[provider],
    model,
    provider === 'claude' ? { anthropic: true } : {},
  );
}

function logUnconfiguredProvider(detail: object, named: boolean): void {
  if (named) {
    logger.warn(
      detail,
      '[AI_STREAM] Provider named in the chain order is not configured — skipping it',
    );
  } else {
    logger.debug(
      detail,
      '[AI_STREAM] Provider in the default chain order is not configured — skipping it',
    );
  }
}

/**
 * Builds one text chain in the configured order (AI_SMART_CHAIN / AI_FAST_CHAIN, default
 * z.ai → Claude → HF), skipping — and logging once — any provider whose key or model is
 * missing. A named-but-unconfigured provider warns; one only in the default order is debug.
 * When nothing in an operator-configured order is usable the default order is tried instead.
 */
function buildTextChain(
  kind: 'smart' | 'fast',
  chain: ChainOrder,
  available: Record<ProviderId, ProviderAvailability>,
): ProviderSlot[] {
  const slotsFor = (ids: readonly ProviderId[], named: boolean): ProviderSlot[] => {
    const slots: ProviderSlot[] = [];
    for (const provider of ids) {
      const slot = textSlotFor(kind, provider, available[provider], named);
      if (slot) slots.push(slot);
    }
    return slots;
  };

  const configured = slotsFor(chain.order, chain.fromEnv);
  if (configured.length > 0 || !chain.fromEnv) return configured;
  // Rebuilt on every round, so this is logged once per process, like the skips above.
  logOnce(`${kind}:nothing-configured`, () =>
    logger.error(
      { chain: kind, order: chain.order },
      '[AI_STREAM] Configured provider order named nothing that is configured — using the default order',
    ),
  );
  return slotsFor(chain.fallback, false);
}

function smartAvailability(): Record<ProviderId, ProviderAvailability> {
  return {
    zai: { model: env.AI_MODEL, apiKey: env.ANTHROPIC_API_KEY },
    claude: { model: env.CLAUDE_MODEL, apiKey: env.CLAUDE_API_TOKEN },
    hf: { model: env.HF_MODEL, apiKey: env.HF_TOKEN },
    openrouter: { model: env.OPENROUTER_MODEL, apiKey: env.OPENROUTER_API_KEY },
  };
}

function fastAvailability(): Record<ProviderId, ProviderAvailability> {
  return {
    zai: { model: env.AI_FAST_MODEL, apiKey: env.ANTHROPIC_API_KEY },
    claude: { model: env.CLAUDE_FAST_MODEL, apiKey: env.CLAUDE_API_TOKEN },
    hf: { model: env.HF_FAST_MODEL, apiKey: env.HF_TOKEN },
    openrouter: { model: env.OPENROUTER_FAST_MODEL, apiKey: env.OPENROUTER_API_KEY },
  };
}

function buildSmartChain(): ProviderSlot[] {
  return buildTextChain('smart', env.AI_SMART_CHAIN, smartAvailability());
}

function buildFastChain(): ProviderSlot[] {
  return buildTextChain('fast', env.AI_FAST_CHAIN, fastAvailability());
}

/** One entry of a role's chain, or null (logged once with the reason) when it cannot load. */
function roleSlotFor(
  role: Role,
  { provider, preset }: RoleChainEntry,
  available: Record<ProviderId, ProviderAvailability>,
): ProviderSlot | null {
  const { apiKey, model: ownModel } = available[provider];
  const model = preset ? preset.models[provider] : ownModel;
  const detail = preset ? `${provider}:${preset.id}` : provider;
  const skip = (why: string): null => {
    logOnce(`role:${role}:${provider}:${detail}:${why}`, () =>
      logger.error(
        { role, provider, entry: detail },
        `[AI_STREAM] Role chain entry skipped: ${why}`,
      ),
    );
    return null;
  };
  if (!apiKey || !model) return skip('no key or model configured');
  if (isExcludedModel(model)) return skip('model is on the excluded list');
  if (preset && !isQualifiedFor(preset, role)) return skip(`preset is not qualified for ${role}`);
  return {
    ...streamingSlot(
      `${TEXT_PROVIDER_LABELS[provider]} (${model})`,
      provider,
      TEXT_PROVIDER_CLIENTS[provider],
      model,
      {
        ...(provider === 'claude' ? { anthropic: true } : {}),
        ...(preset ? { preset, provider } : {}),
      },
    ),
    role,
  };
}

/**
 * The slots of a role's chain (AI_PLANNER_CHAIN / AI_EXECUTOR_CHAIN / AI_REPAIR_CHAIN), in order.
 * A `provider:preset` entry loads only when the preset is qualified for the role; a bare provider
 * entry uses the provider's own model (the fast model for the planner, the smart one otherwise).
 * Anything unusable is skipped and logged once; an empty result makes the caller use the legacy chain.
 */
function buildRoleChain(role: Role): ProviderSlot[] {
  const available = role === 'planner' ? fastAvailability() : smartAvailability();
  const slots: ProviderSlot[] = [];
  for (const entry of env.AI_ROLE_CHAINS[role]) {
    const slot = roleSlotFor(role, entry, available);
    if (slot) slots.push(slot);
  }
  return slots;
}

function buildOcrChain(): ProviderSlot[] {
  const chain: ProviderSlot[] = [];
  if (env.CLAUDE_API_TOKEN) {
    chain.push(
      streamingSlot(
        `Claude (${env.CLAUDE_VISION_MODEL})`,
        'claude',
        claudeClient,
        env.CLAUDE_VISION_MODEL,
        { anthropic: true },
      ),
    );
  }
  chain.push(streamingSlot(`HF (${env.HF_VISION_MODEL})`, 'hf', hfClient, env.HF_VISION_MODEL));
  return chain;
}

/** The smart chain: the role's own chain when one loads, else the legacy order. */
function buildSmartOrRoleChain(role?: Role): ProviderSlot[] {
  if (role && env.AI_ROUTING === 'roles') {
    const roleSlots = buildRoleChain(role);
    if (roleSlots.length > 0) return roleSlots;
    logOnce(`role:${role}:nothing-loadable`, () =>
      logger.error(
        { role },
        '[AI_STREAM] Role chain has nothing loadable — using the legacy chain',
      ),
    );
  }
  return buildSmartChain();
}

/**
 * Role-routed rounds exist only on the smart chain and only while AI_ROUTING=roles: flipping the
 * env back to `legacy` is the rollback for every caller at once. A role whose chain has nothing
 * loadable runs the legacy chain instead of failing the round.
 */
function buildChain(chain: ChainName, role?: Role): ProviderSlot[] {
  switch (chain) {
    case 'smart':
      return buildSmartOrRoleChain(role);
    case 'fast':
      return buildFastChain();
    case 'ocr':
      return buildOcrChain();
  }
}

/** The chain's slots minus the excluded names, in breaker order (demoted slots last). */
export function availableSlots(
  chain: ChainName,
  exclude: readonly string[],
  now: number,
  role?: Role,
): ProviderSlot[] {
  return orderByHealth(
    buildChain(chain, role).filter((slot) => !exclude.includes(slot.name)),
    now,
  );
}

/** The chain's slots named in `exclude` — a round skips them without requesting. */
export function excludedSlots(
  chain: ChainName,
  exclude: readonly string[],
  role?: Role,
): ProviderSlot[] {
  return buildChain(chain, role).filter((slot) => exclude.includes(slot.name));
}

/**
 * Name of the slot a round on `chain` would try first with `exclude` left out, or null when none
 * is left — the agent's handoff target.
 */
export function nextProvider(
  chain: ChainName,
  exclude: readonly string[],
  role?: Role,
): string | null {
  return availableSlots(chain, exclude, Date.now(), role)[0]?.name ?? null;
}
