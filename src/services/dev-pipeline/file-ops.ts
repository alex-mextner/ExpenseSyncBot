/**
 * File operations for the dev pipeline.
 *
 * All file operations are scoped to a worktree directory.
 * Includes path traversal protection and PROTECTED_FILES enforcement.
 * The bot must not be able to modify its own pipeline code — that way
 * lies recursive self-improvement, and we're not ready for that episode.
 */

import { $ } from 'bun';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { PROTECTED_FILES } from './types';

/**
 * Validate that a file path is safe to operate on.
 *
 * Checks:
 * 1. No path traversal (.. components)
 * 2. Resolved path is within the worktree
 * 3. File is not in PROTECTED_FILES list
 *
 * @throws Error if the path is unsafe
 */
export function validateFilePath(
  worktreePath: string,
  filePath: string
): string {
  // Normalize the path
  const normalized = path.normalize(filePath);

  // Check for path traversal
  if (normalized.includes('..')) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }

  // Resolve absolute path within worktree
  const absolutePath = path.resolve(worktreePath, normalized);

  // Ensure it's still within the worktree
  if (!absolutePath.startsWith(path.resolve(worktreePath))) {
    throw new Error(
      `Path escapes worktree: ${filePath} resolved to ${absolutePath}`
    );
  }

  // Check against protected files
  for (const protectedPath of PROTECTED_FILES) {
    if (normalized.startsWith(protectedPath) || normalized === protectedPath) {
      throw new Error(
        `Cannot modify protected file/directory: ${protectedPath}`
      );
    }
  }

  return absolutePath;
}

/**
 * Read a file from a worktree.
 *
 * @param worktreePath - Absolute path to the worktree
 * @param filePath - Relative path within the worktree
 * @returns File contents as string
 */
export async function readFile(
  worktreePath: string,
  filePath: string
): Promise<string> {
  const absolutePath = validateFilePath(worktreePath, filePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const file = Bun.file(absolutePath);
  return await file.text();
}

/**
 * Write a file in a worktree.
 *
 * Creates parent directories if they don't exist.
 * Refuses to write to PROTECTED_FILES.
 *
 * @param worktreePath - Absolute path to the worktree
 * @param filePath - Relative path within the worktree
 * @param content - File contents
 */
export async function writeFile(
  worktreePath: string,
  filePath: string,
  content: string
): Promise<void> {
  const absolutePath = validateFilePath(worktreePath, filePath);

  // Create parent directory if needed
  const dir = path.dirname(absolutePath);
  if (!existsSync(dir)) {
    await $`mkdir -p ${dir}`.quiet();
  }

  await Bun.write(absolutePath, content);
  console.log(`[FILE-OPS] Written: ${filePath}`);
}

/**
 * List files in a directory within a worktree.
 *
 * @param worktreePath - Absolute path to the worktree
 * @param dirPath - Relative directory path within the worktree
 * @returns Array of file/directory names
 */
export async function listDirectory(
  worktreePath: string,
  dirPath: string = '.'
): Promise<string[]> {
  const absolutePath = validateFilePath(worktreePath, dirPath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  const result = await $`ls -1 ${absolutePath}`.text();
  return result
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * Search for a pattern in files within a worktree.
 *
 * Uses grep under the hood.
 *
 * @param worktreePath - Absolute path to the worktree
 * @param pattern - Regex pattern to search for
 * @param glob - Optional glob to filter files (e.g., "*.ts")
 * @returns Matching lines with file paths
 */
export async function searchCode(
  worktreePath: string,
  pattern: string,
  glob?: string
): Promise<string> {
  try {
    const globArgs = glob ? ['--include', glob] : [];
    const result =
      await $`grep -rn ${pattern} ${worktreePath}/src ${globArgs}`.text();
    return result;
  } catch {
    // grep returns exit code 1 when no matches found
    return '';
  }
}

/**
 * Check if a file exists in a worktree.
 */
export function fileExists(
  worktreePath: string,
  filePath: string
): boolean {
  try {
    const absolutePath = validateFilePath(worktreePath, filePath);
    return existsSync(absolutePath);
  } catch {
    return false;
  }
}

/**
 * Delete a file from a worktree.
 *
 * Refuses to delete PROTECTED_FILES.
 */
export async function deleteFile(
  worktreePath: string,
  filePath: string
): Promise<void> {
  const absolutePath = validateFilePath(worktreePath, filePath);

  if (!existsSync(absolutePath)) {
    return; // Already gone, no drama
  }

  await $`rm ${absolutePath}`.quiet();
  console.log(`[FILE-OPS] Deleted: ${filePath}`);
}
