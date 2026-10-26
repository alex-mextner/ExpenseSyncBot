/**
 * Token counts and stream timing of one provider attempt, as stored in ai_usage_events.
 * Split from streaming.ts so the slot, the round loop and the usage-event builder share one
 * definition of "unknown" (NULL) without importing each other.
 */

import type OpenAI from 'openai';

/** Token counts of one attempt. NULL = the provider did not report it; a reported 0 stays 0. */
export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
}

export const UNKNOWN_USAGE: TokenUsage = {
  promptTokens: null,
  completionTokens: null,
  reasoningTokens: null,
  cachedTokens: null,
};

function reportedTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The OpenAI-compatible usage object of a stream's final chunk → nullable token counts. */
export function normalizeUsage(usage: OpenAI.CompletionUsage | null | undefined): TokenUsage {
  if (!usage) return UNKNOWN_USAGE;
  return {
    promptTokens: reportedTokens(usage.prompt_tokens),
    completionTokens: reportedTokens(usage.completion_tokens),
    reasoningTokens: reportedTokens(usage.completion_tokens_details?.reasoning_tokens),
    cachedTokens: reportedTokens(usage.prompt_tokens_details?.cached_tokens),
  };
}

// Internal tag: carries the tokens a provider reported before its attempt failed (an empty answer
// still bills tokens) from the slot to the usage event of the failed attempt.
const ATTEMPT_USAGE: unique symbol = Symbol('attemptUsage');
interface AttemptUsageTag {
  [ATTEMPT_USAGE]?: TokenUsage;
}

export function tagAttemptUsage(error: unknown, usage: TokenUsage): void {
  if (error && typeof error === 'object') (error as AttemptUsageTag)[ATTEMPT_USAGE] = usage;
}

export function attemptUsage(error: unknown): TokenUsage {
  const tag =
    error && typeof error === 'object' ? (error as AttemptUsageTag)[ATTEMPT_USAGE] : undefined;
  return tag ?? UNKNOWN_USAGE;
}

/**
 * Wall-clock shape of one successful stream, in whole milliseconds. `firstTokenMs` runs from the
 * request start to the first content or tool-call delta (thinking that is billed but not streamed
 * sits inside it); `generationMs` from that delta to the last content or tool-call delta, so the
 * trailing usage-only chunk does not stretch the window. A one-delta answer has `generationMs` 0.
 */
export interface StreamTiming {
  firstTokenMs: number | null;
  generationMs: number | null;
}

export const UNKNOWN_TIMING: StreamTiming = { firstTokenMs: null, generationMs: null };
