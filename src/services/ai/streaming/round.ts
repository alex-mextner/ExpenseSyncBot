/**
 * One AI round with automatic provider fallback: walks the chain, gives every provider its own
 * timeout, records one usage event per attempt, keeps the provider breaker informed, and throws an
 * aggregate error once every provider has failed. See streaming.ts for the fallback rules.
 */

import { createLogger } from '../../../utils/logger';
import { estimatePromptSize } from '../prompt-size';
import {
  recordProviderConnectionFailure,
  recordProviderRateLimit,
  recordProviderReachable,
  recordProviderResponded,
} from '../provider-breaker';
import { recordAiUsage } from '../usage-recorder';
import { availableSlots, excludedSlots } from './chains';
import {
  isAbortLike,
  isUnreachableFailure,
  makeAbortError,
  numericStatus,
  providerResponded,
} from './error-signals';
import {
  classifyAttemptFailure,
  getRateLimitCooldownMs,
  pickRepresentativeError,
} from './failure-policy';
import { attemptUsage, UNKNOWN_TIMING } from './token-usage';
import type {
  ChainName,
  ProviderSlot,
  StreamCallbacks,
  StreamRoundOptions,
  StreamRoundResult,
} from './types';
import { SKIPPED_ATTEMPT, type UsageRound, usageEvent } from './usage-event';

const logger = createLogger('ai-streaming');

/**
 * Per-provider wall-clock budget. Each provider in the fallback chain gets its
 * own fresh timeout — a slow/hung provider aborts after this and the loop tries
 * the next one with a clean signal. NOT shared across providers, so one stuck
 * provider does not poison the fallback chain.
 */
const PER_PROVIDER_TIMEOUT_MS = 45_000;

/**
 * Cooldown for a provider that answered 402 (out of prepaid credits, e.g. the HF router). Credits
 * come back only on a manual top-up; a demoted slot is still tried at the back of the chain, and a
 * clean round there lifts the demotion, so a top-up is picked up without waiting this out.
 */
const CREDITS_EXHAUSTED_COOLDOWN_MS = 60 * 60_000;

/**
 * Teach the breaker what a failed attempt says about the provider.
 *
 * An abort (the agent's 60s timeout / caller cancellation) is not evidence about the provider
 * — it neither proves nor disproves reachability — so it must leave the breaker untouched.
 * Otherwise: a truly unreachable failure (no status, connection-like, AND no output this
 * attempt) demotes; anything else means the provider answered (a 4xx/5xx status, a plain
 * reachable error like the empty-response above, or a late drop AFTER it streamed text/
 * tool-calls), so it only resets the connection-failure counter (recordProviderResponded —
 * does NOT lift an active demotion; only a clean round does).
 * The responded tag is read off the ORIGINAL thrown value — it's set on `thrown`, while `error`
 * may be a fresh wrapper Error (for a non-Error throw) that never carried the tag.
 */
function recordBreakerOutcome(
  slot: ProviderSlot,
  error: Error,
  thrown: unknown,
  failedAt: number,
): void {
  if (isAbortLike(error)) return;
  const status = numericStatus(error);
  if (status === 429 || status === 402) {
    // 402 = out of prepaid credits (HF router): back only after a manual top-up, so it
    // cools down far longer than a rate limit. It still sits at the back of the chain.
    const cooldownMs =
      status === 402 ? CREDITS_EXHAUSTED_COOLDOWN_MS : getRateLimitCooldownMs(error, failedAt);
    recordProviderResponded(slot.key, failedAt);
    recordProviderRateLimit(slot.key, failedAt, cooldownMs);
  } else if (isUnreachableFailure(error) && !providerResponded(thrown)) {
    recordProviderConnectionFailure(slot.key, failedAt);
  } else {
    recordProviderResponded(slot.key, failedAt);
  }
}

/** Timing of one provider attempt, as seen when it started. */
interface AttemptClock {
  startedAt: number;
  startedPerf: number;
}

