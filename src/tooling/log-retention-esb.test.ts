// scripts/run-log-retention.sh runs scripts/log-retention.py (a byte-identical copy of
// HyperCalendarBot's, which carries the full criteria tests) over this repository's logs/.
// These tests cover what is specific to ExpenseSyncBot: logs/ is pm2's directory, so the
// script must manage only rotated files and evidence directories (pm2 holds the CURRENT
// out/error logs open; compressing or deleting them would silently lose everything written
// after), deletion must follow the criteria (size, free space) and spare the last deploy's and
// the last failure's evidence, and the alert must find the admin chat under ESB's key name.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// Each scenario spawns bash + python and holds real time; bun's 5 s default is too tight on a busy box.
setDefaultTimeout(60_000);

const WRAPPER = join(import.meta.dir, '../../scripts/run-log-retention.sh');
const DAY_SECONDS = 86_400;
const MB = 1024 * 1024;

interface Sandbox {
  dir: string;
  logs: string;
  env: string;
}

let box: Sandbox | null = null;

afterEach(() => {
  if (box) rmSync(box.dir, { recursive: true, force: true });
  box = null;
});

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'log-retention-'));
  const logs = join(dir, 'logs');
  mkdirSync(logs);
  box = { dir, logs, env: join(dir, '.env') };
  return box;
}

/** Incompressible content, so a .gz keeps its size. */
function bytes(size: number): Buffer {
  return randomBytes(size);
}

function aged(path: string, daysAgo: number): void {
  const at = Date.now() / 1000 - daysAgo * DAY_SECONDS;
  utimesSync(path, at, at);
}

function file(b: Sandbox, name: string, size: number, daysAgo: number): string {
  const path = join(b.logs, name);
  writeFileSync(path, bytes(size));
  aged(path, daysAgo);
  return path;
}

function evidenceDir(b: Sandbox, name: string, daysAgo: number): string {
  const path = join(b.logs, name);
  mkdirSync(path);
  writeFileSync(join(path, 'expensesyncbot.out.log.gz'), bytes(300 * 1024));
  aged(join(path, 'expensesyncbot.out.log.gz'), daysAgo);
  aged(path, daysAgo);
  return path;
}

