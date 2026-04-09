/** Streaming AI completion with tool calling and provider fallback */
import { InferenceClient } from '@huggingface/inference';
import OpenAI from 'openai';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger';

const logger = createLogger('ai-streaming');

// ── Constants ───────────────────────────────────────────────────────────────

const ZAI_OPENAI_BASE_URL = 'https://api.z.ai/api/paas/v4';
const DEFAULT_TIMEOUT_MS = 60_000;

// ── Clients ─────────────────────────────────────────────────────────────────

const openaiClient = new OpenAI({
  apiKey: env.ANTHROPIC_API_KEY,
  baseURL: ZAI_OPENAI_BASE_URL,
  timeout: DEFAULT_TIMEOUT_MS,
  maxRetries: 0,
  fetch: async (url: string | URL | Request, init?: RequestInit) => globalThis.fetch(url, init),
});

const hfClient = new InferenceClient(env.HF_TOKEN);

// ── Types ───────────────────────────────────────────────────────────────────

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
}

export interface StreamRoundOptions {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

// ── Callbacks ───────────────────────────────────────────────────────────────

export interface StreamCallbacks {
  onTextDelta?: (text: string) => void;
  onToolCallStart?: (name: string) => void;
}

// ── Provider adapters ───────────────────────────────────────────────────────

interface ProviderSlot {
  name: string;
  stream: (opts: StreamRoundOptions, callbacks: StreamCallbacks) => Promise<StreamRoundResult>;
}

/** Check if error indicates the provider is down (5xx, timeout, network) */
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

/** Transient errors that may resolve on retry */
export function isRetryableError(error: unknown): boolean {
  if (isProviderDown(error)) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (error instanceof OpenAI.APIError) {
    return error.status === 429 || error.status >= 500;
  }
  return false;
}

/** Exponential backoff: 2s → 6s. For 429, uses retry-after header when available. */
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

// ── OpenAI streaming adapter ────────────────────────────────────────────────

function openaiSlot(model: string): ProviderSlot {
  return {
    name: `GLM (${model})`,
    stream: async (opts, callbacks) => {
      const params: OpenAI.ChatCompletionCreateParamsStreaming = {
        model,
        messages: opts.messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.3,
        stream: true,
      };
      if (opts.tools && opts.tools.length > 0) {
        params.tools = opts.tools;
      }
      const stream = await openaiClient.chat.completions.create(params, { signal: opts.signal });

      let text = '';
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      let finishReason = 'stop';

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Text delta
        if (delta.content) {
          text += delta.content;
          callbacks.onTextDelta?.(delta.content);
        }

        // Tool call deltas (arguments arrive incrementally)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (existing) {
              existing.args += tc.function?.arguments ?? '';
            } else {
              const name = tc.function?.name ?? '';
              if (name) {
                callbacks.onToolCallStart?.(name);
              }
              toolCalls.set(tc.index, {
                id: tc.id ?? '',
                name,
                args: tc.function?.arguments ?? '',
              });
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

      // Build the assistant message for history
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

      return { text, toolCalls: toolCallsArray, finishReason, assistantMessage };
    },
  };
}

// ── HuggingFace streaming adapter (non-streaming fallback) ──────────────────

type HFProvider = NonNullable<Parameters<typeof hfClient.chatCompletion>[0]['provider']>;

function hfSlot(model: string, provider?: HFProvider): ProviderSlot {
  return {
    name: model.includes('DeepSeek') ? 'DeepSeek-R1' : model,
    stream: async (opts, callbacks) => {
      // HF InferenceClient doesn't support streaming with tool calling reliably,
      // so we use non-streaming chatCompletion and emit the full text at once.
      type HFParams = Parameters<typeof hfClient.chatCompletion>[0];
      const base = {
        model,
        messages: opts.messages as HFParams['messages'],
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.3,
      };
      const params: HFParams = provider ? { ...base, provider } : base;
      // HF doesn't support OpenAI-format tools natively — omit for now
      // Tool calling through HF fallback works text-only (no structured tool calls)

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      try {
        const response = await hfClient.chatCompletion(params);
        const choice = response.choices[0];
        const text = choice?.message?.content?.trim() ?? '';

        if (text) {
          callbacks.onTextDelta?.(text);
        }

        return {
          text,
          toolCalls: [],
          finishReason: choice?.finish_reason ?? 'stop',
          assistantMessage: { role: 'assistant', content: text || null },
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

// ── Model chain ─────────────────────────────────────────────────────────────

const STREAMING_CHAIN: ProviderSlot[] = [
  openaiSlot(env.AI_MODEL),
  hfSlot('deepseek-ai/DeepSeek-R1-0528', 'novita'),
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Execute one streaming round with automatic provider fallback.
 *
 * Tries GLM via z.ai first (with full streaming + tool calling).
 * If the provider is down (5xx/timeout), falls through to DeepSeek-R1 via HF
 * (non-streaming, no tool calling — text-only fallback).
 *
 * Fallback happens ONLY on provider-down errors before any text is sent.
 * Once streaming starts successfully, errors propagate to the caller.
 */
export async function aiStreamRound(
  options: StreamRoundOptions,
  callbacks: StreamCallbacks = {},
): Promise<StreamRoundResult> {
  let lastError: Error | null = null;

  for (const slot of STREAMING_CHAIN) {
    try {
      logger.info(`[AI_STREAM] Trying ${slot.name}`);
      return await slot.stream(options, callbacks);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.error(`[AI_STREAM] ${slot.name} failed: ${lastError.message}`);

      if (isProviderDown(error)) {
        logger.warn(`[AI_STREAM] ${slot.name} is down, trying next provider`);
        continue;
      }

      // Non-provider errors (AbortError, client errors) — propagate immediately
      throw error;
    }
  }

  throw lastError ?? new Error('All streaming providers failed');
}

/** Format an API error into a user-facing message */
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
