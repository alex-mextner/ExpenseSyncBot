/**
 * Unified AI streaming round with automatic provider fallback.
 *
 * Three chains, selected via options.chain:
 *   SMART: Groq ${GROQ_MODEL} → z.ai ${AI_MODEL} → Claude ${CLAUDE_MODEL} → Gemini ${GEMINI_MODEL} → HF ${HF_MODEL}
 *   FAST:  Groq ${GROQ_FAST_MODEL} → z.ai ${AI_FAST_MODEL} → Claude ${CLAUDE_FAST_MODEL} → Gemini ${GEMINI_FAST_MODEL} → HF ${HF_FAST_MODEL}
 *   OCR:   Gemini ${GEMINI_VISION_MODEL} → HF ${HF_VISION_MODEL}     (vision-only)
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
 */

import OpenAI from 'openai';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger';
import { claudeClient, geminiClient, groqClient, hfClient, zaiClient } from './clients';
import {
  orderByHealth,
  recordProviderConnectionFailure,
  recordProviderRateLimit,
  recordProviderReachable,
  recordProviderResponded,
} from './provider-breaker';

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
  maxTokens: number;
  temperature?: number;
  /** Which chain to run. Default: 'smart'. */
  chain?: ChainName;
  /** Overall caller deadline. When aborted, the fallback chain stops immediately. */
  signal?: AbortSignal;
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

// ── Provider slots ──────────────────────────────────────────────────────────

