/**
 * Git operations for the dev pipeline.
 *
 * Uses Bun.$ for git CLI and Octokit for GitHub API (PR create/merge).
 * IMPORTANT: Uses `git worktree` — never `git checkout` on the main worktree.
 * The bot runs from the main worktree, so we create separate worktrees
 * for each task to avoid disturbing the running process.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import { $ } from 'bun';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('git-ops');

/**
 * Get the root of the current git repository.
 * Uses import.meta.dir as fallback cwd if the process cwd is not inside a git repo.
 */
export async function getRepoRoot(): Promise<string> {
  try {
    const result = await $`git rev-parse --show-toplevel`.text();
    return result.trim();
  } catch {
    // Fallback: resolve from this file's location (src/services/dev-pipeline/)
    const fallbackDir = path.resolve(import.meta.dir, '../../..');
    const result = await $`git -C ${fallbackDir} rev-parse --show-toplevel`.text();
    return result.trim();
  }
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

  // Check if worktree already exists and is valid
  if (existsSync(worktreePath)) {
    const gitFile = path.join(worktreePath, '.git');
    if (existsSync(gitFile)) {
      // Verify it's actually a working git worktree
      const check = await $`git -C ${worktreePath} rev-parse --git-dir`.nothrow().quiet();
      if (check.exitCode === 0) {
        logger.info(`[GIT-OPS] Worktree already exists at ${worktreePath}`);
        return worktreePath;
      }
    }
    // Directory exists but .git is broken — clean up and recreate
    logger.info(`[GIT-OPS] Broken worktree at ${worktreePath}, cleaning up...`);
    await $`git worktree remove ${worktreePath} --force`.nothrow().quiet();
    await $`rm -rf ${worktreePath}`.nothrow().quiet();
    // Also prune stale worktree entries
    await $`git worktree prune`.nothrow().quiet();
  }

  // Delete stale local branch if it exists (from a previous failed run)
  await $`git branch -D ${branchName}`.nothrow().quiet();

  // Create the worktree with a new branch from main
  await $`git worktree add -b ${branchName} ${worktreePath} main`.quiet();

  // Create data/ dir for SQLite (DATABASE_PATH is relative)
  await $`mkdir -p ${path.join(worktreePath, 'data')}`.quiet().nothrow();

  logger.info(`[GIT-OPS] Created worktree: ${worktreePath} (branch: ${branchName})`);
  return worktreePath;
}

/**
 * Remove a git worktree (directory only, does not delete the branch).
 *
 * @param worktreePath - Absolute path to the worktree
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) {
    logger.info(`[GIT-OPS] Worktree not found at ${worktreePath}, skipping`);
    return;
  }

  try {
    await $`git worktree remove ${worktreePath} --force`.quiet();
    logger.info(`[GIT-OPS] Removed worktree: ${worktreePath}`);
  } catch (error) {
    logger.error({ err: error }, '[GIT-OPS] Failed to remove worktree: ${worktreePath}');
  }
}

/**
 * Delete a local git branch.
 *
 * Safe to call even if the branch doesn't exist — fails silently.
 *
 * @param branchName - Branch name to delete (e.g., "dev/add-feature-42")
 */
export async function deleteLocalBranch(branchName: string): Promise<void> {
  try {
    await $`git branch -D ${branchName}`.quiet();
    logger.info(`[GIT-OPS] Deleted local branch: ${branchName}`);
  } catch {
    // Branch may not exist or already deleted — that's fine
    logger.info(`[GIT-OPS] Branch ${branchName} not found or already deleted`);
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
export async function commitChanges(worktreePath: string, message: string): Promise<void> {
  // Stage all changes
  await $`git -C ${worktreePath} add -A`.quiet();

  // Check if there's anything to commit
  const status = await $`git -C ${worktreePath} status --porcelain`.text();

  if (!status.trim()) {
    logger.info('[GIT-OPS] Nothing to commit');
    return;
  }

  // Commit
  await $`git -C ${worktreePath} commit -m ${message}`.quiet();
  logger.info(`[GIT-OPS] Committed: ${message}`);
}

/**
 * Push a branch to origin.
 *
 * @param worktreePath - Absolute path to the worktree
 * @param branchName - Branch name to push
 */
export async function pushBranch(worktreePath: string, branchName: string): Promise<void> {
  const result = await $`git -C ${worktreePath} push -u origin ${branchName}`.nothrow().quiet();
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`git push failed (exit ${result.exitCode}): ${stderr}`);
  }
  logger.info(`[GIT-OPS] Pushed branch: ${branchName}`);
}

/**
 * Parse GitHub owner/repo from a git remote URL.
 */
function parseGitHubRepo(remoteUrl: string): { owner: string; repo: string } {
  // Handle both SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git)
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!match) {
    throw new Error(`Cannot parse GitHub owner/repo from remote URL: ${remoteUrl}`);
  }
  return { owner: match[1]!, repo: match[2]! };
}

/**
 * Get a configured Octokit instance.
 */
function getOctokit(): Octokit {
  if (!env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not set — required for PR operations');
  }
  return new Octokit({ auth: env.GITHUB_TOKEN });
}

/**
 * Create a pull request on GitHub via Octokit API.
 *
 * @returns Object with PR number and URL
 */
