// Runs the "Deploy or stop stage bot" step of .github/workflows/stage-bot.yml the way the
// odroid runner does: its env is evaluated from a pull_request event with GitHub's expression
// engine, its script runs under bash with /var/www relocated into a temp dir, and git, bun,
// pm2 and curl are stand-ins that record their calls. The point under test is WHICH code
// the stage bot runs: exactly the commit the (guarded) event was about, never a later push,
// and that it runs under the host deploy lock shared with every other deploy on the odroid.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { data, Evaluator, Lexer, Parser } from '@actions/expressions';

// Each scenario spawns bash + python and holds real time; bun's 5 s default is too tight on a busy box.
setDefaultTimeout(60_000);

const WORKFLOW = join(import.meta.dir, '../../.github/workflows/stage-bot.yml');
const LOCK_LIB = join(import.meta.dir, '../../scripts/odroid-deploy-lock.sh');
const REPO = 'alex-mextner/ExpenseSyncBot';
const BRANCH = 'feat/some-change';
const HEAD_SHA = '1111111111111111111111111111111111111111';

// Stand-in git: logs every call (submodule calls also log the directory they ran in);
// `worktree add` creates the worktree directory (its path is
// the only absolute argument); `rev-parse`/`log` answer what the notification needs.
const GIT_STUB = `#!/usr/bin/env bash
echo "git $*" >> "$CALLS"
[ "$1" = submodule ] && echo "git-cwd $PWD" >> "$CALLS"
case "$1" in
  worktree) [ "$2" = add ] && for a in "$@"; do case "$a" in /*) mkdir -p "$a" ;; esac; done ;;
  rev-parse) echo "${HEAD_SHA}" ;;
  log) echo "commit message" ;;
esac
exit 0
`;
// Stand-in bun: `bun -e …` is the pm2-status probe and answers $STAGE_STATUS; everything
// else (install) succeeds. Each call also notes whether another process holds the host
// deploy lock at that moment ($CALLS.locks).
const BUN_STUB = `#!/usr/bin/env bash
state=free
if [ -n "\${ODROID_DEPLOY_LOCK_FILE:-}" ] && [ -e "$ODROID_DEPLOY_LOCK_FILE" ] && ! flock -n "$ODROID_DEPLOY_LOCK_FILE" true; then state=held; fi
echo "bun $* lock=$state" >> "$CALLS.locks"
echo "bun $*" >> "$CALLS"
[ "$1" = -e ] && echo "\${STAGE_STATUS:-online}"
exit 0
`;
// Stand-in pm2: logs the call, the calls that saw the runner's job tracking id, and per call
// whether the host deploy lock is held, whether pm2 inherited its file descriptor and which TZ
// it got.
const PM2_STUB = `#!/usr/bin/env bash
echo "pm2 $*" >> "$CALLS"
[ -n "\${RUNNER_TRACKING_ID:-}" ] && echo "pm2 $1" >> "$CALLS.tracked"
state=free
if [ -n "\${ODROID_DEPLOY_LOCK_FILE:-}" ] && [ -e "$ODROID_DEPLOY_LOCK_FILE" ] && ! flock -n "$ODROID_DEPLOY_LOCK_FILE" true; then state=held; fi
inherited=no
for fd in /proc/self/fd/*; do [ "$(readlink "$fd" 2>/dev/null)" = "\${ODROID_DEPLOY_LOCK_FILE:-/nonexistent}" ] && inherited=yes; done
echo "pm2 $1 lock=$state lock_fd=$inherited tz=\${TZ:-}" >> "$CALLS.locks"
exit 0
`;
const LOGGING_STUB = (name: string) =>
  `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS"\nexit 0\n`;

