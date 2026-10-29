// scripts/odroid-stage-qa-report.py is the odroid half of the per-PR stage QA, run as root through sudo by the
// QA runner's driver: it tells which commit the shared stage slot runs and what the PR's own QA cases are. The
// tests run the real script against a real git repository with a worktree, a stand-in pm2 that prints
// what `pm2 jlist` prints on the server, and a stand-in for Telegram's getMe. They pin what the
// script reports, what it refuses, and that it never writes anything.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  BAD_CASES,
  envText,
  fakeBotCredential,
  PROD_USERNAME,
  pingCase,
  REPO,
  realCases,
  STAGE_USERNAME,
  type TempRoot,
  tempRoot,
  withCase,
  writeExecutable,
} from '../test-utils/stage-qa-fixtures';

setDefaultTimeout(60_000);

const SCRIPT = join(REPO, 'scripts/odroid-stage-qa-report.py');
const STAGE_ID = '222222222';
const PROD_ID = '111111111';
const STAGE_BUN_COMMAND =
  '/var/www/.bun/bin/bun --no-env-file --env-file=/var/www/ExpenseSyncBot-stage/.env';

// What the stand-in pm2 prints for `jlist`: pm2's spawn banner first, like a cold daemon, then the list.
const FAKE_PM2 = `#!/usr/bin/env bash
FIX="$(dirname "$0")/../fix"
echo "$*" >> "$FIX/calls"
[ "$1" = jlist ] || exit 64
[ -f "$FIX/jlist.fail" ] && exit 1
[ -f "$FIX/jlist.raw" ] && { cat "$FIX/jlist.raw"; exit 0; }
echo "[PM2] Spawning PM2 daemon with pm2_home=/var/www/.pm2"
cat "$FIX/jlist.json"
`;

// Loads the script as a module so Telegram's getMe and the uid are stand-ins; nothing else is replaced.
const DRIVER = `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("odroid_report", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
calls = []
def get_me(_):
    calls.append(1)
    if "FAKE_GET_ME_FAIL" in os.environ:
        raise module.load_smoke().Refused("getMe for the stage token failed (URLError)")
    return os.environ["FAKE_GET_ME"]
drops = []
def drop(environ):
    drops.append(1)
    if "FAKE_DROP_FAIL" in os.environ:
        raise module.NotProvisioned("cannot drop to www-data (KeyError)")
    # What the real drop returns for www-data: its own HOME and no PM2_HOME of the caller.
    return {key: value for key, value in environ.items() if key != "PM2_HOME"} | {"HOME": os.environ["FAKE_HOME_AFTER_DROP"]}
code = module.main(sys.argv[3:], environ=dict(os.environ), get_me=get_me, euid=lambda: int(os.environ.get("FAKE_EUID", "1000")), drop=drop)
with open(sys.argv[2], "w") as handle:
    handle.write("%d %d" % (len(calls), len(drops)))
sys.exit(code)
`;

interface Pm2Env {
  status: string;
  pm_exec_path: string;
  args: string[] | string | null;
  pm_uptime: number;
  restart_time: number;
}

interface Slot {
  root: string;
  main: string;
  pm2: string;
  fix: string;
  pm2Home: string;
  worktree: string;
  prSha: string;
  mainSha: string;
}

// Every slot a test creates (some create several): all are removed after the test.
const temps: TempRoot[] = [];

