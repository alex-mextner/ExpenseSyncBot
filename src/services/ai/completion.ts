/** Shared AI completion with automatic provider fallback — all providers via OpenAI SDK */
import OpenAI from 'openai';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger';

const logger = createLogger('ai-completion');

// ── Types ───────────────────────────────────────────────────────────────────

type TextPart = { type: 'text'; text: string };
type ImagePart = { type: 'image_url'; image_url: { url: string } };
type ContentPart = TextPart | ImagePart;

type TextMessage = { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] };
type ToolResultMessage = { role: 'tool'; tool_call_id: string; content: string };
type AssistantToolMessage = {
  role: 'assistant';
  content: string | null;
  tool_calls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
};

export type ChatMessage = TextMessage | ToolResultMessage | AssistantToolMessage;

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;
}

export interface CompletionResult {
  /** Raw response text (not stripped of thinking tags — caller decides) */
  text: string;
  finishReason: string | null;
  usage: unknown;
  /** Which model produced the result (e.g. "GLM (glm-5.1)" or "DeepSeek-R1") */
  model: string;
  /** Tool calls returned by the model (undefined if no tools requested or no calls made) */
  toolCalls?: ToolCallResult[] | undefined;
}

export interface CompletionOptions {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** Use vision model chain (Qwen-VL via HF) instead of text chain (GLM → DeepSeek-R1) */
  vision?: boolean;
  /** Request timeout in ms (default: 60 000) */
  timeoutMs?: number;
  /** Max retries per model before falling through to the next one (default: 3) */
  maxRetries?: number;
  /** OpenAI-format tool definitions for function calling */
  tools?: OpenAI.ChatCompletionTool[];
  /** Abort signal — propagated to the underlying HTTP request */
  signal?: AbortSignal;
}

// ── Constants ───────────────────────────────────────────────────────────────

const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';
const HF_BASE_URL = 'https://router.huggingface.co/v1';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TEMPERATURE = 0.3;

// ── Clients (all OpenAI SDK, different base URLs) ───────────────────────────

