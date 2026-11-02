/** Request-level credential rotation. Never wraps stream consumption or business tools. */
export interface ClaudeCredentialRequestOptions {
  signal?: AbortSignal;
  /** Existing provider/header budget, shared by every credential attempt together. */
  timeoutMs: number;
  onHttpAttempt?: () => void;
  onRetry?: (attempt: { error: unknown; startedAt: number; durationMs: number }) => void;
}

interface CredentialAvailability {
  retryAfterMs: number;
  local: boolean;
  /** Ready/probing is inconclusive, so a terminal key failure cannot disable the whole provider. */
  state: 'ready' | 'probing' | 'cooling';
}
const credentialAvailability = new WeakMap<object, CredentialAvailability>();
/** Safe aggregate health only; the original SDK error and its HTTP status remain unchanged. */
export function getClaudeCredentialAvailability(
  error: unknown,
): CredentialAvailability | undefined {
  return error && typeof error === 'object' ? credentialAvailability.get(error) : undefined;
}

interface FailureMetadata {
  status?: number;
  message?: string;
  name?: string;
  headers?: Headers;
}

class CredentialAttemptTimeoutError extends Error {
  constructor() {
    super('Claude credential request timed out');
    this.name = 'CredentialAttemptTimeoutError';
  }
}

/**
 * Every credential is cooling. Carries the REAL cause of the soonest-expiring cooldown so retry
 * policy sees what actually failed: its HTTP status when it had one, a connection-like message for
 * a status-less transport failure. Nothing is invented: no cause, no status.
 */
export class CredentialsCoolingDownError extends Error {
  readonly headers: Headers;
  declare readonly status?: number;
  constructor(
    remainingMs: number,
    state: CredentialAvailability['state'] = 'cooling',
    cause?: CooldownCause,
  ) {
    super(
      cause?.status === undefined && cause?.connection
        ? 'Claude credentials are cooling down after a connection error'
        : 'Claude credentials are cooling down',
    );
    this.name = 'CredentialsCoolingDownError';
    if (cause?.status !== undefined) this.status = cause.status;
    credentialAvailability.set(this, {
      retryAfterMs: Math.max(1000, remainingMs),
      local: true,
      state,
    });
    this.headers = new Headers({
      'retry-after': String(Math.max(1, Math.ceil(remainingMs / 1000))),
    });
  }
}

function metadata(error: unknown): FailureMetadata {
  return error && typeof error === 'object' ? error : {};
}

/**
 * HTTP 400 bodies that mean this credential or its account cannot be billed or has spent its quota
 * (Anthropic: credit balance too low, and the "specified [workspace] API usage limits" spend caps),
 * as opposed to a request the API cannot process.
 */
const SPEND_LIMIT_REJECTION =
  /credit balance|insufficient (?:credits|balance)|spend(?:ing)?[ _-]limit|reached your (?:specified )?(?:workspace )?api usage limits?/i;

/** Below this a request cannot complete: none starts after a failure, and its timeout is no evidence against a key. */
const MIN_USEFUL_ATTEMPT_MS = 1000;

interface CooldownCause {
  status?: number;
  connection: boolean;
}

/** When a credential may be used again, and the failure that put it there. */
interface Cooldown {
  until: number;
  cause: CooldownCause;
}

function retryable(error: unknown): boolean {
  const { status, message, name } = metadata(error);
  if (status !== undefined) {
    if ([401, 402, 403, 408, 409, 429].includes(status) || (status >= 500 && status <= 599))
      return true;
    return status === 400 && SPEND_LIMIT_REJECTION.test(message ?? '');
  }
  return (
    error instanceof TypeError ||
    ['APIConnectionError', 'APIConnectionTimeoutError', 'CredentialAttemptTimeoutError'].includes(
      name ?? '',
    )
  );
}

function cooldownMs(error: unknown, now: number): number {
  const { status, headers } = metadata(error);
  const base =
    status === 400 || status === 401 || status === 402 || status === 403 ? 300_000 : 60_000;
  const raw = headers?.get?.('retry-after');
  if (!raw) return base;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.max(1000, Math.min(86_400_000, delay)) : base;
}

function discardLateResult(result: unknown): void {
  if (!result || typeof result !== 'object' || !('controller' in result)) return;
  const controller = result.controller;
  if (
    controller &&
    typeof controller === 'object' &&
    'abort' in controller &&
    typeof controller.abort === 'function'
  )
    controller.abort();
}

async function requestWithinBudget<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectAbort = () =>
      reject(parentSignal?.reason ?? new DOMException('Request aborted', 'AbortError'));
    parentSignal?.addEventListener('abort', rejectAbort, { once: true });
    timer = setTimeout(() => {
      expired = true;
      reject(new CredentialAttemptTimeoutError());
      controller.abort();
    }, timeoutMs);
  });
  const pending = Promise.resolve().then(() => operation(signal));
  void pending.then(
    (value) => {
      if (expired || parentSignal?.aborted) discardLateResult(value);
    },
    () => undefined,
  );
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
    if (rejectAbort) parentSignal?.removeEventListener('abort', rejectAbort);
  }
}

