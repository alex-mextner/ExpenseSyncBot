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
 */

import OpenAI from 'openai';
import { type ChainOrder, env } from '../../config/env';
import type {
  AiUsageErrorClass,
  AiUsageEventInput,
} from '../../database/repositories/ai-usage-events.repository';
import { createLogger } from '../../utils/logger';
import { claudeClient, hfClient, openrouterClient, zaiClient } from './clients';
import {
  orderByHealth,
  recordProviderConnectionFailure,
  recordProviderRateLimit,
  recordProviderReachable,
  recordProviderResponded,
} from './provider-breaker';
import type { ProviderId } from './provider-ids';
import { recordAiUsage } from './usage-recorder';

const logger = createLogger('ai-streaming');

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TEMPERATURE = 0.3;

/**
 * Per-provider wall-clock budget. Each provider in the fallback chain gets its
 * own fresh timeout — a slow/hung provider aborts after this and the loop tries
 * the next one with a clean signal. NOT shared across providers, so one stuck
 * provider does not poison the fallback chain.
 */
const PER_PROVIDER_TIMEOUT_MS = 45_000;

// ── Types ───────────────────────────────────────────────────────────────────

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
  /** Which provider slot actually produced the result (e.g. "z.ai (glm-5.1)") */
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

// ── Error helpers (exported for tests) ──────────────────────────────────────

/**
 * Build an Error classified as an abort. A plain Error with name='AbortError'
 * (not a DOMException) so upstream `error.name === 'AbortError'` checks match
 * the existing convention and the timeout user message fires.
 */
function makeAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

// Internal tag: marks a thrown stream error as "the provider had already emitted output (text or a
// tool-call chunk) before failing" — i.e. it was reachable. A Symbol keeps it off any real error
// shape so it never collides with status/code/message.
const PROVIDER_RESPONDED: unique symbol = Symbol('providerResponded');
interface RespondedTag {
  [PROVIDER_RESPONDED]?: boolean;
}

function markProviderResponded(error: unknown, responded: boolean): void {
  if (responded && error && typeof error === 'object') {
    (error as RespondedTag)[PROVIDER_RESPONDED] = true;
  }
}

function providerResponded(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as RespondedTag)[PROVIDER_RESPONDED]);
}

// ── Token usage and attempt failure classes (stored in ai_usage_events) ─────

/** Token counts of one attempt. NULL = the provider did not report it; a reported 0 stays 0. */
export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
}

