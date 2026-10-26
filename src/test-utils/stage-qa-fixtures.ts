// Shared pieces of the stage QA tooling tests: the repository path, the names the case list must carry,
// fake credentials and a temp directory. (The list itself is scripts/stage-smoke-cases.json.)
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = join(import.meta.dir, '../..');
export const STAGE_USERNAME = 'ExpenseSyncStageBot';
export const PROD_USERNAME = 'ExpenseSyncBot';

/** The smallest case list the PC driver and the odroid script accept (the floor). */
export const MIN_CASES = 5;

/** The names the PC driver and the odroid script require in every PR's case list (the floor). */
export const REQUIRED_CASES = [
  'start',
  'ping',
  'help-lists-commands',
  'categories-read-only-listing',
  'validation-connect-rejected-outside-group',
  'simple-intent-phrase',
  'expense-phrase-redirect',
];

export interface SmokeCase {
  name: string;
  send: string;
  expect?: string[];
  forbid?: string[];
  min_replies?: number;
}

function isSmokeCase(value: unknown): value is SmokeCase {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'send' in value &&
    typeof value.send === 'string'
  );
}

export function loadCases(path: string): SmokeCase[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every(isSmokeCase)) {
    throw new Error(`${path}: not a case list`);
  }
  return parsed;
}

export function envText(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
}

/** Fake filler, never a real value: only the numeric bot id before the colon matters to the guards. */
export function fakeBotCredential(botId: string): string {
  return `${botId}:${'x'.repeat(35)}`;
}

export interface TempRoot {
  dir: string;
  cleanup: () => void;
}

export function tempRoot(prefix: string): TempRoot {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