export function createClaudeCredentialPool(
  tokens: readonly (string | undefined)[],
  now: () => number = Date.now,
  isRequestRejection: (error: unknown) => boolean = () => false,
  isConnectionFailure: (error: unknown) => boolean = () => false,
  shouldCooldown: (error: unknown) => boolean = () => true,
) {
  const credentials = [
    ...new Set(tokens.map((token) => token?.trim()).filter((token): token is string => !!token)),
  ];
  // A cooldown's end and the failure that caused it live in one entry, so they can never disagree.
  const cooldowns = new Map<string, Cooldown>();
  const clearCooldown = (token: string) => {
    cooldowns.delete(token);
  };
  const failureVersion = new Map<string, number>();
  const recoveryProbes = new Set<string>();
  const available = (token: string) =>
    (cooldowns.get(token)?.until ?? 0) <= now() && !recoveryProbes.has(token);
  function availability(local: boolean): CredentialAvailability {
    if (credentials.some(available)) return { local, retryAfterMs: 0, state: 'ready' };
    if (credentials.some((token) => recoveryProbes.has(token)))
      return { local, retryAfterMs: 1000, state: 'probing' };
    const retryAfterMs = Math.max(
      1000,
      Math.min(...credentials.map((token) => (cooldowns.get(token)?.until ?? 0) - now())),
    );
    return { local, retryAfterMs, state: 'cooling' };
  }
  const coolingError = () => {
    const current = availability(true);
    let soonest: Cooldown | undefined;
    for (const token of credentials) {
      const cooldown = cooldowns.get(token);
      if (cooldown && (soonest === undefined || cooldown.until < soonest.until)) soonest = cooldown;
    }
    return new CredentialsCoolingDownError(current.retryAfterMs, current.state, soonest?.cause);
  };
  interface FailedAttempt {
    error: unknown;
    startedAt: number;
    durationMs: number;
  }

  function recordCredentialFailure(token: string, error: unknown, version: number): void {
    if (shouldCooldown(error)) {
      const until = now() + cooldownMs(error, now());
      const status = metadata(error).status;
      // The longer cooldown wins and keeps its own cause: a concurrent, shorter failure must not relabel it.
      if (until >= (cooldowns.get(token)?.until ?? 0))
        cooldowns.set(token, {
          until,
          cause: {
            ...(typeof status === 'number' ? { status } : {}),
            connection:
              status === undefined &&
              (error instanceof CredentialAttemptTimeoutError || isConnectionFailure(error)),
          },
        });
      failureVersion.set(token, (failureVersion.get(token) ?? 0) + 1);
    } else if ((failureVersion.get(token) ?? 0) === version) {
      clearCooldown(token);
    }
  }

  function clearExpiredFailureAfterResponse(token: string, error: unknown, version: number): void {
    const until = cooldowns.get(token)?.until;
    if (metadata(error).status === undefined || until === undefined || until > now()) return;
    if ((failureVersion.get(token) ?? 0) === version) clearCooldown(token);
  }

  async function attempt<T>(
    operation: (token: string, signal: AbortSignal) => Promise<T>,
    token: string,
    timeoutMs: number,
    options: ClaudeCredentialRequestOptions,
    previousFailure: FailedAttempt | undefined,
  ): Promise<{ ok: true; value: T } | { ok: false; failure: FailedAttempt }> {
    const version = failureVersion.get(token) ?? 0;
    const recovering = cooldowns.has(token);
    if (recovering) recoveryProbes.add(token);
    const attemptStartedAt = now();
    const attemptStarted = performance.now();
    try {
      const value = await requestWithinBudget(
        (signal) => {
          signal.throwIfAborted();
          if (previousFailure) options.onRetry?.(previousFailure);
          options.onHttpAttempt?.();
          return operation(token, signal);
        },
        options.signal,
        timeoutMs,
      );
      if ((failureVersion.get(token) ?? 0) === version) clearCooldown(token);
      return { ok: true, value };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (isRequestRejection(error) || !(isConnectionFailure(error) || retryable(error))) {
        clearExpiredFailureAfterResponse(token, error, version);
        throw error;
      }
      // A timeout of a slice below the useful floor says nothing about the key: a healthy key that needs
      // longer misses it too. It still rotates, but must not cool the key for later full-budget requests.
      if (!(error instanceof CredentialAttemptTimeoutError && timeoutMs < MIN_USEFUL_ATTEMPT_MS))
        recordCredentialFailure(token, error, version);
      return {
        ok: false,
        failure: {
          error,
          startedAt: attemptStartedAt,
          durationMs: Math.max(0, performance.now() - attemptStarted),
        },
      };
    } finally {
      if (recovering) recoveryProbes.delete(token);
    }
  }

  function throwFinalFailure(lastFailure: FailedAttempt | undefined): never {
    if (!lastFailure) throw coolingError();
    const error = lastFailure.error;
    if (credentials.length > 1 && error && typeof error === 'object') {
      credentialAvailability.set(error, availability(false));
    }
    throw error;
  }

  return {
    async run<T>(
      operation: (token: string, signal: AbortSignal) => Promise<T>,
      options: ClaudeCredentialRequestOptions,
    ): Promise<T> {
      options.signal?.throwIfAborted();
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
        throw new Error('Claude request budget must be positive');
      if (credentials.length === 0) throw new Error('Claude API token is not configured');
      const startedAt = performance.now();
      const attempted = new Set<string>();
      let lastFailure: FailedAttempt | undefined;
      while (attempted.size < credentials.length) {
        options.signal?.throwIfAborted();
        const eligible = credentials.filter((token) => !attempted.has(token) && available(token));
        const token = eligible[0];
        if (!token) break;
        const remaining = options.timeoutMs - (performance.now() - startedAt);
        if (remaining <= 0 && !lastFailure) throw new CredentialAttemptTimeoutError();
        // A sliver of budget cannot complete a request and would cool a healthy key; keep the real failure.
        if (lastFailure && remaining < Math.min(options.timeoutMs / 4, MIN_USEFUL_ATTEMPT_MS))
          break;
        attempted.add(token);
        const result = await attempt(
          operation,
          token,
          remaining / eligible.length,
          options,
          lastFailure,
        );
        if (result.ok) return result.value;
        lastFailure = result.failure;
      }
      return throwFinalFailure(lastFailure);
    },
  };
}