const UNKNOWN_USAGE: TokenUsage = {
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

function tagAttemptUsage(error: unknown, usage: TokenUsage): void {
  if (error && typeof error === 'object') (error as AttemptUsageTag)[ATTEMPT_USAGE] = usage;
}

function attemptUsage(error: unknown): TokenUsage {
  const tag =
    error && typeof error === 'object' ? (error as AttemptUsageTag)[ATTEMPT_USAGE] : undefined;
  return tag ?? UNKNOWN_USAGE;
}

/** A provider answered 200 but produced no text and no tool call (z.ai reasoning-only replies, a refusal). */
export class EmptyProviderResponseError extends Error {
  constructor(slotName: string) {
    super(
      `Provider ${slotName} returned empty response (no text, no tool calls) — treating as failure`,
    );
    this.name = 'EmptyProviderResponseError';
  }
}

/**
 * An out-of-credits / exhausted-quota answer, as opposed to a plain per-minute rate limit. z.ai
 * answers 429 "Weekly/Monthly Limit Exhausted. Your limit will reset at …" (live, 2026-10-23).
 */
const QUOTA_TEXT = /quota|credit|usage limit|limit exhausted|will reset/i;

export interface AttemptFailure {
  errorClass: AiUsageErrorClass;
  /** HTTP status when the provider answered with one. */
  httpStatus: number | null;
}

/**
 * Failure class of one provider attempt, from the SDK error's status, code and name. Only the
 * class and status are kept — never the provider's error body. `callerAborted` (the caller's
 * overall deadline) and `providerTimedOut` (this slot's own timer) take precedence over the error
 * shape: both surface as the same APIUserAbortError. A status-less connection failure is `server`
 * (provider unreachable), matching classifyAiError's provider_down.
 */
export function classifyAttemptFailure(
  error: unknown,
  signals: { callerAborted: boolean; providerTimedOut: boolean },
): AttemptFailure {
  const status = numericStatus(error);
  const failure = (errorClass: AiUsageErrorClass): AttemptFailure => ({
    errorClass,
    httpStatus: status ?? null,
  });

  if (signals.callerAborted) return failure('aborted');
  if (signals.providerTimedOut) return failure('timeout');
  if (error instanceof EmptyProviderResponseError) return failure('empty');

  if (status !== undefined) {
    if (status === 402) return failure('quota');
    if (status === 429 || status === 400) {
      if (QUOTA_TEXT.test(errorText(error))) return failure('quota');
      return failure(status === 429 ? 'rate_limit' : 'bad_request');
    }
    if (status === 401 || status === 403) return failure('auth');
    if (status === 408) return failure('timeout');
    if (status >= 500) return failure('server');
    if (status >= 400) return failure('bad_request');
    return failure('other');
  }

  if (
    error instanceof OpenAI.APIConnectionTimeoutError ||
    errorCode(error) === 'ETIMEDOUT' ||
    /timed out|timeout/i.test(errorText(error))
  ) {
    return failure('timeout');
  }
  if (isAbortLike(error)) return failure('aborted');
  if (isConnectionLike(error)) return failure('server');
  return failure('other');
}

/**
 * Provider-down: 5xx or a connection/network failure. Means "try next", retrying same provider is
 * hopeless. A DEFINED status is authoritative (only >= 500 is down) — a concrete 4xx is a client
 * error and stays non-retryable even if its message mentions "connection"/"timed out", matching
 * classifyAiError (which keeps a non-429 4xx generic). Only a STATUS-LESS error falls through to
 * isConnectionLike (code/message), so an `APIConnectionError` outage aggregate (no status, joined
 * "Connection error" message) is still recognised. (429 retryability is handled by isRetryableError.)
 */
function isProviderDown(error: unknown): boolean {
  const status = numericStatus(error);
  if (status !== undefined) return status >= 500;
  return isConnectionLike(error);
}

/**
 * Retryable for same-provider retry (backoff): 429, 5xx, timeout, abort.
 * NOT used for cross-provider fallback — the chain always tries the next provider.
 * Status is read structurally so the aggregate chain error (a plain `Error` with a copied transient
 * `status`) stays retryable — otherwise a chain that ends in 5xx/429 would silently lose its retry.
 */
export function isRetryableError(error: unknown): boolean {
  if (isProviderDown(error)) return true;
  if (numericStatus(error) === 429) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  // OpenAI SDK v6: APIUserAbortError extends APIError with status=undefined —
  // catches abort errors that don't set .name to 'AbortError'.
  if (error instanceof OpenAI.APIError && error.status === undefined) return true;
  return false;
}

function readErrorHeader(error: unknown, name: string): string | undefined {
  const headers = (error as { headers?: unknown } | null | undefined)?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const maybeGet = (headers as { get?: (key: string) => string | null }).get;
  if (typeof maybeGet === 'function') {
    return maybeGet.call(headers, name) ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

/** Exponential backoff: 2s → 6s → 18s capped at 30s. 429 uses Retry-After if present. */
export function getBackoffDelay(attempt: number, error: unknown): number {
  if (numericStatus(error) === 429) {
    const retryAfter = readErrorHeader(error, 'retry-after');
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter);
      if (!Number.isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
    }
    return 5000;
  }
  return Math.min(2000 * 3 ** attempt, 30_000);
}

/**
 * Cooldown used to move a rate-limited provider to the back of subsequent chains.
 * Prefer Retry-After. For quota messages that include an ISO reset timestamp, honor that reset.
 * Otherwise use five minutes so a quota-limited head provider does not penalize every request.
 */
export function getRateLimitCooldownMs(error: unknown, now = Date.now()): number {
  const retryAfter = readErrorHeader(error, 'retry-after');
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return Math.max(1_000, seconds * 1000);
  }

  const text = errorText(error);
  if (/reset|quota|limit/i.test(text)) {
    const iso = text.match(
      /20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/i,
    )?.[0];
    if (iso) {
      const resetAt = Date.parse(iso);
      if (Number.isFinite(resetAt) && resetAt > now) {
        return Math.max(1_000, resetAt - now + 1_000);
      }
    }
  }

  return 5 * 60_000;
}

/**
 * Cooldown for a provider that answered 402 (out of prepaid credits, e.g. the HF router). Credits
 * come back only on a manual top-up; a demoted slot is still tried at the back of the chain, and a
 * clean round there lifts the demotion, so a top-up is picked up without waiting this out.
 */
const CREDITS_EXHAUSTED_COOLDOWN_MS = 60 * 60_000;

// ── Provider slots ──────────────────────────────────────────────────────────

/** What a slot hands back: the caller-facing result plus the tokens the provider reported for it. */
interface SlotOutput {
  result: StreamRoundResult;
  usage: TokenUsage;
}

interface ProviderSlot {
  /** Human-readable, per-model label for logs/errors, e.g. "z.ai (glm-5.1)". */
  name: string;
  /** Stable endpoint id shared across chains/models ('zai'/'claude'/'hf'/'openrouter') — the breaker key. */
  key: string;
  /** Model id the slot sends, e.g. "glm-5.1". */
  model: string;
  stream: (opts: StreamRoundOptions, cbs: StreamCallbacks) => Promise<SlotOutput>;
}

interface SlotOptions {
  /**
   * Anthropic (Claude) request shape: never send `temperature` (Claude 5.x → 400 "temperature is
   * deprecated"); thinking and max_tokens come from claudeRequestParams(model, maxTokens).
   */
  anthropic?: boolean;
}

/**
 * Extra output tokens granted on top of the caller's budget when Claude thinks. Thinking is billed
 * against the same max_tokens as the visible answer: Sonnet 5.5 spent ~150 tokens thinking on a
 * 10-item prefill prompt and truncated the answer in 3/6 calls at max_tokens=200.
 * max_tokens is only a cap — unused reserve costs nothing. No clamp to the model's output ceiling is
 * needed: measured ceiling for claude-sonnet-5-5 is 128000 (2026-10-10), and the largest caller
 * budget is 8192, so 8192 + 8192 stays far below it (#144).
 */
export const CLAUDE_THINKING_RESERVE_TOKENS = 8192;

/** Anthropic-only request fields accepted by its OpenAI-compat endpoint; the SDK forwards them as-is. */
interface ClaudeParams {
  max_tokens: number;
  thinking?: { type: 'disabled' };
}

/**
 * Thinking settings for a Claude model (measured against the live API, 2026-10). Sonnet/Opus/Fable
 * (and any unlisted model) think at the model's own level — the OpenAI-compat endpoint ignores
 * `reasoning_effort`, `output_config.effort` and `thinking.budget_tokens`, so none is sent (#146) —
 * with CLAUDE_THINKING_RESERVE_TOKENS on top, so the caller's whole budget stays available for the
 * visible answer. Haiku serves the latency-sensitive fast chain (validators, prefill) and runs with
 * thinking disabled: with thinking on it spent the entire small budget (validators 256, prefill 200)
 * and streamed zero text. The endpoint rejects explicit adaptive thinking and handles tool rounds
 * without thinking blocks in the history.
 */
export function claudeRequestParams(model: string, maxTokens: number): ClaudeParams {
  if (model.startsWith('claude-haiku')) {
    return { thinking: { type: 'disabled' }, max_tokens: maxTokens };
  }
  return { max_tokens: maxTokens + CLAUDE_THINKING_RESERVE_TOKENS };
}

/** Budget/sampling fields for one chat request: Claude shape for Anthropic slots, otherwise max_tokens + temperature. */
export function chatRequestParams(
  model: string,
  maxTokens: number,
  temperature: number,
  anthropic: boolean,
): ClaudeParams | { max_tokens: number; temperature: number } {
  return anthropic ? claudeRequestParams(model, maxTokens) : { max_tokens: maxTokens, temperature };
}

/**
 * Endpoint+model pairs (`key:model`) that answered 400/422 to `stream_options`. They are asked
 * without it from then on; their usage rows carry NULL tokens. Per model, not per endpoint: HF
 * Router fronts different backends per model. Module state, like the provider breaker.
 */
const providersWithoutStreamingUsage = new Set<string>();

/** Forget which endpoints rejected `stream_options` (tests). */
export function resetStreamingUsageCompatibility(): void {
  providersWithoutStreamingUsage.clear();
}

/**
 * A 400/422 that names the streaming-usage option: the request itself is
 * fine without it, so it is retried instead of failing over — the last fallback (HF Router) is
 * one endpoint in front of many backends, and an unsupported option there must not cost the chain
 * its only remaining slot.
 */
function rejectsUsageStreamOption(error: unknown): boolean {
  const status = numericStatus(error);
  if (status !== 400 && status !== 422) return false;
  return /stream_options|include_usage/i.test(errorText(error));
}

/**
 * Standard OpenAI streaming adapter. Works for any OpenAI-compat provider
 * (z.ai, Claude, HF, OpenRouter) via the shared OpenAI SDK.
 */
function streamingSlot(
  name: string,
  key: string,
  getClient: () => OpenAI,
  model: string,
  slotOptions: SlotOptions = {},
): ProviderSlot {
  return {
    name,
    key,
    model,
    stream: async (opts, cbs) => {
      const params: OpenAI.ChatCompletionCreateParamsStreaming & Omit<ClaudeParams, 'max_tokens'> =
        {
          model,
          messages: opts.messages,
          stream: true,
          ...chatRequestParams(
            model,
            opts.maxTokens,
            opts.temperature ?? DEFAULT_TEMPERATURE,
            slotOptions.anthropic ?? false,
          ),
        };
      if (opts.tools && opts.tools.length > 0) {
        params.tools = opts.tools;
        if (opts.toolChoice) params.tool_choice = opts.toolChoice;
      }

      const client = getClient();
      const request = (withUsage: boolean) =>
        client.chat.completions.create(
          withUsage ? { ...params, stream_options: { include_usage: true } } : params,
          opts.signal ? { signal: opts.signal } : undefined,
        );
      // Ask for the final usage chunk; a provider that rejects the option is remembered and
      // retried at once without it (same attempt, one usage row — its tokens stay unknown).
      const openStream = async () => {
        const usageOptionKey = `${key}:${model}`;
        if (providersWithoutStreamingUsage.has(usageOptionKey)) return request(false);
        try {
          return await request(true);
        } catch (error) {
          if (!rejectsUsageStreamOption(error)) throw error;
          providersWithoutStreamingUsage.add(usageOptionKey);
          logger.warn(
            { provider: key, model },
            '[AI_STREAM] Provider rejected streaming usage — retrying without usage telemetry',
          );
          return request(false);
        }
      };
      const stream = await openStream();

      let text = '';
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      let lastToolCallKey = -1;
      let finishReason = 'stop';
      let usage: OpenAI.CompletionUsage | null = null;

      try {
        for await (const chunk of stream) {
          // The usage-only final chunk has no choices: capture it before the delta guard below.
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            text += delta.content;
            cbs.onTextDelta?.(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              // Resolve index: some providers (HF Router) omit tc.index.
              // Fallback: new tool call if id/name present, otherwise append to last.
              let key: number;
              if (typeof tc.index === 'number') {
                key = tc.index;
              } else if (tc.id || tc.function?.name) {
                key = toolCalls.size;
              } else if (lastToolCallKey >= 0) {
                key = lastToolCallKey;
              } else {
                continue;
              }

              const existing = toolCalls.get(key);
              if (existing) {
                existing.args += tc.function?.arguments ?? '';
                if (tc.id && !existing.id) existing.id = tc.id;
                if (tc.function?.name && !existing.name) existing.name = tc.function.name;
              } else {
                const tcName = tc.function?.name ?? '';
                if (tcName) cbs.onToolCallStart?.(tcName);
                toolCalls.set(key, {
                  id: tc.id ?? '',
                  name: tcName,
                  args: tc.function?.arguments ?? '',
                });
                lastToolCallKey = key;
              }
            }
          }

          if (chunk.choices[0]?.finish_reason) {
            finishReason = chunk.choices[0].finish_reason;
          }
        }
      } catch (streamError) {
        // Tag whether ANY output (text or a tool-call chunk — even before a tool name arrives) was
        // received before the drop. The chain uses this so the breaker doesn't treat a late drop
        // after a real response as "provider unreachable".
        markProviderResponded(streamError, text.length > 0 || toolCalls.size > 0);
        if (usage) tagAttemptUsage(streamError, normalizeUsage(usage));
        throw streamError;
      }
      const tokenUsage = normalizeUsage(usage);

      const toolCallsArray: StreamToolCall[] = [...toolCalls.values()].map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.args,
      }));

      // z.ai coding endpoint quirk: for pure text responses (no tools) it returns
      // content='' and populates reasoning_content instead. We can't read
      // reasoning_content via the OpenAI SDK, so we treat this as a failure and
      // fall through to the next provider. Tool-calling responses are unaffected.
      if (!text && toolCallsArray.length === 0) {
        const empty = new EmptyProviderResponseError(name);
        tagAttemptUsage(empty, tokenUsage);
        throw empty;
      }

      const assistantMessage: OpenAI.ChatCompletionMessageParam = {
        role: 'assistant',
        content: text || null,
        ...(toolCallsArray.length > 0
          ? {
              tool_calls: toolCallsArray.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };

      return {
        result: {
          text,
          toolCalls: toolCallsArray,
          finishReason,
          assistantMessage,
          providerUsed: name,
        },
        usage: tokenUsage,
      };
    },
  };
}