/** The state of one aiStreamRound call that every provider attempt reads or extends. */
class RoundRun {
  private lastError: Error | null = null;
  // Once text reaches the user we cannot splice another model's output on a fallback. (Whether the
  // provider was reachable before a failure is read separately, off the thrown error's tag.)
  private textEmitted = false;
  private readonly providerErrors: Array<{ name: string; error: Error }> = [];
  private readonly usageRound: UsageRound;
  private readonly callbacks: StreamCallbacks;
  private readonly perProviderTimeoutMs: number;

  constructor(
    private readonly options: StreamRoundOptions,
    private readonly chainName: ChainName,
    callbacks: StreamCallbacks,
  ) {
    this.usageRound = {
      chain: chainName,
      purpose: options.purpose,
      requestId: crypto.randomUUID(),
      promptSize: estimatePromptSize(options.messages, options.tools),
    };
    this.callbacks = {
      onTextDelta: (text) => {
        this.textEmitted = true;
        callbacks.onTextDelta?.(text);
      },
    };
    if (callbacks.onToolCallStart) {
      this.callbacks.onToolCallStart = callbacks.onToolCallStart;
    }
    this.perProviderTimeoutMs = options.perProviderTimeoutMs ?? PER_PROVIDER_TIMEOUT_MS;
  }

  /** Slots a handoff excluded are logged as skipped: the round never requests them. */
  recordSkipped(excludeProviders: readonly string[], now: number): void {
    if (excludeProviders.length === 0) return;
    recordAiUsage(
      excludedSlots(this.chainName, excludeProviders, this.options.role).map((slot) =>
        usageEvent(this.usageRound, slot, now, SKIPPED_ATTEMPT),
      ),
    );
  }

  /** The slot's result, or null when it failed and the chain should go on with the next slot. */
  async tryProvider(slot: ProviderSlot): Promise<StreamRoundResult | null> {
    // Overall caller deadline already passed — trying more providers is pointless.
    if (this.options.signal?.aborted) {
      logger.warn('[AI_STREAM] Overall deadline exceeded, stopping fallback chain');
      throw makeAbortError('AI overall deadline exceeded');
    }

    // Each provider gets its own fresh timeout combined with the overall signal.
    // A slow provider aborts after perProviderTimeoutMs without poisoning the next one.
    const perProviderController = new AbortController();
    const perProviderTimeout = setTimeout(
      () => perProviderController.abort(),
      this.perProviderTimeoutMs,
    );
    const combinedSignal = this.options.signal
      ? AbortSignal.any([this.options.signal, perProviderController.signal])
      : perProviderController.signal;

    const clock: AttemptClock = { startedAt: Date.now(), startedPerf: performance.now() };
    try {
      logger.info(`[AI_STREAM] Trying ${this.chainName} → ${slot.name}`);
      const { result, usage, timing } = await slot.stream(
        { ...this.options, signal: combinedSignal },
        this.callbacks,
      );
      recordProviderReachable(slot.key); // a clean round rehabilitates a previously-demoted slot
      recordAiUsage([
        usageEvent(this.usageRound, slot, clock.startedAt, {
          outcome: 'ok',
          errorClass: null,
          httpStatus: null,
          durationMs: Math.round(performance.now() - clock.startedPerf),
          ...timing,
          ...usage,
        }),
      ]);
      return result;
    } catch (error) {
      this.handleFailure(slot, error, clock, perProviderController.signal.aborted);
      return null;
    } finally {
      clearTimeout(perProviderTimeout);
    }
  }

  /** Aggregate of every provider's failure, thrown once the chain is exhausted. */
  exhaustedError(): Error {
    // Aggregate all provider errors so the caller (and logs) see the full picture,
    // not just the last provider's error. The message lists each provider and its
    // failure reason — much more useful for debugging than "400 (no body)".
    const summary = this.providerErrors
      .map((e) => `${e.name}: ${e.error.message.slice(0, 120)}`)
      .join('; ');
    const aggregated = new Error(
      `All ${this.providerErrors.length} providers in ${this.chainName} chain failed: ${summary}`,
    );
    // Carry status/code for upstream classification (classifyAiError) and retry (isRetryableError),
    // both of which read error.status/code. The choice must NOT depend on which provider failed LAST
    // — the breaker can reorder the chain, so "last error" is unstable. pickRepresentativeError
    // prefers a transient signal (429/529/5xx/connection → retryable provider_down) over a co-occurring
    // 4xx, so a chain where one provider 400s and the rest are down still reads as "try later".
    const representative = pickRepresentativeError(
      this.providerErrors.map((e) => e.error),
      this.lastError,
    );
    if (representative) {
      const carrier = representative as { status?: number; code?: string };
      Object.assign(aggregated, { status: carrier.status, code: carrier.code });
    }
    return aggregated;
  }

