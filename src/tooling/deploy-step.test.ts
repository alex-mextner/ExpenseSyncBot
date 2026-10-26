// Runs the "Deploy via git pull" step of .github/workflows/deploy.yml the way the odroid
// runner does — its script under bash with /var/www relocated into a temp dir, the repository's
// real deploy scripts copied in, and git, bun and caddy replaced by stand-ins next to a fake
// pm2 and curl — and checks what the step does around `pm2 reload`:
//   * the host deploy lock is held from before the first install until the step ends, and
//     pm2 never inherits its file descriptor;
//   * pm2 never sees the runner's job tracking id (the runner SIGKILLs everything that still
//     carries it when the job ends);
//   * the running release's logs are saved before anything is rotated or reloaded, and no log
//     file is ever deleted, on success or failure;
//   * a release that does not come up fails the job and leaves a failed-release bundle;
//   * log retention runs only after a verified deploy.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  createDeployFixture,
  type DeployFixture,
  type Scenario,
} from '../test-utils/deploy-fixtures';

// Each scenario spawns bash + python and holds real time; bun's 5 s default is too tight on a busy box.
setDefaultTimeout(60_000);

const REPO = join(import.meta.dir, '../..');
const WORKFLOW = join(REPO, '.github/workflows/deploy.yml');
const DEPLOY_SCRIPTS = [
  'odroid-deploy-lock.sh',
  'deploy-evidence.py',
  'deploy-health.py',
  'deploy_pm2.py',
  'log-retention.py',
  'run-log-retention.sh',
];
const OLD_SHA = '1111111111111111111111111111111111111111';
const NEW_SHA = '2222222222222222222222222222222222222222';
const PLENTY_FREE_BYTES = String(500 * 1024 * 1024 * 1024);

/** Logs of the running release, as the first deploy step finds them. */
const LIVE_LOGS: Record<string, string> = {
  'error.log': 'old error line\n',
  'out.log': 'old out line 1\nold out line 2\n',
  'healthcheck.log': 'old healthcheck line\n',
  'bank-sync-out.log': 'old bank-sync line\n',
  'bank-sync-error.log': '',
};

// Stand-in git: every call is logged; the first `rev-parse` is the outgoing release, later
// ones the pulled commit.
const GIT_STUB = `#!/usr/bin/env bash
state=free
if [ -n "\${ODROID_DEPLOY_LOCK_FILE:-}" ] && [ -e "$ODROID_DEPLOY_LOCK_FILE" ] && ! flock -n "$ODROID_DEPLOY_LOCK_FILE" true; then state=held; fi
echo "git $* | lock=$state" >> "$CALLS"
# The lock script comes from the commit being deployed (git show FETCH_HEAD:...), before the checkout moves.
if [ "$1" = show ]; then cat "$LOCK_SRC"; fi
if [ "$1" = rev-parse ]; then
  n=$(cat "$CALLS.rev" 2>/dev/null || echo 0)
  echo $((n + 1)) > "$CALLS.rev"
  if [ "$n" = 0 ]; then echo "${OLD_SHA}"; else echo "${NEW_SHA}"; fi
fi
exit 0
`;

// Stand-in bun: logs the call with whether the host deploy lock was held by someone else at
// that moment, and the calls that saw the runner's job tracking id. BUN_FAIL_ON makes a
// matching call fail.
const BUN_STUB = `#!/usr/bin/env bash
state=free
if [ -n "\${ODROID_DEPLOY_LOCK_FILE:-}" ] && [ -e "$ODROID_DEPLOY_LOCK_FILE" ] && ! flock -n "$ODROID_DEPLOY_LOCK_FILE" true; then state=held; fi
echo "bun $* | lock=$state" >> "$CALLS"
[ -n "\${RUNNER_TRACKING_ID:-}" ] && echo "bun $1" >> "$CALLS.tracked"
if [ -n "\${BUN_FAIL_ON:-}" ]; then case "$*" in *"$BUN_FAIL_ON"*) exit 1 ;; esac; fi
exit 0
`;

const CADDY_STUB = '#!/usr/bin/env bash\necho "caddy $*" >> "$CALLS"\nexit 0\n';