export async function createPR(
  worktreePath: string,
  title: string,
  body: string,
  baseBranch: string = 'main',
): Promise<{ number: number; url: string }> {
  const remoteUrl = (await $`git -C ${worktreePath} remote get-url origin`.text()).trim();
  const head = (await $`git -C ${worktreePath} rev-parse --abbrev-ref HEAD`.text()).trim();
  const { owner, repo } = parseGitHubRepo(remoteUrl);

  const octokit = getOctokit();
  const { data } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    base: baseBranch,
    head,
  });

  logger.info(`[GIT-OPS] Created PR #${data.number}: ${data.html_url}`);
  return { number: data.number, url: data.html_url };
}

/**
 * Merge a pull request on GitHub via Octokit API.
 *
 * Uses squash merge and deletes the branch after merge.
 *
 * @param prNumber - PR number to merge
 */
export async function mergePR(prNumber: number): Promise<void> {
  const repoRoot = await getRepoRoot();
  const remoteUrl = (await $`git -C ${repoRoot} remote get-url origin`.text()).trim();
  const { owner, repo } = parseGitHubRepo(remoteUrl);

  const octokit = getOctokit();

  // Squash merge the PR
  await octokit.pulls.merge({
    owner,
    repo,
    pull_number: prNumber,
    merge_method: 'squash',
  });

  // Delete the remote branch
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  try {
    await octokit.git.deleteRef({ owner, repo, ref: `heads/${pr.head.ref}` });
  } catch {
    // Branch may already be deleted — that's fine
  }

  logger.info(`[GIT-OPS] Merged PR #${prNumber}`);
}

/**
 * Get the current diff in a worktree (staged + unstaged).
 *
 * @returns The diff as a string
 */
export async function getCurrentDiff(worktreePath: string): Promise<string> {
  // Get both staged and unstaged changes
  const staged = await $`git -C ${worktreePath} diff --cached`.text();
  const unstaged = await $`git -C ${worktreePath} diff`.text();

  // Also get untracked files
  const untracked = await $`git -C ${worktreePath} ls-files --others --exclude-standard`.text();

  let result = '';

  if (staged.trim()) {
    result += `=== STAGED CHANGES ===\n${staged}\n`;
  }

  if (unstaged.trim()) {
    result += `=== UNSTAGED CHANGES ===\n${unstaged}\n`;
  }

  if (untracked.trim()) {
    result += `=== UNTRACKED FILES ===\n${untracked}\n`;
  }

  return result;
}

/**
 * Get full diff between the task branch and main.
 *
 * @returns The diff as a string
 */
export async function getDiffFromMain(worktreePath: string): Promise<string> {
  const diff = await $`git -C ${worktreePath} diff main...HEAD`.text();
  return diff;
}

/**
 * Get list of files changed in worktree compared to main.
 */
export async function getChangedFilesFromMain(worktreePath: string): Promise<string[]> {
  // Committed changes
  const committed = await $`git -C ${worktreePath} diff main --name-only`.nothrow().quiet().text();
  // Uncommitted changes (staged + unstaged + untracked)
  const unstaged = await $`git -C ${worktreePath} diff --name-only`.nothrow().quiet().text();
  const untracked = await $`git -C ${worktreePath} ls-files --others --exclude-standard`
    .nothrow()
    .quiet()
    .text();

  const all = new Set(
    [committed, unstaged, untracked]
      .join('\n')
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean),
  );
  return [...all];
}

/**
 * Revert a file in worktree to its main branch version.
 */
export async function revertFileToMain(worktreePath: string, filePath: string): Promise<void> {
  // Check if file exists on main
  const existsOnMain = await $`git -C ${worktreePath} cat-file -e main:${filePath}`
    .nothrow()
    .quiet();

  if (existsOnMain.exitCode === 0) {
    // File exists on main — restore it
    await $`git -C ${worktreePath} checkout main -- ${filePath}`.quiet();
    logger.info(`[GIT-OPS] Reverted to main: ${filePath}`);
  } else {
    // File doesn't exist on main — it was created by agent, delete it
    const absolutePath = path.resolve(worktreePath, filePath);
    if (existsSync(absolutePath)) {
      await $`rm ${absolutePath}`.quiet();
      logger.info(`[GIT-OPS] Deleted (not on main): ${filePath}`);
    }
  }
}

/**
 * Generate a safe branch name from a task description.
 *
 * @param taskId - The task ID
 * @param description - The task description
 * @returns A sanitized branch name like "dev/add-weekly-summary-42"
 */
export function generateBranchName(taskId: number, description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');

  return `dev/${slug}-${taskId}`;
}

/** Validate package name to prevent shell injection */
const VALID_PACKAGE_RE = /^(@[\w.-]+\/)?[\w.-]+(@[\w.*^~<>=|-]+)?$/;

/** Install or remove packages in a worktree */
export async function managePackages(
  worktreePath: string,
  action: 'add' | 'remove',
  packages: string,
): Promise<string> {
  const names = packages.split(/\s+/).filter(Boolean);
  if (names.length === 0) {
    throw new Error('No package names provided');
  }

  for (const name of names) {
    if (!VALID_PACKAGE_RE.test(name)) {
      throw new Error(`Invalid package name: ${name}`);
    }
  }

  const result =
    action === 'add'
      ? await $`cd ${worktreePath} && bun add ${names}`.nothrow().quiet()
      : await $`cd ${worktreePath} && bun remove ${names}`.nothrow().quiet();

  const output = result.text();

  if (result.exitCode !== 0) {
    throw new Error(`bun ${action} failed (exit ${result.exitCode}): ${output}`);
  }

  logger.info(`[GIT-OPS] bun ${action} ${names.join(' ')} — success`);
  return output || `${action === 'add' ? 'Installed' : 'Removed'}: ${names.join(', ')}`;
}
