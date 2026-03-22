/**
 * Dev Pipeline — self-modifying bot infrastructure.
 *
 * Re-exports everything needed by consumers.
 */

export { runCodexReview } from './codex-integration';
export {
  deleteFile,
  fileExists,
  listDirectory,
  readFile,
  searchCode,
  validateFilePath,
  writeFile,
} from './file-ops';
export {
  commitChanges,
  createPR,
  createWorktree,
  generateBranchName,
  getCurrentDiff,
  getDiffFromMain,
  mergePR,
  pushBranch,
  removeWorktree,
  worktreeExists,
} from './git-ops';
export { DevPipeline, type NotifyCallback } from './pipeline';
export {
  getAllowedTransitions,
  isResumableState,
  isTerminalState,
  isTransitionAllowed,
  isWaitingForUser,
  validateTransition,
} from './state-machine';
export {
  type CreateDevTaskData,
  type DevTask,
  DevTaskState,
  MAX_RETRY_ATTEMPTS,
  PROTECTED_FILES,
  STATE_EMOJI,
  STATE_LABELS,
  STATE_TRANSITIONS,
  type UpdateDevTaskData,
} from './types';
