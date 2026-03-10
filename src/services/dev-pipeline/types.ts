/**
 * Dev Pipeline types
 *
 * Self-modifying bot pipeline for autonomous code development.
 * The bot receives a task via Telegram, creates a worktree,
 * writes code, runs tests, creates a PR, and merges it.
 */

/**
 * All possible states for a dev task
 */
export enum DevTaskState {
  /** Initial state — task just created */
  PENDING = 'pending',
  /** AI is asking clarifying questions */
  CLARIFYING = 'clarifying',
  /** AI is designing the solution */
  DESIGNING = 'designing',
  /** Waiting for user approval of the design */
  APPROVAL = 'approval',
  /** AI is implementing the solution in a worktree */
  IMPLEMENTING = 'implementing',
  /** Running tests and type checks */
  TESTING = 'testing',
  /** Creating a GitHub pull request */
  PULL_REQUEST = 'pull_request',
  /** Code review (automated or manual) */
  REVIEWING = 'reviewing',
  /** Addressing review feedback */
  UPDATING = 'updating',
  /** Task completed and merged */
  COMPLETED = 'completed',
  /** Task rejected by user */
  REJECTED = 'rejected',
  /** Task failed after max retries */
  FAILED = 'failed',
}

/**
 * Valid state transitions map.
 * Key = current state, value = array of allowed next states.
 */
export const STATE_TRANSITIONS: Record<DevTaskState, DevTaskState[]> = {
  [DevTaskState.PENDING]: [DevTaskState.CLARIFYING, DevTaskState.DESIGNING, DevTaskState.REJECTED],
  [DevTaskState.CLARIFYING]: [DevTaskState.DESIGNING, DevTaskState.REJECTED],
  [DevTaskState.DESIGNING]: [DevTaskState.APPROVAL, DevTaskState.FAILED, DevTaskState.REJECTED],
  [DevTaskState.APPROVAL]: [DevTaskState.IMPLEMENTING, DevTaskState.REJECTED, DevTaskState.DESIGNING],
  [DevTaskState.IMPLEMENTING]: [DevTaskState.TESTING, DevTaskState.FAILED, DevTaskState.REJECTED],
  [DevTaskState.TESTING]: [DevTaskState.PULL_REQUEST, DevTaskState.IMPLEMENTING, DevTaskState.FAILED, DevTaskState.REJECTED],
  [DevTaskState.PULL_REQUEST]: [DevTaskState.REVIEWING, DevTaskState.FAILED, DevTaskState.REJECTED],
  [DevTaskState.REVIEWING]: [DevTaskState.UPDATING, DevTaskState.COMPLETED, DevTaskState.FAILED, DevTaskState.REJECTED],
  [DevTaskState.UPDATING]: [DevTaskState.TESTING, DevTaskState.FAILED, DevTaskState.REJECTED],
  [DevTaskState.COMPLETED]: [],
  [DevTaskState.REJECTED]: [],
  [DevTaskState.FAILED]: [DevTaskState.PENDING, DevTaskState.DESIGNING, DevTaskState.IMPLEMENTING, DevTaskState.REJECTED],
};

/**
 * Dev task record (matches dev_tasks DB table)
 */
export interface DevTask {
  id: number;
  group_id: number;
  user_id: number;
  state: DevTaskState;
  title: string | null;
  description: string;
  branch_name: string | null;
  worktree_path: string | null;
  pr_number: number | null;
  pr_url: string | null;
  design: string | null;
  plan: string | null;
  code_review: string | null;
  error_log: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface CreateDevTaskData {
  group_id: number;
  user_id: number;
  description: string;
  title?: string;
}

export interface UpdateDevTaskData {
  state?: DevTaskState;
  title?: string;
  branch_name?: string;
  worktree_path?: string;
  pr_number?: number;
  pr_url?: string;
  design?: string;
  plan?: string;
  code_review?: string;
  error_log?: string;
  retry_count?: number;
}

/**
 * Files and directories the pipeline must NEVER modify.
 * Self-referential protection: the bot cannot edit its own pipeline code,
 * migration files, or CI config.
 */
export const PROTECTED_FILES = [
  'src/services/dev-pipeline/',
  'src/database/schema.ts',
  '.github/',
] as const;

/**
 * Maximum retry attempts for test failures before marking as failed
 */
export const MAX_RETRY_ATTEMPTS = 15;

/**
 * Human-readable state labels (Russian)
 */
export const STATE_LABELS: Record<DevTaskState, string> = {
  [DevTaskState.PENDING]: 'Ожидание',
  [DevTaskState.CLARIFYING]: 'Уточнение',
  [DevTaskState.DESIGNING]: 'Проектирование',
  [DevTaskState.APPROVAL]: 'Ожидание одобрения',
  [DevTaskState.IMPLEMENTING]: 'Реализация',
  [DevTaskState.TESTING]: 'Тестирование',
  [DevTaskState.PULL_REQUEST]: 'Создание PR',
  [DevTaskState.REVIEWING]: 'Код-ревью',
  [DevTaskState.UPDATING]: 'Доработка',
  [DevTaskState.COMPLETED]: 'Завершено',
  [DevTaskState.REJECTED]: 'Отклонено',
  [DevTaskState.FAILED]: 'Ошибка',
};

/**
 * State emoji for display
 */
export const STATE_EMOJI: Record<DevTaskState, string> = {
  [DevTaskState.PENDING]: '🔵',
  [DevTaskState.CLARIFYING]: '💬',
  [DevTaskState.DESIGNING]: '📐',
  [DevTaskState.APPROVAL]: '⏳',
  [DevTaskState.IMPLEMENTING]: '🔨',
  [DevTaskState.TESTING]: '🧪',
  [DevTaskState.PULL_REQUEST]: '📤',
  [DevTaskState.REVIEWING]: '🔍',
  [DevTaskState.UPDATING]: '🔄',
  [DevTaskState.COMPLETED]: '✅',
  [DevTaskState.REJECTED]: '❌',
  [DevTaskState.FAILED]: '💥',
};
