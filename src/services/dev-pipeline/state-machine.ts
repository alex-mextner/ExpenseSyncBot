/**
 * State machine for dev task lifecycle.
 *
 * Pure functions only — no database imports.
 * The actual DB persistence happens in pipeline.ts via transition().
 */

import {
  DevTaskState,
  STATE_TRANSITIONS,
  STATE_LABELS,
} from './types';

/**
 * Check if a state transition is allowed
 */
export function isTransitionAllowed(
  currentState: DevTaskState,
  newState: DevTaskState
): boolean {
  const allowed = STATE_TRANSITIONS[currentState];
  return allowed.includes(newState);
}

/**
 * Get all allowed transitions from current state
 */
export function getAllowedTransitions(
  currentState: DevTaskState
): DevTaskState[] {
  return STATE_TRANSITIONS[currentState];
}

/**
 * Validate a state transition, throw if not allowed.
 */
export function validateTransition(
  taskId: number,
  currentState: DevTaskState,
  newState: DevTaskState
): void {
  if (!isTransitionAllowed(currentState, newState)) {
    const from = STATE_LABELS[currentState];
    const to = STATE_LABELS[newState];
    throw new Error(
      `Invalid state transition: ${from} (${currentState}) -> ${to} (${newState}) for task #${taskId}`
    );
  }
}

/**
 * Check if a task is in a terminal state (completed, rejected, or failed)
 */
export function isTerminalState(state: DevTaskState): boolean {
  return (
    state === DevTaskState.COMPLETED ||
    state === DevTaskState.REJECTED ||
    state === DevTaskState.FAILED
  );
}

/**
 * Check if a task is in a state that requires user interaction
 */
export function isWaitingForUser(state: DevTaskState): boolean {
  return (
    state === DevTaskState.APPROVAL ||
    state === DevTaskState.CLARIFYING
  );
}

/**
 * Check if a task can be automatically resumed after bot restart
 */
export function isResumableState(state: DevTaskState): boolean {
  return (
    state === DevTaskState.PENDING ||
    state === DevTaskState.DESIGNING ||
    state === DevTaskState.IMPLEMENTING ||
    state === DevTaskState.TESTING ||
    state === DevTaskState.PULL_REQUEST ||
    state === DevTaskState.REVIEWING ||
    state === DevTaskState.UPDATING
  );
}
