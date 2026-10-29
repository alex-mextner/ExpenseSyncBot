// Shared pieces of the stage QA tooling tests (stage-qa-cases, odroid-stage-qa-report, stage-qa-driver,
// stage-qa-browser, stage-qa-engine, stage-qa-gate, stage-qa-workflows, install-stage-qa): the repository path,
// the committed case list and the table of case lists a PR must not be able to ship, fake credentials, a temp
// directory, an executable writer, and the process helpers (a child whose stdin stays open, a held flock).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const REPO = join(import.meta.dir, '../..');
export const STAGE_USERNAME = 'ExpenseSyncStageBot';
export const PROD_USERNAME = 'ExpenseSyncBot';

/** The smallest case list the browser half and the odroid script accept (the floor). */
export const MIN_CASES = 5;

/** The names the browser half and the odroid script require in every PR's case list (the floor). */
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

/** The committed list, exactly what a PR that changes nothing sends. */
export function realCases(): SmokeCase[] {
  return loadCases(join(REPO, 'scripts/stage-smoke-cases.json'));
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

export function writeExecutable(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

export type CaseRecord = Record<string, unknown>;

/** The committed `ping` case as a plain record a test can mutate a copy of. */
export function pingCase(): CaseRecord {
  const found = realCases().find((c) => c.name === 'ping');
  if (!found) throw new Error('scripts/stage-smoke-cases.json has no ping case');
  return { ...found };
}

/** The committed list with the case `name` replaced by `replacement`. */
export function withCase(name: string, replacement: CaseRecord): CaseRecord[] {
  return realCases().map((c) => (c.name === name ? replacement : { ...c }));
}

export interface BadCase {
  title: string;
  /** Turns the committed `ping` case into the bad one. */
  mutate: (ping: CaseRecord) => CaseRecord;
  /** Part of the reason both the odroid script and the browser half give. */
  reason: string;
}

function without(record: CaseRecord, key: string): CaseRecord {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/**
 * What a PR must not be able to put in its case list. The engine accepts all of these (or crashes on
 * them), so the odroid script and the browser half each refuse them on their own; both tests run this table.
 */
export const BAD_CASES: BadCase[] = [
  {
    title: 'a case without expect',
    mutate: (c) => without(c, 'expect'),
    reason: 'case ping: expect must be a non-empty list of patterns',
  },
  {
    title: 'an empty expect list',
    mutate: (c) => ({ ...c, expect: [] }),
    reason: 'case ping: expect must be a non-empty list of patterns',
  },
  {
    title: 'a case without forbid',
    mutate: (c) => without(c, 'forbid'),
    reason: 'case ping: forbid must be a non-empty list of patterns',
  },
  {
    title: 'an empty forbid list',
    mutate: (c) => ({ ...c, forbid: [] }),
    reason: 'case ping: forbid must be a non-empty list of patterns',
  },
  {
    title: 'a forbid list without the trusted error patterns',
    mutate: (c) => ({ ...c, forbid: ['Traceback'] }),
    reason: 'case ping: forbid must contain the error patterns the trusted side requires',
  },
  ...['.', '.*', '\\w', '[\\s\\S]', 'x?', '(?:)'].map((pattern) => ({
    title: `an expect pattern that any reply satisfies (${pattern})`,
    mutate: (c: CaseRecord) => ({ ...c, expect: [pattern] }),
    reason: 'matches any reply',
  })),
  {
    title: 'an expect pattern that is not a regular expression',
    mutate: (c) => ({ ...c, expect: ['('] }),
    reason: 'case ping: bad expect pattern',
  },
  ...[
    ['timeout_s', 1e9],
    ['timeout_s', 301],
    ['timeout_s', 0],
    ['timeout_s', -5],
    ['timeout_s', '60'],
    ['timeout_s', true],
    ['max_first_reply_s', 1e6],
    ['max_first_reply_s', 0],
    ['settle_s', 61],
    ['settle_s', -1],
    ['min_replies', 0],
    ['min_replies', 21],
  ].map(([key, value]) => ({
    title: `${key} of ${JSON.stringify(value)}`,
    mutate: (c: CaseRecord) => ({ ...c, [String(key)]: value }),
    reason: `case ping: ${key} must be a number`,
  })),
  {
    title: 'a name that is not text',
    mutate: (c) => ({ ...c, name: ['ping'] }),
    reason: 'a case has no text name',
  },
  {
    title: 'a name that is not one line (it would forge SMOKE lines)',
    mutate: (c) => ({ ...c, name: 'ping\nSMOKE PASS everything' }),
    reason: 'a case has no text name',
  },
  {
    title: 'a send that is not text',
    mutate: (c) => ({ ...c, send: 7 }),
    reason: 'case ping: send must be text',
  },
];

export interface Finished {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface StartedProcess {
  child: ChildProcess;
  /** Writes one line to the child's stdin. */
  send: (line: string) => void;
  /** Closes the child's stdin (EOF). */
  closeStdin: () => void;
  /** Resolves once the text is on the child's stderr (instead of guessing a delay). */
  stderrSeen: (text: string) => Promise<void>;
  /** Resolves once the text is on the child's stdout. */
  stdoutSeen: (text: string) => Promise<void>;
  /** Everything the child has written to stdout so far. */
  stdoutText: () => string;
  finished: Promise<Finished>;
}

/**
 * A child process with a stdin that STAYS OPEN until the test closes it: the browser half reads the end of
 * its stdin as "the odroid driver is gone", which `spawnSync({ input })` would signal at once.
 */
export function startProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
  input?: string,
): StartedProcess {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const waiters: Array<{ text: string; resolve: () => void }> = [];
  const stdoutWaiters: Array<{ text: string; resolve: () => void }> = [];
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const waiter of stdoutWaiters.splice(0)) {
      if (stdout.includes(waiter.text)) waiter.resolve();
      else stdoutWaiters.push(waiter);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    for (const waiter of waiters.splice(0)) {
      if (stderr.includes(waiter.text)) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  // A child that exits before reading its stdin must not crash the test with EPIPE.
  child.stdin.on('error', () => {});
  const { promise: finished, resolve } = Promise.withResolvers<Finished>();
  child.on('close', (status) => resolve({ status, stdout, stderr }));
  const started: StartedProcess = {
    child,
    send: (line) => {
      child.stdin.write(`${line}\n`);
    },
    closeStdin: () => {
      child.stdin.end();
    },
    stderrSeen: (text) => {
      const seen = Promise.withResolvers<void>();
      if (stderr.includes(text)) seen.resolve();
      else waiters.push({ text, resolve: seen.resolve });
      return seen.promise;
    },
    stdoutSeen: (text) => {
      const seen = Promise.withResolvers<void>();
      if (stdout.includes(text)) seen.resolve();
      else stdoutWaiters.push({ text, resolve: seen.resolve });
      return seen.promise;
    },
    stdoutText: () => stdout,
    finished,
  };
  if (input !== undefined) started.send(input);
  return started;
}

/** Holds an exclusive flock(2) on `path` from another process until stopped. */
export function holdLock(path: string): { stop: () => void; ready: Promise<void> } {
  mkdirSync(dirname(path), { recursive: true });
  const child = spawn(
    'python3',
    [
      '-c',
      "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(60)",
      path,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const { promise: ready, resolve } = Promise.withResolvers<void>();
  child.stdout.once('data', () => resolve());
  return { stop: () => child.kill('SIGKILL'), ready };
}

export function lockIsFree(path: string): boolean {
  return (
    spawnSync('python3', [
      '-c',
      'import fcntl,sys; f=open(sys.argv[1]); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)',
      path,
    ]).status === 0
  );
}

export function isAlive(pid: number): boolean {
  return spawnSync('kill', ['-0', String(pid)]).status === 0;
}
