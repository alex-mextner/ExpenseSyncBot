import OpenAI from 'openai';
import {
  type ClaudeCredentialRequestOptions,
  createClaudeCredentialPool,
} from './claude-credential-pool';

const MODEL_PERMISSION_REJECTION =
  /\b(?:do(?:es)? not have|no) access to (?:the )?model\b|\bnot (?:authorized|permitted|allowed) to (?:use|access) (?:the )?model\b|\b(?:access|permission) denied (?:to|for) (?:the )?model\b|\bmodel\b[^.\n]{0,160}\b(?:access denied|not (?:available|accessible|enabled|permitted|allowed))\b|\bdo(?:es)? not have permission to (?:use|access) (?:this |the )?model\b/i;

const REQUEST_SIZE_REJECTION =
  /request (?:is )?too (?:large|big)|context (?:length|window)|maximum (?:context|input)/i;

const MODERATION_REJECTION =
  /content policy|safety (?:policy|filter)|requires moderation|input was flagged/i;

interface ClaudeClientConfig {
  tokens: readonly (string | undefined)[];
  baseURL: string;
  timeout: number;
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

interface RegisteredPool {
  pool: ReturnType<typeof createClaudeCredentialPool>;
  clientFor: (token: string) => OpenAI;
}

// The same registered client serves smart, fast, OCR and role chains, so credential health is shared.
// Weak keys let resetClients() discard all associated state without keeping old credentials alive.
const registeredPools = new WeakMap<OpenAI, RegisteredPool>();
// Older Bun releases include an invalid Authorization value in the SDK's header error.
const headerInvalidClients = new WeakSet<OpenAI>();

/**
 * The SDK builds `Authorization: Bearer <key>` through Headers, which rejects CR/LF/NUL and non-Latin-1
 * text. It still accepts other control bytes (SOH, US), which a real HTTP server then refuses with a 400
 * before any handler runs, so those are excluded here too.
 */
function isHeaderSafe(token: string): boolean {
  if ([...token].some((char) => char < ' ' || char === '\u007f')) return false;
  try {
    new Headers().append('authorization', `Bearer ${token}`);
    return true;
  } catch {
    return false;
  }
}

export function createClaudeClient(config: ClaudeClientConfig): OpenAI {
  const tokens = [
    ...new Set(
      config.tokens.map((token) => token?.trim()).filter((token): token is string => !!token),
    ),
  ];
  const clients = new Map<string, OpenAI>();
  const clientFor = (token: string): OpenAI => {
    let client = clients.get(token);
    if (!client) {
      client = new OpenAI({
        apiKey: token,
        baseURL: config.baseURL,
        timeout: config.timeout,
        maxRetries: 0,
        fetch: config.fetch,
      });
      clients.set(token, client);
    }
    return client;
  };
  // A header-invalid token makes the SDK throw a raw TypeError before fetch, indistinguishable from a
  // request-serialization TypeError, so it must never enter rotation. The value is deliberately not logged.
  const usable = tokens.length > 1 ? tokens.filter(isHeaderSafe) : [];
  // A single usable credential (one configured, or one left after filtering) keeps the existing
  // single-key SDK/caller timeout and error behavior: no pool, no local cooldown. With none usable
  // requests are rejected with a fixed message before the SDK can include the invalid header value.
  const selected = usable.length === 1 ? (usable[0] ?? '') : (tokens[0] ?? '');
  const primary = clientFor(selected);
  if (usable.length < 2 && !isHeaderSafe(selected)) headerInvalidClients.add(primary);
  if (usable.length > 1)
    registeredPools.set(primary, {
      pool: createClaudeCredentialPool(
        usable,
        Date.now,
        (error) =>
          error instanceof TypeError ||
          (error instanceof OpenAI.APIError &&
            ((error.status === 403 && MODERATION_REJECTION.test(error.message)) ||
              (error.status === 429 && REQUEST_SIZE_REJECTION.test(error.message)))),
        (error) => error instanceof OpenAI.APIConnectionError,
        (error) =>
          !(
            error instanceof OpenAI.APIError &&
            error.status === 403 &&
            MODEL_PERMISSION_REJECTION.test(error.message)
          ),
      ),
      clientFor,
    });
  return primary;
}

/**
 * Retry only request creation. Once it returns a stream, consumption and tools stay outside the pool.
 * `countHttpRequest` reports one more HTTP request made inside the same credential attempt; it only
 * counts when a pool is counting (a single-key client reports nothing, even for its first request).
 */
export function withClaudeCredentials<T>(
  client: OpenAI,
  operation: (
    client: OpenAI,
    signal: AbortSignal | undefined,
    countHttpRequest: () => void,
  ) => Promise<T>,
  options: ClaudeCredentialRequestOptions,
): Promise<T> {
  const entry = registeredPools.get(client);
  if (!entry) {
    if (headerInvalidClients.has(client)) {
      return Promise.reject(
        options.signal?.aborted
          ? options.signal.reason
          : new TypeError('Claude API token is not a valid HTTP header value'),
      );
    }
    return operation(client, options.signal, () => undefined);
  }
  return entry.pool.run(
    (token, signal) => operation(entry.clientFor(token), signal, () => options.onHttpAttempt?.()),
    options,
  );
}