afterEach(() => {
  for (const temp of temps.splice(0)) temp.cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const done = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: cwd,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
  if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout.trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function stageProcess(
  codeDir: string,
  overrides: Partial<Pm2Env> = {},
): { name: string; pm2_env: Pm2Env } {
  // Exactly how stage-bot.yml's `pm2 start "<cmd>"` shows up in `pm2 jlist` on the odroid.
  return {
    name: 'expensesyncbot-stage',
    pm2_env: {
      status: 'online',
      pm_exec_path: '/usr/bin/bash',
      args: ['-c', `${STAGE_BUN_COMMAND} ${codeDir}/index.ts`],
      pm_uptime: 1_761_000_000_000,
      restart_time: 0,
      ...overrides,
    },
  };
}

function writeJlist(slot: Slot, processes: object[]): void {
  writeFileSync(join(slot.fix, 'jlist.json'), JSON.stringify(processes));
}

function createSlot(): Slot {
  const temp = tempRoot('odroid-stage-qa-report-');
  temps.push(temp);
  const root = temp.dir;
  const main = join(root, 'ExpenseSyncBot');
  const fix = join(root, 'fix');
  const pm2Home = join(root, 'pm2home');
  mkdirSync(main, { recursive: true });
  mkdirSync(fix);
  mkdirSync(pm2Home);
  writeFileSync(join(pm2Home, 'rpc.sock'), '');
  mkdirSync(join(root, 'bin'));
  const pm2 = join(root, 'bin/pm2');
  writeExecutable(pm2, FAKE_PM2);

  git(main, 'init', '-q', '-b', 'main');
  mkdirSync(join(main, 'scripts'));
  writeFileSync(join(main, 'scripts/stage-smoke-cases.json'), JSON.stringify(realCases()));
  writeFileSync(join(main, '.gitignore'), '.claude/worktrees/\n.env\n.env.stage\n');
  const mainSha = commitAll(main, 'main');
  writeFileSync(
    join(main, '.env'),
    envText({ BOT_TOKEN: fakeBotCredential(PROD_ID), BOT_USERNAME: PROD_USERNAME }),
  );
  writeFileSync(
    join(main, '.env.stage'),
    envText({ BOT_TOKEN: fakeBotCredential(STAGE_ID), PORT: '3312' }),
  );

  const worktree = join(main, '.claude/worktrees/feat/x');
  git(main, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
  writeFileSync(join(worktree, 'pr-change.txt'), 'the PR');
  const prSha = commitAll(worktree, 'the PR');

  const slot: Slot = {
    root,
    main,
    pm2,
    fix,
    pm2Home,
    worktree,
    prSha,
    mainSha,
  };
  writeJlist(slot, [
    { name: 'expensesyncbot', pm2_env: { status: 'online', pm_exec_path: `${main}/start.sh` } },
    stageProcess(worktree),
  ]);
  return slot;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  getMeCalls: number;
  dropCalls: number;
  pm2Calls: string[];
}

interface Options {
  env?: Record<string, string>;
}

function runReport(slot: Slot, options: Options = {}): Run {
  const out = join(slot.root, 'call-counts');
  const done = spawnSync(
    'python3',
    ['-c', DRIVER, SCRIPT, out, '--main-dir', slot.main, '--pm2', slot.pm2],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: slot.root,
        PM2_HOME: slot.pm2Home,
        FAKE_GET_ME: STAGE_USERNAME,
        ...options.env,
      },
    },
  );
  const callsFile = join(slot.fix, 'calls');
  return {
    status: done.status,
    stdout: done.stdout,
    stderr: done.stderr,
    getMeCalls: existsSync(out) ? Number(readFileSync(out, 'utf8').split(' ')[0]) : -1,
    dropCalls: existsSync(out) ? Number(readFileSync(out, 'utf8').split(' ')[1]) : -1,
    pm2Calls: existsSync(callsFile)
      ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean)
      : [],
  };
}

interface Report {
  sha: string | null;
  online: boolean;
  started_at: number;
  restarts: number;
  username: string;
  peer: string | null;
  cases: Array<{ name: string }> | null;
  cases_error: string | null;
  slot_error: string | null;
}

function parseReport(run: Run): Report {
  const lines = run.stdout.split('\n').filter(Boolean);
  expect(lines.length).toBe(1);
  const [line] = lines;
  expect(line?.startsWith('STAGE_REPORT ')).toBe(true);
  // The line is the script's own JSON; the fields are checked one by one below.
  return JSON.parse((line ?? '').slice('STAGE_REPORT '.length)) as Report;
}