// ── Chain builders ──────────────────────────────────────────────────────────
// Lazy — read env on each build so tests can mock env per-test.

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
      const { model, apiKey } = available[provider];
      if (!model || !apiKey) {
        const marker = `${kind}:${provider}:${!!model}:${!!apiKey}`;
        if (!loggedSkips.has(marker)) {
          loggedSkips.add(marker);
          const detail = { chain: kind, provider, hasModel: !!model, hasKey: !!apiKey };
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
        continue;
      }
      slots.push(
        streamingSlot(
          `${TEXT_PROVIDER_LABELS[provider]} (${model})`,
          provider,
          TEXT_PROVIDER_CLIENTS[provider],
          model,
          provider === 'claude' ? { anthropic: true } : {},
        ),
      );
    }
    return slots;
  };

  const configured = slotsFor(chain.order, chain.fromEnv);
  if (configured.length > 0 || !chain.fromEnv) return configured;
  // Rebuilt on every round, so this is logged once per process, like the skips above.
  const marker = `${kind}:nothing-configured`;
  if (!loggedSkips.has(marker)) {
    loggedSkips.add(marker);
    logger.error(
      { chain: kind, order: chain.order },
      '[AI_STREAM] Configured provider order named nothing that is configured — using the default order',
    );
  }
  return slotsFor(chain.fallback, false);
}

