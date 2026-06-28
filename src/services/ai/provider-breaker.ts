// Circuit breaker for AI provider slots: when a provider hits repeated connection-type failures
// it is moved to the BACK of the fallback chain for a cooldown (never dropped), so a flapping
// provider stops being tried first while the others answer. A success rehabilitates it instantly.
// Scope is deliberately CONNECTION failures only: a reachable-but-erroring provider (5xx) is handled
// by per-round fallback (try next), not demotion — so a 5xx response never demotes and never lifts
// an ACTIVE demotion (recordProviderResponded resets the connection-failure counter and resolves an
// already-EXPIRED half-open demotion, but leaves a still-active one in place).
// All logic is pure and clock-injected (no Date.now() inside) so the windows are deterministic
// in tests; the orchestrator (aiStreamRound) passes a single `now` per round.
// State is a single module-global Map (in-process, single Node process). Concurrent rounds may
// interleave failure counts, but with 5-min windows the skew is negligible — an accepted trade-off
// over locking a hot path.

/** Consecutive connection failures, clustered within the window, before a provider is demoted. */
const FAILURE_THRESHOLD = 3;
/** Failures must cluster within this window (ms) to count toward demotion. */
const FAILURE_WINDOW_MS = 5 * 60_000;
/** How long a demoted provider stays at the back of the chain (ms). */
const DEMOTION_MS = 5 * 60_000;

interface ProviderHealth {
  /** Connection failures in the current cluster. */
  failures: number;
  /** Epoch ms of the first failure in the current cluster. */
  clusterStartedAt: number;
  /** Epoch ms until which the provider is demoted; 0 = not demoted. */
  demotedUntil: number;
}

const health = new Map<string, ProviderHealth>();

/**
 * Record a connection-type failure for provider `key` (a stable id like 'zai'/'gemini'/'hf', NOT
 * the per-model display name — connection failures are endpoint-level, shared across chains).
 * Non-connection failures (4xx/5xx responses) and successes are NOT routed here — only true
 * "provider unreachable" errors. Demotes the provider once it accumulates FAILURE_THRESHOLD
 * failures within FAILURE_WINDOW_MS. After a demotion's cooldown lapses the provider gets one
 * half-open probe at its normal slot; if that probe also fails it is re-demoted immediately (no
 * fresh THRESHOLD strikes), so a persistently-down provider costs one failed request per cooldown,
 * not THRESHOLD.
 */
export function recordProviderConnectionFailure(key: string, now: number): void {
  const existing = health.get(key);
  if (!existing) {
    health.set(key, { failures: 1, clusterStartedAt: now, demotedUntil: 0 });
    return;
  }
  // The provider already carries a demotion (active OR just-lapsed) and failed again — re-demote for
  // a fresh cooldown. This MUST run before the window-aging branch below: FAILURE_WINDOW_MS ===
  // DEMOTION_MS, so the original failure cluster ages out right at the tail of the cooldown while the
  // demotion is still active. If active failures fell through instead, a failure in that tail window
  // would hit the aging branch, reset the count to 1, leave demotedUntil on its original schedule, and
  // let the provider flap back to the front milliseconds after a fresh drop. One rule, two cases:
  //  - active (demotedUntil > now): a still-demoted provider (tried last) keeps failing → push it out.
  //  - lapsed (demotedUntil <= now): the half-open post-cooldown probe (tried at its normal slot)
  //    failed → re-demote immediately rather than making users eat THRESHOLD fresh timeouts before it
  //    drops back. Roughly one failed probe per cooldown (single-threaded; under concurrent rounds
  //    several may probe before the first failure is recorded). recordProviderResponded clears an
  //    EXPIRED demotion to 0 first, so a probe that got a reachable response never reaches here.
  if (existing.demotedUntil !== 0) {
    existing.failures = FAILURE_THRESHOLD;
    existing.clusterStartedAt = now;
    existing.demotedUntil = now + DEMOTION_MS;
    return;
  }
  if (now - existing.clusterStartedAt > FAILURE_WINDOW_MS) {
    // The cluster aged out — start a clean cluster.
    existing.failures = 1;
    existing.clusterStartedAt = now;
  } else {
    existing.failures += 1;
  }
  if (existing.failures >= FAILURE_THRESHOLD) {
    existing.demotedUntil = now + DEMOTION_MS;
  }
}

/**
 * A clean round fully rehabilitates the provider — clears its connection-failure cluster AND any
 * active demotion. Only a successful round proves the provider can actually serve.
 */
export function recordProviderReachable(key: string): void {
  health.delete(key);
}

/**
 * A status-bearing response (4xx/5xx) proves the endpoint answered, so it breaks the connection-
 * failure streak: the next drop starts a fresh count (one 400 between drops won't reach the
 * threshold). It does NOT lift an ACTIVE demotion — an error response is not proof the provider can
 * serve, just that it replied, so a provider demoted for being unreachable stays at the back until a
 * clean round (recordProviderReachable) or the cooldown expires.
 */
export function recordProviderResponded(key: string, now: number): void {
  const existing = health.get(key);
  if (!existing) return;
  existing.failures = 0;
  existing.clusterStartedAt = now;
  // Clear an EXPIRED demotion: this reachable probe resolves the half-open state, so a later lone
  // connection failure starts a fresh count instead of instantly re-demoting via the cooldown-lapsed
  // branch. An ACTIVE demotion (demotedUntil > now) is kept — a 5xx must not lift it.
  if (existing.demotedUntil !== 0 && existing.demotedUntil <= now) {
    existing.demotedUntil = 0;
  }
}

/** True while provider `key` is inside its demotion cooldown. */
export function isProviderDemoted(key: string, now: number): boolean {
  const existing = health.get(key);
  return existing !== undefined && existing.demotedUntil > now;
}

/**
 * Stable reorder: providers currently in their demotion cooldown move to the back, every other
 * provider keeps its original order. Demoted providers are kept (tried last), never dropped.
 */
export function orderByHealth<T extends { key: string }>(slots: T[], now: number): T[] {
  const healthy: T[] = [];
  const demoted: T[] = [];
  for (const slot of slots) {
    if (isProviderDemoted(slot.key, now)) {
      demoted.push(slot);
    } else {
      healthy.push(slot);
    }
  }
  return demoted.length === 0 ? slots : [...healthy, ...demoted];
}

/** Test-only: clear all breaker state. */
export function resetProviderBreaker(): void {
  health.clear();
}
