/**
 * Output parsing and Telegram report formatting for the TESTING stage.
 *
 * Split out of pipeline.ts: these are pure functions over the type-check and
 * `bun test` output, so the orchestrator only decides transitions.
 */

import { escapeHtml } from '../../utils/html';
import { MAX_RETRY_ATTEMPTS } from './types';

/** Reorder test output: failures and errors first, then passing tests fill remaining space */
export function prioritizeFailures(raw: string, maxChars: number): string {
  const lines = raw.split('\n');
  const failLines: string[] = [];
  const otherLines: string[] = [];

  for (const line of lines) {
    if (
      line.includes('error:') ||
      line.includes('Error:') ||
      line.includes('✗') ||
      line.includes('FAIL') ||
      line.includes('# Unhandled')
    ) {
      failLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  // Failures + context first
  const result = [...failLines, ...otherLines].join('\n');
  return result.slice(0, maxChars);
}

/** Parse bun test summary counts from output (bun 1.3+: "N pass", "N fail", "N error") */
export function parseTestCounts(output: string): { pass: number; fail: number; error: number } {
  const passMatch = output.match(/(\d+)\s+pass(?!\w)/);
  const failMatch = output.match(/(\d+)\s+fail(?!\w)/);
  const errorMatch = output.match(/(\d+)\s+error/);
  return {
    pass: passMatch ? parseInt(passMatch[1] ?? '0', 10) : 0,
    fail: failMatch ? parseInt(failMatch[1] ?? '0', 10) : 0,
    error: errorMatch ? parseInt(errorMatch[1] ?? '0', 10) : 0,
  };
}

/** Take the last N characters of a string (errors are usually at the end of output) */
export function tailSlice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…${text.slice(-maxChars)}`;
}

/** Extract tsc error lines (file:line:col + message) for concise display */
export function extractTscErrors(output: string): string {
  const lines = output.split('\n');
  const errors: string[] = [];
  for (const line of lines) {
    if (line.includes('error TS')) {
      errors.push(line.trim());
    }
  }
  return errors.join('\n') || output;
}

/** Outcome of one TESTING run (type check + `bun test`). */
export interface TestingOutcome {
  typeCheckPassed: boolean;
  /** tsc was killed by the OOM killer (exit 137): counted as passed but flagged. */
  tscOOM: boolean;
  typeCheckExitCode: number;
  typeCheckOutput: string;
  testsPassed: boolean;
  testExitCode: number;
  testsOutput: string;
  passCount: number;
  failCount: number;
  errorCount: number;
}

/** Raw error_log text stored on the task (for the AI agent), also used for loop detection. */
export function buildFullOutput(outcome: TestingOutcome): string {
  return `TYPE CHECK ${outcome.typeCheckPassed ? 'PASSED' : 'FAILED'}:\n${outcome.typeCheckOutput}\n\nTESTS ${outcome.testsPassed ? 'PASSED' : 'FAILED'} (exit code ${outcome.testExitCode}):\n${outcome.testsOutput}`;
}

/** "all checks passed" Telegram message; `prUrl` is appended when a PR already exists. */
export function formatAllPassedMessage(
  taskId: number,
  outcome: TestingOutcome,
  prUrl?: string | null,
): string {
  const base =
    `✅ <b>Dev task #${taskId}:</b> all checks passed!\n\n` +
    `${outcome.tscOOM ? '⚠️' : '✅'} <b>Тайпчекер:</b> ${outcome.tscOOM ? 'OOM (skipped)' : 'OK'}\n` +
    `✅ <b>Тесты:</b> ${outcome.passCount} ✅`;
  return prUrl === undefined ? base : `${base}\n\nPR: ${prUrl}`;
}

function formatTypeCheckLines(outcome: TestingOutcome): string[] {
  if (outcome.typeCheckPassed) {
    return [`✅ <b>Тайпчекер:</b> OK`];
  }
  const lines: string[] = [];
  const tscErrors = extractTscErrors(outcome.typeCheckOutput);
  const tscErrorCount = (outcome.typeCheckOutput.match(/error TS\d+/g) || []).length;
  if (tscErrorCount > 0) {
    lines.push(
      `❌ <b>Тайпчекер:</b> ${tscErrorCount} ${tscErrorCount === 1 ? 'ошибка' : 'ошибок'}`,
    );
  } else {
    lines.push(`⚠️ <b>Тайпчекер:</b> failed (exit code ${outcome.typeCheckExitCode})`);
  }
  const tscDisplay = tscErrors.trim() || outcome.typeCheckOutput.trim() || '(no output)';
  lines.push(`<blockquote expandable>${escapeHtml(tailSlice(tscDisplay, 3000))}</blockquote>`);
  return lines;
}

function formatTestLines(outcome: TestingOutcome): string[] {
  const { passCount, failCount, errorCount, testExitCode, testsOutput } = outcome;
  if (outcome.testsPassed) {
    return [`✅ <b>Тесты:</b> ${passCount} ✅`];
  }
  const parts: string[] = [];
  if (passCount > 0) parts.push(`${passCount} ✅`);
  if (failCount > 0) parts.push(`${failCount} ❌`);
  if (errorCount > 0) parts.push(`${errorCount} 💥`);
  if (failCount === 0 && errorCount === 0) parts.push(`exit code ${testExitCode}`);
  return [
    `${failCount > 0 || errorCount > 0 ? '❌' : '⚠️'} <b>Тесты:</b> ${parts.join(' / ')}`,
    `<blockquote expandable>${escapeHtml(prioritizeFailures(testsOutput, 3000))}</blockquote>`,
  ];
}

/** Failure report lines (header + type check + tests); the caller appends the verdict line. */
export function formatFailureReportLines(
  taskId: number,
  retryCount: number,
  outcome: TestingOutcome,
): string[] {
  return [
    `🧪 <b>Dev task #${taskId}</b> — результаты (попытка ${retryCount}/${MAX_RETRY_ATTEMPTS})\n`,
    ...formatTypeCheckLines(outcome),
    ...formatTestLines(outcome),
  ];
}