function buildSmartChain(): ProviderSlot[] {
  return buildTextChain('smart', env.AI_SMART_CHAIN, {
    zai: { model: env.AI_MODEL, apiKey: env.ANTHROPIC_API_KEY },
    claude: { model: env.CLAUDE_MODEL, apiKey: env.CLAUDE_API_TOKEN },
    hf: { model: env.HF_MODEL, apiKey: env.HF_TOKEN },
    openrouter: { model: env.OPENROUTER_MODEL, apiKey: env.OPENROUTER_API_KEY },
  });
}

function buildFastChain(): ProviderSlot[] {
  return buildTextChain('fast', env.AI_FAST_CHAIN, {
    zai: { model: env.AI_FAST_MODEL, apiKey: env.ANTHROPIC_API_KEY },
    claude: { model: env.CLAUDE_FAST_MODEL, apiKey: env.CLAUDE_API_TOKEN },
    hf: { model: env.HF_FAST_MODEL, apiKey: env.HF_TOKEN },
    openrouter: { model: env.OPENROUTER_FAST_MODEL, apiKey: env.OPENROUTER_API_KEY },
  });
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

function buildChain(chain: ChainName): ProviderSlot[] {
  switch (chain) {
    case 'smart':
      return buildSmartChain();
    case 'fast':
      return buildFastChain();
    case 'ocr':
      return buildOcrChain();
  }
}

/** The chain's slots minus the excluded names, in breaker order (demoted slots last). */
function availableSlots(chain: ChainName, exclude: readonly string[], now: number): ProviderSlot[] {
  return orderByHealth(
    buildChain(chain).filter((slot) => !exclude.includes(slot.name)),
    now,
  );
}

/** The chain's slots named in `exclude` — a round skips them without requesting. */
function excludedSlots(chain: ChainName, exclude: readonly string[]): ProviderSlot[] {
  return buildChain(chain).filter((slot) => exclude.includes(slot.name));
}

/**
 * Name of the slot a round on `chain` would try first with `exclude` left out, or null when none
 * is left — the agent's handoff target.
 */
export function nextProvider(chain: ChainName, exclude: readonly string[]): string | null {
  return availableSlots(chain, exclude, Date.now())[0]?.name ?? null;
}

function numericStatus(error: unknown): number | undefined {
  // Optional chain: isProviderDown/isRetryableError call this on `unknown`, which may be a thrown
  // null/undefined/primitive — those must classify as not-retryable, never throw a TypeError.
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Pick the error whose status/code best represents an all-providers-failed chain. The aggregate
 * feeds BOTH the user-facing classifier (classifyAiError) and the retry decision (isRetryableError),
 * so a transient signal must win over a co-occurring 4xx — otherwise a chain where one provider 400s
 * and the rest 5xx would lose its retry. Priority:
 *   1. 429 (rate limit) / 529 (overloaded) — the most actionable, retryable signals.
 *   2. any other transient failure — a 5xx response or a connection error — → provider_down + retry.
 *   3. otherwise a 4xx response — the request itself is the problem (generic, not retryable).
 *   4. fallback (the last error) when nothing else matched.
 *
 * The resulting CATEGORY is independent of the order providers were tried (the breaker can reorder
 * the chain). The exact status WITHIN a tier follows try order — but every error in a tier maps to
 * the same classifyAiError/isRetryableError category, so the user-facing outcome is stable.
 */
export function pickRepresentativeError(errors: Error[], fallback: Error | null): Error | null {
  const rateLimited = errors.find((e) => numericStatus(e) === 429);
  if (rateLimited) return rateLimited;
  const overloaded = errors.find((e) => numericStatus(e) === 529);
  if (overloaded) return overloaded;

  const transient = errors.find((e) => {
    const status = numericStatus(e);
    return (status !== undefined && status >= 500) || (status === undefined && isConnectionLike(e));
  });
  if (transient) return transient;

  const clientError = errors.find((e) => numericStatus(e) !== undefined);
  return clientError ?? fallback;
}

/**
 * Breaker-specific: only a STATUS-less connection error is a true "provider unreachable" event.
 * A 4xx/5xx response — even one whose message happens to mention "connection" / "timed out" — means
 * the provider WAS reachable, so it must not demote it (isConnectionLike also matches by message and
 * would otherwise count such responses).
 */
function isUnreachableFailure(error: unknown): boolean {
  if (numericStatus(error) !== undefined) return false;
  return isConnectionLike(error);
}

// ── Public API ──────────────────────────────────────────────────────────────

interface UsageRound {
  chain: ChainName;
  purpose: AiPurpose;
  /** Shared by every attempt of one aiStreamRound call, so a failed attempt links to its fallback. */
  requestId: string;
}

type AttemptResult = Pick<
  AiUsageEventInput,
  | 'outcome'
  | 'errorClass'
  | 'httpStatus'
  | 'durationMs'
  | 'promptTokens'
  | 'completionTokens'
  | 'reasoningTokens'
  | 'cachedTokens'
>;

/** A slot the round never requested (excluded by an agent handoff). */
const SKIPPED_ATTEMPT: AttemptResult = {
  outcome: 'skipped',
  errorClass: null,
  httpStatus: null,
  durationMs: null,
  ...UNKNOWN_USAGE,
};

function usageEvent(
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
    ...attempt,
  };
}

/**
 * Execute one AI round with automatic provider fallback.
 *
 * With callbacks: streams text deltas and tool-call starts to the caller
 * (used by the agent for live Telegram updates).
 *
 * Without callbacks: collects the full result and returns it at the end
 * (used by validator, prefill, merchant-agent, OCR).
 */
export async function aiStreamRound(
  options: StreamRoundOptions,
  callbacks: StreamCallbacks = {},
): Promise<StreamRoundResult> {
  const chainName: ChainName = options.chain ?? 'smart';
  // Round-start snapshot used ONLY to order the chain: demoted providers (repeated connection
  // failures) drop to the back instead of being tried first; they're never removed. Breaker
  // mutations below read a fresh `Date.now()` at failure time so a cooldown that expires mid-round
  // is honored (the boundary check `demotedUntil <= now` must not use a stale anchor).
  const now = Date.now();
  const excludeProviders = options.excludeProviders ?? [];
  const chain = availableSlots(chainName, excludeProviders, now);
  const round: UsageRound = {
    chain: chainName,
    purpose: options.purpose,
    requestId: crypto.randomUUID(),
  };
  if (excludeProviders.length > 0) {
    recordAiUsage(
      excludedSlots(chainName, excludeProviders).map((slot) =>
        usageEvent(round, slot, now, SKIPPED_ATTEMPT),
      ),
    );
  }
  let lastError: Error | null = null;
  // Once text reaches the user we cannot splice another model's output on a fallback. (Whether the
  // provider was reachable before a failure is read separately, off the thrown error's tag.)
  let textEmitted = false;

  const wrappedCallbacks: StreamCallbacks = {
    onTextDelta: (text) => {
      textEmitted = true;
      callbacks.onTextDelta?.(text);
    },
  };
  if (callbacks.onToolCallStart) {
    wrappedCallbacks.onToolCallStart = callbacks.onToolCallStart;
  }

  const providerErrors: Array<{ name: string; error: Error }> = [];
  const perProviderTimeoutMs = options.perProviderTimeoutMs ?? PER_PROVIDER_TIMEOUT_MS;

  for (const slot of chain) {
    // Overall caller deadline already passed — trying more providers is pointless.
    if (options.signal?.aborted) {
      logger.warn('[AI_STREAM] Overall deadline exceeded, stopping fallback chain');
      throw makeAbortError('AI overall deadline exceeded');
    }

    // Each provider gets its own fresh timeout combined with the overall signal.
    // A slow provider aborts after perProviderTimeoutMs without poisoning the next one.
    const perProviderController = new AbortController();
    const perProviderTimeout = setTimeout(
      () => perProviderController.abort(),
      perProviderTimeoutMs,
    );
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, perProviderController.signal])
      : perProviderController.signal;

    const attemptStartedAt = Date.now();
    const attemptStartedPerf = performance.now();
    try {
      logger.info(`[AI_STREAM] Trying ${chainName} → ${slot.name}`);
      const { result, usage } = await slot.stream(
        { ...options, signal: combinedSignal },
        wrappedCallbacks,
      );
      recordProviderReachable(slot.key); // a clean round rehabilitates a previously-demoted slot
      recordAiUsage([
        usageEvent(round, slot, attemptStartedAt, {
          outcome: 'ok',
          errorClass: null,
          httpStatus: null,
          durationMs: Math.round(performance.now() - attemptStartedPerf),
          ...usage,
        }),
      ]);
      return result;
    } catch (error) {
      // A fresh read at FAILURE time — the round-start `now` (used only for orderByHealth) can
      // predate a cooldown that expires mid-round, which would wrongly skip clearing an expired
      // half-open demotion or extend a cooldown from a stale anchor.
      const failedAt = Date.now();
      lastError = error instanceof Error ? error : new Error(String(error));
      providerErrors.push({ name: slot.name, error: lastError });
      recordAiUsage([
        usageEvent(round, slot, attemptStartedAt, {
          outcome: 'error',
          ...classifyAttemptFailure(lastError, {
            callerAborted: options.signal?.aborted === true,
            providerTimedOut: perProviderController.signal.aborted,
          }),
          durationMs: Math.round(performance.now() - attemptStartedPerf),
          // The tag sits on the ORIGINAL thrown value, like the responded tag below.
          ...attemptUsage(error),
        }),
      ]);
      logger.error({ err: lastError }, `[AI_STREAM] ${slot.name} failed: ${lastError.message}`);

      // Text already sent to user — can't splice another model's output. The provider proved it was
      // reachable (it streamed text), so reset its connection-failure cluster before bailing out.
      if (textEmitted) {
        if (!isAbortLike(lastError)) recordProviderResponded(slot.key, failedAt);
        logger.error(
          `[AI_STREAM] ${slot.name} died mid-stream after text was emitted — cannot fallback`,
        );
        throw error;
      }

      // An abort (the agent's 60s timeout / caller cancellation) is not evidence about the provider
      // — it neither proves nor disproves reachability — so it must leave the breaker untouched.
      // Otherwise: a truly unreachable failure (no status, connection-like, AND no output this
      // attempt) demotes; anything else means the provider answered (a 4xx/5xx status, a plain
      // reachable error like the empty-response above, or a late drop AFTER it streamed text/
      // tool-calls), so it only resets the connection-failure counter (recordProviderResponded —
      // does NOT lift an active demotion; only a clean round does).
      // Read the responded tag off the ORIGINAL thrown value — it's set on `error`, while `lastError`
      // may be a fresh wrapper Error (for a non-Error throw) that never carried the tag.
      if (!isAbortLike(lastError)) {
        const status = numericStatus(lastError);
        if (status === 429 || status === 402) {
          // 402 = out of prepaid credits (HF router): back only after a manual top-up, so it
          // cools down far longer than a rate limit. It still sits at the back of the chain.
          const cooldownMs =
            status === 402
              ? CREDITS_EXHAUSTED_COOLDOWN_MS
              : getRateLimitCooldownMs(lastError, failedAt);
          recordProviderResponded(slot.key, failedAt);
          recordProviderRateLimit(slot.key, failedAt, cooldownMs);
        } else if (isUnreachableFailure(lastError) && !providerResponded(error)) {
          recordProviderConnectionFailure(slot.key, failedAt);
        } else {
          recordProviderResponded(slot.key, failedAt);
        }
      }

      // Overall deadline fired (not just this provider's timeout) — stop the chain
      // and signal a timeout so the caller surfaces the "time exceeded" message.
      if (options.signal?.aborted) {
        logger.warn('[AI_STREAM] Overall deadline exceeded mid-provider, stopping fallback chain');
        throw makeAbortError('AI overall deadline exceeded');
      }

      // Always try the next provider in the chain.
      // isRetryableError is for same-provider retry (backoff), not for fallback decisions.
      // Different providers have different quirks — one may fail where another succeeds.
      logger.warn(`[AI_STREAM] ${slot.name} failed, trying next provider`);
    } finally {
      clearTimeout(perProviderTimeout);
    }
  }

  // Aggregate all provider errors so the caller (and logs) see the full picture,
  // not just the last provider's error. The message lists each provider and its
  // failure reason — much more useful for debugging than "400 (no body)".
  const summary = providerErrors
    .map((e) => `${e.name}: ${e.error.message.slice(0, 120)}`)
    .join('; ');
  const aggregated = new Error(
    `All ${providerErrors.length} providers in ${chainName} chain failed: ${summary}`,
  );
  // Carry status/code for upstream classification (classifyAiError) and retry (isRetryableError),
  // both of which read error.status/code. The choice must NOT depend on which provider failed LAST
  // — the breaker can reorder the chain, so "last error" is unstable. pickRepresentativeError
  // prefers a transient signal (429/529/5xx/connection → retryable provider_down) over a co-occurring
  // 4xx, so a chain where one provider 400s and the rest are down still reads as "try later".
  const representative = pickRepresentativeError(
    providerErrors.map((e) => e.error),
    lastError,
  );
  if (representative) {
    Object.assign(aggregated, {
      status: (representative as { status?: number }).status,
      code: (representative as { code?: string }).code,
    });
  }
  throw aggregated;
}

