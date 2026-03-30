// Tests for /feedback command pending state management
import { afterEach, describe, expect, it } from 'bun:test';
import { cancelPendingFeedback, consumePendingFeedback, setPendingFeedback } from './feedback';

afterEach(() => {
  cancelPendingFeedback(100);
  cancelPendingFeedback(200);
});

describe('consumePendingFeedback', () => {
  it('returns null when no pending feedback exists', () => {
    expect(consumePendingFeedback(100, 1)).toBeNull();
  });

  it('returns null when pending feedback is for a different user', () => {
    setPendingFeedback(100, 1, 42);
    expect(consumePendingFeedback(100, 999)).toBeNull();
  });

  it('returns prompt message ID and clears state for the correct user', () => {
    setPendingFeedback(100, 1, 42);
    expect(consumePendingFeedback(100, 1)).toBe(42);
    // Consumed — second call returns null
    expect(consumePendingFeedback(100, 1)).toBeNull();
  });
});

describe('cancelPendingFeedback', () => {
  it('does not throw when no pending feedback exists', () => {
    expect(() => cancelPendingFeedback(100)).not.toThrow();
  });

  it('clears pending state', () => {
    setPendingFeedback(100, 1, 42);
    cancelPendingFeedback(100);
    expect(consumePendingFeedback(100, 1)).toBeNull();
  });
});