  /**
   * Books one failed attempt: usage event, log line, breaker accounting. Returns when the chain
   * should try the next provider; throws when it must stop (text already sent, overall deadline).
   */
  private handleFailure(
    slot: ProviderSlot,
    thrown: unknown,
    clock: AttemptClock,
    providerTimedOut: boolean,
  ): void {
    // A fresh read at FAILURE time — the round-start `now` (used only for orderByHealth) can
    // predate a cooldown that expires mid-round, which would wrongly skip clearing an expired
    // half-open demotion or extend a cooldown from a stale anchor.
    const failedAt = Date.now();
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    this.lastError = error;
    this.providerErrors.push({ name: slot.name, error });
    recordAiUsage([
      usageEvent(this.usageRound, slot, clock.startedAt, {
        outcome: 'error',
        ...classifyAttemptFailure(error, {
          callerAborted: this.options.signal?.aborted === true,
          providerTimedOut,
        }),
        durationMs: Math.round(performance.now() - clock.startedPerf),
        ...UNKNOWN_TIMING,
        // The tag sits on the ORIGINAL thrown value, like the responded tag.
        ...attemptUsage(thrown),
      }),
    ]);
    logger.error({ err: error }, `[AI_STREAM] ${slot.name} failed: ${error.message}`);

    // Text already sent to user — can't splice another model's output. The provider proved it was
    // reachable (it streamed text), so reset its connection-failure cluster before bailing out.
    if (this.textEmitted) {
      if (!isAbortLike(error)) recordProviderResponded(slot.key, failedAt);
      logger.error(
        `[AI_STREAM] ${slot.name} died mid-stream after text was emitted — cannot fallback`,
      );
      throw thrown;
    }

    recordBreakerOutcome(slot, error, thrown, failedAt);

    // Overall deadline fired (not just this provider's timeout) — stop the chain
    // and signal a timeout so the caller surfaces the "time exceeded" message.
    if (this.options.signal?.aborted) {
      logger.warn('[AI_STREAM] Overall deadline exceeded mid-provider, stopping fallback chain');
      throw makeAbortError('AI overall deadline exceeded');
    }

    // Always try the next provider in the chain.
    // isRetryableError is for same-provider retry (backoff), not for fallback decisions.
    // Different providers have different quirks — one may fail where another succeeds.
    logger.warn(`[AI_STREAM] ${slot.name} failed, trying next provider`);
  }
}

/**
 * Execute one AI round with automatic provider fallback.
 *
 * With callbacks: streams text deltas and tool-call starts to the caller
 * (used by the agent for live Telegram updates).
 *
 * Without callbacks: collects the full result and returns it at the end
 * (used by validator, prefill, merchant-agent, OCR).
 */
export async function aiStreamRound(
  options: StreamRoundOptions,
  callbacks: StreamCallbacks = {},
): Promise<StreamRoundResult> {
  const chainName: ChainName = options.chain ?? 'smart';
  // Round-start snapshot used ONLY to order the chain: demoted providers (repeated connection
  // failures) drop to the back instead of being tried first; they're never removed. Breaker
  // mutations read a fresh `Date.now()` at failure time so a cooldown that expires mid-round
  // is honored (the boundary check `demotedUntil <= now` must not use a stale anchor).
  const now = Date.now();
  const excludeProviders = options.excludeProviders ?? [];
  const chain = availableSlots(chainName, excludeProviders, now, options.role);
  const run = new RoundRun(options, chainName, callbacks);
  run.recordSkipped(excludeProviders, now);

  for (const slot of chain) {
    const result = await run.tryProvider(slot);
    if (result) return result;
  }
  throw run.exhaustedError();
}