/** Strip `<think>…</think>` blocks emitted by reasoning models (DeepSeek-R1, Qwen3). */
export function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ── Error classification (informative, user-safe) ────────────────────────────

/** User-facing Telegram messages per error class. Short, no internals, address user as "ты". */
const AI_ERROR_MESSAGES = {
  rateLimit: '⏳ Слишком много запросов к AI. Подожди минуту.',
  overloaded: '⚡ AI сервер перегружен. Попробуй позже.',
  timeout: '⏳ Время ожидания истекло. Попробуй ещё раз.',
  providerDown:
    '⚠️ AI временно недоступен (сбой на стороне провайдера). Уже разбираемся — попробуй через минуту.',
  generic: '❌ Ошибка AI. Попробуй позже.',
} as const;

/**
 * Error classes the agent surfaces to the user. `provider_down` covers connection/network
 * failures and 5xx from the providers (the whole chain is unreachable); `generic` is a
 * recognized-but-uncategorized API error; a null classification (see `classifyAiError`)
 * means "not an AI error" and the caller should rethrow.
 */
export type AiErrorKind = 'rate_limit' | 'overloaded' | 'timeout' | 'provider_down' | 'generic';

export interface AiErrorClassification {
  kind: AiErrorKind;
  /** Short, user-safe Telegram message (no stack, no IDs, no provider internals). */
  userMessage: string;
}

