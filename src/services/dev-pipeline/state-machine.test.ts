import { test, expect, describe, mock, beforeEach } from 'bun:test';
import { DevTaskState, STATE_TRANSITIONS, type DevTask } from './types';

// Mock the database module before importing state-machine
const mockUpdate = mock(() => null as DevTask | null);

mock.module('../../database', () => ({
  database: {
    devTasks: {
      update: mockUpdate,
    },
  },
}));

import {
  isTransitionAllowed,
  isTerminalState,
  isWaitingForUser,
  isResumableState,
  getAllowedTransitions,
  transition,
} from './state-machine';

/** Helper: create a fake DevTask with given state */
function makeTask(state: DevTaskState, id = 1): DevTask {
  return {
    id,
    group_id: 100,
    user_id: 200,
    state,
    title: 'Test task',
    description: 'Do something',
    branch_name: null,
    worktree_path: null,
    pr_number: null,
    pr_url: null,
    design: null,
    plan: null,
    code_review: null,
    error_log: null,
    retry_count: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  };
}

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

  test('REVIEWING -> COMPLETED is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.REVIEWING, DevTaskState.COMPLETED)).toBe(true);
  });

  test('REVIEWING -> UPDATING is allowed', () => {
    expect(isTransitionAllowed(DevTaskState.REVIEWING, DevTaskState.UPDATING)).toBe(true);
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
      // Only allowed if explicitly in STATE_TRANSITIONS[s]
      const allowed = STATE_TRANSITIONS[s].includes(s);
      expect(isTransitionAllowed(s, s)).toBe(allowed);
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
    ]);
  });

  test('returns empty array for terminal state COMPLETED', () => {
    expect(getAllowedTransitions(DevTaskState.COMPLETED)).toEqual([]);
  });

  test('returns empty array for terminal state REJECTED', () => {
    expect(getAllowedTransitions(DevTaskState.REJECTED)).toEqual([]);
  });

  test('FAILED can only transition to PENDING', () => {
    expect(getAllowedTransitions(DevTaskState.FAILED)).toEqual([DevTaskState.PENDING]);
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
      DevTaskState.PENDING,
      DevTaskState.CLARIFYING,
      DevTaskState.DESIGNING,
      DevTaskState.APPROVAL,
      DevTaskState.IMPLEMENTING,
      DevTaskState.TESTING,
      DevTaskState.PULL_REQUEST,
      DevTaskState.REVIEWING,
      DevTaskState.UPDATING,
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
      DevTaskState.PENDING,
      DevTaskState.DESIGNING,
      DevTaskState.IMPLEMENTING,
      DevTaskState.TESTING,
      DevTaskState.PULL_REQUEST,
      DevTaskState.REVIEWING,
      DevTaskState.UPDATING,
      DevTaskState.COMPLETED,
      DevTaskState.REJECTED,
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
      DevTaskState.PENDING,
      DevTaskState.DESIGNING,
      DevTaskState.IMPLEMENTING,
      DevTaskState.TESTING,
      DevTaskState.PULL_REQUEST,
      DevTaskState.REVIEWING,
      DevTaskState.UPDATING,
    ];
    for (const s of resumable) {
      expect(isResumableState(s)).toBe(true);
    }
  });

  test('non-resumable states return false', () => {
    const notResumable = [
      DevTaskState.CLARIFYING,
      DevTaskState.APPROVAL,
      DevTaskState.COMPLETED,
      DevTaskState.REJECTED,
      DevTaskState.FAILED,
    ];
    for (const s of notResumable) {
      expect(isResumableState(s)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────
// transition
// ─────────────────────────────────────────────
describe('transition', () => {
  beforeEach(() => {
    mockUpdate.mockReset();
  });

  test('valid transition updates task state and returns updated task', () => {
    const task = makeTask(DevTaskState.PENDING);
    const updatedTask = { ...task, state: DevTaskState.DESIGNING, updated_at: '2026-01-02' };
    mockUpdate.mockReturnValueOnce(updatedTask);

    const result = transition(task, DevTaskState.DESIGNING);

    expect(result).toEqual(updatedTask);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(task.id, { state: DevTaskState.DESIGNING });
  });

  test('valid transition with extra data passes it to update', () => {
    const task = makeTask(DevTaskState.DESIGNING);
    const updatedTask = { ...task, state: DevTaskState.APPROVAL, design: 'Some design' };
    mockUpdate.mockReturnValueOnce(updatedTask);

    const result = transition(task, DevTaskState.APPROVAL, { design: 'Some design' });

    expect(result).toEqual(updatedTask);
    expect(mockUpdate).toHaveBeenCalledWith(task.id, {
      state: DevTaskState.APPROVAL,
      design: 'Some design',
    });
  });

  test('invalid transition throws an error', () => {
    const task = makeTask(DevTaskState.PENDING);

    expect(() => transition(task, DevTaskState.COMPLETED)).toThrow('Invalid state transition');
  });

  test('invalid transition does not call database update', () => {
    const task = makeTask(DevTaskState.PENDING);

    try {
      transition(task, DevTaskState.COMPLETED);
    } catch {
      // expected
    }

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('throws when database update returns null', () => {
    const task = makeTask(DevTaskState.PENDING);
    mockUpdate.mockReturnValueOnce(null);

    expect(() => transition(task, DevTaskState.DESIGNING)).toThrow(
      `Failed to update task #${task.id}`
    );
  });

  test('transition from terminal state throws', () => {
    const task = makeTask(DevTaskState.COMPLETED);

    expect(() => transition(task, DevTaskState.PENDING)).toThrow('Invalid state transition');
  });
});