describe('the report of a slot that runs a PR', () => {
  test('names the PR commit, the stage bot, its pm2 state and the cases of that commit', () => {
    const slot = createSlot();
    const run = runReport(slot);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const report = parseReport(run);
    expect(report.sha).toBe(slot.prSha);
    expect(report.sha).not.toBe(slot.mainSha);
    expect(report.online).toBe(true);
    expect(report.username).toBe(STAGE_USERNAME);
    expect(report.peer).toBe(STAGE_ID);
    expect(report.started_at).toBe(1_761_000_000_000);
    expect(report.restarts).toBe(0);
    expect(report.cases?.map((c) => c.name)).toEqual(realCases().map((c) => c.name));
    expect(report.cases_error).toBeNull();
    expect(report.slot_error).toBeNull();
  });

  test('reads the cases from the commit, not from the working tree the PR code can touch', () => {
    const slot = createSlot();
    writeFileSync(join(slot.worktree, 'scripts/stage-smoke-cases.json'), '[]');
    const report = parseReport(runReport(slot));
    expect(report.cases?.length).toBe(realCases().length);
  });

  test('carries pm2 counters through so the driver can tell a crash from a redeploy', () => {
    const slot = createSlot();
    writeJlist(slot, [stageProcess(slot.worktree, { restart_time: 4, pm_uptime: 42 })]);
    const report = parseReport(runReport(slot));
    expect(report.restarts).toBe(4);
    expect(report.started_at).toBe(42);
  });

  test('finds the commit of a worktree whose branch name has slashes (chore/deploy-docs)', () => {
    const slot = createSlot();
    const nested = join(slot.main, '.claude/worktrees/chore/deploy-docs');
    git(slot.main, 'worktree', 'add', '-q', '--detach', nested, slot.mainSha);
    writeJlist(slot, [stageProcess(nested)]);
    expect(parseReport(runReport(slot)).sha).toBe(slot.mainSha);
  });

  test('prints no token, no env value and nothing but the report line on stdout', () => {
    const slot = createSlot();
    const run = runReport(slot);
    const everything = run.stdout + run.stderr;
    expect(everything).not.toContain('x'.repeat(35));
    expect(everything).not.toContain(`${PROD_USERNAME}\n`);
    expect(everything).not.toContain('3312');
    expect(run.stdout.split('\n').filter(Boolean).length).toBe(1);
  });
});

describe('the report of a slot that runs main or nothing', () => {
  test('a slot started by start-stage.sh from the main checkout reports the main commit', () => {
    const slot = createSlot();
    writeJlist(slot, [
      stageProcess(slot.main, {
        pm_exec_path: `${slot.main}/start-stage.sh`,
        args: null,
      }),
    ]);
    expect(parseReport(runReport(slot)).sha).toBe(slot.mainSha);
  });

  test('a slot started by bun from the main checkout reports the main commit', () => {
    const slot = createSlot();
    writeJlist(slot, [stageProcess(slot.main)]);
    expect(parseReport(runReport(slot)).sha).toBe(slot.mainSha);
  });

  test('no stage process: no commit, offline, and Telegram is not asked', () => {
    const slot = createSlot();
    writeJlist(slot, [
      { name: 'expensesyncbot', pm2_env: { status: 'online', pm_exec_path: '/x/start.sh' } },
    ]);
    const run = runReport(slot);
    const report = parseReport(run);
    expect(report.sha).toBeNull();
    expect(report.online).toBe(false);
    expect(report.cases).toBeNull();
    expect(report.slot_error).toContain('no process expensesyncbot-stage');
    expect(run.getMeCalls).toBe(0);
  });

  test('no pm2 daemon: reports an empty slot and never runs pm2 (it would spawn a daemon)', () => {
    const slot = createSlot();
    const run = runReport(slot, { env: { PM2_HOME: join(slot.root, 'no-such-home') } });
    expect(run.status).toBe(0);
    const report = parseReport(run);
    expect(report.sha).toBeNull();
    expect(report.slot_error).toContain('daemon is not running');
    expect(run.pm2Calls).toEqual([]);
  });

  test('a stopped or errored process still names its commit but is offline and carries no cases', () => {
    for (const status of ['errored', 'stopped', 'launching']) {
      const slot = createSlot();
      writeJlist(slot, [stageProcess(slot.worktree, { status })]);
      const run = runReport(slot);
      const report = parseReport(run);
      expect(report.sha).toBe(slot.prSha);
      expect(report.online).toBe(false);
      expect(report.peer).toBeNull();
      expect(report.cases).toBeNull();
      expect(run.getMeCalls).toBe(0);
    }
  });

  test('pm2 prints a list with no usable process shape: the slot is empty', () => {
    const slot = createSlot();
    writeJlist(slot, [{ name: 'expensesyncbot-stage' }]);
    const report = parseReport(runReport(slot));
    expect(report.sha).toBeNull();
    expect(report.slot_error).toContain('does not run from the main checkout');
  });
});

