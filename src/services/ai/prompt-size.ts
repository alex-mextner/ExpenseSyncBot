/**
 * Estimated size of the request a round sends, split by component, for the usage ledger. These are
 * character-based ESTIMATES (no tokenizer, no prompt text kept): the provider's own prompt_tokens
 * stays the truth, these only show where the prompt's weight sits (tool catalog vs history) and
 * make the effect of trimming or compaction measurable.
 */
import type OpenAI from 'openai';
import type { AiPromptSize } from '../../database/repositories/ai-usage-events.repository';

const CHARS_PER_TOKEN = 3.5;

function estimateTokens(chars: number): number {
  return chars === 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Text characters of one message: string content, text parts of a multi-part one (images add nothing), tool-call arguments. */
function messageChars(message: OpenAI.ChatCompletionMessageParam): number {
  let chars = 0;
  const { content } = message;
  if (typeof content === 'string') {
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text') chars += part.text.length;
    }
  }
  if (message.role === 'assistant' && message.tool_calls) {
    for (const call of message.tool_calls) {
      if (call.type === 'function')
        chars += call.function.name.length + call.function.arguments.length;
    }
  }
  return chars;
}

export function estimatePromptSize(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  tools: readonly OpenAI.ChatCompletionTool[] | undefined,
): AiPromptSize {
  const last = messages.at(-1);
  const finalUserIndex = last?.role === 'user' ? messages.length - 1 : -1;
  let systemChars = 0;
  let historyChars = 0;
  let userChars = 0;
  messages.forEach((message, index) => {
    const chars = messageChars(message);
    if (message.role === 'system' || message.role === 'developer') systemChars += chars;
    else if (index === finalUserIndex) userChars += chars;
    else historyChars += chars;
  });
  const toolCount = tools?.length ?? 0;
  return {
    systemPromptTokens: estimateTokens(systemChars),
    toolCatalogTokens: toolCount === 0 ? 0 : estimateTokens(JSON.stringify(tools).length),
    historyTokens: estimateTokens(historyChars),
    userTokens: estimateTokens(userChars),
    toolCount,
    messageCount: messages.length,
  };
}
