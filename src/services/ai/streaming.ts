/**
 * Unified AI streaming round with automatic provider fallback.
 *
 * Three chains, selected via options.chain:
 *   SMART: z.ai ${AI_MODEL}      → Gemini ${GEMINI_MODEL}      → HF ${HF_MODEL}
 *   FAST:  z.ai ${AI_FAST_MODEL} → Gemini ${GEMINI_FAST_MODEL} → HF ${HF_FAST_MODEL}
 *   OCR:   Gemini ${GEMINI_VISION_MODEL} → HF ${HF_VISION_MODEL}     (vision-only)
 *
 * Callers that need live updates pass `onTextDelta` / `onToolCallStart` callbacks.
 * Callers that just want the final text (validator, prefill, merchant-agent) omit callbacks.
 *
 * Fallback rules:
 *  - Any error (including 4xx)             → try next provider in the chain
 *  - Provider streams text then fails      → propagate (cannot splice another model's output)
 *  - All providers exhausted               → propagate the last error
 */

import OpenAI from 'openai';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger';
import { geminiClient, hfClient, zaiClient } from './clients';

const logger = createLogger('ai-streaming');

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TEMPERATURE = 0.3;

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
  signal?: AbortSignal;
}

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolCallStart?: (name: string) => void;
}

// ── Error helpers (exported for tests) ──────────────────────────────────────

/** Provider-down: 5xx, timeout, network. Means "try next", retrying same provider is hopeless. */
function isProviderDown(error: unknown): boolean {
  if (error instanceof OpenAI.APIError && error.status !== undefined && error.status >= 500) {
    return true;
  }
  if (error instanceof Error) {
    if (error.message.includes('timed out')) return true;
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code &&
      ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND'].includes(code)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Retryable for same-provider retry (backoff): 429, 5xx, timeout, abort.
 * NOT used for cross-provider fallback — the chain always tries the next provider.
 */
export function isRetryableError(error: unknown): boolean {
  if (isProviderDown(error)) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  // OpenAI SDK v6: APIUserAbortError extends APIError with status=undefined —
  // catches abort errors that don't set .name to 'AbortError'.
  if (error instanceof OpenAI.APIError && error.status === undefined) return true;
  if (error instanceof OpenAI.APIError) {
    return error.status === 429 || (error.status ?? 0) >= 500;
  }
  return false;
}

/** Exponential backoff: 2s → 6s → 18s capped at 30s. 429 uses Retry-After if present. */
export function getBackoffDelay(attempt: number, error: unknown): number {
  if (error instanceof OpenAI.APIError && error.status === 429) {
    const retryAfter = error.headers?.['retry-after'];
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (!Number.isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
    }
    return 5000;
  }
  return Math.min(2000 * 3 ** attempt, 30_000);
}

// ── Provider slots ──────────────────────────────────────────────────────────

interface ProviderSlot {
  name: string;
  stream: (opts: StreamRoundOptions, cbs: StreamCallbacks) => Promise<StreamRoundResult>;
}

/**
 * Standard OpenAI streaming adapter. Works for any OpenAI-compat provider
 * (z.ai, Gemini, HF) via the shared OpenAI SDK.
 */
function streamingSlot(name: string, getClient: () => OpenAI, model: string): ProviderSlot {
  return {
    name,
    stream: async (opts, cbs) => {
      const params: OpenAI.ChatCompletionCreateParamsStreaming = {
        model,
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
        stream: true,
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
  return [
    streamingSlot(`z.ai (${env.AI_MODEL})`, zaiClient, env.AI_MODEL),
    streamingSlot(`Gemini (${env.GEMINI_MODEL})`, geminiClient, env.GEMINI_MODEL),
    streamingSlot(`HF (${env.HF_MODEL})`, hfClient, env.HF_MODEL),
  ];
}

function buildFastChain(): ProviderSlot[] {
  return [
    streamingSlot(`z.ai (${env.AI_FAST_MODEL})`, zaiClient, env.AI_FAST_MODEL),
    streamingSlot(`Gemini (${env.GEMINI_FAST_MODEL})`, geminiClient, env.GEMINI_FAST_MODEL),
    streamingSlot(`HF (${env.HF_FAST_MODEL})`, hfClient, env.HF_FAST_MODEL),
  ];
}

function buildOcrChain(): ProviderSlot[] {
  return [
    streamingSlot(`Gemini (${env.GEMINI_VISION_MODEL})`, geminiClient, env.GEMINI_VISION_MODEL),
    streamingSlot(`HF (${env.HF_VISION_MODEL})`, hfClient, env.HF_VISION_MODEL),
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
  const chain = buildChain(chainName);
  let lastError: Error | null = null;
  let textEmitted = false;

  // Wrap callbacks to track whether text was actually sent to the user —
  // if so, we cannot splice another model's output in a fallback.
  const wrappedCallbacks: StreamCallbacks = {
    onTextDelta: (text) => {
      textEmitted = true;
      callbacks.onTextDelta?.(text);
    },
  };
  if (callbacks.onToolCallStart) {
    wrappedCallbacks.onToolCallStart = callbacks.onToolCallStart;
  }

  for (const slot of chain) {
    try {
      logger.info(`[AI_STREAM] Trying ${chainName} → ${slot.name}`);
      return await slot.stream(options, wrappedCallbacks);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.error({ err: lastError }, `[AI_STREAM] ${slot.name} failed: ${lastError.message}`);

      // Text already sent to user — can't splice another model's output
      if (textEmitted) {
        logger.error(
          `[AI_STREAM] ${slot.name} died mid-stream after text was emitted — cannot fallback`,
        );
        throw error;
      }

      // Always try the next provider in the chain.
      // isRetryableError is for same-provider retry (backoff), not for fallback decisions.
      // Different providers have different quirks — one may fail where another succeeds.
      logger.warn(`[AI_STREAM] ${slot.name} failed, trying next provider`);
    }
  }

  throw lastError ?? new Error(`All providers in ${chainName} chain failed`);
}

// ── User-facing error formatting ────────────────────────────────────────────

/** Format an API error into a user-facing Telegram message. */
export function formatApiError(error: unknown): string {
  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) {
      logger.warn('[AI_STREAM] Rate limited (429)');
      return '\u23f3 Слишком много запросов к AI. Подождите минуту.';
    }
    if (error.status === 529) {
      logger.warn('[AI_STREAM] Overloaded (529)');
      return '\u26a1 AI сервер перегружен. Попробуйте позже.';
    }
    logger.error({ err: error }, `[AI_STREAM] API error: ${error.status}`);
  }
  return '\u274c Ошибка AI. Попробуйте позже.';
}

/** Strip `<think>…</think>` blocks emitted by reasoning models (DeepSeek-R1, Qwen3). */
export function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