describe('where the stage process may run from', () => {
  function expectNoCommit(slot: Slot, codeDir: string): void {
    writeJlist(slot, [stageProcess(codeDir)]);
    const run = runReport(slot);
    expect(run.status).toBe(0);
    const report = parseReport(run);
    expect(report.sha).toBeNull();
    expect(report.cases).toBeNull();
    expect(report.slot_error).toContain('does not run from the main checkout');
    expect(run.getMeCalls).toBe(0);
  }

  test('a directory outside the main checkout is not read', () => {
    const slot = createSlot();
    const other = join(slot.root, 'elsewhere');
    mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    expectNoCommit(slot, other);
  });

  test('`..` out of the worktrees directory does not pass', () => {
    const slot = createSlot();
    expectNoCommit(slot, `${slot.main}/.claude/worktrees/../../../elsewhere`);
  });

  test('a symlink under the worktrees directory that points outside does not pass', () => {
    const slot = createSlot();
    const other = join(slot.root, 'elsewhere');
    mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    symlinkSync(other, join(slot.main, '.claude/worktrees/link'));
    expectNoCommit(slot, `${slot.main}/.claude/worktrees/link`);
  });

  test('a plain directory under the worktrees directory that is no checkout does not pass', () => {
    const slot = createSlot();
    mkdirSync(join(slot.main, '.claude/worktrees/plain'), { recursive: true });
    expectNoCommit(slot, `${slot.main}/.claude/worktrees/plain`);
  });

  test('a prefix of the main directory name is not the main directory', () => {
    const slot = createSlot();
    const sibling = `${slot.main}-evil`;
    mkdirSync(sibling);
    git(sibling, 'init', '-q', '-b', 'main');
    expectNoCommit(slot, sibling);
  });
});

