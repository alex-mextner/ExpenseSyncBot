// Tests for SSE event bus — subscription lifecycle, group-scoped emission, SSE framing

import { beforeEach, describe, expect, test } from 'bun:test';
import { emitForGroup, type SseEventType, subscribeGroup } from './sse-emitter.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect emitted SSE frames for a subscriber. The emitter calls `send(event)`
 * with the fully framed SSE chunk; we just push into an array for assertions.
 */
function collector() {
  const frames: string[] = [];
  return {
    frames,
    send: (event: string) => {
      frames.push(event);
    },
  };
}

/**
 * Parse an SSE frame into { event, data } for assertion convenience.
 * Throws if the frame doesn't match the expected `event: X\ndata: Y\n\n` shape.
 */
function parseFrame(raw: string): { event: string; data: unknown } {
  expect(raw.endsWith('\n\n')).toBe(true);
  const lines = raw.slice(0, -2).split('\n');
  const eventLine = lines.find((l) => l.startsWith('event: '));
  const dataLine = lines.find((l) => l.startsWith('data: '));
  if (!eventLine || !dataLine) {
    throw new Error(`Malformed SSE frame: ${JSON.stringify(raw)}`);
  }
  return {
    event: eventLine.slice('event: '.length),
    data: JSON.parse(dataLine.slice('data: '.length)),
  };
}

// The subscribers map is module-level state — reset by unsubscribing any leftover
// subscriptions at the start of each test. Tests that subscribe must store the
// unsubscribe fn and call it (either here or inline).
const cleanup: (() => void)[] = [];

beforeEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('subscribeGroup + emitForGroup — group isolation', () => {
  test('event only broadcast to subscribers of that group', () => {
    const groupA = collector();
    const groupB = collector();

    cleanup.push(subscribeGroup(1, groupA.send));
    cleanup.push(subscribeGroup(2, groupB.send));

    emitForGroup(1, 'expense_added');

    expect(groupA.frames).toHaveLength(1);
    expect(groupB.frames).toHaveLength(0);
  });

  test('emit to a group with zero subscribers is a no-op', () => {
    // No subscribers at all — just verify no throw
    emitForGroup(42, 'budget_updated');

    // Now subscribe a different group; the earlier emit must not have been queued
    const other = collector();
    cleanup.push(subscribeGroup(43, other.send));
    expect(other.frames).toHaveLength(0);
  });

  test('multiple subscribers for the same group all receive the event', () => {
    const sub1 = collector();
    const sub2 = collector();
    const sub3 = collector();

    cleanup.push(subscribeGroup(7, sub1.send));
    cleanup.push(subscribeGroup(7, sub2.send));
    cleanup.push(subscribeGroup(7, sub3.send));

    emitForGroup(7, 'expense_added');

    expect(sub1.frames).toHaveLength(1);
    expect(sub2.frames).toHaveLength(1);
    expect(sub3.frames).toHaveLength(1);
  });
});

describe('SSE framing', () => {
  test('expense_added event uses correct SSE framing', () => {
    const sub = collector();
    cleanup.push(subscribeGroup(10, sub.send));

    emitForGroup(10, 'expense_added');

    expect(sub.frames).toHaveLength(1);
    const raw = sub.frames[0];
    if (!raw) throw new Error('expected frame');
    // Full literal framing check — contract with the Mini App SSE client
    expect(raw).toBe('event: expense_added\ndata: {}\n\n');

    const parsed = parseFrame(raw);
    expect(parsed.event).toBe('expense_added');
    expect(parsed.data).toEqual({});
  });

  test('budget_updated event uses correct SSE framing', () => {
    const sub = collector();
    cleanup.push(subscribeGroup(11, sub.send));

    emitForGroup(11, 'budget_updated');

    const raw = sub.frames[0];
    if (!raw) throw new Error('expected frame');
    expect(raw).toBe('event: budget_updated\ndata: {}\n\n');
  });

  test('each emit produces one frame (no batching)', () => {
    const sub = collector();
    cleanup.push(subscribeGroup(12, sub.send));

    const events: SseEventType[] = ['expense_added', 'budget_updated', 'expense_added'];
    for (const e of events) emitForGroup(12, e);

    expect(sub.frames).toHaveLength(3);
    expect(sub.frames.map((f) => parseFrame(f).event)).toEqual(events);
  });
});

describe('unsubscribe semantics', () => {
  test('unsubscribed subscriber no longer receives events', () => {
    const sub = collector();
    const unsubscribe = subscribeGroup(20, sub.send);

    emitForGroup(20, 'expense_added');
    expect(sub.frames).toHaveLength(1);

    unsubscribe();

    emitForGroup(20, 'expense_added');
    expect(sub.frames).toHaveLength(1); // no new frame
  });

  test('unsubscribe removes only the caller, other subs keep receiving', () => {
    const subA = collector();
    const subB = collector();
    const unsubA = subscribeGroup(21, subA.send);
    cleanup.push(subscribeGroup(21, subB.send));

    unsubA();

    emitForGroup(21, 'expense_added');

    expect(subA.frames).toHaveLength(0);
    expect(subB.frames).toHaveLength(1);
  });

  test('calling unsubscribe twice is a no-op (idempotent)', () => {
    const sub = collector();
    const unsubscribe = subscribeGroup(22, sub.send);

    unsubscribe();
    // Second call must not throw even though the entry is already gone
    expect(() => unsubscribe()).not.toThrow();

    emitForGroup(22, 'expense_added');
    expect(sub.frames).toHaveLength(0);
  });

  test('after all subscribers unsubscribe, group is eligible for cleanup and emit is a no-op', () => {
    const sub = collector();
    const unsub = subscribeGroup(23, sub.send);
    unsub();

    // No error when emitting to a now-empty group key
    expect(() => emitForGroup(23, 'expense_added')).not.toThrow();
    expect(sub.frames).toHaveLength(0);
  });

  test('re-subscribing after unsubscribe works (fresh Set is created)', () => {
    // Regression: subscribers.delete(groupId) runs when the Set empties; the
    // next subscribeGroup() must create a fresh Set rather than reusing a stale
    // reference. This exercises the `if (!group)` branch in subscribeGroup.
    const first = collector();
    const unsub = subscribeGroup(24, first.send);
    unsub(); // empties + deletes the group's Set

    const second = collector();
    cleanup.push(subscribeGroup(24, second.send));

    emitForGroup(24, 'expense_added');

    expect(first.frames).toHaveLength(0);
    expect(second.frames).toHaveLength(1);
  });
});

describe('disconnected subscriber cleanup (simulated stream close)', () => {
  test('emit continues to remaining subscribers when one has been unsubscribed', () => {
    // Simulates: SSE stream's `cancel()` fires, which invokes the unsubscribe
    // returned by subscribeGroup. Other subscribers on the same group must not
    // be affected.
    const alive = collector();
    const disconnected = collector();

    cleanup.push(subscribeGroup(30, alive.send));
    const disconnect = subscribeGroup(30, disconnected.send);

    // simulate stream close
    disconnect();

    emitForGroup(30, 'expense_added');
    emitForGroup(30, 'budget_updated');

    expect(disconnected.frames).toHaveLength(0);
    expect(alive.frames).toHaveLength(2);
  });
});