const NETWORK_ERROR_CODES = ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND'];

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const value = (error as { status?: unknown }).status;
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The agent's abort timer fired (or a user/SDK abort) — distinct from a provider being down. */
// INVARIANT (the provider breaker depends on this): this must distinguish APIUserAbortError (an
// abort → skip the breaker) from APIConnectionError (a real outage → must demote). Both are
// `APIError` with `status === undefined`, so the match is by name/message ("aborted"), NEVER by
// `status === undefined` — broadening it that way would silently stop demoting real connection
// outages, the main case the breaker exists for.
function isAbortLike(error: unknown): boolean {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'APIUserAbortError')
  ) {
    return true;
  }
  return /\baborted\b|was aborted|operation was aborted/i.test(errorText(error));
}

/** Connection/network failure to a provider (includes the z.ai "Connection error." case). */
function isConnectionLike(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true;
  const code = errorCode(error);
  if (code && NETWORK_ERROR_CODES.includes(code)) return true;
  return /connection error|connection refused|network error|fetch failed|socket hang up|timed out|econnreset|econnrefused|enotfound|enetunreach|etimedout/i.test(
    errorText(error),
  );
}

/**
 * The "All N providers in <chain> chain failed: …" aggregate thrown by aiStreamRound once every
 * provider in the chain has failed. That exact prefix is produced ONLY there, so matching it can't
 * swallow an unrelated non-AI error (a bug elsewhere never carries this message). Used as a final
 * floor in classifyAiError: an exhausted chain is, by construction, always an AI failure.
 */
