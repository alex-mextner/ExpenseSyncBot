/**
 * Folds the chunks of one OpenAI-compatible chat stream into the round result: text, tool calls
 * (with the index quirks of HF Router), finish reason, the final usage chunk and the first/last
 * token timestamps. Split from the provider slot so the per-chunk rules are plain methods that
 * can be read and tested one at a time.
 */

import type OpenAI from 'openai';
import { EmptyProviderResponseError, markProviderResponded } from './error-signals';
import { normalizeUsage, type StreamTiming, tagAttemptUsage, UNKNOWN_TIMING } from './token-usage';
import type { SlotOutput, StreamCallbacks, StreamToolCall } from './types';

interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

export class StreamCollector {
  private text = '';
  private readonly toolCalls = new Map<number, PartialToolCall>();
  private lastToolCallKey = -1;
  private finishReason = 'stop';
  private usage: OpenAI.CompletionUsage | null = null;
  private firstTokenPerf: number | null = null;
  private lastTokenPerf: number | null = null;

  constructor(private readonly callbacks: StreamCallbacks) {}

  consume(chunk: OpenAI.ChatCompletionChunk): void {
    // The usage-only final chunk has no choices: capture it before the delta guard below.
    if (chunk.usage) this.usage = chunk.usage;
    const delta = chunk.choices[0]?.delta;
    if (!delta) return;

    if (delta.content || (delta.tool_calls && delta.tool_calls.length > 0)) {
      this.markTokenDelta();
    }

    if (delta.content) {
      this.text += delta.content;
      this.callbacks.onTextDelta?.(delta.content);
    }

    if (delta.tool_calls) {
      for (const toolCall of delta.tool_calls) this.applyToolCallDelta(toolCall);
    }

    if (chunk.choices[0]?.finish_reason) {
      this.finishReason = chunk.choices[0].finish_reason;
    }
  }

  /**
   * Tags a stream error with what had already arrived. Whether ANY output (text or a tool-call
   * chunk — even before a tool name arrives) was received before the drop lets the chain avoid
   * treating a late drop after a real response as "provider unreachable"; the usage reported so
   * far still belongs to the failed attempt's usage event.
   */
  tagFailure(error: unknown): void {
    markProviderResponded(error, this.text.length > 0 || this.toolCalls.size > 0);
    if (this.usage) tagAttemptUsage(error, normalizeUsage(this.usage));
  }

  /** The slot's output once the stream ended cleanly; an answer with no text and no tool call is a failure. */
  finish(slotName: string, requestStartedPerf: number): SlotOutput {
    const tokenUsage = normalizeUsage(this.usage);
    const toolCalls: StreamToolCall[] = [...this.toolCalls.values()].map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.args,
    }));

    // z.ai coding endpoint quirk: for pure text responses (no tools) it returns
    // content='' and populates reasoning_content instead. We can't read
    // reasoning_content via the OpenAI SDK, so we treat this as a failure and
    // fall through to the next provider. Tool-calling responses are unaffected.
    if (!this.text && toolCalls.length === 0) {
      const empty = new EmptyProviderResponseError(slotName);
      tagAttemptUsage(empty, tokenUsage);
      throw empty;
    }

    return {
      result: {
        text: this.text,
        toolCalls,
        finishReason: this.finishReason,
        assistantMessage: assistantMessageOf(this.text, toolCalls),
        providerUsed: slotName,
      },
      usage: tokenUsage,
      timing: this.timing(requestStartedPerf),
    };
  }

  private markTokenDelta(): void {
    const deltaPerf = performance.now();
    this.firstTokenPerf ??= deltaPerf;
    this.lastTokenPerf = deltaPerf;
  }

  private timing(requestStartedPerf: number): StreamTiming {
    if (this.firstTokenPerf === null || this.lastTokenPerf === null) return UNKNOWN_TIMING;
    return {
      firstTokenMs: Math.round(this.firstTokenPerf - requestStartedPerf),
      generationMs: Math.round(this.lastTokenPerf - this.firstTokenPerf),
    };
  }

  /**
   * Resolve the tool-call slot of a delta: some providers (HF Router) omit tc.index.
   * Fallback: a new tool call if id/name present, otherwise append to the last one; null when
   * there is nothing to append to.
   */
  private toolCallKey(toolCall: OpenAI.ChatCompletionChunk.Choice.Delta.ToolCall): number | null {
    if (typeof toolCall.index === 'number') return toolCall.index;
    if (toolCall.id || toolCall.function?.name) return this.toolCalls.size;
    return this.lastToolCallKey >= 0 ? this.lastToolCallKey : null;
  }

  private applyToolCallDelta(toolCall: OpenAI.ChatCompletionChunk.Choice.Delta.ToolCall): void {
    const key = this.toolCallKey(toolCall);
    if (key === null) return;

    const existing = this.toolCalls.get(key);
    if (existing) {
      existing.args += toolCall.function?.arguments ?? '';
      if (toolCall.id && !existing.id) existing.id = toolCall.id;
      if (toolCall.function?.name && !existing.name) existing.name = toolCall.function.name;
      return;
    }

    const name = toolCall.function?.name ?? '';
    if (name) this.callbacks.onToolCallStart?.(name);
    this.toolCalls.set(key, {
      id: toolCall.id ?? '',
      name,
      args: toolCall.function?.arguments ?? '',
    });
    this.lastToolCallKey = key;
  }
}

/** Full assistant message for appending to conversation history. */
function assistantMessageOf(
  text: string,
  toolCalls: StreamToolCall[],
): OpenAI.ChatCompletionMessageParam {
  return {
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length > 0
      ? {
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }
      : {}),
  };
}
