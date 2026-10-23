// A leaf on purpose: it imports nothing. Both the config layer (which validates the chain order
// named in the environment) and the AI layer (which owns the clients) need this list, and a shared
// constant that imports either of them could be undefined at startup depending on load order.

/**
 * Every text provider the bot can talk to. The chain order in the environment is validated against
 * this list, so a provider added here becomes nameable in AI_SMART_CHAIN / AI_FAST_CHAIN with no
 * second edit — and one that is not here cannot be named by accident. The ids are the same as in
 * HyperCalendarBot.
 */
export const PROVIDER_IDS = ['zai', 'claude', 'hf'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
