import OpenAI from 'openai';

const REQUEST_SIZE_REJECTION =
  /request (?:is )?too (?:large|big)|context (?:length|window)|maximum (?:context|input)/i;

const MODERATION_REJECTION =
  /content policy|safety (?:policy|filter)|requires moderation|input was flagged/i;

import {
  type ClaudeCredentialRequestOptions,
  createClaudeCredentialPool,
} from './claude-credential-pool';

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
  const primary = clientFor(tokens[0] ?? '');
  // A single credential keeps the existing SDK/caller timeout and error behavior.
  if (tokens.length > 1)
    registeredPools.set(primary, {
      pool: createClaudeCredentialPool(
        tokens,
        Date.now,
        (error) =>
          error instanceof OpenAI.APIError &&
          ((error.status === 403 && MODERATION_REJECTION.test(error.message)) ||
            (error.status === 429 && REQUEST_SIZE_REJECTION.test(error.message))),
        (error) => error instanceof OpenAI.APIConnectionError,
      ),
      clientFor,
    });
  return primary;
}

/** Retry only request creation. Once it returns a stream, consumption and tools stay outside the pool. */
export function withClaudeCredentials<T>(
  client: OpenAI,
  operation: (client: OpenAI, signal: AbortSignal | undefined) => Promise<T>,
  options: ClaudeCredentialRequestOptions,
): Promise<T> {
  const entry = registeredPools.get(client);
  if (!entry) return operation(client, options.signal);
  return entry.pool.run((token, signal) => operation(entry.clientFor(token), signal), options);
}
