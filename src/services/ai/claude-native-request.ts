// Translate supported bot requests into cacheable native Claude Messages payloads.
import type OpenAI from 'openai';
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import { systemCachePrefix, systemHistoryCaching } from './claude-cache-prefix.ts';
import {
  type NativeAssistantBlock,
  type NativeReplay,
  nativeMessageReplay,
  sourcePrefixHash,
} from './claude-native-content.ts';

interface CacheControl {
  type: 'ephemeral';
}
interface NativeText {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}
interface NativeImage {
  type: 'image';
  source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string };
}
interface NativeToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: { [key: string]: z.core.JSONType };
}
interface NativeToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: NativeText[];
}
interface NativeToolAddition {
  type: 'tool_addition';
  tool: { type: 'tool_definition'; definition: NativeTool };
}
type NativeBlock =
  | NativeText
  | NativeImage
  | NativeToolUse
  | NativeToolResult
  | NativeAssistantBlock
  | NativeToolAddition;
interface NativeMessage {
  role: 'user' | 'assistant' | 'system';
  content: NativeBlock[];
}
export interface NativeTool {
  name: string;
  description?: string;
  input_schema: { [key: string]: z.core.JSONType };
  cache_control?: CacheControl;
}
export interface NativeRequest {
  model: string;
  max_tokens: number;
  stream: true;
  cache_control?: CacheControl;
  system?: NativeText[];
  messages: NativeMessage[];
  tools?: NativeTool[];
  temperature?: number;
  stop_sequences?: string[];
  tool_choice?: { type: 'none' | 'auto' };
  thinking?: { type: 'disabled' };
}
/** Rejected locally before credential admission or HTTP; not evidence of provider health. */
export class NativeRequestContractError extends TypeError {}

const jsonObject = z.record(z.string(), z.json());
// Some compatible providers encode no-argument calls as JSON null. Native tool input is an object.
const argumentsCodec = jsonCodec(jsonObject.nullable());
const ephemeral: CacheControl = { type: 'ephemeral' };

function imageBlock(url: string): NativeImage {
  const data = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
  if (data?.[1] && data[2])
    return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
  if (!/^https?:\/\//.test(url)) throw new TypeError('Unsupported Claude image source');
  return { type: 'image', source: { type: 'url', url } };
}

function contentBlocks(content: OpenAI.ChatCompletionMessageParam['content']): NativeBlock[] {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.flatMap((part): NativeBlock[] => {
    if (part.type === 'text') return part.text ? [{ type: 'text', text: part.text }] : [];
    if (part.type === 'image_url') return [imageBlock(part.image_url.url)];
    if (part.type === 'refusal') return [{ type: 'text', text: part.refusal }];
    throw new TypeError('Unsupported Claude message content');
  });
}

function toolUse(call: OpenAI.ChatCompletionMessageToolCall): NativeToolUse {
  if (call.type !== 'function') throw new TypeError('Unsupported Claude tool call');
  const input = argumentsCodec.safeParse(call.function.arguments);
  if (!input.success) throw new TypeError('Invalid Claude tool-call arguments');
  return { type: 'tool_use', id: call.id, name: call.function.name, input: input.data ?? {} };
}

function messageBlocks(message: OpenAI.ChatCompletionMessageParam): NativeBlock[] {
  const replay = nativeMessageReplay(message);
  if (message.role === 'assistant' && replay) return [...replay.content];
  const blocks = contentBlocks(message.content);
  if (message.role === 'assistant') blocks.push(...(message.tool_calls ?? []).map(toolUse));
  return blocks;
}

function systemBlocks(message: OpenAI.ChatCompletionMessageParam): NativeText[] {
  if (typeof message.content === 'string') {
    const prefix = systemCachePrefix(message);
    if (prefix) {
      const tail = message.content.slice(prefix.length);
      return [
        { type: 'text', text: prefix, cache_control: ephemeral },
        ...(tail ? [{ type: 'text' as const, text: tail }] : []),
      ];
    }
    return message.content
      ? [{ type: 'text', text: message.content, cache_control: ephemeral }]
      : [];
  }
  return messageBlocks(message).map((part) => {
    if (part.type !== 'text') throw new TypeError('Unsupported Claude system content');
    return part;
  });
}

function convertTool(tool: OpenAI.ChatCompletionTool): NativeTool {
  if (tool.type !== 'function') throw new TypeError('Unsupported Claude tool definition');
  const schema = jsonObject.safeParse(
    tool.function.parameters ?? { type: 'object', properties: {} },
  );
  if (!schema.success) throw new TypeError('Invalid Claude tool schema');
  return {
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: schema.data,
  };
}

function appendMessage(messages: NativeMessage[], message: NativeMessage): void {
  if (!message.content.length) return;
  const previous = messages.at(-1);
  if (previous?.role === message.role) previous.content.push(...message.content);
  else messages.push(message);
}

function convertMessages(source: readonly OpenAI.ChatCompletionMessageParam[]) {
  const messages: NativeMessage[] = [];
  const system: NativeText[] = [];
  for (const message of source) {
    if (message.role === 'system' || message.role === 'developer')
      system.push(...systemBlocks(message));
    else if (message.role === 'tool') {
      const content = messageBlocks(message).map((part) => {
        if (part.type !== 'text') throw new TypeError('Unsupported Claude tool result');
        return part;
      });
      appendMessage(messages, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content }],
      });
    } else if (message.role === 'user' || message.role === 'assistant') {
      appendMessage(messages, { role: message.role, content: messageBlocks(message) });
    } else throw new TypeError('Unsupported Claude message role');
  }
  return { messages, system };
}