/** `value[key]` when `value` is an object that has `key`, otherwise undefined. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? Reflect.get(value, key)
    : undefined;
}

function workflowJob(workflow: unknown, job: string): unknown {
  return field(field(workflow, 'jobs'), job);
}

async function deployScript(): Promise<string> {
  const workflow: unknown = Bun.YAML.parse(await Bun.file(WORKFLOW).text());
  const steps = field(workflowJob(workflow, 'deploy'), 'steps');
  const step = Array.isArray(steps)
    ? steps.find((s) => field(s, 'name') === 'Deploy via git pull')
    : undefined;
  const run = field(step, 'run');
  if (typeof run !== 'string') throw new Error('deploy.yml has no "Deploy via git pull" step');
  return run;
}

interface StepOptions {
  scenario?: Scenario;
  bunFailsOn?: string;
  env?: Record<string, string>;
}

interface StepRun {
  status: number | null;
  stdout: string;
  stderr: string;
  fixture: DeployFixture;
  mainDir: string;
  logs: string;
  calls: string[];
  githubOutput: Record<string, string>;
  /** `bun <first arg>` lines of the calls that saw the runner's job tracking id. */
  bunTracked: string[];
}

const fixtures: DeployFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function install(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o755 });
}

interface Prepared {
  fixture: DeployFixture;
  www: string;
  mainDir: string;
  logs: string;
  lockFile: string;
  githubOutput: string;
  env: Record<string, string>;
}

/** Builds the relocated /var/www tree for one run; the caller starts the step. */
function prepare(options: StepOptions = {}): Prepared {
  const fixture = createDeployFixture();
  fixtures.push(fixture);
  const www = join(fixture.dir, 'var/www');
  const bunBin = join(www, '.bun/bin');
  const stubs = join(fixture.dir, 'stubs');
  const mainDir = join(www, 'ExpenseSyncBot');
  const logs = join(mainDir, 'logs');
  for (const dir of [bunBin, stubs, logs, join(mainDir, 'miniapp'), join(mainDir, 'scripts')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(mainDir, 'start.sh'), '#!/bin/sh\n');
  writeFileSync(
    join(mainDir, '.env'),
    'OAUTH_SERVER_PORT=3311\nBOT_TOKEN=prod-token\nBOT_ADMIN_CHAT_ID=7\n',
  );
  for (const [name, text] of Object.entries(LIVE_LOGS)) writeFileSync(join(logs, name), text);
  for (const name of DEPLOY_SCRIPTS)
    copyFileSync(join(REPO, 'scripts', name), join(mainDir, 'scripts', name));
  for (const name of DEPLOY_SCRIPTS) chmodSync(join(mainDir, 'scripts', name), 0o755);
  install(join(bunBin, 'bun'), BUN_STUB);
  copyFileSync(fixture.pm2, join(bunBin, 'pm2'));
  chmodSync(join(bunBin, 'pm2'), 0o755);
  install(join(stubs, 'git'), GIT_STUB);
  install(join(stubs, 'caddy'), CADDY_STUB);
  fixture.setScenario({ logs, ...options.scenario });
  const lockFile = join(fixture.dir, 'lock/odroid-deploy.lock');
  const githubOutput = join(fixture.dir, 'github-output');
  const env: Record<string, string> = {
    ...fixture.env,
    PATH: `${stubs}:${fixture.bin}:${process.env['PATH'] ?? ''}`,
    CALLS: join(fixture.dir, 'calls.log'),
    OLD_SHA,
    NEW_SHA,
    LOCK_SRC: join(import.meta.dir, '../../scripts/odroid-deploy-lock.sh'),
    // Set by the self-hosted runner on every step; at job end it SIGKILLs any process still
    // carrying this value ("Terminate orphan process").
    RUNNER_TRACKING_ID: 'github_test-job',
    GITHUB_OUTPUT: githubOutput,
    ODROID_DEPLOY_LOCK_FILE: lockFile,
    ODROID_DEPLOY_LOCK_SLICE: '1',
    ODROID_DEPLOY_LOCK_MAX_WAIT: '30',
    DEPLOY_HEALTH_POLL: '0.05',
    DEPLOY_HEALTH_STABLE: '0.2',
    // Wide: a slow poll on a busy test machine must not turn a slow-start scenario into a failure.
    DEPLOY_HEALTH_BASE_BUDGET: '30',
    DEPLOY_HEALTH_HARD_CAP: '60',
    LOG_RETENTION_FREE_BYTES_FILE: join(fixture.dir, 'free-bytes'),
    ...(options.bunFailsOn ? { BUN_FAIL_ON: options.bunFailsOn } : {}),
    ...options.env,
  };
  writeFileSync(join(fixture.dir, 'free-bytes'), PLENTY_FREE_BYTES);
  return { fixture, www, mainDir, logs, lockFile, githubOutput, env };
}

async function runDeployStep(options: StepOptions = {}): Promise<StepRun> {
  const t = prepare(options);
  const script = join(t.fixture.dir, 'step.sh');
  writeFileSync(script, (await deployScript()).replaceAll('/var/www', t.www));
  const result = spawnSync('bash', [script], { env: t.env, encoding: 'utf8', timeout: 60_000 });
  return finish(t, result.status, result.stdout, result.stderr);
}

function finish(t: Prepared, status: number | null, stdout: string, stderr: string): StepRun {
  const read = (file: string) =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const githubOutput = Object.fromEntries(
    read(t.githubOutput).map((line) => [
      line.slice(0, line.indexOf('=')),
      line.slice(line.indexOf('=') + 1),
    ]),
  );
  return {
    status,
    stdout,
    stderr,
    fixture: t.fixture,
    mainDir: t.mainDir,
    logs: t.logs,
    calls: t.fixture.calls(),
    githubOutput,
    bunTracked: read(join(t.fixture.dir, 'calls.log.tracked')).filter((c) => c.startsWith('bun ')),
  };
}

const pm2Calls = (r: StepRun) => r.calls.filter((c) => c.startsWith('pm2 '));
const indexOfCall = (r: StepRun, prefix: string) => r.calls.findIndex((c) => c.startsWith(prefix));

function dirsWith(logs: string, prefix: string): string[] {
  return readdirSync(logs)
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(logs, name));
}