/** `value[key]` when `value` is an object that has `key`, otherwise undefined. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? Reflect.get(value, key)
    : undefined;
}

function dictionary(entries: Record<string, data.ExpressionData>): data.Dictionary {
  const d = new data.Dictionary();
  for (const [key, value] of Object.entries(entries)) d.add(key, value);
  return d;
}

type PullRequestAction = 'opened' | 'synchronize' | 'closed';

function eventContext(action: PullRequestAction): data.Dictionary {
  const head = dictionary({
    sha: new data.StringData(HEAD_SHA),
    ref: new data.StringData(BRANCH),
    repo: dictionary({ full_name: new data.StringData(REPO) }),
  });
  const pullRequest = dictionary({
    number: new data.NumberData(42),
    title: new data.StringData('Some change'),
    head,
  });
  const github = dictionary({
    repository: new data.StringData(REPO),
    head_ref: new data.StringData(BRANCH),
    sha: new data.StringData('2222222222222222222222222222222222222222'),
    event: dictionary({ action: new data.StringData(action), pull_request: pullRequest }),
  });
  return dictionary({
    github,
    secrets: dictionary({ BOT_ADMIN_CHAT_ID: new data.StringData('7') }),
  });
}

async function deployStep(): Promise<{ run: string; env: Record<string, string> }> {
  const workflow: unknown = Bun.YAML.parse(await Bun.file(WORKFLOW).text());
  const steps = field(field(field(workflow, 'jobs'), 'stage-bot'), 'steps');
  const step = Array.isArray(steps)
    ? steps.find((s) => field(s, 'name') === 'Deploy or stop stage bot')
    : undefined;
  const run = field(step, 'run');
  const env = field(step, 'env');
  if (typeof run !== 'string' || env === null || typeof env !== 'object') {
    throw new Error('stage-bot.yml has no "Deploy or stop stage bot" step with run + env');
  }
  return { run, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])) };
}

/** Evaluates `${{ expr }}` env values against the event, as the runner does. */
function evaluateEnv(env: Record<string, string>, context: data.Dictionary) {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      const expr = value.match(/^\$\{\{\s*(.+?)\s*\}\}$/)?.[1];
      if (!expr) return [key, value];
      const parsed = new Parser(new Lexer(expr).lex().tokens, ['github', 'secrets'], []).parse();
      return [key, new Evaluator(parsed, context).evaluate().coerceString()];
    }),
  );
}

interface DeployOptions {
  worktreeExists: boolean;
  action?: PullRequestAction;
  stageStatus?: string;
  /** Ship scripts/odroid-deploy-lock.sh in the main checkout (default true). */
  lockLib?: boolean;
  /** Another process holds the host deploy lock for the whole run. */
  lockHeldByOther?: boolean;
}