interface ProviderSlot {
  /** Human-readable, per-model label for logs/errors, e.g. "z.ai (glm-5.1)". */
  name: string;
  /** Stable endpoint id shared across chains/models ('zai'/'gemini'/'hf') — the breaker key. */
  key: string;
  stream: (opts: StreamRoundOptions, cbs: StreamCallbacks) => Promise<StreamRoundResult>;
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
 * against the same max_tokens as the visible answer: at medium effort Sonnet 5.5 spent ~150 tokens
 * thinking on a 10-item prefill prompt and truncated the answer in 3/6 calls at max_tokens=200.
 * max_tokens is only a cap — unused reserve costs nothing.
 */
export const CLAUDE_THINKING_RESERVE_TOKENS = 8192;

/** Anthropic-only request fields accepted by its OpenAI-compat endpoint; the SDK forwards them as-is. */
interface ClaudeParams {
  max_tokens: number;
  reasoning_effort?: 'medium';
  thinking?: { type: 'disabled' };
}

/**
 * Thinking settings for a Claude model (measured against the live API, 2026-10). Sonnet/Opus/Fable
 * think at medium effort with CLAUDE_THINKING_RESERVE_TOKENS on top, so the caller's whole budget
 * stays available for the visible answer. Haiku runs with thinking disabled: even at medium effort
 * it spent the entire small budget (validators 256, prefill 200) and streamed zero text. The
 * OpenAI-compat endpoint rejects explicit adaptive thinking and handles tool rounds without
 * thinking blocks in the history.
 */
export function claudeRequestParams(model: string, maxTokens: number): ClaudeParams {
  if (model.startsWith('claude-haiku')) {
    return { thinking: { type: 'disabled' }, max_tokens: maxTokens };
  }
  return { reasoning_effort: 'medium', max_tokens: maxTokens + CLAUDE_THINKING_RESERVE_TOKENS };
}

/**
 * Standard OpenAI streaming adapter. Works for any OpenAI-compat provider
 * (z.ai, Groq, Claude, Gemini, HF) via the shared OpenAI SDK.
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
    stream: async (opts, cbs) => {
      const params: OpenAI.ChatCompletionCreateParamsStreaming & Omit<ClaudeParams, 'max_tokens'> =
        {
          model,
          messages: opts.messages,
          stream: true,
          ...(slotOptions.anthropic
            ? claudeRequestParams(model, opts.maxTokens)
            : { max_tokens: opts.maxTokens, temperature: opts.temperature ?? DEFAULT_TEMPERATURE }),
        };
      if (opts.tools && opts.tools.length > 0) {
        params.tools = opts.tools;
      }

      const stream = await getClient().chat.completions.create(
        params,
        opts.signal ? { signal: opts.signal } : undefined,
      );

      let text = '';
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      let lastToolCallKey = -1;
      let finishReason = 'stop';

      try {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            text += delta.content;
            cbs.onTextDelta?.(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              // Resolve index: some providers (HF Router, early Gemini) omit tc.index.
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
        throw streamError;
      }

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
        throw new Error(
          `Provider ${name} returned empty response (no text, no tool calls) — treating as failure`,
        );
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
        text,
        toolCalls: toolCallsArray,
        finishReason,
        assistantMessage,
        providerUsed: name,
      };
    },
  };
}

// ── Chain builders ──────────────────────────────────────────────────────────
// Lazy — read env on each build so tests can mock env per-test.

function buildSmartChain(): ProviderSlot[] {
  const chain: ProviderSlot[] = [];
  if (env.GROQ_API_KEY) {
    chain.push(streamingSlot(`Groq (${env.GROQ_MODEL})`, 'groq', groqClient, env.GROQ_MODEL));
  }
  chain.push(streamingSlot(`z.ai (${env.AI_MODEL})`, 'zai', zaiClient, env.AI_MODEL));
  if (env.CLAUDE_API_TOKEN) {
    chain.push(
      streamingSlot(`Claude (${env.CLAUDE_MODEL})`, 'claude', claudeClient, env.CLAUDE_MODEL, {
        anthropic: true,
      }),
    );
  }
  chain.push(
    streamingSlot(`Gemini (${env.GEMINI_MODEL})`, 'gemini', geminiClient, env.GEMINI_MODEL),
    streamingSlot(`HF (${env.HF_MODEL})`, 'hf', hfClient, env.HF_MODEL),
  );
  return chain;
}

function buildFastChain(): ProviderSlot[] {
  const chain: ProviderSlot[] = [];
  if (env.GROQ_API_KEY) {
    chain.push(
      streamingSlot(`Groq (${env.GROQ_FAST_MODEL})`, 'groq', groqClient, env.GROQ_FAST_MODEL),
    );
  }
  chain.push(streamingSlot(`z.ai (${env.AI_FAST_MODEL})`, 'zai', zaiClient, env.AI_FAST_MODEL));
  if (env.CLAUDE_API_TOKEN) {
    chain.push(
      streamingSlot(
        `Claude (${env.CLAUDE_FAST_MODEL})`,
        'claude',
        claudeClient,
        env.CLAUDE_FAST_MODEL,
        { anthropic: true },
      ),
    );
  }
  chain.push(
    streamingSlot(
      `Gemini (${env.GEMINI_FAST_MODEL})`,
      'gemini',
      geminiClient,
      env.GEMINI_FAST_MODEL,
    ),
    streamingSlot(`HF (${env.HF_FAST_MODEL})`, 'hf', hfClient, env.HF_FAST_MODEL),
  );
  return chain;
}

function buildOcrChain(): ProviderSlot[] {
  return [
    streamingSlot(
      `Gemini (${env.GEMINI_VISION_MODEL})`,
      'gemini',
      geminiClient,
      env.GEMINI_VISION_MODEL,
    ),
    streamingSlot(`HF (${env.HF_VISION_MODEL})`, 'hf', hfClient, env.HF_VISION_MODEL),
  ];
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
  const chain = orderByHealth(buildChain(chainName), now);
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

    try {
      logger.info(`[AI_STREAM] Trying ${chainName} → ${slot.name}`);
      const result = await slot.stream({ ...options, signal: combinedSignal }, wrappedCallbacks);
      recordProviderReachable(slot.key); // a clean round rehabilitates a previously-demoted slot
      return result;
    } catch (error) {
      // A fresh read at FAILURE time — the round-start `now` (used only for orderByHealth) can
      // predate a cooldown that expires mid-round, which would wrongly skip clearing an expired
      // half-open demotion or extend a cooldown from a stale anchor.
      const failedAt = Date.now();
      lastError = error instanceof Error ? error : new Error(String(error));
      providerErrors.push({ name: slot.name, error: lastError });
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
        if (numericStatus(lastError) === 429) {
          recordProviderResponded(slot.key, failedAt);
          recordProviderRateLimit(slot.key, failedAt, getRateLimitCooldownMs(lastError, failedAt));
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
