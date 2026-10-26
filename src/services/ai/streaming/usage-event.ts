/**
 * Builds the ai_usage_events row of one provider attempt: the round-wide facts (chain, purpose,
 * request id, prompt size) plus what that attempt measured. Split from the round loop so the row
 * shape lives in one place for ok, failed and skipped attempts alike.
 */

import type {
  AiPromptSize,
  AiUsageEventInput,
} from '../../../database/repositories/ai-usage-events.repository';
import { computeCostMicroUsd } from '../model-presets';
import { UNKNOWN_TIMING, UNKNOWN_USAGE } from './token-usage';
import type { AiPurpose, ChainName, ProviderSlot } from './types';

export interface UsageRound {
  chain: ChainName;
  purpose: AiPurpose;
  /** Shared by every attempt of one aiStreamRound call, so a failed attempt links to its fallback. */
  requestId: string;
  /** Estimated request size, the same for every attempt of the round (messages and tools do not change per slot). */
  promptSize: AiPromptSize;
}

export type AttemptResult = Pick<
  AiUsageEventInput,
  | 'outcome'
  | 'errorClass'
  | 'httpStatus'
  | 'durationMs'
  | 'firstTokenMs'
  | 'generationMs'
  | 'promptTokens'
  | 'completionTokens'
  | 'reasoningTokens'
  | 'cachedTokens'
>;

/** A slot the round never requested (excluded by an agent handoff). */
export const SKIPPED_ATTEMPT: AttemptResult = {
  outcome: 'skipped',
  errorClass: null,
  httpStatus: null,
  durationMs: null,
  ...UNKNOWN_TIMING,
  ...UNKNOWN_USAGE,
};

export function usageEvent(
  round: UsageRound,
  slot: ProviderSlot,
  at: number,
  attempt: AttemptResult,
): AiUsageEventInput {
  return {
    at,
    provider: slot.key,
    model: slot.model,
    chain: round.chain,
    purpose: round.purpose,
    requestId: round.requestId,
    promptSize: attempt.outcome === 'skipped' ? null : round.promptSize,
    role: slot.role ?? null,
    preset: slot.presetId ?? null,
    costMicroUsd: computeCostMicroUsd(
      slot.key,
      slot.model,
      attempt.promptTokens,
      attempt.completionTokens,
    ),
    ...attempt,
  };
}