async function runDeploy({
  worktreeExists,
  action = worktreeExists ? 'synchronize' : 'opened',
  stageStatus = 'online',
  lockLib = true,
  lockHeldByOther = false,
}: DeployOptions) {
  const root = mkdtempSync(join(tmpdir(), 'stage-bot-deploy-'));
  const www = join(root, 'var/www');
  const bunBin = join(www, '.bun/bin');
  const stubs = join(root, 'stubs');
  const mainDir = join(www, 'ExpenseSyncBot');
  const worktree = join(mainDir, '.claude/worktrees', BRANCH);
  const calls = join(root, 'calls');
  const lockFile = join(root, 'lock/odroid-deploy.lock');
  mkdirSync(bunBin, { recursive: true });
  mkdirSync(stubs);
  mkdirSync(join(mainDir, 'scripts'), { recursive: true });
  if (worktreeExists) mkdirSync(worktree, { recursive: true });
  if (lockLib) {
    copyFileSync(LOCK_LIB, join(mainDir, 'scripts/odroid-deploy-lock.sh'));
  }
  writeFileSync(join(mainDir, '.env'), 'BOT_TOKEN=prod\n');
  writeFileSync(join(mainDir, '.env.stage'), 'BOT_TOKEN=stage\n');
  writeFileSync(join(bunBin, 'bun'), BUN_STUB, { mode: 0o755 });
  writeFileSync(join(bunBin, 'pm2'), PM2_STUB, { mode: 0o755 });
  writeFileSync(join(stubs, 'git'), GIT_STUB, { mode: 0o755 });
  writeFileSync(join(stubs, 'curl'), LOGGING_STUB('curl'), { mode: 0o755 });
  writeFileSync(join(stubs, 'sleep'), '#!/bin/sh\n', { mode: 0o755 });

  const holder = lockHeldByOther ? await holdLock(lockFile) : null;
  try {
    const step = await deployStep();
    const script = join(root, 'step.sh');
    writeFileSync(script, step.run.replaceAll('/var/www', www));
    const result = spawnSync('bash', [script], {
      env: {
        ...evaluateEnv(step.env, eventContext(action)),
        PATH: `${stubs}:${process.env['PATH']}`,
        CALLS: calls,
        // Set by the self-hosted runner on every step; at job end it SIGKILLs any process
        // still carrying this value ("Terminate orphan process").
        RUNNER_TRACKING_ID: 'github_test-job',
        STAGE_STATUS: stageStatus,
        ODROID_DEPLOY_LOCK_FILE: lockFile,
        ODROID_DEPLOY_LOCK_SLICE: '1',
        ODROID_DEPLOY_LOCK_MAX_WAIT: lockHeldByOther ? '2' : '30',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const lines = (file: string) =>
      existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    const log = lines(calls);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      worktree,
      mainDir,
      lockFile,
      log,
      locks: lines(`${calls}.locks`),
      git: log.filter((l) => l.startsWith('git ')),
      pm2: log.filter((l) => l.startsWith('pm2 ')),
      pm2Tracked: lines(`${calls}.tracked`),
    };
  } finally {
    if (holder?.pid !== undefined) process.kill(-holder.pid, 'SIGKILL');
  }
}

/** Another deploy: a process that holds the flock until killed. Resolves once it does. */
async function holdLock(lockFile: string) {
  mkdirSync(dirname(lockFile), { recursive: true });
  const holder = spawn('flock', ['-x', lockFile, 'bash', '-c', 'echo HELD; sleep 120'], {
    detached: true,
  });
  const held = Promise.withResolvers<void>();
  holder.stdout.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('HELD')) held.resolve();
  });
  await held.promise;
  return holder;
}

