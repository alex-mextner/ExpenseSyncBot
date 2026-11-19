// Adapt native Claude SSE to the shared streaming contract without losing usage or opaque content.
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import type { Stream } from 'openai/core/streaming';
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import {
  type NativeAssistantBlock,
  type NativeReplay,
  nativeAssistantBlockSchema,
  rememberNativeChunk,
} from './claude-native-content.ts';
import type { PreparedNativeRequest } from './claude-native-request.ts';
import {
  mergeNativeUsage,
  type NativeUsage,
  type NativeUsageObserver,
  nativeCompletionUsage,
  nativeTokenUsage,
  nativeUsageSchema,
} from './claude-native-usage.ts';

const deltaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
  z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
  z.object({ type: z.literal('signature_delta'), signature: z.string() }),
  z.object({ type: z.literal('citations_delta') }),
]);
const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_start'),
    message: z.object({ id: z.string(), model: z.string(), usage: nativeUsageSchema }),
  }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number().int().nonnegative(),
    content_block: nativeAssistantBlockSchema,
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number().int().nonnegative(),
    delta: deltaSchema,
  }),
  z.object({ type: z.literal('content_block_stop'), index: z.number().int() }),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({ stop_reason: z.string().nullable().optional() }),
    usage: nativeUsageSchema.optional(),
  }),
  z.object({ type: z.literal('message_stop') }),
  z.object({ type: z.literal('ping') }),
]);
type NativeEvent = z.infer<typeof eventSchema>;
interface PendingTool {
  index: number;
  hasArguments: boolean;
  arguments: string;
}
interface NativeState {
  id: string;
  model: string;
  usage: NativeUsage;
  started: boolean;
  stopped: boolean;
  finishSeen: boolean;
  outputReported: boolean;
  openBlocks: Set<number>;
  blocks: Map<number, NativeAssistantBlock>;
  tools: Map<number, PendingTool>;
}
type Choice = OpenAI.ChatCompletionChunk.Choice;
const knownTypes = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
]);

function finishReason(reason: string): Choice['finish_reason'] {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'length';
  if (reason === 'refusal') return 'content_filter';
  throw new Error('Claude did not finish the turn');
}

function startBlock(
  event: Extract<NativeEvent, { type: 'content_block_start' }>,
  state: NativeState,
): Choice['delta'] | null {
  const block = event.content_block;
  if (state.blocks.has(event.index)) throw new Error('Duplicate Claude content block');
  state.blocks.set(event.index, block);
  state.openBlocks.add(event.index);
  if (block.type === 'text') return block.text ? { content: block.text } : null;
  if (block.type !== 'tool_use') return null;
  const args = Object.keys(block.input).length ? JSON.stringify(block.input) : '';
  const index = state.tools.size;
  state.tools.set(event.index, { index, hasArguments: args.length > 0, arguments: args });
  return {
    tool_calls: [
      { index, id: block.id, type: 'function', function: { name: block.name, arguments: args } },
    ],
  };
}

function blockDelta(
  event: Extract<NativeEvent, { type: 'content_block_delta' }>,
  state: NativeState,
): Choice['delta'] | null {
  if (!state.openBlocks.has(event.index))
    throw new Error('Claude delta targets a closed content block');
  const delta = event.delta;
  const block = state.blocks.get(event.index);
  if (!block) throw new Error('Claude delta has no matching content block');
  if (delta.type === 'text_delta') {
    if (block.type !== 'text') throw new Error('Claude text delta has a mismatched block');
    block.text += delta.text;
    return { content: delta.text };
  }
  if (delta.type === 'thinking_delta' || delta.type === 'signature_delta') {
    if (block.type !== 'thinking') throw new Error('Claude thinking delta has a mismatched block');
    if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
    else block.signature = delta.signature;
    return null;
  }
  if (delta.type !== 'input_json_delta') return null;
  const tool = state.tools.get(event.index);
  if (!tool) throw new Error('Claude tool delta has no matching start');
  if (block.type !== 'tool_use') throw new Error('Claude tool delta has a mismatched block');
  tool.hasArguments ||= delta.partial_json.length > 0;
  tool.arguments += delta.partial_json;
  return { tool_calls: [{ index: tool.index, function: { arguments: delta.partial_json } }] };
}

function eventDelta(event: NativeEvent, state: NativeState): Choice['delta'] | null {
  if (event.type === 'content_block_start') return startBlock(event, state);
  if (event.type === 'content_block_delta') return blockDelta(event, state);
  if (event.type !== 'content_block_stop') return null;
  if (!state.openBlocks.delete(event.index))
    throw new Error('Unexpected Claude content block stop');
  const tool = state.tools.get(event.index);
  if (!tool) return null;
  const block = state.blocks.get(event.index);
  const parsed = jsonCodec(z.record(z.string(), z.json())).safeParse(tool.arguments || '{}');
  if (block?.type !== 'tool_use' || !parsed.success)
    throw new Error('Malformed Claude tool arguments');
  block.input = parsed.data;
  if (tool.hasArguments) return null;
  tool.hasArguments = true;
  return { tool_calls: [{ index: tool.index, function: { arguments: '{}' } }] };
}

