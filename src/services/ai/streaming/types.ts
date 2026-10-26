/**
 * Public shapes of an AI streaming round and the provider slot contract. Split from streaming.ts
 * so the slot, chain and round modules can share them without importing the orchestrator.
 */

import type OpenAI from 'openai';
import type { Role } from '../model-presets';
import type { StreamTiming, TokenUsage } from './token-usage';

export type ChainName = 'smart' | 'fast' | 'ocr';

/** What a round is for — stored with every usage event so spend and failures can be told apart by feature. */
export type AiPurpose =
  | 'agent'
  | 'agent_final'
  | 'agent_batch'
  | 'advice'
  | 'validator'
  | 'advice_validator'
  | 'prefill'
  | 'merchant'
  | 'receipt_parse'
  | 'receipt_summary'
  | 'ocr'
  | 'dev_agent'
  | 'code_review'
  | 'replay'
  | 'probe';

export interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamRoundResult {
  text: string;
  toolCalls: StreamToolCall[];
  finishReason: string;
  /** Full assistant message for appending to conversation history */
  assistantMessage: OpenAI.ChatCompletionMessageParam;
  /** Which provider slot actually produced the result (e.g. "z.ai (glm-5.3)") */
  providerUsed: string;
}

export interface StreamRoundOptions {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  /**
   * 'none': the model sees `tools` but must answer in text. For a round whose history holds tool
   * calls but must not make new ones. Sent only together with `tools`.
   */
  toolChoice?: 'none';
  maxTokens: number;
  temperature?: number;
  /** Which chain to run. Default: 'smart'. */
  chain?: ChainName;
  /**
   * Routing role of the round (stage B3). Takes effect only on the smart chain while
   * AI_ROUTING=roles; the caller decides which users it applies to (rolesRoutingAppliesTo).
   */
  role?: Role | undefined;
  /** What this round is for; recorded with the usage events of every provider attempt. */
  purpose: AiPurpose;
  /** Overall caller deadline. When aborted, the fallback chain stops immediately. */
  signal?: AbortSignal;
  /**
   * Slot names (`StreamRoundResult.providerUsed`) this round must not use: a model the agent
   * handed the run away from stays out for the rest of that run.
   */
  excludeProviders?: readonly string[];
  /** Per-provider timeout override (defaults to PER_PROVIDER_TIMEOUT_MS). For tests. */
  perProviderTimeoutMs?: number;
}

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolCallStart?: (name: string) => void;
}

/** What a slot hands back: the caller-facing result plus the tokens the provider reported and the stream timing. */
export interface SlotOutput {
  result: StreamRoundResult;
  usage: TokenUsage;
  timing: StreamTiming;
}

export interface ProviderSlot {
  /** Human-readable, per-model label for logs/errors, e.g. "z.ai (glm-5.3)". */
  name: string;
  /** Stable endpoint id shared across chains/models ('zai'/'claude'/'hf'/'openrouter') — the breaker key. */
  key: string;
  /** Model id the slot sends, e.g. "glm-5.3". */
  model: string;
  /** Registry preset the slot runs (role-routed slots only). */
  presetId?: string;
  /** Role whose chain this slot belongs to; unset on legacy-chain slots. */
  role?: Role;
  stream: (opts: StreamRoundOptions, cbs: StreamCallbacks) => Promise<SlotOutput>;
}
