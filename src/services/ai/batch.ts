/** Batch execution helper for write tools — runs executor per item, collects results */
import type { ToolResult } from './types';

export const MAX_BATCH_SIZE = 20;

/** Check whether a value is a non-empty array (used to detect batch mode) */
export function isBatchInput(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

interface BatchItemResult {
  success: boolean;
  message: string;
}

/**
 * Execute a function for each item in a batch, collect per-item results.
 * Returns a combined ToolResult with a formatted summary.
 *
 * Note: only `output` and `error` from individual results are aggregated.
 * `data` and `summary` fields are intentionally dropped — write tools
 * don't return structured data, and batch output is already a summary.
 *
 * Items execute sequentially (not Promise.all) to avoid rate limits
 * on Google Sheets and maintain DB consistency.
 */
export async function executeBatchItems<T>(
  items: T[],
  toolName: string,
  executor: (item: T) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (items.length > MAX_BATCH_SIZE) {
    return {
      success: false,
      error: `Batch too large: ${items.length} items, max ${MAX_BATCH_SIZE}. Split into smaller batches.`,
    };
  }

  const results: BatchItemResult[] = [];

  for (const item of items) {
    const result = await executor(item);
    results.push({
      success: result.success,
      message: result.success
        ? `✓ ${toolName}: ${result.output ?? 'OK'}`
        : `✗ ${toolName}: ${result.error ?? 'Unknown error'}`,
    });
  }

  const succeeded = results.filter((r) => r.success).length;
  const total = results.length;
  const lines = [
    `=== Batch result (${succeeded}/${total} succeeded) ===`,
    ...results.map((r) => r.message),
  ];

  return {
    success: succeeded > 0,
    output: lines.join('\n'),
  };
}