describe('the PR case list is data that is held to the floor', () => {
  function reportWithCases(text: string) {
    const slot = createSlot();
    writeFileSync(join(slot.worktree, 'scripts/stage-smoke-cases.json'), text);
    commitAll(slot.worktree, 'edit cases');
    const run = runReport(slot);
    expect(run.status).toBe(0);
    return parseReport(run);
  }

  test('fewer than five cases', () => {
    const report = reportWithCases(JSON.stringify(realCases().slice(0, 4)));
    expect(report.cases).toBeNull();
    expect(report.cases_error).toContain('at least 5 are required');
    expect(report.sha).not.toBeNull();
  });

  test('a required case name missing', () => {
    const report = reportWithCases(JSON.stringify(realCases().filter((c) => c.name !== 'start')));
    expect(report.cases).toBeNull();
    expect(report.cases_error).toContain('required case(s) missing: start');
  });

  test('an empty list', () => {
    const report = reportWithCases('[]');
    expect(report.cases).toBeNull();
    expect(report.cases_error).toContain('has no smoke cases');
  });

  test('not JSON', () => {
    const report = reportWithCases('{nope');
    expect(report.cases).toBeNull();
    expect(report.cases_error).toContain('not valid JSON');
  });

  test('a case that sends two lines, a case with a bad pattern and a duplicated name', () => {
    const base = realCases();
    const twoLines = [...base.slice(1), { ...base[0], send: 'a\nb' }];
    expect(reportWithCases(JSON.stringify(twoLines)).cases_error).toContain('one line');
    const badPattern = [...base.slice(1), { ...base[0], expect: ['('] }];
    expect(reportWithCases(JSON.stringify(badPattern)).cases_error).toContain('bad expect pattern');
    const duplicated = [...base, base[0]];
    expect(reportWithCases(JSON.stringify(duplicated)).cases_error).toContain(
      'duplicate case name',
    );
  });

  test.each(BAD_CASES)('$title is refused with its reason', ({ mutate, reason }) => {
    const report = reportWithCases(JSON.stringify(withCase('ping', mutate(pingCase()))));
    expect(report.cases).toBeNull();
    expect(report.cases_error).toContain(reason);
    expect(report.sha).not.toBeNull();
  });

  test.each([
    'NaN',
    'Infinity',
    '-Infinity',
  ])('the JSON constant %s is not valid JSON', (constant) => {
    const text = JSON.stringify(realCases()).replace('"timeout_s":60', `"timeout_s":${constant}`);
    expect(text).toContain(constant);
    const report = reportWithCases(text);
    expect(report.cases).toBeNull();
    expect(report.cases_error).toContain('not valid JSON');
  });

  test('JSON nested far deeper than the parser allows, and a nested regular expression, are refused not crashed on', () => {
    const deep = reportWithCases(`${'['.repeat(50_000)}${']'.repeat(50_000)}`);
    expect(deep.cases).toBeNull();
    // Older Pythons raise RecursionError inside json.loads, newer ones return a list of lists: both are refused.
    expect(deep.cases_error).toMatch(/not valid JSON|has no text name/);
    const nested = reportWithCases(
      JSON.stringify(
        withCase('ping', { ...pingCase(), expect: [`${'('.repeat(5000)}a${')'.repeat(5000)}`] }),
      ),
    );
    expect(nested.cases).toBeNull();
    expect(nested.cases_error).toContain('case ping: bad expect pattern');
  });

  test('a case list that is not a list', () => {
    const report = reportWithCases('{"cases": []}');
    expect(report.cases).toBeNull();
    expect(report.cases_error).toContain('is not a list of cases');
  });

  test('a file larger than the cap', () => {
    const padding = 'x'.repeat(300_000);
    const report = reportWithCases(JSON.stringify([{ ...realCases()[0], note: padding }]));
    expect(report.cases).toBeNull();
    expect(report.cases_error).toContain('larger than');
  });

  test('the Russian patterns survive a session whose locale is not UTF-8', () => {
    const slot = createSlot();
    const run = runReport(slot, {
      env: { LC_ALL: 'C', PYTHONUTF8: '0', PYTHONCOERCECLOCALE: '0' },
    });
    expect(run.status).toBe(0);
    expect(parseReport(run).cases).toEqual(realCases());
  });

  test('the commit has no case file at all', () => {
    const slot = createSlot();
    git(slot.worktree, 'rm', '-q', 'scripts/stage-smoke-cases.json');
    commitAll(slot.worktree, 'drop the cases');
    const report = parseReport(runReport(slot));
    expect(report.cases).toBeNull();
    expect(report.cases_error).toContain('is not in commit');
  });
});

describe('what it takes as input', () => {
  test('nothing: the environment of the caller (an ssh command included) does not change the report', () => {
    const slot = createSlot();
    const plain = runReport(slot);
    expect(plain.status).toBe(0);
    const withCommand = runReport(slot, { env: { SSH_ORIGINAL_COMMAND: 'rm -rf /' } });
    expect(withCommand.status).toBe(0);
    expect(withCommand.stdout).toBe(plain.stdout);
  });

  test('started as another user it stays that user and never drops anything', () => {
    const slot = createSlot();
    expect(runReport(slot).dropCalls).toBe(0);
  });

  test('is a script that works when started directly, and refuses an argument it does not know (exit 2)', () => {
    const slot = createSlot();
    const done = spawnSync(SCRIPT, ['--main-dir', slot.main, '--pm2', slot.pm2, 'report'], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: slot.root, PM2_HOME: slot.pm2Home },
    });
    expect(done.status).toBe(2);
    expect(done.stdout).toBe('');
  });
});

