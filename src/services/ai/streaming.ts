/**
 * Unified AI streaming round with automatic provider fallback.
 *
 * Three chains, selected via options.chain:
 *   SMART: configured AI_SMART_CHAIN, default z.ai ${AI_MODEL} → Claude ${CLAUDE_MODEL} → HF ${HF_MODEL}
 *   FAST:  configured AI_FAST_CHAIN, default z.ai ${AI_FAST_MODEL} → Claude ${CLAUDE_FAST_MODEL} → HF ${HF_FAST_MODEL}
 *   OCR:   Claude ${CLAUDE_VISION_MODEL} → HF ${HF_VISION_MODEL}     (vision-only)
 * The Claude slot is skipped when its key is absent (OCR then runs HF-only); the OCR order is fixed.
 *
 * Callers that need live updates pass `onTextDelta` / `onToolCallStart` callbacks.
 * Callers that just want the final text (validator, prefill, merchant-agent) omit callbacks.
 *
 * Fallback rules:
 *  - Any error (including 4xx)             → try next provider in the chain
 *  - Provider streams text then fails      → propagate (cannot splice another model's output)
 *  - All providers exhausted               → throw an aggregated error (status/code chosen
 *                                            order-independently, see pickRepresentativeError)
 *
 * A circuit breaker (provider-breaker.ts) demotes a provider that hits repeated connection-type
 * failures to the back of the chain for a cooldown, so a flapping endpoint stops being tried first.
 * The agent's stall handoff (stall-guard.ts) passes `excludeProviders` to keep a stalled model out
 * of the rest of a run; `nextProvider` names the slot such a round would try first.
 *
 * The implementation lives in streaming/: types, error signals, failure policy, request params,
 * the stream collector, the provider slot, chain builders and the round loop. This module is the
 * public entry point and re-exports all of it.
 */

export { nextProvider } from './streaming/chains';
export { EmptyProviderResponseError } from './streaming/error-signals';
export {
  type AiErrorClassification,
  type AiErrorKind,
  type AttemptFailure,
  classifyAiError,
  classifyAttemptFailure,
  getBackoffDelay,
  getRateLimitCooldownMs,
  isRetryableError,
  pickRepresentativeError,
} from './streaming/failure-policy';
export {
  CLAUDE_THINKING_RESERVE_TOKENS,
  chatRequestParams,
  claudeRequestParams,
  resetStreamingUsageCompatibility,
} from './streaming/request-params';
export { aiStreamRound } from './streaming/round';
export { normalizeUsage, type StreamTiming, type TokenUsage } from './streaming/token-usage';
export type {
  AiPurpose,
  ChainName,
  StreamCallbacks,
  StreamRoundOptions,
  StreamRoundResult,
  StreamToolCall,
} from './streaming/types';

/** Strip `<think>…</think>` blocks emitted by reasoning models (DeepSeek-R1, Qwen3). */
export function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