function isExhaustedChainError(error: unknown): boolean {
  return /^All \d+ providers? in \w+ chain failed/.test(errorText(error));
}

/**
 * Classify an error from the AI pipeline into a user-facing message.
 *
 * Returns `null` when the error is not recognizably an AI/network/timeout failure, so the
 * caller can rethrow it instead of masking an unrelated bug behind a generic AI message.
 *
 * Order matters: rate-limit/overloaded are checked by status first; a concrete non-429 4xx
 * is authoritative next (a request/client error — don't let an aggregate's text about an
 * earlier provider's connection blip mask it as an outage); then the agent-level abort
 * (60s timeout) is detected before connection failures so a timed-out chain reads as
 * "timeout" rather than "provider down". Aggregated "All N providers failed" errors are
 * thus classified by their real status/code/message (e.g. all-400 stays generic, not masked
 * as an outage), since the aggregate carries the last provider's status/code and the joined
 * messages. As a final floor, an exhausted-chain aggregate with NO classifiable signal — every
 * provider returned an empty body (a plain Error: no status, no abort, no connection match) — is
 * still `generic` rather than `null`, so the user gets a safe message and the admin a report
 * instead of the in-progress message silently vanishing on a rethrow.
 */
export function classifyAiError(error: unknown): AiErrorClassification | null {
  const status = errorStatus(error);
  if (status === 429) return { kind: 'rate_limit', userMessage: AI_ERROR_MESSAGES.rateLimit };
  if (status === 529) return { kind: 'overloaded', userMessage: AI_ERROR_MESSAGES.overloaded };
  if (status !== undefined && status >= 400 && status < 500) {
    return { kind: 'generic', userMessage: AI_ERROR_MESSAGES.generic };
  }
  if (isAbortLike(error)) return { kind: 'timeout', userMessage: AI_ERROR_MESSAGES.timeout };
  if (isConnectionLike(error) || (status !== undefined && status >= 500)) {
    return { kind: 'provider_down', userMessage: AI_ERROR_MESSAGES.providerDown };
  }
  if (status !== undefined) return { kind: 'generic', userMessage: AI_ERROR_MESSAGES.generic };
  if (isExhaustedChainError(error)) {
    return { kind: 'generic', userMessage: AI_ERROR_MESSAGES.generic };
  }
  return null;
}