describe('started as root through sudo, the door of the report', () => {
  test('drops to the service user before it reads anything, and reports with that user home', () => {
    const slot = createSlot();
    const home = join(slot.root, 'service-home');
    mkdirSync(join(home, '.pm2'), { recursive: true });
    writeFileSync(join(home, '.pm2/rpc.sock'), '');
    const run = runReport(slot, {
      env: { FAKE_EUID: '0', FAKE_HOME_AFTER_DROP: home, PM2_HOME: join(slot.root, 'roots-pm2') },
    });
    expect(run.status).toBe(0);
    expect(run.dropCalls).toBe(1);
    expect(parseReport(run).sha).toBe(slot.prSha);
  });

  test('a root that cannot drop reports nothing and runs nothing: exit 3', () => {
    const slot = createSlot();
    const run = runReport(slot, { env: { FAKE_EUID: '0', FAKE_DROP_FAIL: '1' } });
    expect(run.status).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('cannot drop to www-data');
    expect(run.pm2Calls).toEqual([]);
    expect(run.getMeCalls).toBe(0);
  });

  test('a caller environment cannot change what is read: an ssh command in it is ignored', () => {
    const slot = createSlot();
    const home = join(slot.root, 'service-home');
    mkdirSync(join(home, '.pm2'), { recursive: true });
    writeFileSync(join(home, '.pm2/rpc.sock'), '');
    const run = runReport(slot, {
      env: { FAKE_EUID: '0', FAKE_HOME_AFTER_DROP: home, SSH_ORIGINAL_COMMAND: 'id' },
    });
    expect(run.status).toBe(0);
    expect(run.dropCalls).toBe(1);
  });

  // The real drop needs root to run; its calls and their order are checked against recorders.
  const DROP = `
import importlib.util, os, pwd, sys
spec = importlib.util.spec_from_file_location("odroid_report", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
calls = []
os.setgroups = lambda groups: calls.append(("setgroups", list(groups)))
os.setgid = lambda gid: calls.append(("setgid", gid))
os.setuid = lambda uid: calls.append(("setuid", uid))
mode = sys.argv[2]
if mode == "missing":
    def lookup(name):
        raise KeyError(name)
else:
    uid = 0 if mode == "root" else 33
    def lookup(name):
        calls.append(("lookup", name))
        return pwd.struct_passwd(("www-data", "x", uid, 33, "", "/var/www", "/bin/false"))
pwd.getpwnam = lookup
try:
    env = module.drop_to_service_user({"PATH": "/bin", "PM2_HOME": "/root/.pm2", "HOME": "/root"})
    print(repr(calls), repr(sorted(env.items())))
except module.NotProvisioned as error:
    print("NotProvisioned", error, repr(calls))
`;

  function drop(mode: string): string {
    return spawnSync('python3', ['-c', DROP, SCRIPT, mode], { encoding: 'utf8' }).stdout.trim();
  }

  test('the real drop clears the groups first, then the gid, then the uid, and returns www-data home without the caller PM2_HOME', () => {
    expect(drop('ok')).toBe(
      "[('lookup', 'www-data'), ('setgroups', []), ('setgid', 33), ('setuid', 33)] " +
        "[('HOME', '/var/www'), ('PATH', '/bin')]",
    );
  });

  test('a missing www-data account, or one that is root, is not provisioned', () => {
    expect(drop('missing')).toContain('NotProvisioned cannot drop to www-data (KeyError) []');
    expect(drop('root')).toContain('NotProvisioned cannot drop to www-data (KeyError)');
    expect(drop('root')).not.toContain('setuid');
  });
});

