// Diagnostic scripts use the same native Claude stream adapter as the bot.
import type OpenAI from 'openai';
import { openChatStream } from '../src/services/ai/streaming/request-params';

interface ProbeCompletion {
  choices: { message: { content: string | null }; finish_reason: string | null }[];
  usage?: OpenAI.CompletionUsage;
}

export async function probeCompletion(
  client: OpenAI,
  params: OpenAI.ChatCompletionCreateParamsNonStreaming,
  anthropic: boolean,
): Promise<ProbeCompletion> {
  if (!anthropic) return client.chat.completions.create(params);
  // Bound stream consumption as well as credential admission and response headers.
  const timeoutMs = client.timeout * 2;
  const signal = AbortSignal.timeout(timeoutMs);
  const stream = await openChatStream(client, { ...params, stream: true }, signal, 'claude', params.model, { timeoutMs });
  let text = '';
  let finishReason: string | null = null;
  let usage: OpenAI.CompletionUsage | undefined;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    text += choice?.delta.content ?? '';
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  return { choices: [{ message: { content: text }, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
}
