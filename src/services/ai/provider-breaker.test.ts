// Tests for the AI provider circuit breaker — deterministic via injected `now` (fake clock).

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  isProviderDemoted,
  orderByHealth,
  recordProviderConnectionFailure,
  recordProviderReachable,
  recordProviderResponded,
  resetProviderBreaker,
} from './provider-breaker';

const WINDOW = 5 * 60_000;
const COOLDOWN = 5 * 60_000;
const slots = [{ key: 'zai' }, { key: 'gemini' }, { key: 'hf' }];

describe('provider-breaker', () => {
  beforeEach(() => {
    resetProviderBreaker();
  });

  it('does not demote before the failure threshold', () => {
    recordProviderConnectionFailure('zai', 0);
    recordProviderConnectionFailure('zai', 1_000);
    expect(isProviderDemoted('zai', 1_000)).toBe(false);
    expect(orderByHealth(slots, 1_000)).toEqual(slots);
  });

  it('demotes after 3 connection failures within the window and moves it to the back', () => {
    recordProviderConnectionFailure('zai', 0);
    recordProviderConnectionFailure('zai', 1_000);
    recordProviderConnectionFailure('zai', 2_000);
    expect(isProviderDemoted('zai', 2_000)).toBe(true);
    expect(orderByHealth(slots, 2_000).map((s) => s.key)).toEqual(['gemini', 'hf', 'zai']);
  });

  it('keeps non-demoted providers in their original relative order', () => {
    recordProviderConnectionFailure('gemini', 0);
    recordProviderConnectionFailure('gemini', 1_000);
    recordProviderConnectionFailure('gemini', 2_000);
    expect(orderByHealth(slots, 2_000).map((s) => s.key)).toEqual(['zai', 'hf', 'gemini']);
  });

  it('rehabilitates the provider after the cooldown elapses', () => {
    recordProviderConnectionFailure('zai', 0);
    recordProviderConnectionFailure('zai', 1_000);
    recordProviderConnectionFailure('zai', 2_000);
    expect(isProviderDemoted('zai', 2_000 + COOLDOWN - 1)).toBe(true);
    expect(isProviderDemoted('zai', 2_000 + COOLDOWN + 1)).toBe(false);
    expect(orderByHealth(slots, 2_000 + COOLDOWN + 1)).toEqual(slots);
  });

  it('stays demoted at the exact cooldown boundary (demotedUntil === now is still demoted)', () => {
    for (const t of [0, 1_000, 2_000]) recordProviderConnectionFailure('zai', t);
    const demotedUntil = 2_000 + COOLDOWN; // isProviderDemoted is strictly `> now`
    expect(isProviderDemoted('zai', demotedUntil - 1)).toBe(true);
    expect(isProviderDemoted('zai', demotedUntil)).toBe(false); // boundary: not strictly after
  });

  it('a connection failure while already demoted extends the cooldown', () => {
    for (const t of [0, 1_000, 2_000]) recordProviderConnectionFailure('zai', t);
    const firstUntil = 2_000 + COOLDOWN;
    // Still inside the demotion (cooldown not lapsed) — another failure pushes demotedUntil forward.
    recordProviderConnectionFailure('zai', 3_000);
    expect(isProviderDemoted('zai', firstUntil + 1)).toBe(true); // extended past the original window
    expect(isProviderDemoted('zai', 3_000 + COOLDOWN + 1)).toBe(false);
  });

  it('extends the cooldown for an active-demotion failure after the original cluster aged out', () => {
    // Failures at 0/1s/2s demote until 302_000 with clusterStartedAt=0. WINDOW === COOLDOWN, so the
    // original cluster ages out at 300_000 — INSIDE the still-active demotion. A demoted provider is
    // still tried last; if it fails again in that tail window the cooldown MUST move forward, not let
    // it expire milliseconds later on the original schedule (a flap straight back to the chain head).
    for (const t of [0, 1_000, 2_000]) recordProviderConnectionFailure('zai', t);
    const lateFailure = 301_999; // past the cluster age-out (> WINDOW) but before demotedUntil
    expect(isProviderDemoted('zai', lateFailure)).toBe(true); // still inside the original cooldown
    recordProviderConnectionFailure('zai', lateFailure);
    expect(isProviderDemoted('zai', 302_001)).toBe(true); // would be false on the original schedule
    expect(isProviderDemoted('zai', lateFailure + COOLDOWN - 1)).toBe(true);
    expect(isProviderDemoted('zai', lateFailure + COOLDOWN + 1)).toBe(false);
  });

  it('orderByHealth moves ALL slots to the back in original order when all are demoted', () => {
    for (const key of ['zai', 'gemini', 'hf']) {
      for (const t of [0, 1_000, 2_000]) recordProviderConnectionFailure(key, t);
    }
    // Every slot is demoted → healthy is empty, so the order is unchanged (all at the "back").
    expect(orderByHealth(slots, 2_000).map((s) => s.key)).toEqual(['zai', 'gemini', 'hf']);
  });

  it('does not accumulate failures spread beyond the window', () => {
    recordProviderConnectionFailure('zai', 0);
    recordProviderConnectionFailure('zai', WINDOW + 1); // stale → fresh cluster (count 1)
    recordProviderConnectionFailure('zai', WINDOW + 2); // count 2 — still below threshold
    expect(isProviderDemoted('zai', WINDOW + 2)).toBe(false);
  });

  it('a successful round rehabilitates a demoted provider immediately', () => {
    recordProviderConnectionFailure('zai', 0);
    recordProviderConnectionFailure('zai', 1_000);
    recordProviderConnectionFailure('zai', 2_000);
    expect(isProviderDemoted('zai', 2_000)).toBe(true);

    recordProviderReachable('zai'); // a clean round — full rehab, clears the active demotion
    expect(isProviderDemoted('zai', 2_000)).toBe(false);
    expect(orderByHealth(slots, 2_000)).toEqual(slots);
  });

  it('a successful round clears a sub-threshold connection streak', () => {
    recordProviderConnectionFailure('zai', 0);
    recordProviderConnectionFailure('zai', 1_000); // 2 failures — one short of demotion
    recordProviderReachable('zai'); // a clean round resets the counter
    recordProviderConnectionFailure('zai', 2_000); // fresh count 1, not 3
    expect(isProviderDemoted('zai', 2_000)).toBe(false);
  });

  it('a status response between connection failures resets the cluster (no demotion)', () => {
    recordProviderConnectionFailure('zai', 0);
    recordProviderConnectionFailure('zai', 1_000);
    recordProviderResponded('zai', 1_500); // a real 400/500 response proves the endpoint is reachable
    recordProviderConnectionFailure('zai', 2_000); // fresh cluster — count 1, not 3
    expect(isProviderDemoted('zai', 2_000)).toBe(false);
  });

  it('a status response does NOT lift an active demotion (only a clean round does)', () => {
    recordProviderConnectionFailure('zai', 0);
    recordProviderConnectionFailure('zai', 1_000);
    recordProviderConnectionFailure('zai', 2_000);
    expect(isProviderDemoted('zai', 2_000)).toBe(true);

    recordProviderResponded('zai', 2_500); // a 5xx is reachable, but not proof it can serve
    expect(isProviderDemoted('zai', 2_500)).toBe(true); // still at the back of the chain
  });

  it('a status response after the cooldown expires clears the stale demotion (no instant re-demote)', () => {
    for (const t of [0, 1_000, 2_000]) recordProviderConnectionFailure('zai', t);
    const afterCooldown = 2_000 + COOLDOWN + 1;
    expect(isProviderDemoted('zai', afterCooldown)).toBe(false); // cooldown lapsed

    recordProviderResponded('zai', afterCooldown); // half-open probe got a reachable (5xx) response
    // The stale demotion is cleared, so a later lone connection failure starts a fresh count — it
    // must NOT hit the half-open branch and re-demote off a single strike.
    recordProviderConnectionFailure('zai', afterCooldown + 1_000);
    expect(isProviderDemoted('zai', afterCooldown + 1_000)).toBe(false);
  });

  it('orderByHealth returns the same array reference when nothing is demoted', () => {
    expect(orderByHealth(slots, 5_000)).toBe(slots);
  });

  it('demotes multiple providers and keeps all of them (never drops)', () => {
    for (const t of [0, 1_000, 2_000]) recordProviderConnectionFailure('zai', t);
    for (const t of [0, 1_000, 2_000]) recordProviderConnectionFailure('gemini', t);
    const ordered = orderByHealth(slots, 2_000).map((s) => s.key);
    expect(ordered).toEqual(['hf', 'zai', 'gemini']);
    expect(ordered).toHaveLength(slots.length);
  });

  it('re-demotes after a single post-cooldown probe failure (half-open)', () => {
    for (const t of [0, 1_000, 2_000]) recordProviderConnectionFailure('zai', t);
    const afterCooldown = 2_000 + COOLDOWN + 1;
    expect(isProviderDemoted('zai', afterCooldown)).toBe(false); // cooldown lapsed → half-open probe

    // The half-open probe fails → re-demote immediately (don't make users eat 3 fresh timeouts).
    recordProviderConnectionFailure('zai', afterCooldown);
    expect(isProviderDemoted('zai', afterCooldown)).toBe(true);
    expect(isProviderDemoted('zai', afterCooldown + COOLDOWN - 1)).toBe(true);
    expect(isProviderDemoted('zai', afterCooldown + COOLDOWN + 1)).toBe(false);
  });

  it('shares state by stable key across chains (smart vs fast z.ai)', () => {
    // Connection failures are endpoint-level: the breaker is keyed by 'zai', not the model name,
    // so a demotion accrued on one chain applies to the other chain's z.ai slot too.
    for (const t of [0, 1_000, 2_000]) recordProviderConnectionFailure('zai', t);
    const fastChainSlots = [{ key: 'zai' }, { key: 'gemini' }, { key: 'hf' }];
    expect(orderByHealth(fastChainSlots, 2_000).map((s) => s.key)).toEqual(['gemini', 'hf', 'zai']);
  });
});