function readEvent(raw: unknown): NativeEvent | null {
  const parsed = eventSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const type = z.object({ type: z.string() }).safeParse(raw);
  if (type.success && !knownTypes.has(type.data.type)) return null;
  throw new Error('Malformed Claude streaming event');
}

function updateMessageState(event: NativeEvent, state: NativeState): void {
  if (event.type === 'message_start') {
    if (state.started) throw new Error('Duplicate Claude message start');
    state.id = event.message.id;
    state.model = event.message.model;
    state.usage = mergeNativeUsage({}, event.message.usage);
    state.started = true;
  } else if (!state.started) throw new Error('Claude stream has no message start');
  if (event.type === 'message_delta' && event.usage) {
    state.usage = mergeNativeUsage(state.usage, event.usage);
    state.outputReported ||= event.usage.output_tokens != null;
  }
  if (event.type === 'message_stop') {
    if (!state.finishSeen) throw new Error('Claude stream has no terminal stop reason');
    if (state.openBlocks.size)
      throw new Error('Claude stream ended with incomplete content blocks');
    state.stopped = true;
  }
}

function convertEvent(
  event: NativeEvent,
  state: NativeState,
  credentialId: string,
  onUsage?: NativeUsageObserver,
): OpenAI.ChatCompletionChunk | null {
  if (event.type === 'ping') return null;
  updateMessageState(event, state);
  if (event.type === 'message_start' || event.type === 'message_delta') {
    onUsage?.(nativeTokenUsage(state.usage, credentialId));
  }
  const delta = eventDelta(event, state);
  const reason =
    event.type === 'message_delta' && event.delta.stop_reason
      ? finishReason(event.delta.stop_reason)
      : null;
  if (reason) state.finishSeen = true;
  const reportsUsage =
    event.type === 'message_start' ||
    event.type === 'message_delta' ||
    event.type === 'message_stop';
  if (!delta && !reason && !reportsUsage) return null;
  return {
    id: state.id,
    model: state.model,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    choices: delta || reason ? [{ index: 0, delta: delta ?? {}, finish_reason: reason }] : [],
    ...(reportsUsage
      ? { usage: nativeCompletionUsage(state.usage, credentialId, state.outputReported) }
      : {}),
  };
}

function streamFailure(error: unknown, signal?: AbortSignal): Error {
  signal?.throwIfAborted();
  if (error instanceof OpenAI.APIError) return error;
  return new OpenAI.APIConnectionError({
    message: error instanceof Error ? error.message : 'Claude stream failed',
    cause: error instanceof Error ? error : undefined,
  });
}

async function* convertStream(
  stream: AsyncIterable<unknown>,
  model: string,
  credentialId: string,
  replay: Omit<NativeReplay, 'content'>,
  signal?: AbortSignal,
  onUsage?: NativeUsageObserver,
): AsyncGenerator<OpenAI.ChatCompletionChunk> {
  const state: NativeState = {
    id: '',
    model,
    usage: {},
    started: false,
    stopped: false,
    finishSeen: false,
    outputReported: false,
    openBlocks: new Set(),
    blocks: new Map(),
    tools: new Map(),
  };
  try {
    for await (const raw of stream) {
      signal?.throwIfAborted();
      const event = readEvent(raw);
      if (!event) continue;
      const chunk = convertEvent(event, state, credentialId, onUsage);
      if (chunk) {
        if (state.stopped)
          rememberNativeChunk(chunk, { ...replay, content: [...state.blocks.values()] });
        yield chunk;
      }
      if (state.stopped) return;
    }
    signal?.throwIfAborted();
    throw new Error('Claude stream ended before message_stop');
  } catch (error) {
    onUsage?.(nativeTokenUsage(state.usage, credentialId));
    throw streamFailure(error, signal);
  }
}

/** Uses the selected SDK key; reports attribution before HTTP and usage directly to this attempt. */
export async function openNativeClaudeStream(
  client: OpenAI,
  replay: PreparedNativeRequest,
  signal?: AbortSignal,
  onUsage?: NativeUsageObserver,
) {
  const body = replay.request;
  const credentialId = createHash('sha256').update(client.apiKey).digest('hex').slice(0, 12);
  onUsage?.(nativeTokenUsage({}, credentialId));
  const stream = await client.post<Stream<unknown>>('/messages', {
    body,
    stream: true,
    signal,
    headers: {
      authorization: null,
      'x-api-key': client.apiKey,
      'anthropic-version': '2023-06-01',
      ...(body.messages.some((message) => message.role === 'system')
        ? { 'anthropic-beta': 'inline-tools-2026-09-15' }
        : {}),
    },
  });
  return {
    controller: stream.controller,
    [Symbol.asyncIterator]: () =>
      convertStream(stream, body.model, credentialId, replay, signal, onUsage),
  };
}
