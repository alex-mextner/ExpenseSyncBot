/**
 * Budget and sampling fields of one chat request, and which endpoint+model pairs refused the
 * streaming-usage option. Split from streaming.ts so the provider slot builds its request from
 * pure helpers and the usage-option memory has one owner.
 */

import type OpenAI from 'openai';
import { createLogger } from '../../../utils/logger';
import { errorText, numericStatus } from './error-signals';

const logger = createLogger('ai-streaming');

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
export interface ClaudeParams {
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
 * Opens the chat stream, asking for the final usage chunk. A provider that rejects the option is
 * remembered and retried at once without it (same attempt, one usage row — its tokens stay unknown).
 */
export async function openChatStream(
  client: OpenAI,
  params: OpenAI.ChatCompletionCreateParamsStreaming,
  signal: AbortSignal | undefined,
  providerKey: string,
  model: string,
): Promise<AsyncIterable<OpenAI.ChatCompletionChunk>> {
  const request = (withUsage: boolean) =>
    client.chat.completions.create(
      withUsage ? { ...params, stream_options: { include_usage: true } } : params,
      signal ? { signal } : undefined,
    );
  const usageOptionKey = `${providerKey}:${model}`;
  if (providersWithoutStreamingUsage.has(usageOptionKey)) return request(false);
  try {
    return await request(true);
  } catch (error) {
    if (!rejectsUsageStreamOption(error)) throw error;
    providersWithoutStreamingUsage.add(usageOptionKey);
    logger.warn(
      { provider: providerKey, model },
      '[AI_STREAM] Provider rejected streaming usage — retrying without usage telemetry',
    );
    return request(false);
  }
}
