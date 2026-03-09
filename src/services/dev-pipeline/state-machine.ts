/**
 * State machine for dev task lifecycle.
 *
 * Validates transitions and logs state changes.
 * Keeps things boring and predictable — exactly what you want
 * from code that modifies its own codebase.
 */

import {
  DevTaskState,
  STATE_TRANSITIONS,
  STATE_LABELS,
  type DevTask,
  type UpdateDevTaskData,
} from './types';
import { database } from '../../database';

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
 * Transition a task to a new state.
 * Throws if the transition is not allowed.
 *
 * @returns The updated task
 */
export function transition(
  task: DevTask,
  newState: DevTaskState,
  extra?: Partial<UpdateDevTaskData>
): DevTask {
  if (!isTransitionAllowed(task.state, newState)) {
    const from = STATE_LABELS[task.state];
    const to = STATE_LABELS[newState];
    throw new Error(
      `Invalid state transition: ${from} (${task.state}) -> ${to} (${newState}) for task #${task.id}`
    );
  }

  const updateData: UpdateDevTaskData = {
    ...extra,
    state: newState,
  };

  console.log(
    `[DEV-PIPELINE] Task #${task.id}: ${task.state} -> ${newState}`
  );

  const updated = database.devTasks.update(task.id, updateData);

  if (!updated) {
    throw new Error(`Failed to update task #${task.id}`);
  }

  return updated;
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