/** The logs directory of an odroid that has seen a month of deploys. */
function esbLogsDir(b: Sandbox) {
  const current = [
    'out.log',
    'error.log',
    'bank-sync-out.log',
    'bank-sync-error.log',
    'healthcheck.log',
    'backup.log',
  ].map(
    // Old and large on purpose: only pm2 may rotate these, never the retention sweep.
    (name) => file(b, name, 3 * MB, 40),
  );
  const rotated = [
    file(b, 'out__2026-10-01_00-00-00.log.gz', 400 * 1024, 24),
    file(b, 'error__2026-10-02_00-00-00.log.gz', 400 * 1024, 23),
    file(b, 'bank-sync-out__2026-10-03_00-00-00.log.gz', 400 * 1024, 22),
    // The deploy step's own rotation (single underscore).
    file(b, 'out_2026-10-04_03-00-00.log.gz', 400 * 1024, 21),
    file(b, 'healthcheck_2026-10-04_03-00-00.log.gz', 400 * 1024, 21),
  ];
  const oldRelease = evidenceDir(b, 'release-aaaaaaaaaaaa-2026-10-01_00-00-00', 30);
  const lastRelease = evidenceDir(b, 'release-bbbbbbbbbbbb-2026-10-05_00-00-00', 25);
  const oldFailure = evidenceDir(b, 'failed-cccccccccccc-2026-10-02_00-00-00', 29);
  const lastFailure = evidenceDir(b, 'failed-dddddddddddd-2026-10-06_00-00-00', 28);
  mkdirSync(join(b.logs, 'chats'));
  const chat = join(b.logs, 'chats', 'conversation.json');
  writeFileSync(chat, bytes(2 * MB));
  aged(chat, 60);
  return { current, rotated, oldRelease, lastRelease, oldFailure, lastFailure, chat };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function retain(b: Sandbox, args: string[] = [], env: Record<string, string> = {}): Run {
  const done = spawnSync('bash', [WRAPPER, ...args], {
    env: { ...process.env, LOGS_ROOT: b.logs, ENV_FILE: b.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

function freeSpace(b: Sandbox, bytesFree: number): Record<string, string> {
  const path = join(b.dir, 'free-bytes');
  writeFileSync(path, String(bytesFree));
  return { LOG_RETENTION_FREE_BYTES_FILE: path };
}

const PLENTY = 500 * 1024 * MB;

describe('run-log-retention.sh over an ESB-shaped logs directory', () => {
  test('an old plain healthcheck rotation the deploy set aside is compressed, never deleted', () => {
    const b = sandbox();
    const plain = file(b, 'healthcheck_2026-10-04_03-00-00.log', 64 * 1024, 3);
    const original = readFileSync(plain);
    const run = retain(b, [], freeSpace(b, PLENTY));
    expect(run.status).toBe(0);
    expect(existsSync(plain)).toBe(false);
    expect(gunzipSync(readFileSync(`${plain}.gz`)).equals(original)).toBe(true);
  });

  test('a directory within every limit loses nothing, current logs included', () => {
    const b = sandbox();
    const tree = esbLogsDir(b);
    const before = readdirSync(b.logs).sort();
    const run = retain(b, [], freeSpace(b, PLENTY));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('SUMMARY status=ok');
    expect(
      readdirSync(b.logs)
        .filter((n) => !n.startsWith('.'))
        .sort(),
    ).toEqual(before);
    for (const path of [...tree.current, ...tree.rotated, tree.chat])
      expect(existsSync(path)).toBe(true);
  });

  test('size limit: the oldest rotated files and old evidence go first, pm2 current logs and chats never', () => {
    const b = sandbox();
    const tree = esbLogsDir(b);
    const sizes = Object.fromEntries(tree.current.map((p) => [p, statSync(p).size]));
    // 5 rotated x 400 KB + 4 dirs x 300 KB is about 3.2 MB: allow 2 MB.
    const run = retain(b, ['--max-dir-mb', '2'], freeSpace(b, PLENTY));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('DELETED');
    expect(existsSync(tree.oldRelease)).toBe(false);
    expect(existsSync(tree.rotated[0] ?? '')).toBe(false);
    expect(existsSync(tree.lastRelease)).toBe(true);
    expect(existsSync(tree.lastFailure)).toBe(true);
    for (const path of tree.current) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBe(sizes[path] ?? -1);
    }
    expect(existsSync(tree.chat)).toBe(true);
    expect(readdirSync(b.logs).some((n) => n.endsWith('.log.gz') && n.startsWith('out.'))).toBe(
      false,
    );
  });

  test('low free space deletes oldest-first and still spares the last deploy and the last failure', () => {
    const b = sandbox();
    const tree = esbLogsDir(b);
    const run = retain(b, [], freeSpace(b, 50 * MB));
    // Free space cannot recover in this fixture, so everything deletable goes and the sweep says so.
    expect(run.status).toBe(2);
    expect(run.stdout).toContain('violations=free');
    expect(run.stdout).toContain('protected=last-deploy');
    expect(run.stdout).toContain('protected=last-failure');
    for (const gone of [tree.oldRelease, tree.oldFailure, ...tree.rotated])
      expect(existsSync(gone)).toBe(false);
    expect(existsSync(tree.lastRelease)).toBe(true);
    expect(existsSync(tree.lastFailure)).toBe(true);
    for (const path of [...tree.current, tree.chat]) expect(existsSync(path)).toBe(true);
  });

  test('the evidence of a failed deploy is never what a size sweep removes first', () => {
    const b = sandbox();
    const tree = esbLogsDir(b);
    // Only the newest failure and release may survive a limit nothing can satisfy.
    const run = retain(b, ['--max-dir-mb', '0'], freeSpace(b, PLENTY));
    expect(run.status).toBe(2);
    expect(
      readdirSync(b.logs)
        .filter((n) => /^(release|failed)-/.test(n))
        .sort(),
    ).toEqual([tree.lastRelease, tree.lastFailure].map((p) => p.split('/').at(-1) ?? '').sort());
  });

  test('nothing modified in the last five minutes is deleted, even when the limits are violated', () => {
    const b = sandbox();
    esbLogsDir(b);
    const fresh = file(b, 'out__2026-10-25_12-00-00.log.gz', 400 * 1024, 0);
    const run = retain(b, ['--max-dir-mb', '0'], freeSpace(b, PLENTY));
    expect(run.status).toBe(2);
    expect(existsSync(fresh)).toBe(true);
  });

  test('--dry-run reports and deletes nothing', () => {
    const b = sandbox();
    esbLogsDir(b);
    const before = readdirSync(b.logs).sort();
    const run = retain(b, ['--max-dir-mb', '0', '--dry-run'], freeSpace(b, PLENTY));
    expect(run.stdout).toContain('DRY-RUN DELETED');
    expect(readdirSync(b.logs).sort()).toEqual(before);
  });
});

describe('run-log-retention.sh alert wiring', () => {
  // ESB's admin chat is BOT_ADMIN_CHAT_ID; log-retention.py reads BOT_ADMIN_ID. The wrapper
  // hands the script a private env file under the name it reads, and the run's own stub python
  // records what it was given (the real script would post to Telegram).
  const STUB_PYTHON = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$STUB_ARGS"
while [ $# -gt 0 ]; do
  if [ "$1" = --env-file ]; then cp "$2" "$STUB_ENV_COPY"; stat -c %a "$2" > "$STUB_ENV_MODE"; echo "$2" > "$STUB_ENV_PATH"; fi
  shift
done
exit "\${STUB_EXIT:-0}"
`;

  function withStub(
    b: Sandbox,
    exit: number,
  ): Run & { args: string[]; envCopy: string; envMode: string; envPath: string } {
    const bin = join(b.dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'python3'), STUB_PYTHON, { mode: 0o755 });
    writeFileSync(
      b.env,
      'BOT_TOKEN="stage-and-prod-token"\nBOT_ADMIN_CHAT_ID=\'-100777\'\nOTHER=1\n',
    );
    const out = (name: string) => join(b.dir, name);
    const run = retain(b, ['--extra-flag'], {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      STUB_ARGS: out('args'),
      STUB_ENV_COPY: out('env-copy'),
      STUB_ENV_MODE: out('env-mode'),
      STUB_ENV_PATH: out('env-path'),
      STUB_EXIT: String(exit),
    });
    return {
      ...run,
      args: readFileSync(out('args'), 'utf8').split('\n').filter(Boolean),
      envCopy: readFileSync(out('env-copy'), 'utf8'),
      envMode: readFileSync(out('env-mode'), 'utf8').trim(),
      envPath: readFileSync(out('env-path'), 'utf8').trim(),
    };
  }

  test('passes the token and the admin chat under the names log-retention.py reads, privately', () => {
    const b = sandbox();
    const r = withStub(b, 0);
    expect(r.envCopy).toBe('BOT_TOKEN=stage-and-prod-token\nBOT_ADMIN_ID=-100777\n');
    expect(r.envMode).toBe('600');
    expect(existsSync(r.envPath)).toBe(false); // removed once the sweep is done
    expect(readFileSync(b.env, 'utf8')).toContain('BOT_ADMIN_CHAT_ID'); // the source file is left alone
  });

  test('scopes the sweep to pm2-rotated files and evidence directories, with the alert on', () => {
    const b = sandbox();
    const { args } = withStub(b, 0);
    const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
    expect(pairs('--root')).toEqual([b.logs]);
    expect(pairs('--only-glob')).toEqual([
      '*__*.log',
      '*__*.log.gz',
      '*_????-??-??_??-??-??.log',
      '*_????-??-??_??-??-??.log.gz',
    ]);
    expect(args).toContain('--manage-evidence-dirs');
    expect(args).toContain('--alert');
    expect(args).toContain('--extra-flag');
  });

  test('hands back the exit status of the sweep', () => {
    const b = sandbox();
    expect(withStub(b, 2).status).toBe(2);
  });

  test('without credentials the sweep still runs and says why no alert can go out', () => {
    const b = sandbox();
    esbLogsDir(b);
    const run = retain(b, ['--max-dir-mb', '0'], freeSpace(b, PLENTY));
    expect(run.stdout).toContain('ALERT_FAILED MissingCredentials');
  });
});
