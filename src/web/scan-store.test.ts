/** Tests for scan store — in-memory scan state with SSE pub/sub and TTL cleanup */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  _cleanupExpired,
  _resetForTests,
  createScan,
  emitEvent,
  getScan,
  subscribe,
  updateScan,
} from './scan-store';

beforeEach(() => {
  _resetForTests();
});

describe('createScan', () => {
  it('creates a scan with pending phase and returns scanId', () => {
    const scanId = createScan(42, 12345);
    expect(typeof scanId).toBe('string');
    expect(scanId.length).toBeGreaterThan(0);

    const state = getScan(scanId);
    expect(state).toBeDefined();
    expect(state?.phase).toBe('pending');
    expect(state?.groupId).toBe(42);
    expect(state?.telegramGroupId).toBe(12345);
    expect(state?.items).toEqual([]);
  });

  it('creates unique IDs', () => {
    const id1 = createScan(1, 100);
    const id2 = createScan(1, 100);
    expect(id1).not.toBe(id2);
  });
});

describe('updateScan', () => {
  it('merges patch into existing state', () => {
    const scanId = createScan(1, 100);
    updateScan(scanId, { phase: 'fetching', url: 'test.com' });
    const state = getScan(scanId);
    expect(state?.phase).toBe('fetching');
    expect(state?.url).toBe('test.com');
    expect(state?.groupId).toBe(1);
  });

  it('is a no-op for unknown scanId', () => {
    updateScan('nonexistent', { phase: 'done' });
  });

  it('notifies SSE subscribers on phase update', () => {
    const scanId = createScan(1, 100);
    const received: string[] = [];
    subscribe(scanId, (event) => received.push(event));

    updateScan(scanId, { phase: 'extracting' });
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('event: status');
    expect(received[0]).toContain('"phase":"extracting"');
  });
});

describe('emitEvent', () => {
  it('sends SSE-formatted event to all subscribers', () => {
    const scanId = createScan(1, 100);
    const received1: string[] = [];
    const received2: string[] = [];
    subscribe(scanId, (e) => received1.push(e));
    subscribe(scanId, (e) => received2.push(e));

    emitEvent(scanId, 'item', { name: 'Молоко', total: 89.99 });

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect(received1[0]).toBe('event: item\ndata: {"name":"Молоко","total":89.99}\n\n');
  });

  it('is a no-op for unknown scanId', () => {
    emitEvent('nonexistent', 'item', {});
  });
});

describe('subscribe', () => {
  it('returns unsubscribe function', () => {
    const scanId = createScan(1, 100);
    const received: string[] = [];
    const unsub = subscribe(scanId, (e) => received.push(e));

    emitEvent(scanId, 'ping', {});
    expect(received).toHaveLength(1);

    unsub?.();
    emitEvent(scanId, 'ping', {});
    expect(received).toHaveLength(1);
  });

  it('rejects with null when exceeding 5 subscribers', () => {
    const scanId = createScan(1, 100);
    for (let i = 0; i < 5; i++) {
      expect(subscribe(scanId, () => {})).not.toBeNull();
    }
    expect(subscribe(scanId, () => {})).toBeNull();
  });

  it('allows new subscriber after one unsubscribes', () => {
    const scanId = createScan(1, 100);
    const unsubs: Array<(() => void) | null> = [];
    for (let i = 0; i < 5; i++) {
      unsubs.push(subscribe(scanId, () => {}));
    }
    expect(subscribe(scanId, () => {})).toBeNull();

    unsubs[0]?.();
    expect(subscribe(scanId, () => {})).not.toBeNull();
  });
});

describe('TTL cleanup', () => {
  it('removes scans older than TTL', () => {
    const scanId = createScan(1, 100);
    expect(getScan(scanId)).toBeDefined();

    const state = getScan(scanId);
    if (state) state.createdAt = Date.now() - 31 * 60 * 1000;

    _cleanupExpired();

    expect(getScan(scanId)).toBeUndefined();
  });
});
