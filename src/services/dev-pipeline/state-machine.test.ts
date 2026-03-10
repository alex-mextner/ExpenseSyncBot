import { test, expect, describe } from 'bun:test';
import { DevTaskState, STATE_TRANSITIONS } from './types';
import {
  isTransitionAllowed,
  isTerminalState,
  isWaitingForUser,
  isResumableState,
  getAllowedTransitions,
  validateTransition,
} from './state-machine';

// ─────────────────────────────────────────────
// isTransitionAllowed
// ─────────────────────────────────────────────
describe('isTransitionAllowed', () => {
  test('PENDING -> CLARIFYING is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.PENDING, DevTaskState.CLARIFYING)).toBe(true);
  });

  test('PENDING -> DESIGNING is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.PENDING, DevTaskState.DESIGNING)).toBe(true);
  });

  test('PENDING -> COMPLETED is not allowed (skipping the whole pipeline)', () => {
    expect(isTransitionAllowed(DevTaskState.PENDING, DevTaskState.COMPLETED)).toBe(false);
  });

  test('CLARIFYING -> DESIGNING is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.CLARIFYING, DevTaskState.DESIGNING)).toBe(true);
  });

  test('CLARIFYING -> REJECTED is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.CLARIFYING, DevTaskState.REJECTED)).toBe(true);
  });

  test('DESIGNING -> APPROVAL is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.DESIGNING, DevTaskState.APPROVAL)).toBe(true);
  });

  test('APPROVAL -> IMPLEMENTING is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.APPROVAL, DevTaskState.IMPLEMENTING)).toBe(true);
  });

  test('APPROVAL -> REJECTED is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.APPROVAL, DevTaskState.REJECTED)).toBe(true);
  });

  test('APPROVAL -> DESIGNING is allowed (send back for redesign)', () => {
    expect(isTransitionAllowed(DevTaskState.APPROVAL, DevTaskState.DESIGNING)).toBe(true);
  });

  test('TESTING -> IMPLEMENTING is allowed (fix and retry)', () => {
    expect(isTransitionAllowed(DevTaskState.TESTING, DevTaskState.IMPLEMENTING)).toBe(true);
  });

  test('TESTING -> PULL_REQUEST is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.TESTING, DevTaskState.PULL_REQUEST)).toBe(true);
  });

  test('REVIEWING -> AWAITING_REVIEW is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.REVIEWING, DevTaskState.AWAITING_REVIEW)).toBe(true);
  });

  test('AWAITING_REVIEW -> UPDATING is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.AWAITING_REVIEW, DevTaskState.UPDATING)).toBe(true);
  });

  test('AWAITING_MERGE -> COMPLETED is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.AWAITING_MERGE, DevTaskState.COMPLETED)).toBe(true);
  });

  test('AWAITING_MERGE -> UPDATING is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.AWAITING_MERGE, DevTaskState.UPDATING)).toBe(true);
  });

  test('UPDATING -> TESTING is allowed (re-test after changes)', () => {
    expect(isTransitionAllowed(DevTaskState.UPDATING, DevTaskState.TESTING)).toBe(true);
  });

  test('FAILED -> PENDING is allowed (retry from scratch)', () => {
    expect(isTransitionAllowed(DevTaskState.FAILED, DevTaskState.PENDING)).toBe(true);
  });

  test('COMPLETED -> any state is not allowed (terminal)', () => {
    const allStates = Object.values(DevTaskState);
    for (const s of allStates) {
      expect(isTransitionAllowed(DevTaskState.COMPLETED, s)).toBe(false);
    }
  });

  test('REJECTED -> any state is not allowed (terminal)', () => {
    const allStates = Object.values(DevTaskState);
    for (const s of allStates) {
      expect(isTransitionAllowed(DevTaskState.REJECTED, s)).toBe(false);
    }
  });

  test('IMPLEMENTING -> COMPLETED is not allowed (must go through testing)', () => {
    expect(isTransitionAllowed(DevTaskState.IMPLEMENTING, DevTaskState.COMPLETED)).toBe(false);
  });

  test('same state -> same state is not allowed for any state', () => {
    const allStates = Object.values(DevTaskState);
    for (const s of allStates) {
      const allowed = STATE_TRANSITIONS[s].includes(s);
      expect(isTransitionAllowed(s, s)).toBe(allowed);
    }
  });

  test('any non-terminal state -> REJECTED is allowed (cancel)', () => {
    const nonTerminal = [
      DevTaskState.PENDING, DevTaskState.CLARIFYING, DevTaskState.DESIGNING,
      DevTaskState.APPROVAL, DevTaskState.IMPLEMENTING, DevTaskState.TESTING,
      DevTaskState.PULL_REQUEST, DevTaskState.REVIEWING, DevTaskState.UPDATING,
    ];
    for (const s of nonTerminal) {
      expect(isTransitionAllowed(s, DevTaskState.REJECTED)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────
// getAllowedTransitions
// ─────────────────────────────────────────────
describe('getAllowedTransitions', () => {
  test('returns correct transitions for PENDING', () => {
    expect(getAllowedTransitions(DevTaskState.PENDING)).toEqual([
      DevTaskState.CLARIFYING,
      DevTaskState.DESIGNING,
      DevTaskState.REJECTED,
      DevTaskState.FAILED,
    ]);
  });

  test('returns empty array for terminal state COMPLETED', () => {
    expect(getAllowedTransitions(DevTaskState.COMPLETED)).toEqual([]);
  });

  test('returns empty array for terminal state REJECTED', () => {
    expect(getAllowedTransitions(DevTaskState.REJECTED)).toEqual([]);
  });

  test('FAILED can transition to PENDING, DESIGNING, IMPLEMENTING, PULL_REQUEST, REVIEWING, AWAITING_REVIEW, or REJECTED', () => {
    expect(getAllowedTransitions(DevTaskState.FAILED)).toEqual([
      DevTaskState.PENDING,
      DevTaskState.DESIGNING,
      DevTaskState.IMPLEMENTING,
      DevTaskState.PULL_REQUEST,
      DevTaskState.REVIEWING,
      DevTaskState.AWAITING_REVIEW,
      DevTaskState.REJECTED,
    ]);
  });

  test('matches STATE_TRANSITIONS for every state', () => {
    const allStates = Object.values(DevTaskState);
    for (const s of allStates) {
      expect(getAllowedTransitions(s)).toEqual(STATE_TRANSITIONS[s]);
    }
  });
});

// ─────────────────────────────────────────────
// isTerminalState
// ─────────────────────────────────────────────
describe('isTerminalState', () => {
  test('COMPLETED is terminal', () => {
    expect(isTerminalState(DevTaskState.COMPLETED)).toBe(true);
  });

  test('REJECTED is terminal', () => {
    expect(isTerminalState(DevTaskState.REJECTED)).toBe(true);
  });

  test('FAILED is terminal', () => {
    expect(isTerminalState(DevTaskState.FAILED)).toBe(true);
  });

  test('non-terminal states return false', () => {
    const nonTerminal = [
      DevTaskState.PENDING, DevTaskState.CLARIFYING, DevTaskState.DESIGNING,
      DevTaskState.APPROVAL, DevTaskState.IMPLEMENTING, DevTaskState.TESTING,
      DevTaskState.PULL_REQUEST, DevTaskState.REVIEWING, DevTaskState.UPDATING,
    ];
    for (const s of nonTerminal) {
      expect(isTerminalState(s)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────
// isWaitingForUser
// ─────────────────────────────────────────────
describe('isWaitingForUser', () => {
  test('APPROVAL is waiting for user', () => {
    expect(isWaitingForUser(DevTaskState.APPROVAL)).toBe(true);
  });

  test('CLARIFYING is waiting for user', () => {
    expect(isWaitingForUser(DevTaskState.CLARIFYING)).toBe(true);
  });

  test('automated states are not waiting for user', () => {
    const automated = [
      DevTaskState.PENDING, DevTaskState.DESIGNING, DevTaskState.IMPLEMENTING,
      DevTaskState.TESTING, DevTaskState.PULL_REQUEST, DevTaskState.REVIEWING,
      DevTaskState.UPDATING, DevTaskState.COMPLETED, DevTaskState.REJECTED,
      DevTaskState.FAILED,
    ];
    for (const s of automated) {
      expect(isWaitingForUser(s)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────
// isResumableState
// ─────────────────────────────────────────────
describe('isResumableState', () => {
  test('resumable states return true', () => {
    const resumable = [
      DevTaskState.PENDING, DevTaskState.DESIGNING, DevTaskState.IMPLEMENTING,
      DevTaskState.TESTING, DevTaskState.PULL_REQUEST, DevTaskState.REVIEWING,
      DevTaskState.UPDATING,
    ];
    for (const s of resumable) {
      expect(isResumableState(s)).toBe(true);
    }
  });

  test('non-resumable states return false', () => {
    const notResumable = [
      DevTaskState.CLARIFYING, DevTaskState.APPROVAL,
      DevTaskState.COMPLETED, DevTaskState.REJECTED, DevTaskState.FAILED,
    ];
    for (const s of notResumable) {
      expect(isResumableState(s)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────
// validateTransition
// ─────────────────────────────────────────────
describe('validateTransition', () => {
  test('valid transition does not throw', () => {
    expect(() => validateTransition(1, DevTaskState.PENDING, DevTaskState.DESIGNING)).not.toThrow();
  });

  test('invalid transition throws with descriptive message', () => {
    expect(() => validateTransition(1, DevTaskState.PENDING, DevTaskState.COMPLETED)).toThrow(
      'Invalid state transition'
    );
  });

  test('transition from terminal state throws', () => {
    expect(() => validateTransition(1, DevTaskState.COMPLETED, DevTaskState.PENDING)).toThrow(
      'Invalid state transition'
    );
  });
});