describe('stage-bot deploy step', () => {
  test('a new worktree is created at the event head commit, not the branch tip', async () => {
    const r = await runDeploy({ worktreeExists: false });
    expect(r.status).toBe(0);
    const add = r.git.filter((call) => call.startsWith('git worktree add'));
    expect(add).toHaveLength(1);
    expect(add[0]?.split(' ').at(-1)).toBe(HEAD_SHA);
  });

  test('an existing worktree is reset to the event head commit, not the branch tip', async () => {
    const r = await runDeploy({ worktreeExists: true });
    expect(r.status).toBe(0);
    expect(r.git).toContain(`git reset --hard ${HEAD_SHA}`);
    expect(r.git.some((call) => call.includes(`origin/${BRANCH}`))).toBe(false);
  });

  // A reboot resurrects pm2's saved list; without a save it brings back whatever stage ran
  // when someone last saved by hand (on 2026-10-12: a deleted worktree, ~7000 crash loops).
  test.each([
    ['PR opened', false, 'opened'],
    ['PR updated', true, 'synchronize'],
    ['PR closed, stage back on main', false, 'closed'],
  ] as const)('%s: the started stage bot is saved for resurrect', async (_name, worktreeExists, action) => {
    const r = await runDeploy({ worktreeExists, action });
    expect(r.status).toBe(0);
    const start = r.pm2.findIndex((call) => call.startsWith('pm2 start'));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(r.pm2.indexOf('pm2 save')).toBeGreaterThan(start);
  });

  test('a stage bot that fails to come online is not saved', async () => {
    const r = await runDeploy({ worktreeExists: false, stageStatus: 'errored' });
    expect(r.status).not.toBe(0);
    expect(r.pm2).not.toContain('pm2 save');
  });

  test('a crashing stage bot backs off instead of restarting in a hot loop', async () => {
    const r = await runDeploy({ worktreeExists: false });
    const start = r.pm2.find((call) => call.startsWith('pm2 start'));
    expect(start).toContain('--exp-backoff-restart-delay 2000');
  });

  // On 2026-10-12 every stage deploy's bot was SIGKILLed ~7 s after start by the runner's
  // orphan cleanup, because pm2 inherited the job's RUNNER_TRACKING_ID into the app env.
  test.each([
    ['PR deploy', 'opened'],
    ['PR closed, stage back on main', 'closed'],
  ] as const)('%s: pm2 never sees the runner job tracking id', async (_name, action) => {
    const r = await runDeploy({ worktreeExists: false, action });
    expect(r.status).toBe(0);
    expect(r.pm2.some((call) => call.startsWith('pm2 start'))).toBe(true);
    expect(r.pm2Tracked).toEqual([]);
  });

  // A fresh `git worktree add` leaves submodules empty: until 2026-10-15 every PR stage bot
  // ran without ZenPlugins, so bank sync logged "Unknown bank in registry" for every
  // connection. The stage checkout must get the submodule and its deps, as prod's deploy does.
  test.each([
    ['PR opened', false, 'opened', 'worktree'],
    ['PR updated', true, 'synchronize', 'worktree'],
    ['PR closed, stage back on main', false, 'closed', 'mainDir'],
  ] as const)('%s: the stage checkout has ZenPlugins checked out and installed', async (_name, worktreeExists, action, checkout) => {
    const r = await runDeploy({ worktreeExists, action });
    expect(r.status).toBe(0);
    const update = r.log.indexOf('git submodule update --init');
    expect(update).toBeGreaterThanOrEqual(0);
    expect(r.log[update + 1]).toBe(`git-cwd ${r[checkout]}`);
    const install = r.log.indexOf('bun install --cwd src/services/bank/ZenPlugins');
    expect(install).toBeGreaterThan(update);
    expect(install).toBeLessThan(r.log.findIndex((l) => l.startsWith('pm2 start')));
  });

  // On 2026-10-24 a stage-sized load (installs, pm2 restarts) next to another repository's deploy
  // drove the odroid to 33-62 % iowait. Every deploy of both repositories takes one host lock.
  describe('host deploy lock', () => {
    test.each([
      ['PR opened', false, 'opened'],
      ['PR updated', true, 'synchronize'],
      ['PR closed, stage back on main', false, 'closed'],
    ] as const)('%s: every install and every pm2 call runs while the lock is held', async (_name, worktreeExists, action) => {
      const r = await runDeploy({ worktreeExists, action });
      expect(r.status).toBe(0);
      const installs = r.locks.filter((l) => l.startsWith('bun install'));
      expect(installs.length).toBeGreaterThanOrEqual(2);
      for (const line of installs) expect(line).toContain('lock=held');
      const pm2 = r.locks.filter((l) => l.startsWith('pm2 '));
      expect(pm2.length).toBeGreaterThan(2);
      for (const line of pm2) expect(line).toContain('lock=held');
      // The step has ended: nothing it started may still hold the lock.
      expect(spawnSync('flock', ['-n', r.lockFile, 'true']).status).toBe(0);
    });

    // A pm2 daemon started from this step would inherit the descriptor and hold the host lock
    // long after the job ended.
    test('pm2 does not inherit the lock descriptor and still gets its TZ', async () => {
      const r = await runDeploy({ worktreeExists: false });
      const pm2 = r.locks.filter((l) => l.startsWith('pm2 '));
      for (const line of pm2) expect(line).toContain('lock_fd=no');
      expect(pm2.find((l) => l.startsWith('pm2 start'))).toContain('tz=UTC');
    });

    test('another deploy holding the lock makes this one give up with 75 before it touches anything', async () => {
      const r = await runDeploy({ worktreeExists: false, lockHeldByOther: true });
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('gave up');
      expect(r.log).toEqual([]);
    });

    // Until the first prod deploy ships scripts/odroid-deploy-lock.sh the main checkout does not
    // have it; the stage deploy of the very pull request that adds it must not fail for that.
    test('a checkout that does not have the lock script yet deploys with a warning', async () => {
      const r = await runDeploy({ worktreeExists: false, lockLib: false });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('::warning::');
      expect(r.pm2.some((call) => call.startsWith('pm2 start'))).toBe(true);
      for (const line of r.locks.filter((l) => l.startsWith('pm2 '))) {
        expect(line).toContain('lock_fd=no');
      }
    });
  });
});