/** Every line the live logs held is still on disk: as the file, or gzipped under a rotated name. */
function everyLiveLogSurvives(logs: string): void {
  const names = readdirSync(logs);
  for (const [name, text] of Object.entries(LIVE_LOGS)) {
    if (text === '') continue;
    const stem = name.replace(/\.log$/, '');
    const candidates = names.filter(
      (n) =>
        n === name ||
        new RegExp(`^${stem}_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}\\.log(\\.gz)?$`).test(n),
    );
    const contents = candidates.map((n) => {
      const raw = readFileSync(join(logs, n));
      return (n.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
    });
    expect(contents, `${name} must survive`).toContain(text);
  }
}

describe('deploy.yml deploy step: runner and pm2 plumbing', () => {
  // On 2026-10-12 pm2-logrotate, restarted by `pm2 set`, was SIGKILLed at the end of every
  // deploy job ("Terminate orphan process: … node") because it inherited the tracking id.
  test('pm2 never sees the runner job tracking id', async () => {
    const r = await runDeployStep();
    expect(r.status).toBe(0);
    const calls = pm2Calls(r);
    expect(calls.some((call) => call.startsWith('pm2 reload ecosystem.config.cjs'))).toBe(true);
    expect(calls.some((call) => call.startsWith('pm2 set pm2-logrotate'))).toBe(true);
    for (const call of calls) expect(call).toContain('tracking= ');
  });

  test('installs and builds keep the tracking id, so the runner still reaps their leftovers', async () => {
    const r = await runDeployStep();
    expect(r.bunTracked).toContain('bun install');
    expect(r.bunTracked).toContain('bun run');
  });

  // A pm2 daemon this step starts would inherit the lock's descriptor and keep the host
  // deploy lock long after the step ended, blocking every later deploy of both repositories.
  test('pm2 never inherits the host deploy lock descriptor, though the lock is held while it runs', async () => {
    const r = await runDeployStep();
    expect(r.status).toBe(0);
    const calls = pm2Calls(r);
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      expect(call).toContain('lock_fd=no');
      expect(call).toContain('lock=held');
    }
  });
});

