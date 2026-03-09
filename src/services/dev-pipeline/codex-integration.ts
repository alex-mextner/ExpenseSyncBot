/**
 * Codex CLI integration for automated code review.
 *
 * Uses claude code in --full-auto mode for code review.
 * NOTE: /review slash commands do NOT work in codex exec mode —
 * we use regular prompts with the diff passed inline.
 */

import { $ } from 'bun';

/**
 * Run a code review on a diff using Claude Code CLI.
 *
 * Sends the diff as part of a prompt (not as a slash command).
 *
 * @param diff - The git diff to review
 * @returns Review comments as a string
 */
export async function runCodexReview(diff: string): Promise<string> {
  if (!diff.trim()) {
    return 'No changes to review.';
  }

  // Truncate very large diffs to avoid token limits
  const maxDiffLength = 50000;
  const truncatedDiff =
    diff.length > maxDiffLength
      ? diff.slice(0, maxDiffLength) + '\n\n[... diff truncated ...]'
      : diff;

  const prompt = `Review this code diff. Focus on:
1. Bugs or logic errors
2. Security issues (especially path traversal, injection)
3. Missing error handling
4. TypeScript type safety issues
5. Performance concerns

Be concise. List issues as bullet points. If the code looks good, say so.

\`\`\`diff
${truncatedDiff}
\`\`\``;

  try {
    const result =
      await $`echo ${prompt} | claude --print`.text();
    return result.trim();
  } catch (error) {
    console.error('[CODEX] Review failed:', error);
    return `Review failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Ask Claude Code to implement a feature in a worktree.
 *
 * Uses --full-auto mode which means no interactive prompts.
 *
 * @param worktreePath - Absolute path to the worktree
 * @param prompt - What to implement
 * @returns Claude's response
 */
export async function runCodexImplement(
  worktreePath: string,
  prompt: string
): Promise<string> {
  try {
    const result =
      await $`cd ${worktreePath} && echo ${prompt} | claude --print`.text();
    return result.trim();
  } catch (error) {
    console.error('[CODEX] Implementation failed:', error);
    return `Implementation failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
