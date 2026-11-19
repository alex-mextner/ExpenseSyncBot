// Preserve a trusted static system-prefix boundary without changing compatible JSON requests.
import type OpenAI from 'openai';

const CACHE_PREFIX = Symbol('claudeCachePrefix');
const CACHE_HISTORY = Symbol('claudeCacheHistory');
interface CacheableSystemMessage extends OpenAI.ChatCompletionSystemMessageParam {
  content: string;
  [CACHE_PREFIX]: string;
  [CACHE_HISTORY]: boolean;
}

/** Internal metadata is not serialized to other providers or debug logs. */
export function cacheableSystemMessage(
  content: string,
  prefix: string,
  cacheHistory = true,
): CacheableSystemMessage {
  if (!prefix || !content.startsWith(prefix)) throw new TypeError('Invalid system cache prefix');
  return { role: 'system', content, [CACHE_PREFIX]: prefix, [CACHE_HISTORY]: cacheHistory };
}

export function systemCachePrefix(message: OpenAI.ChatCompletionMessageParam): string | null {
  if (!(CACHE_PREFIX in message)) return null;
  const prefix = message[CACHE_PREFIX];
  return typeof prefix === 'string' &&
    typeof message.content === 'string' &&
    message.content.startsWith(prefix)
    ? prefix
    : null;
}

/** One-shot requests can retain the stable boundary without writing their changing history. */
export function systemHistoryCaching(message: OpenAI.ChatCompletionMessageParam): boolean {
  return (
    systemCachePrefix(message) !== null &&
    CACHE_HISTORY in message &&
    message[CACHE_HISTORY] === true
  );
}