describe('deploy.yml deploy step: host deploy lock', () => {
  test('is taken before the checkout moves (fetch, not pull) and held through pull, install, reload and verdict', async () => {
    const r = await runDeployStep();
    expect(r.status).toBe(0);
    const pull = indexOfCall(r, 'git pull');
    const firstInstall = indexOfCall(r, 'bun install');
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(firstInstall).toBeGreaterThan(pull);
    // A deploy that waits for the lock must not have touched the checkout yet: only the holder moves it.
    expect(r.calls[pull]).toContain('lock=held');
    expect(r.calls.find((c) => c.startsWith('git submodule'))).toContain('lock=held');
    expect(indexOfCall(r, 'git fetch')).toBeLessThan(pull);
    expect(r.calls.find((c) => c.startsWith('git fetch'))).toContain('lock=free');
    const bunCalls = r.calls.filter((c) => c.startsWith('bun '));
    expect(bunCalls.length).toBeGreaterThan(2);
    for (const call of bunCalls) expect(call).toContain('lock=held');
    const reload = r.calls.find((c) => c.startsWith('pm2 reload'));
    expect(reload).toContain('lock=held');
    expect(r.calls.filter((c) => c.startsWith('curl ')).length).toBeGreaterThan(0);
    expect(r.stderr + r.stdout).not.toContain('waiting for the host deploy lock');
  });

  test('is released when the step ends', async () => {
    const t = prepare();
    const script = join(t.fixture.dir, 'step.sh');
    writeFileSync(script, (await deployScript()).replaceAll('/var/www', t.www));
    expect(spawnSync('bash', [script], { env: t.env, timeout: 60_000 }).status).toBe(0);
    // Nothing the step started (pm2, python) may still hold it.
    expect(spawnSync('flock', ['-n', t.lockFile, 'true']).status).toBe(0);
  });

  test('another deploy holding it makes this one wait, give up with 75 and touch nothing', async () => {
    const t = prepare({ env: { ODROID_DEPLOY_LOCK_MAX_WAIT: '2' } });
    mkdirSync(dirname(t.lockFile), { recursive: true });
    const holder = spawn('flock', ['-x', t.lockFile, 'bash', '-c', 'echo HELD; sleep 60'], {
      detached: true,
    });
    try {
      const held = Promise.withResolvers<void>();
      holder.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('HELD')) held.resolve();
      });
      await held.promise;
      const script = join(t.fixture.dir, 'step.sh');
      writeFileSync(script, (await deployScript()).replaceAll('/var/www', t.www));
      const result = spawnSync('bash', [script], { env: t.env, encoding: 'utf8', timeout: 60_000 });
      const r = finish(t, result.status, result.stdout, result.stderr);
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('gave up');
      expect(r.calls.some((c) => c.startsWith('bun '))).toBe(false);
      expect(pm2Calls(r)).toEqual([]);
      expect(readFileSync(join(r.logs, 'out.log'), 'utf8')).toBe(LIVE_LOGS['out.log'] ?? '');
      expect(r.githubOutput['failure_note']).toContain('host deploy lock');
      expect(r.githubOutput['failed_evidence']).toBe('');
    } finally {
      if (holder.pid !== undefined) process.kill(-holder.pid, 'SIGKILL');
    }
  });
});

describe('deploy.yml deploy step: logs and evidence', () => {
  test('saves the running release logs before rotating or reloading, and deletes nothing', async () => {
    const r = await runDeployStep();
    expect(r.status).toBe(0);
    const [saved] = dirsWith(r.logs, 'release-');
    expect(dirsWith(r.logs, 'release-')).toHaveLength(1);
    expect(saved).toContain(`release-${OLD_SHA.slice(0, 12)}-`);
    // The copy is of the live file as it was before the step set it aside.
    expect(
      gunzipSync(readFileSync(join(saved ?? '', 'expensesyncbot.out.log.gz'))).toString(),
    ).toBe(LIVE_LOGS['out.log'] ?? '');
    expect(indexOfCall(r, 'pm2 jlist')).toBeGreaterThanOrEqual(0);
    expect(indexOfCall(r, 'pm2 jlist')).toBeLessThan(indexOfCall(r, 'pm2 reload'));
    everyLiveLogSurvives(r.logs);
    expect(r.stdout).toContain('RELEASE_LOGS dir=');
  });

  // The old process keeps writing into the file it had open until the reload; compressing that
  // file earlier would unlink it under the writer and lose those lines.
  test('never compresses healthcheck.log: the cron job may hold it open', async () => {
    const r = await runDeployStep();
    const left = readdirSync(r.logs);
    expect(left.some((n) => n.startsWith('healthcheck_') && n.endsWith('.gz'))).toBe(false);
    everyLiveLogSurvives(r.logs);
  });

  test('compresses the logs it set aside only after the reload', async () => {
    const r = await runDeployStep({ scenario: { reload_fails: true } });
    expect(r.status).not.toBe(0);
    const left = readdirSync(r.logs);
    expect(left.some((n) => /^out_\d{4}-.*\.log$/.test(n))).toBe(true);
    expect(left.some((n) => n.endsWith('.gz') && n.startsWith('out_'))).toBe(false);
    everyLiveLogSurvives(r.logs);
  });

  test('keeps every pm2-logrotate rotation: retention is the only thing that deletes', async () => {
    const r = await runDeployStep();
    const calls = pm2Calls(r).map((c) => c.split(' | ')[0]);
    expect(calls).toContain('pm2 set pm2-logrotate:retain 100000');
    expect(calls).toContain('pm2 set pm2-logrotate:max_size 20M');
    expect(calls).toContain('pm2 set pm2-logrotate:compress true');
    expect(calls.some((c) => c?.includes('retain 14'))).toBe(false);
  });

  test('a verified deploy ends with the log retention sweep, which may not fail the deploy', async () => {
    const r = await runDeployStep();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SUMMARY status=ok');
    expect(r.githubOutput['failed_evidence']).toBeUndefined();
    const failing = await runDeployStep({
      env: { LOG_RETENTION_FREE_BYTES_FILE: '/nonexistent/free-bytes' },
    });
    expect(failing.stdout + failing.stderr).toMatch(/log retention exited/);
    expect(failing.status).toBe(0);
  });

  test('a build that fails before the reload changes nothing: no rotation, no reload, no bundle', async () => {
    const r = await runDeployStep({ bunFailsOn: 'install --cwd src/services/bank/ZenPlugins' });
    expect(r.status).not.toBe(0);
    expect(pm2Calls(r).some((c) => c.startsWith('pm2 reload'))).toBe(false);
    expect(dirsWith(r.logs, 'failed-')).toEqual([]);
    for (const [name, text] of Object.entries(LIVE_LOGS)) {
      expect(readFileSync(join(r.logs, name), 'utf8')).toBe(text);
    }
  });
});

