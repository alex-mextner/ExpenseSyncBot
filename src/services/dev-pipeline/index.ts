/**
 * Dev Pipeline — self-modifying bot infrastructure.
 *
 * Re-exports everything needed by consumers.
 */

export { DevPipeline, type NotifyCallback } from './pipeline';
export {
  DevTaskState,
  STATE_TRANSITIONS,
  STATE_LABELS,
  STATE_EMOJI,
  PROTECTED_FILES,
  MAX_RETRY_ATTEMPTS,
  type DevTask,
  type CreateDevTaskData,
  type UpdateDevTaskData,
} from './types';
export {
  isTransitionAllowed,
  getAllowedTransitions,
  validateTransition,
  isTerminalState,
  isWaitingForUser,
  isResumableState,
} from './state-machine';
export {
  createWorktree,
  removeWorktree,
  worktreeExists,
  commitChanges,
  pushBranch,
  createPR,
  mergePR,
  getCurrentDiff,
  getDiffFromMain,
  generateBranchName,
} from './git-ops';
export {
  validateFilePath,
  readFile,
  writeFile,
  listDirectory,
  searchCode,
  fileExists,
  deleteFile,
} from './file-ops';
export { runCodexReview } from './codex-integration';
