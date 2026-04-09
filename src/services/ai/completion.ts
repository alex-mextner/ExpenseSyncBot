/** Shared AI completion with automatic provider fallback */
import { InferenceClient } from '@huggingface/inference';
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
  /** Use vision model chain (Qwen-VL → GLM) instead of text chain (GLM → DeepSeek-R1) */
  vision?: boolean;
  /** Request timeout in ms (default: 60 000) */
  timeoutMs?: number;
  /** Max retries per model before falling through to the next one (default: 3) */
  maxRetries?: number;
  /** OpenAI-format tool definitions for function calling */
  tools?: OpenAI.ChatCompletionTool[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const ZAI_OPENAI_BASE_URL = 'https://api.z.ai/api/paas/v4';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TEMPERATURE = 0.3;

// ── Clients (lazy-ish singletons, created once at module load) ──────────────

const openaiClient = new OpenAI({
  apiKey: env.ANTHROPIC_API_KEY,
  baseURL: ZAI_OPENAI_BASE_URL,
  timeout: DEFAULT_TIMEOUT_MS,
  maxRetries: 0,
  fetch: async (url: string | URL | Request, init?: RequestInit) => globalThis.fetch(url, init),
});

const hfClient = new InferenceClient(env.HF_TOKEN);

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
  ) => Promise<RawResponse>;
}

function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** Server errors and timeouts mean the provider is down — retrying won't help */
function isProviderDown(error: unknown): boolean {
  if (error instanceof OpenAI.APIError && error.status !== undefined && error.status >= 500) {
    return true;
  }
  const hfErr = error as { httpResponse?: { status?: number } };
  if (hfErr.httpResponse?.status !== undefined && hfErr.httpResponse.status >= 500) {
    return true;
  }
  return error instanceof Error && error.message.includes('timed out');
}

function logError(error: unknown): void {
  if (error instanceof OpenAI.APIError) {
    logger.error(`[AI] OpenAI API: ${error.status} ${error.message}`);
    return;
  }
  const err = error as {
    httpRequest?: { url?: string; method?: string };
    httpResponse?: { status?: number; statusText?: string };
  };
  if (err.httpResponse) {
    logger.error(`[AI] HTTP ${err.httpResponse.status} ${err.httpResponse.statusText || ''}`);
  }
  if (err.httpRequest) {
    logger.error(`[AI] → ${err.httpRequest.method} ${err.httpRequest.url}`);
  }
}

// ── OpenAI SDK adapter (z.ai GLM) ──────────────────────────────────────────

function callOpenAI(model: string): ModelSlot['call'] {
  return async (msgs, maxTokens, temp, _timeoutMs, tools) => {
    const response = await openaiClient.chat.completions.create({
      model,
      messages: msgs as OpenAI.ChatCompletionMessageParam[],
      max_tokens: maxTokens,
      temperature: temp,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });
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

// ── HuggingFace SDK adapter ─────────────────────────────────────────────────

type HFCompletionParams = Parameters<typeof hfClient.chatCompletion>[0];

function callHF(model: string, provider?: HFCompletionParams['provider']): ModelSlot['call'] {
  return async (msgs, maxTokens, temp, timeoutMs) => {
    const base = {
      model,
      messages: msgs as HFCompletionParams['messages'],
      max_tokens: maxTokens,
      temperature: temp,
    };
    const params: HFCompletionParams = provider ? { ...base, provider } : base;
    const response = await raceTimeout(hfClient.chatCompletion(params), timeoutMs, model);
    const choice = response.choices[0];
    return {
      text: choice?.message?.content?.trim() ?? null,
      finishReason: choice?.finish_reason ?? null,
      usage: response.usage,
    };
  };
}

// ── Model chains ────────────────────────────────────────────────────────────

const TEXT_CHAIN: ModelSlot[] = [
  { name: `GLM (${env.AI_MODEL})`, call: callOpenAI(env.AI_MODEL) },
  { name: 'DeepSeek-R1', call: callHF('deepseek-ai/DeepSeek-R1-0528', 'novita') },
];

const VISION_CHAIN: ModelSlot[] = [
  { name: 'Qwen-VL', call: callHF('Qwen/Qwen2.5-VL-72B-Instruct') },
  { name: `GLM (${env.AI_MODEL})`, call: callOpenAI(env.AI_MODEL) },
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run a chat completion with automatic provider fallback.
 *
 * Text chain:   GLM via z.ai → DeepSeek-R1 via HuggingFace
 * Vision chain: Qwen-VL via HuggingFace → GLM via z.ai
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

        const raw = await slot.call(messages, maxTokens, temperature, timeoutMs, options.tools);

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
