// A leaf on purpose: it imports nothing. Both the config layer (which validates the chain order
// named in the environment) and the AI layer (which owns the clients) need this list, and a shared
// constant that imports either of them could be undefined at startup depending on load order.

/**
 * Every text provider the bot can talk to. The chain order in the environment is validated against
 * this list, so a provider added here becomes nameable in AI_SMART_CHAIN / AI_FAST_CHAIN with no
 * second edit — and one that is not here cannot be named by accident. The ids are the same as in
 * HyperCalendarBot. `openrouter` is optional and never in a default order: it is used only when the
 * operator names it in a chain and sets its key and model.
 */
export const PROVIDER_IDS = ['zai', 'claude', 'hf', 'openrouter'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** The providers of the default chain orders; `openrouter` is optional and in none of them. */
export const DEFAULT_PROVIDER_IDS: readonly ProviderId[] = ['zai', 'claude', 'hf'];
