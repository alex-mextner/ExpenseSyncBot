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
  // Keep the pool in charge of header deadlines and credential cooldowns.
  const timeoutMs = client.timeout * 2;
  const controller = new AbortController();
  const stream = await openChatStream(
    client,
    { ...params, stream: true },
    controller.signal,
    'claude',
    params.model,
    { timeoutMs },
  );
  // Body reads need a separate deadline after headers; the SDK header timer is now finished.
  const timer = setTimeout(
    () => controller.abort(new DOMException('Claude diagnostic stream timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    let text = '';
    let finishReason: string | null = null;
    let usage: OpenAI.CompletionUsage | undefined;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      text += choice?.delta.content ?? '';
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
    controller.signal.throwIfAborted();
    return {
      choices: [{ message: { content: text }, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