function makeFetchDelegate(): (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> {
  return async (url, init) => globalThis.fetch(url, init);
}

// OpenAI SDK throws on empty apiKey at construction — pass a placeholder
// for missing keys so module load doesn't fail in tests / partial setups.
// Actual API calls will fail with 401 if the placeholder is hit at runtime.
const PLACEHOLDER_KEY = 'missing';

const zaiClient = new OpenAI({
  apiKey: env.ANTHROPIC_API_KEY || PLACEHOLDER_KEY,
  baseURL: ZAI_BASE_URL,
  timeout: DEFAULT_TIMEOUT_MS,
  maxRetries: 0,
  fetch: makeFetchDelegate(),
});

const hfClient = new OpenAI({
  apiKey: env.HF_TOKEN || PLACEHOLDER_KEY,
  baseURL: HF_BASE_URL,
  timeout: DEFAULT_TIMEOUT_MS,
  maxRetries: 0,
  fetch: makeFetchDelegate(),
});

const geminiClient = new OpenAI({
  apiKey: env.GEMINI_API_KEY || PLACEHOLDER_KEY,
  baseURL: GEMINI_BASE_URL,
  timeout: DEFAULT_TIMEOUT_MS,
  maxRetries: 0,
  fetch: makeFetchDelegate(),
});

// ── Internal helpers ────────────────────────────────────────────────────────

interface RawResponse {
  text: string | null;
  finishReason: string | null;
  usage: unknown;
  toolCalls?: ToolCallResult[] | undefined;
}

interface ModelSlot {
  name: string;
  call: (
    msgs: ChatMessage[],
    maxTokens: number,
    temp: number,
    timeoutMs: number,
    tools?: OpenAI.ChatCompletionTool[],
    signal?: AbortSignal,
  ) => Promise<RawResponse>;
}

/** Server errors and timeouts mean the provider is down — retrying won't help */
function isProviderDown(error: unknown): boolean {
  if (error instanceof OpenAI.APIError && error.status !== undefined && error.status >= 500) {
    return true;
  }
  return error instanceof Error && error.message.includes('timed out');
}

function logError(error: unknown): void {
  if (error instanceof OpenAI.APIError) {
    logger.error(`[AI] API error: ${error.status} ${error.message}`);
  }
}

// ── OpenAI SDK adapter (works for any OpenAI-compatible provider) ───────────

function callProvider(client: OpenAI, model: string): ModelSlot['call'] {
  return async (msgs, maxTokens, temp, _timeoutMs, tools, signal) => {
    const response = await client.chat.completions.create(
      {
        model,
        messages: msgs as OpenAI.ChatCompletionMessageParam[],
        max_tokens: maxTokens,
        temperature: temp,
        ...(tools && tools.length > 0 ? { tools } : {}),
      },
      signal ? { signal } : undefined,
    );
    const choice = response.choices[0];
    const toolCalls = choice?.message?.tool_calls
      ?.filter(
        (tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: 'function' } =>
          tc.type === 'function',
      )
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
    return {
      text: choice?.message?.content?.trim() ?? null,
      finishReason: choice?.finish_reason ?? null,
      usage: response.usage,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    };
  };
}

// ── Model chains ────────────────────────────────────────────────────────────

const TEXT_CHAIN: ModelSlot[] = [
  { name: `GLM (${env.AI_MODEL})`, call: callProvider(zaiClient, env.AI_MODEL) },
  { name: 'DeepSeek-R1', call: callProvider(hfClient, 'deepseek-ai/DeepSeek-R1-0528') },
];

// Vision: Gemini Flash (cheap, fast) → Qwen-VL via HF (free fallback)
const VISION_CHAIN: ModelSlot[] = [
  { name: 'Gemini-Flash', call: callProvider(geminiClient, 'gemini-2.5-flash') },
  { name: 'Qwen-VL', call: callProvider(hfClient, 'Qwen/Qwen2.5-VL-72B-Instruct') },
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run a chat completion with automatic provider fallback.
 *
 * Text chain:   GLM via z.ai → DeepSeek-R1 via HuggingFace
 * Vision chain: Qwen-VL via HuggingFace
 *
 * On 5xx / timeout the current model is abandoned immediately
 * (no wasted retries against a dead provider).
 */
export async function aiComplete(options: CompletionOptions): Promise<CompletionResult> {
  const {
    messages,
    maxTokens,
    temperature = DEFAULT_TEMPERATURE,
    vision = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options;

  const chain = vision ? VISION_CHAIN : TEXT_CHAIN;
  let lastError: Error | null = null;

  for (const slot of chain) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`[AI] ${slot.name} attempt ${attempt}/${maxRetries}`);

        const raw = await slot.call(
          messages,
          maxTokens,
          temperature,
          timeoutMs,
          options.tools,
          options.signal,
        );

        // For tool-calling requests, allow empty text (model may only return tool_calls)
        if (!raw.text && !raw.toolCalls) {
          throw new Error('Empty response from AI');
        }

        logger.info(
          `[AI] ${slot.name} → ${raw.text?.length ?? 0} chars, finish=${raw.finishReason}, tools=${raw.toolCalls?.length ?? 0}`,
        );

        return {
          text: raw.text ?? '',
          finishReason: raw.finishReason,
          usage: raw.usage,
          model: slot.name,
          toolCalls: raw.toolCalls,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(`[AI] ${slot.name} attempt ${attempt}/${maxRetries}: ${lastError.message}`);
        logError(error);

        if (isProviderDown(error)) {
          logger.warn(`[AI] ${slot.name} is down, skipping to next model`);
          break;
        }

        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
  }

  throw new Error(`All AI models failed: ${lastError?.message}`);
}

/** Strip `<think>…</think>` blocks emitted by reasoning models (DeepSeek-R1) */
export function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*<\/think>/gi, '').trim();
}