const optionsSchema = z.object({
  thinking: z.object({ type: z.literal('disabled') }).optional(),
  tool_choice: z.enum(['none', 'auto']).optional(),
  response_format: z.never().optional(),
  functions: z.never().optional(),
  function_call: z.never().optional(),
});

function nativeOptions(params: OpenAI.ChatCompletionCreateParamsStreaming) {
  const parsed = optionsSchema.safeParse(params);
  if (!parsed.success) throw new TypeError('Unsupported Claude request contract');
  return {
    ...(parsed.data.thinking ? { thinking: parsed.data.thinking } : {}),
    ...(parsed.data.tool_choice ? { tool_choice: { type: parsed.data.tool_choice } } : {}),
  };
}

/** Converts only the fields used by the bot; unsupported contracts fail before an HTTP request. */
function initialRequest(
  params: OpenAI.ChatCompletionCreateParamsStreaming,
  activeTools: NativeTool[],
): NativeRequest {
  const { messages, system } = convertMessages(params.messages);
  // A single stable system prefix needs only one explicit breakpoint; the automatic one covers history.
  const cachedSystem = system.filter((part) => part.cache_control);
  for (const part of cachedSystem.slice(0, -1)) delete part.cache_control;
  const tools = activeTools.map((tool) => ({ ...tool }));
  const lastTool = tools?.at(-1);
  if (lastTool) lastTool.cache_control = ephemeral;
  const maxTokens = params.max_tokens ?? params.max_completion_tokens;
  if (!maxTokens || maxTokens < 1) throw new TypeError('Claude output limit is required');
  return {
    model: params.model,
    max_tokens: maxTokens,
    stream: true,
    // Only real agent loops reuse changing history; one-shot payloads should not incur cache writes.
    ...(params.messages.some(systemHistoryCaching) ? { cache_control: ephemeral } : {}),
    ...nativeOptions(params),
    ...(system.length ? { system } : {}),
    messages,
    ...(tools?.length ? { tools } : {}),
    ...(params.temperature == null ? {} : { temperature: params.temperature }),
    ...(params.stop
      ? { stop_sequences: typeof params.stop === 'string' ? [params.stop] : params.stop }
      : {}),
  };
}

/** Preserve the exact native prefix across tool loops, including earlier inline schema additions. */
function buildNativeRequest(
  params: OpenAI.ChatCompletionCreateParamsStreaming,
  active: NativeTool[],
): NativeRequest {
  const current = initialRequest(params, active);
  const index = params.messages.findLastIndex(
    (message) => nativeMessageReplay(message) !== undefined,
  );
  const message = params.messages[index];
  if (!message) return current;
  const replay = nativeMessageReplay(message);
  if (!replay) return current;
  if (
    sourcePrefixHash(params.messages.slice(0, index)) !== replay.sourcePrefixHash ||
    JSON.stringify(current.system) !== JSON.stringify(replay.request.system)
  )
    throw new TypeError('Claude conversation prefix changed inside a native turn');
  if (
    active.length < replay.activeTools.length ||
    replay.activeTools.some((tool, i) => JSON.stringify(tool) !== JSON.stringify(active[i]))
  )
    throw new TypeError('Claude existing tool schemas changed inside a native turn');
  const suffix = convertMessages(params.messages.slice(index + 1)).messages;
  const messages: NativeMessage[] = [
    ...replay.request.messages,
    { role: 'assistant', content: [...replay.content] },
    ...suffix,
  ];
  const additions = active.slice(replay.activeTools.length);
  if (additions.length) {
    if (messages.at(-1)?.role !== 'user')
      throw new TypeError('Claude tool additions require a user or tool-result turn');
    messages.push({
      role: 'system',
      content: additions.map((definition) => ({
        type: 'tool_addition',
        tool: { type: 'tool_definition', definition },
      })),
    });
  }
  const request = { ...current, messages };
  delete request.system;
  delete request.tools;
  if (replay.request.system) request.system = replay.request.system;
  if (replay.request.tools) request.tools = replay.request.tools;
  return request;
}

export type PreparedNativeRequest = Omit<NativeReplay, 'content'>;

/** Prepare once before credential rotation; local contract rejection never starts a keyed HTTP attempt. */
export function prepareNativeRequest(
  params: OpenAI.ChatCompletionCreateParamsStreaming,
): PreparedNativeRequest {
  try {
    const activeTools = params.tools?.map(convertTool) ?? [];
    return {
      request: buildNativeRequest(params, activeTools),
      activeTools,
      sourcePrefixHash: sourcePrefixHash(params.messages),
    };
  } catch (error) {
    if (error instanceof TypeError)
      throw new NativeRequestContractError(error.message, { cause: error });
    throw error;
  }
}

export function nativeRequest(params: OpenAI.ChatCompletionCreateParamsStreaming): NativeRequest {
  return prepareNativeRequest(params).request;
}
