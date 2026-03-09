/**
 * Git operations for the dev pipeline.
 *
 * Uses Bun.$ (Bun Shell) for all git/gh operations.
 * IMPORTANT: Uses `git worktree` — never `git checkout` on the main worktree.
 * The bot runs from the main worktree, so we create separate worktrees
 * for each task to avoid disturbing the running process.
 */

import { $ } from 'bun';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Get the root of the current git repository
 */
export async function getRepoRoot(): Promise<string> {
  const result = await $`git rev-parse --show-toplevel`.text();
  return result.trim();
}

/**
 * Base directory for worktrees, relative to the repo
 */
const WORKTREE_BASE_DIR = '.claude/worktrees';

/**
 * Create a git worktree for a dev task.
 *
 * Creates a new branch and a worktree directory for isolated work.
 * The worktree survives bot restarts (it's just a directory on disk).
 *
 * @param branchName - The branch name (e.g., "dev/add-weekly-summary-42")
 * @returns The absolute path to the worktree directory
 */
export async function createWorktree(branchName: string): Promise<string> {
  const repoRoot = await getRepoRoot();
  const worktreePath = path.join(repoRoot, WORKTREE_BASE_DIR, branchName);

  // Check if worktree already exists
  if (existsSync(worktreePath)) {
    console.log(`[GIT-OPS] Worktree already exists at ${worktreePath}`);
    return worktreePath;
  }

  // Create the worktree with a new branch from main
  await $`git worktree add -b ${branchName} ${worktreePath} main`.quiet();

  console.log(
    `[GIT-OPS] Created worktree: ${worktreePath} (branch: ${branchName})`
  );
  return worktreePath;
}

/**
 * Remove a git worktree and its branch.
 *
 * @param worktreePath - Absolute path to the worktree
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) {
    console.log(`[GIT-OPS] Worktree not found at ${worktreePath}, skipping`);
    return;
  }

  try {
    await $`git worktree remove ${worktreePath} --force`.quiet();
    console.log(`[GIT-OPS] Removed worktree: ${worktreePath}`);
  } catch (error) {
    console.error(`[GIT-OPS] Failed to remove worktree: ${worktreePath}`, error);
  }
}

/**
 * Check if a worktree exists on disk
 */
export function worktreeExists(worktreePath: string): boolean {
  return existsSync(worktreePath);
}

/**
 * Stage and commit all changes in a worktree.
 *
 * @param worktreePath - Absolute path to the worktree
 * @param message - Commit message
 */
export async function commitChanges(
  worktreePath: string,
  message: string
): Promise<void> {
  // Stage all changes
  await $`git -C ${worktreePath} add -A`.quiet();

  // Check if there's anything to commit
  const status = await $`git -C ${worktreePath} status --porcelain`.text();

  if (!status.trim()) {
    console.log('[GIT-OPS] Nothing to commit');
    return;
  }

  // Commit
  await $`git -C ${worktreePath} commit -m ${message}`.quiet();
  console.log(`[GIT-OPS] Committed: ${message}`);
}

/**
 * Push a branch to origin.
 *
 * @param worktreePath - Absolute path to the worktree
 * @param branchName - Branch name to push
 */
export async function pushBranch(
  worktreePath: string,
  branchName: string
): Promise<void> {
  await $`git -C ${worktreePath} push -u origin ${branchName}`.quiet();
  console.log(`[GIT-OPS] Pushed branch: ${branchName}`);
}

/**
 * Create a pull request on GitHub using the `gh` CLI.
 *
 * @returns Object with PR number and URL
 */
export async function createPR(
  worktreePath: string,
  title: string,
  body: string,
  baseBranch: string = 'main'
): Promise<{ number: number; url: string }> {
  const result = await $`gh pr create \
    --title ${title} \
    --body ${body} \
    --base ${baseBranch} \
    --repo $(git -C ${worktreePath} remote get-url origin) \
    --head $(git -C ${worktreePath} rev-parse --abbrev-ref HEAD)`.text();

  const url = result.trim();

  // Extract PR number from URL (last segment)
  const prNumberMatch = url.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch?.[1] ? parseInt(prNumberMatch[1], 10) : 0;

  console.log(`[GIT-OPS] Created PR #${prNumber}: ${url}`);

  return { number: prNumber, url };
}

/**
 * Merge a pull request on GitHub using the `gh` CLI.
 *
 * Uses squash merge by default.
 *
 * @param prNumber - PR number to merge
 */
export async function mergePR(prNumber: number): Promise<void> {
  const repoRoot = await getRepoRoot();
  await $`gh pr merge ${prNumber} --squash --delete-branch --repo $(git -C ${repoRoot} remote get-url origin)`.quiet();
  console.log(`[GIT-OPS] Merged PR #${prNumber}`);
}

/**
 * Get the current diff in a worktree (staged + unstaged).
 *
 * @returns The diff as a string
 */
export async function getCurrentDiff(worktreePath: string): Promise<string> {
  // Get both staged and unstaged changes
  const staged =
    await $`git -C ${worktreePath} diff --cached`.text();
  const unstaged = await $`git -C ${worktreePath} diff`.text();

  // Also get untracked files
  const untracked =
    await $`git -C ${worktreePath} ls-files --others --exclude-standard`.text();

  let result = '';

  if (staged.trim()) {
    result += '=== STAGED CHANGES ===\n' + staged + '\n';
  }

  if (unstaged.trim()) {
    result += '=== UNSTAGED CHANGES ===\n' + unstaged + '\n';
  }

  if (untracked.trim()) {
    result += '=== UNTRACKED FILES ===\n' + untracked + '\n';
  }

  return result;
}

/**
 * Get full diff between the task branch and main.
 *
 * @returns The diff as a string
 */
export async function getDiffFromMain(worktreePath: string): Promise<string> {
  const diff =
    await $`git -C ${worktreePath} diff main...HEAD`.text();
  return diff;
}

/**
 * Generate a safe branch name from a task description.
 *
 * @param taskId - The task ID
 * @param description - The task description
 * @returns A sanitized branch name like "dev/add-weekly-summary-42"
 */
export function generateBranchName(
  taskId: number,
  description: string
): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');

  return `dev/${slug}-${taskId}`;
}
