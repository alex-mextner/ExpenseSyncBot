/**
 * The provider slot: one OpenAI-compatible endpoint+model that can run a streaming round. Works
 * for any OpenAI-compat provider (z.ai, Claude, HF, OpenRouter) via the shared OpenAI SDK.
 */

import type OpenAI from 'openai';
import { type ModelPreset, presetRequestParams } from '../model-presets';
import type { ProviderId } from '../provider-ids';
import { type ClaudeParams, chatRequestParams, openChatStream } from './request-params';
import { StreamCollector } from './stream-collector';
import type { ProviderSlot, StreamRoundOptions } from './types';

const DEFAULT_TEMPERATURE = 0.3;

export interface SlotOptions {
  /**
   * Anthropic (Claude) request shape: never send `temperature` (Claude 5.x → 400 "temperature is
   * deprecated"); thinking and max_tokens come from claudeRequestParams(model, maxTokens).
   */
  anthropic?: boolean;
  /**
   * Role-routed slot: the preset's measured settings (reasoning effort, temperature, output
   * ceiling) replace the caller defaults. Ignored on Anthropic slots, whose request shape is fixed
   * by claudeRequestParams.
   */
  preset?: ModelPreset;
  /** Provider id of the slot; picks the preset's per-provider settings. */
  provider?: ProviderId;
}

type StreamParams = OpenAI.ChatCompletionCreateParamsStreaming & Omit<ClaudeParams, 'max_tokens'>;

/** The streaming chat request of one round: the slot's model, the caller's messages, tools and budget. */
function buildStreamParams(
  model: string,
  opts: StreamRoundOptions,
  slotOptions: SlotOptions,
): StreamParams {
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const params: StreamParams = {
    model,
    messages: opts.messages,
    stream: true,
    ...(slotOptions.preset && slotOptions.provider && !slotOptions.anthropic
      ? presetRequestParams(slotOptions.preset, slotOptions.provider, temperature, opts.maxTokens)
      : chatRequestParams(model, opts.maxTokens, temperature, slotOptions.anthropic ?? false)),
  };
  if (opts.tools && opts.tools.length > 0) {
    params.tools = opts.tools;
    if (opts.toolChoice) params.tool_choice = opts.toolChoice;
  }
  return params;
}

/**
 * Standard OpenAI streaming adapter. Works for any OpenAI-compat provider
 * (z.ai, Claude, HF, OpenRouter) via the shared OpenAI SDK.
 */
export function streamingSlot(
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
    ...(slotOptions.preset ? { presetId: slotOptions.preset.id } : {}),
    stream: async (opts, cbs) => {
      const params = buildStreamParams(model, opts, slotOptions);
      const requestStartedPerf = performance.now();
      const client = getClient();
      const stream = await openChatStream(client, params, opts.signal, key, model);

      const collector = new StreamCollector(cbs);
      try {
        for await (const chunk of stream) collector.consume(chunk);
      } catch (streamError) {
        collector.tagFailure(streamError);
        throw streamError;
      }
      return collector.finish(name, requestStartedPerf);
    },
  };
}
