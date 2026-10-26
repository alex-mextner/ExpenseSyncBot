// scripts/deploy-evidence.py keeps PM2's logs and a failed release's evidence on the host.
//
// `release-logs` runs before a deploy rotates and reloads anything and copies the last N MB of
// every app's current out/error log into logs/release-<sha12>-<stamp>/; `failed` runs when the
// release did not come up and writes a bounded, redacted bundle to logs/failed-<sha12>-<stamp>/.
// The tests run the real script against a fake pm2 and fixture log files and check what ends up
// on disk: what is copied, how much, with which permissions, with which secrets removed, and
// that no existing log file is ever touched.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createDeployFixture, type DeployFixture, pm2LogLine } from '../test-utils/deploy-fixtures';

// Each scenario spawns bash + python and holds real time; bun's 5 s default is too tight on a busy box.
setDefaultTimeout(60_000);

const SCRIPT = join(import.meta.dir, '../../scripts/deploy-evidence.py');
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const TIMEOUT_MS = 60_000;

let fixture: DeployFixture | null = null;

function fx(): DeployFixture {
  fixture = createDeployFixture();
  return fixture;
}

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

interface ScriptRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function evidence(f: DeployFixture, args: string[], env: Record<string, string> = {}): ScriptRun {
  const done = spawnSync('python3', [SCRIPT, ...args], {
    env: { ...f.env, ...env },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

const APPS = ['--app', 'expensesyncbot', '--app', 'bank-sync'];

function releaseArgs(f: DeployFixture, extra: string[] = []): string[] {
  return [
    'release-logs',
    '--pm2',
    f.pm2,
    '--logs-root',
    f.logs,
    '--label',
    'abcdef012345',
    ...APPS,
    ...extra,
  ];
}

function failedArgs(f: DeployFixture, extra: string[] = []): string[] {
  return ['failed', '--pm2', f.pm2, '--logs-root', f.logs, '--sha', SHA, ...APPS, ...extra];
}

/** The single directory under logs/ whose name starts with `prefix`. */
function onlyDir(f: DeployFixture, prefix: string): string {
  const found = readdirSync(f.logs).filter((name) => name.startsWith(prefix));
  const [name] = found;
  if (found.length !== 1 || name === undefined) {
    throw new Error(`expected one ${prefix}* directory, found ${JSON.stringify(found)}`);
  }
  return join(f.logs, name);
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function gunzipped(path: string): string {
  return gunzipSync(readFileSync(path)).toString('utf8');
}

function bundleText(dir: string): string {
  return readdirSync(dir)
    .map((name) =>
      name.endsWith('.gz') ? gunzipped(join(dir, name)) : readFileSync(join(dir, name), 'utf8'),
    )
    .join('\n');
}

function numberedLines(prefix: string, count: number): string {
  const at = new Date('2026-10-25T12:00:00Z');
  const lines = Array.from({ length: count }, (_, i) =>
    pm2LogLine(at, `${prefix}-${String(i + 1).padStart(4, '0')}`),
  );
  return `${lines.join('\n')}\n`;
}

interface ProcessSummary {
  name: string;
  status: string;
}

function processSummaries(dir: string): ProcessSummary[] {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, 'processes.json'), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('processes.json is not a list');
  return parsed.map((entry: ProcessSummary) => ({ name: entry.name, status: entry.status }));
}

describe('deploy-evidence.py release-logs', () => {
  test('copies every app log tail to a private release-<label>-<stamp> directory and touches nothing', () => {
    const f = fx();
    const files = {
      'out.log': numberedLines('out', 20),
      'error.log': numberedLines('err', 5),
      'bank-sync-out.log': numberedLines('bank', 7),
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(f.logs, name), text);
    writeFileSync(join(f.logs, 'bank-sync-error.log'), ''); // empty: nothing to keep

    const run = evidence(f, releaseArgs(f));

    expect(run.status).toBe(0);
    const dir = onlyDir(f, 'release-abcdef012345-');
    expect(dir).toMatch(/release-abcdef012345-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    expect(run.stdout).toContain(`RELEASE_LOGS dir=${dir}`);
    expect(mode(dir)).toBe(0o700);
    const saved = readdirSync(dir).sort();
    expect(saved).toEqual([
      'bank-sync.out.log.gz',
      'expensesyncbot.err.log.gz',
      'expensesyncbot.out.log.gz',
      'processes.json',
    ]);
    for (const name of saved) expect(mode(join(dir, name))).toBe(0o600);
    expect(gunzipped(join(dir, 'expensesyncbot.out.log.gz'))).toBe(files['out.log']);
    expect(gunzipped(join(dir, 'expensesyncbot.err.log.gz'))).toBe(files['error.log']);
    expect(gunzipped(join(dir, 'bank-sync.out.log.gz'))).toBe(files['bank-sync-out.log']);
    // The copies are additional: the live files stay exactly as they were.
    for (const [name, text] of Object.entries(files)) {
      expect(readFileSync(join(f.logs, name), 'utf8')).toBe(text);
    }
  });

  test('is bounded to the last --tail-mb of a huge log and starts on a line boundary', () => {
    const f = fx();
    const at = new Date('2026-10-25T12:00:00Z');
    const line = (i: number) =>
      `${pm2LogLine(at, `row-${String(i).padStart(6, '0')} ${'x'.repeat(90)}`)}\n`;
    const text = Array.from({ length: 30_000 }, (_, i) => line(i)).join('');
    writeFileSync(join(f.logs, 'out.log'), text);

    expect(evidence(f, releaseArgs(f, ['--tail-mb', '1'])).status).toBe(0);

    const kept = gunzipped(join(onlyDir(f, 'release-'), 'expensesyncbot.out.log.gz'));
    expect(kept.length).toBeLessThanOrEqual(1024 * 1024);
    expect(kept.length).toBeGreaterThan(1024 * 1024 - 400);
    expect(kept.endsWith(line(29_999))).toBe(true);
    expect(kept.startsWith('2026-10-25 12:00:00 +00:00: row-')).toBe(true);
    expect(statSync(join(f.logs, 'out.log')).size).toBe(text.length);
  });

  test('a log whose last --tail-mb is one giant line keeps those bytes instead of an empty file', () => {
    const f = fx();
    const giant = `${'y'.repeat(3 * 1024 * 1024)}\n`;
    writeFileSync(join(f.logs, 'out.log'), giant);

    expect(evidence(f, releaseArgs(f, ['--tail-mb', '1'])).status).toBe(0);

    const kept = gunzipped(join(onlyDir(f, 'release-'), 'expensesyncbot.out.log.gz'));
    expect(kept.length).toBe(1024 * 1024);
    expect(kept.endsWith('y\n')).toBe(true);
  });

  test('never writes pm2 env into the process summary', () => {
    const f = fx();
    f.setScenario({ env_secret: 'PLANTED-ENV-VALUE-12345' });
    writeFileSync(join(f.logs, 'out.log'), 'a line\n');
    evidence(f, releaseArgs(f));
    const dir = onlyDir(f, 'release-');
    expect(readFileSync(join(dir, 'processes.json'), 'utf8')).not.toContain(
      'PLANTED-ENV-VALUE-12345',
    );
    expect(processSummaries(dir)[0]?.name).toBe('expensesyncbot');
  });

  test('a pm2 that cannot be reached still exits 0 and the live logs stay put', () => {
    const f = fx();
    f.setScenario({ unreachable: true });
    writeFileSync(join(f.logs, 'out.log'), 'a line\n');
    const run = evidence(f, releaseArgs(f));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('RELEASE_LOGS dir=');
    expect(readFileSync(join(f.logs, 'out.log'), 'utf8')).toBe('a line\n');
  });

  test('a label that is not a plain token is refused before anything is written', () => {
    const f = fx();
    const run = evidence(f, [
      'release-logs',
      '--pm2',
      f.pm2,
      '--logs-root',
      f.logs,
      '--label',
      '../../etc',
      '--app',
      'x',
    ]);
    expect(run.status).not.toBe(0);
    expect(readdirSync(f.logs)).toEqual([]);
  });

  test('pm2 never receives the runner job tracking id', () => {
    const f = fx();
    writeFileSync(join(f.logs, 'out.log'), 'a line\n');
    evidence(f, releaseArgs(f), { RUNNER_TRACKING_ID: 'github_job-1' });
    const pm2Calls = f.calls().filter((call) => call.startsWith('pm2 '));
    expect(pm2Calls.length).toBeGreaterThan(0);
    for (const call of pm2Calls) expect(call).toContain('tracking= ');
  });
});

describe('deploy-evidence.py failed', () => {
  // Assembled from pieces so no scanner mistakes the fixture for a real credential.
  const SECRETS = {
    telegram: ['123456789', ':', 'AAEhBOweik9ai2yLHnGq2AbCdEfGhIjKlMnO'].join(''),
    bearer: ['abcdefghijklmnop', '1234567'].join(''),
    password: ['hunter2', 'hunter2'].join(''),
    apiKey: ['sk', '-ant-api03-', 'ABCDEFGHIJKLMNOPQRSTUV'].join(''),
    googleToken: ['ya29', '.a0AfH6SMB', 'xxxxxxxxxxxxxxxxxxxxxxxx'].join(''),
    googleKey: ['AIza', 'SyA-1234567890abcdefghijklmnopqrstu'].join(''),
    dbPassword: ['secret', 'pw'].join(''),
    encryptionKey: ['ab12cd34ef56ab12', 'cd34ef56ab12cd34'].join(''),
    userText: 'I spent 50 euro at a very private cafe',
    msgText: 'lunch with a very private colleague 77 euro',
    structuredText: 'a private message inside an array',
  };

  function leakyLog(): string {
    const at = new Date('2026-10-25T12:00:00Z');
    return `${[
      pm2LogLine(
        at,
        `telegram request https://api.telegram.org/bot${SECRETS.telegram}/getMe failed`,
      ),
      pm2LogLine(at, `header Authorization: Bearer ${SECRETS.bearer}`),
      pm2LogLine(at, `config password=${SECRETS.password} loaded`),
      pm2LogLine(at, `key ${SECRETS.apiKey} rejected`),
      pm2LogLine(at, `google token ${SECRETS.googleToken} expired, key ${SECRETS.googleKey}`),
      pm2LogLine(at, `db postgres://user:${SECRETS.dbPassword}@host/db down`),
      pm2LogLine(at, `ENCRYPTION_KEY=${SECRETS.encryptionKey}`),
      pm2LogLine(at, { level: 30, msg: 'message', text: SECRETS.userText, chatId: 42 }),
      pm2LogLine(at, {
        level: 30,
        msg: `[MSG] Received message from user bob (42): "${SECRETS.msgText}"`,
      }),
      pm2LogLine(at, { level: 30, msg: 'message', content: [SECRETS.structuredText], chatId: 42 }),
      pm2LogLine(at, 'benign marker line'),
    ].join('\n')}\n`;
  }

  test('writes a private bundle: state, process summary without env, redacted tails, host load', () => {
    const f = fx();
    f.setScenario({ restarts: 3, env_secret: 'PLANTED-ENV-VALUE-12345' });
    writeFileSync(join(f.logs, 'out.log'), leakyLog());
    writeFileSync(join(f.logs, 'error.log'), numberedLines('err', 3));
    writeFileSync(join(f.logs, 'bank-sync-out.log'), numberedLines('bank', 3));
    writeFileSync(join(f.logs, 'bank-sync-error.log'), '');
    const before = readdirSync(f.logs).sort();

    const run = evidence(f, failedArgs(f));

    expect(run.status).toBe(0);
    const dir = onlyDir(f, 'failed-abcdef012345-');
    expect(run.stdout).toContain(`EVIDENCE_DIR=${dir}`);
    expect(mode(dir)).toBe(0o700);
    const names = readdirSync(dir);
    for (const name of names) expect(mode(join(dir, name))).toBe(0o600);
    for (const wanted of [
      'processes.json',
      'state.txt',
      'host-load.txt',
      'logs-index.txt',
      'expensesyncbot.out.tail.redacted.log',
      'expensesyncbot.err.tail.redacted.log',
      'bank-sync.out.tail.redacted.log',
    ]) {
      expect(names).toContain(wanted);
    }
    const everything = bundleText(dir);
    expect(everything).not.toContain('PLANTED-ENV-VALUE-12345');
    for (const secret of Object.values(SECRETS)) expect(everything).not.toContain(secret);
    const tail = readFileSync(join(dir, 'expensesyncbot.out.tail.redacted.log'), 'utf8');
    expect(tail).toContain('benign marker line');
    expect(tail).toContain('[redacted]');
    expect(processSummaries(dir)).toEqual([
      { name: 'expensesyncbot', status: 'online' },
      { name: 'bank-sync', status: 'online' },
    ]);
    expect(readFileSync(join(dir, 'state.txt'), 'utf8')).toMatch(
      /expensesyncbot .*status=online .*restarts=3/,
    );
    const host = readFileSync(join(dir, 'host-load.txt'), 'utf8');
    for (const heading of ['## loadavg', '## pressure/io', '## free -m', '## df -h']) {
      expect(host).toContain(heading);
    }
    // Nothing that existed before the bundle was written was changed or removed.
    expect(
      readdirSync(f.logs)
        .filter((n) => !n.startsWith('failed-'))
        .sort(),
    ).toEqual(before);
    expect(readFileSync(join(f.logs, 'out.log'), 'utf8')).toBe(leakyLog());
  });

  test('keeps the last 400 lines of each log and no more', () => {
    const f = fx();
    writeFileSync(join(f.logs, 'out.log'), numberedLines('out', 1000));
    evidence(f, failedArgs(f));
    const lines = readFileSync(
      join(onlyDir(f, 'failed-'), 'expensesyncbot.out.tail.redacted.log'),
      'utf8',
    )
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(400);
    expect(lines[0]).toContain('out-0601');
    expect(lines.at(-1)).toContain('out-1000');
  });

  test('includes the verdict log, redacted', () => {
    const f = fx();
    const verdict = join(f.dir, 'verdict.log');
    writeFileSync(
      verdict,
      `HEALTH t=20s health=none\nRESULT verdict=dead token=${SECRETS.password} reason=crash loop\n`,
    );
    evidence(f, failedArgs(f, ['--verdict-log', verdict]));
    const saved = readFileSync(join(onlyDir(f, 'failed-'), 'verdict.log'), 'utf8');
    expect(saved).toContain('RESULT verdict=dead');
    expect(saved).not.toContain(SECRETS.password);
  });

  test('a wedged pm2 cannot hold the deploy up: each command is bounded', () => {
    const f = fx();
    f.setScenario({ hang: true });
    writeFileSync(join(f.logs, 'out.log'), numberedLines('out', 3));
    const started = performance.now();
    const run = evidence(f, failedArgs(f, ['--command-timeout', '1']));
    expect(run.status).toBe(0);
    expect(performance.now() - started).toBeLessThan(30_000);
    const dir = onlyDir(f, 'failed-');
    expect(readFileSync(join(dir, 'state.txt'), 'utf8')).toContain('pm2 unavailable');
    expect(readFileSync(join(dir, 'host-load.txt'), 'utf8')).toContain('## loadavg');
  });

  test('a logs directory that cannot be written is reported, never raised into the deploy', () => {
    const f = fx();
    const blocked = join(f.dir, 'blocked');
    writeFileSync(blocked, 'a file where the logs directory should be');
    const run = evidence(f, [
      'failed',
      '--pm2',
      f.pm2,
      '--logs-root',
      join(blocked, 'logs'),
      '--sha',
      SHA,
      '--app',
      'expensesyncbot',
    ]);
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('deploy-evidence: command failed failed');
    expect(run.stdout).not.toContain('EVIDENCE_DIR=');
  });

  test('pm2 never receives the runner job tracking id', () => {
    const f = fx();
    evidence(f, failedArgs(f), { RUNNER_TRACKING_ID: 'github_job-1' });
    const pm2Calls = f.calls().filter((call) => call.startsWith('pm2 '));
    expect(pm2Calls.length).toBeGreaterThan(0);
    for (const call of pm2Calls) expect(call).toContain('tracking= ');
  });

  test('works from a logs directory with no app log yet (first deploy)', () => {
    const f = fx();
    mkdirSync(join(f.logs, 'chats'));
    const run = evidence(f, failedArgs(f));
    expect(run.status).toBe(0);
    expect(onlyDir(f, 'failed-')).toContain('failed-abcdef012345-');
  });
});