describe('when the stage identity or pm2 cannot be proven', () => {
  test('Telegram says the stage token belongs to another bot', () => {
    const slot = createSlot();
    const run = runReport(slot, { env: { FAKE_GET_ME: PROD_USERNAME } });
    expect(run.status).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(`belongs to @${PROD_USERNAME}`);
  });

  test('Telegram is unreachable', () => {
    const slot = createSlot();
    const run = runReport(slot, { env: { FAKE_GET_ME_FAIL: '1' } });
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('getMe for the stage token failed');
  });

  test('the stage token is the production token', () => {
    const slot = createSlot();
    writeFileSync(
      join(slot.main, '.env.stage'),
      envText({ BOT_TOKEN: fakeBotCredential(PROD_ID) }),
    );
    const run = runReport(slot);
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('the stage token is the production token');
    expect(run.getMeCalls).toBe(0);
  });

  test('the stage env file is missing or has no token', () => {
    const slot = createSlot();
    writeFileSync(join(slot.main, '.env.stage'), 'PORT=3312\n');
    expect(runReport(slot).stderr).toContain('stage BOT_TOKEN is missing');
    expect(runReport(slot).status).toBe(3);
    writeFileSync(join(slot.main, '.env.stage'), '');
    expect(runReport(slot).status).toBe(3);
  });

  test('the production env file is missing: the production comparison would be skipped, so it is not provisioned', () => {
    const slot = createSlot();
    rmSync(join(slot.main, '.env'));
    const run = runReport(slot);
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('.env is not readable');
    expect(run.getMeCalls).toBe(0);
  });

  test('a stage env file that is not UTF-8 is not provisioned, not a crash', () => {
    const slot = createSlot();
    writeFileSync(join(slot.main, '.env.stage'), Buffer.from([0xff, 0xfe, 0x42, 0x4f, 0x54, 0x3d]));
    const run = runReport(slot);
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('.env.stage is not readable');
  });

  test('pm2 fails or prints something that is not a list', () => {
    const slot = createSlot();
    writeFileSync(join(slot.fix, 'jlist.fail'), '');
    expect(runReport(slot).status).toBe(3);
    const second = createSlot();
    writeFileSync(join(second.fix, 'jlist.raw'), 'Error: connect ECONNREFUSED\n');
    const run = runReport(second);
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('did not print a JSON list');
  });

  test('the engine next to the script is missing', () => {
    const slot = createSlot();
    const lib = join(slot.root, 'lib');
    mkdirSync(lib);
    writeExecutable(join(lib, 'odroid-stage-qa-report.py'), readFileSync(SCRIPT, 'utf8'));
    const done = spawnSync(
      'python3',
      [join(lib, 'odroid-stage-qa-report.py'), '--main-dir', slot.main, '--pm2', slot.pm2],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: slot.root,
          PM2_HOME: slot.pm2Home,
        },
      },
    );
    expect(done.status).toBe(3);
    expect(done.stderr).toContain('stage-smoke.py not found');
  });
});

describe('read-only', () => {
  function snapshot(dir: string): string[] {
    const lines: string[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) {
          const stat = statSync(path);
          lines.push(`${path} ${stat.size} ${stat.mtimeMs} ${readFileSync(path).toString('hex')}`);
        } else lines.push(`${path} ${entry.isSymbolicLink() ? 'link' : 'other'}`);
        if (entry.isDirectory()) lines.push(`${path}/ ${statSync(path).mtimeMs}`);
      }
    };
    walk(dir);
    return lines;
  }

  test('a run changes no file, directory or timestamp under the checkouts, the env files and pm2 home', () => {
    const slot = createSlot();
    const before = snapshot(slot.main).concat(snapshot(slot.pm2Home));
    for (let i = 0; i < 3; i++) expect(runReport(slot).status).toBe(0);
    expect(snapshot(slot.main).concat(snapshot(slot.pm2Home))).toEqual(before);
  });

  test('the only pm2 command it ever runs is `jlist`', () => {
    const slot = createSlot();
    runReport(slot);
    runReport(slot);
    expect(runReport(slot).pm2Calls).toEqual(['jlist', 'jlist', 'jlist']);
  });

  test('the script has no code that writes, deletes, signals or locks', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    for (const forbidden of [
      /open\([^)]*['"][wax]\+?b?['"]/,
      /\.write_text\(/,
      /os\.(remove|unlink|rename|replace|mkdir|makedirs|chmod|kill|system)\(/,
      /shutil\.(rmtree|move|copy)/,
      /\bflock\b/,
      /['"]pm2['"].*['"](start|stop|delete|restart|reload|save)['"]/,
    ]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});