describe('deploy.yml deploy step: verdict', () => {
  test('waits for /health on the port in .env after the reload', async () => {
    const r = await runDeployStep();
    expect(r.status).toBe(0);
    expect(r.calls).toContain('curl http://127.0.0.1:3311/health');
    expect(indexOfCall(r, 'curl ')).toBeGreaterThan(indexOfCall(r, 'pm2 reload'));
    expect(r.stdout).toContain('RESULT verdict=ok');
  });

  test('a release that errors after the reload fails the job with a bundle saved before anything restarts', async () => {
    const r = await runDeployStep({ scenario: { dies_after: 3, health_after: 1_000_000 } });
    expect(r.status).toBe(3);
    const [bundle] = dirsWith(r.logs, 'failed-');
    expect(dirsWith(r.logs, 'failed-')).toHaveLength(1);
    expect(bundle).toContain(`failed-${NEW_SHA.slice(0, 12)}-`);
    expect(r.stdout).toContain(`FAILED_EVIDENCE ${bundle}`);
    expect(r.githubOutput['failed_evidence']).toBe(bundle ?? '');
    expect(r.githubOutput['failure_note']).toContain('verdict=dead');
    const names = readdirSync(bundle ?? '');
    expect(names).toContain('state.txt');
    expect(names).toContain('verdict.log');
    // No automatic rollback and no further restart: exactly one reload.
    expect(
      pm2Calls(r).filter((c) => /^pm2 (reload|restart|start|delete|stop)/.test(c)),
    ).toHaveLength(1);
    expect(r.stdout).not.toContain('SUMMARY status=');
    everyLiveLogSurvives(r.logs);
  });

  test('a slow start is not a failure: health that answers late still passes', async () => {
    const r = await runDeployStep({ scenario: { health_after: 12, answers_503: true } });
    expect(r.status).toBe(0);
    expect(dirsWith(r.logs, 'failed-')).toEqual([]);
  });

  test('a crash loop after the reload fails the job', async () => {
    const r = await runDeployStep({ scenario: { loop_after: 4, health_after: 1_000_000 } });
    expect(r.status).toBe(3);
    expect(r.githubOutput['failure_note']).toContain('crash loop');
  });

  test('a reload that itself fails still saves the failed-release bundle', async () => {
    const r = await runDeployStep({ scenario: { reload_fails: true } });
    expect(r.status).not.toBe(0);
    expect(dirsWith(r.logs, 'failed-')).toHaveLength(1);
    expect(r.stdout).toContain('FAILED_EVIDENCE');
    everyLiveLogSurvives(r.logs);
  });
});

describe('deploy.yml deploy step: never deletes logs', () => {
  test('no command in the step removes, truncates or overwrites anything under logs/', async () => {
    const script = await deployScript();
    // The only rm commands in the step are the verdict log's and the lock script's own temp files.
    for (const line of script.split('\n')) {
      if (/\brm\b/.test(line)) expect(line).toMatch(/VERDICT_LOG|LOCK_LIB/);
      expect(line).not.toMatch(/\bfind\b.*-delete|\btruncate\b|shred|--remove-files/);
    }
    expect(script).not.toMatch(/>\s*"?\$?\{?(LOGS_DIR|logs)\b/);
    // mv must refuse to overwrite: -n.
    for (const line of script.split('\n')) {
      if (/\bmv\b/.test(line)) expect(line).toContain('mv -n');
    }
  });
});
