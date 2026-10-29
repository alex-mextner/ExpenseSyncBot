// scripts/stage-qa-browser.py is the browser-host half of the per-PR stage QA: the odroid driver opens it as an
// ssh forced command with the commit on the command line and the stdin kept open. It takes the browser lock it
// shares with the HyperCalendarBot runs FIRST and prints `STAGE_BROWSER_LOCKED`; only then does it read the slot
// report from the first stdin line, validate it against its OWN config, run the PR's cases through qa-cli, and
// exit with the verdict. The engine is a stub stage-smoke.py next to a copy of the script (the script runs the
// engine that sits beside it) and qa-cli is a file that only has to exist. The driver's end of the ssh
// connection is a child whose stdin stays open, as the real one does, because the end of that stdin means "the
// odroid driver is gone". Nothing here touches Telegram, ssh or the net.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  BAD_CASES,
  type Finished,
  holdLock,
  isAlive,
  lockIsFree,
  PROD_USERNAME,
  pingCase,
  REPO,
  REQUIRED_CASES,
  realCases,
  type SmokeCase,
  STAGE_USERNAME,
  type StartedProcess,
  startProcess,
  type TempRoot,
  tempRoot,
  withCase,
  writeExecutable,
} from '../test-utils/stage-qa-fixtures';

setDefaultTimeout(60_000);

const BROWSER = join(REPO, 'scripts/stage-qa-browser.py');
const COMMON = join(REPO, 'scripts/stage_qa_common.py');
const SHA = 'a'.repeat(40);
const LOCKED = 'STAGE_BROWSER_LOCKED';
const OTHER_SHA = 'b'.repeat(40);
const PEER = '222222222';
// The lock file HyperCalendarBot's browser half uses too: one Telegram Web session at a time.
const SHARED_LOCK = '.local/state/hypercal-stage-qa/qa.lock';

// The engine: records how it was called, plays a scenario, and can hang with a child to prove the whole
// process group is killed.
const STUB_SMOKE = `#!/usr/bin/env python3
import fcntl, json, os, signal, subprocess, sys, time
here = os.path.dirname(os.path.abspath(__file__))
scenario = json.load(open(os.path.join(here, "smoke_scenario.json")))
args = sys.argv[1:]
cases_path = args[args.index("--cases-json") + 1]
held = False
try:
    probe = open(scenario["lock_file"])
    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    held = True
with open(scenario["record"], "w") as handle:
    json.dump({
        "argv": args,
        "cases": json.load(open(cases_path)),
        "cases_mode": os.stat(cases_path).st_mode & 0o777,
        "cases_path": cases_path,
        "lock_held_by_browser": held,
        "owner": open(scenario["lock_file"] + ".owner").read(),
    }, handle)
for line in scenario.get("stdout", []):
    print(line, flush=True)
if scenario.get("sleep"):
    # Ignored signals are inherited: only SIGKILL stops this process and its child.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    with open(scenario["marker"], "w") as handle:
        json.dump({"pid": os.getpid(), "child": child.pid}, handle)
    print("SMOKE hanging", flush=True)
    time.sleep(scenario["sleep"])
sys.exit(scenario.get("rc", 0))
`;

interface ReportFields {
  sha: string | null;
  online: boolean;
  started_at: number;
  restarts: number;
  username: string;
  peer: string | null;
  cases: unknown;
  cases_error: string | null;
  slot_error: string | null;
}

function report(overrides: Partial<ReportFields> = {}): ReportFields {
  return {
    sha: SHA,
    online: true,
    started_at: 1_761_000_000_000,
    restarts: 0,
    username: STAGE_USERNAME,
    peer: PEER,
    cases: realCases(),
    cases_error: null,
    slot_error: null,
    ...overrides,
  };
}

interface SmokeScenario {
  rc?: number;
  stdout?: string[];
  sleep?: number;
}

const PASSED = (cases = 7): SmokeScenario => ({
  rc: 0,
  stdout: [
    'SMOKE PASS start',
    `STAGE_SMOKE_PASSED sha=${SHA} bot=@${STAGE_USERNAME} cases=${cases} failed=0`,
  ],
});

const FAILED: SmokeScenario = {
  rc: 1,
  stdout: [`STAGE_SMOKE_FAILED sha=${SHA} bot=@${STAGE_USERNAME} cases=7 failed=2`],
};

interface SmokeRecord {
  argv: string[];
  cases: unknown;
  cases_mode: number;
  cases_path: string;
  lock_held_by_browser: boolean;
  owner: string;
}

interface Fixture {
  root: string;
  home: string;
  config: Record<string, unknown>;
  configPath: string;
  smoke: (scenario: SmokeScenario) => void;
  writeConfig: () => void;
  /** Starts the script as the odroid driver's ssh connection would: the report on the first stdin line, stdin open. */
  start: (args?: string[], payload?: string | null) => StartedProcess;
  /** Runs to the end with the report on stdin (and stdin open until the script exits). */
  run: (
    payload?: ReportFields | Record<string, unknown> | string,
    args?: string[],
  ) => Promise<Finished>;
  smokeRecord: () => SmokeRecord | null;
  lockFile: string;
  lib: string;
}

let temp: TempRoot | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

function createFixture(configOverrides: Record<string, unknown> = {}): Fixture {
  temp = tempRoot('stage-qa-browser-');
  const root = temp.dir;
  const home = join(root, 'home');
  const lib = join(root, 'lib');
  mkdirSync(join(home, '.config/esb-stage-qa'), { recursive: true });
  mkdirSync(lib);
  copyFileSync(BROWSER, join(lib, 'stage-qa-browser.py'));
  copyFileSync(COMMON, join(lib, 'stage_qa_common.py'));
  writeExecutable(join(lib, 'stage-smoke.py'), STUB_SMOKE);
  writeExecutable(join(home, 'qa'), '#!/bin/sh\nexit 0\n');
  const lockFile = join(home, SHARED_LOCK);
  const config = {
    username: STAGE_USERNAME,
    qa_bin: join(home, 'qa'),
    state_dir: join(home, 'state'),
    lock_max_wait: 1,
    smoke_timeout: 30,
    ...configOverrides,
  };
  const configPath = join(home, '.config/esb-stage-qa/browser.json');
  const env = { PATH: process.env['PATH'] ?? '', HOME: home };
  const fixture: Fixture = {
    root,
    home,
    config,
    configPath,
    lockFile,
    lib,
    smoke: (scenario) =>
      writeFileSync(
        join(lib, 'smoke_scenario.json'),
        JSON.stringify({
          record: join(root, 'smoke.json'),
          marker: join(root, 'marker.json'),
          lock_file: lockFile,
          ...scenario,
        }),
      ),
    writeConfig: () => {
      writeFileSync(configPath, JSON.stringify(fixture.config));
      chmodSync(configPath, 0o600);
    },
    start: (args = [SHA], payload = JSON.stringify(report())) =>
      startProcess(
        'python3',
        [join(lib, 'stage-qa-browser.py'), ...args, '--config', configPath],
        env,
        payload ?? undefined,
      ),
    run: (payload = report(), args = [SHA]) =>
      fixture.start(args, typeof payload === 'string' ? payload : JSON.stringify(payload)).finished,
    smokeRecord: () => {
      const file = join(root, 'smoke.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    },
  };
  fixture.writeConfig();
  return fixture;
}

/** The only things on stdout: the LOCKED line (when the lock was taken) and the final result line. */
function result(done: Finished): string {
  const lines = done.stdout.split('\n').filter(Boolean);
  const line = lines.pop();
  expect(line?.startsWith('STAGE_QA_RESULT ')).toBe(true);
  expect(lines.every((text) => text === LOCKED)).toBe(true);
  expect(lines.length).toBeLessThanOrEqual(1);
  return line ?? '';
}

describe('a report for the requested commit whose cases pass', () => {
  test('passes: exit 0 and the result line with the case count', async () => {
    const f = createFixture();
    f.smoke(PASSED(7));
    const done = await f.run();
    expect(done.status).toBe(0);
    expect(result(done)).toBe(`STAGE_QA_RESULT status=passed sha=${SHA} cases=7 failed=0`);
  });

  test('hands the validated cases and the stage bot id to the engine, with the production bot denied', async () => {
    const f = createFixture();
    f.smoke(PASSED());
    await f.run();
    const record = f.smokeRecord();
    expect(record?.cases).toEqual(realCases());
    expect(record?.cases_mode).toBe(0o600);
    const argv = record?.argv ?? [];
    expect(argv[0]).toBe('run');
    const value = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
    expect(value('--username')).toBe(STAGE_USERNAME);
    expect(value('--peer')).toBe(PEER);
    expect(value('--sha')).toBe(SHA);
    expect(value('--deny')).toBe(PROD_USERNAME);
    expect(value('--min-cases')).toBe('5');
    expect(value('--base-cases')).toBe(String(realCases().length));
    expect(value('--receipt')).toBe(join(f.home, `state/receipts/${SHA}.json`));
    expect(value('--qa-bin')).toBe(join(f.home, 'qa'));
  });

  test('keeps stdout to the result line: the engine output goes to stderr', async () => {
    const f = createFixture();
    f.smoke(PASSED());
    const done = await f.run();
    result(done);
    expect(done.stderr).toContain('SMOKE PASS start');
  });

  test('removes the temporary case file and ignores everything after the first stdin line', async () => {
    const f = createFixture();
    f.smoke(PASSED());
    const started = f.start();
    started.send('STAGE_QA_RESULT status=passed sha=x cases=99 failed=0');
    const done = await started.finished;
    expect(done.status).toBe(0);
    const left = spawnSync('find', [join(f.home, 'state'), '-name', 'cases-*'], {
      encoding: 'utf8',
    });
    expect(left.stdout).toBe('');
    expect(result(done)).toContain('cases=7');
  });
});

describe('the browser half does not trust the odroid', () => {
  async function refuse(payload: ReportFields | Record<string, unknown> | string, message: string) {
    const f = createFixture();
    f.smoke(PASSED());
    const done = await f.run(payload);
    expect(done.status).toBe(2);
    expect(result(done)).toBe(`STAGE_QA_RESULT status=refused sha=${SHA} cases=0 failed=0`);
    expect(done.stderr).toContain(message);
    expect(f.smokeRecord()).toBeNull();
  }

  test.each([
    ['another bot', report({ username: 'SomeOtherStageBot' })],
    ['the production bot', report({ username: PROD_USERNAME })],
    ['a username that is no text', { ...report(), username: 7 }],
  ])('a report naming %s', async (_name, payload) => {
    await refuse(payload, 'another bot than the configured');
  });

  test('a report for another commit than the one requested', async () => {
    await refuse(report({ sha: OTHER_SHA }), 'another commit than the one requested');
    await refuse(report({ sha: null }), 'another commit than the one requested');
  });

  test('a report that does not say the bot is online', async () => {
    await refuse(report({ online: false }), 'does not say the stage bot is online');
    await refuse({ ...report(), online: 'yes' }, 'does not say the stage bot is online');
  });

  test('a peer that is not a numeric id, and an online bot without one', async () => {
    await refuse(report({ peer: '12; rm -rf /' }), 'peer is not a numeric bot id');
    await refuse(report({ peer: null }), 'no bot id for an online bot');
  });

  test('cases that are no list', async () => {
    await refuse(report({ cases: 'nope' }), 'cases is not a list');
  });

  test('fewer cases than the floor, even when the odroid says it was fine', async () => {
    await refuse(
      report({ cases: realCases().slice(0, 4) }),
      'only 4 cases; at least 5 are required',
    );
  });

  test('a required case missing', async () => {
    await refuse(
      report({ cases: realCases().filter((c: SmokeCase) => c.name !== 'ping') }),
      'required case(s) missing: ping',
    );
  });

  test('duplicate case names and cases without a name', async () => {
    await refuse(report({ cases: [...realCases(), realCases()[0]] }), 'duplicate case names');
    await refuse(report({ cases: [...realCases(), { send: 'x' }] }), 'a case has no text name');
  });

  test.each(BAD_CASES)('$title is refused with its reason', async ({ mutate, reason }) => {
    await refuse(report({ cases: withCase('ping', mutate(pingCase())) }), reason);
  });

  test.each([
    'NaN',
    'Infinity',
    '-Infinity',
  ])('the JSON constant %s is not valid JSON', async (constant) => {
    const raw = JSON.stringify(report()).replace('"timeout_s":60', `"timeout_s":${constant}`);
    expect(raw).toContain(constant);
    await refuse(raw, 'not valid JSON');
  });

  test('a case list the odroid rejected: refused with the odroid reason', async () => {
    await refuse(
      report({ cases: null, cases_error: 'required case(s) missing: start' }),
      "the PR's case list is not usable: required case(s) missing: start",
    );
    await refuse(report({ cases: null }), 'the odroid sent none');
  });

  test('a payload that is not JSON or not an object', async () => {
    await refuse('{nope', 'not valid JSON');
    await refuse('[1]', 'payload is not an object');
  });

  test('a first stdin line that is empty, or larger than the bound', async () => {
    const f = createFixture();
    f.smoke(PASSED());
    const started = f.start([SHA], '');
    const empty = await started.finished;
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain('first stdin line must be the STAGE_REPORT JSON payload');
    const big = createFixture();
    big.smoke(PASSED());
    const huge = await big.run(`{"pad":"${'x'.repeat((1 << 20) + 10)}"}`);
    expect(huge.status).toBe(2);
    expect(huge.stderr).toContain('is larger than');
    expect(big.smokeRecord()).toBeNull();
  });
});

describe('the engine verdicts', () => {
  async function runWith(smoke: SmokeScenario, overrides: Record<string, unknown> = {}) {
    const f = createFixture(overrides);
    f.smoke(smoke);
    return f.run();
  }

  test('exit 0 without a pass summary is a failure, never a pass', async () => {
    expect((await runWith({ rc: 0, stdout: [] })).status).toBe(1);
  });

  test('a pass summary that covers fewer cases than the floor is a failure', async () => {
    expect((await runWith(PASSED(4))).status).toBe(1);
  });

  test('a pass summary that reports failures is a failure', async () => {
    const done = await runWith({
      rc: 0,
      stdout: [`STAGE_SMOKE_PASSED sha=${SHA} bot=@${STAGE_USERNAME} cases=7 failed=1`],
    });
    expect(done.status).toBe(1);
  });

  test('a failed case fails the run and the result line says how many', async () => {
    const done = await runWith(FAILED);
    expect(done.status).toBe(1);
    expect(result(done)).toBe(`STAGE_QA_RESULT status=failed sha=${SHA} cases=7 failed=2`);
  });

  test('engine exit 64 (refused) is exit 2, exit 69 (qa-cli unavailable) is exit 3, anything else is 1', async () => {
    expect((await runWith({ rc: 64 })).status).toBe(2);
    const unavailable = await runWith({ rc: 69 });
    expect(unavailable.status).toBe(3);
    expect(unavailable.stderr).toContain('qa-cli is unavailable');
    expect((await runWith({ rc: 7 })).status).toBe(1);
  });

  test('a hung engine is killed with its whole process group after smoke_timeout: exit 1', async () => {
    const f = createFixture({ smoke_timeout: 1 });
    f.smoke({ sleep: 60 });
    const done = await f.run();
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('the smoke timed out');
    const marker = JSON.parse(readFileSync(join(f.root, 'marker.json'), 'utf8'));
    expect(isAlive(marker.pid)).toBe(false);
    expect(isAlive(marker.child)).toBe(false);
  });
});

describe('the odroid driver going away', () => {
  test('the end of stdin while the engine runs stops the engine and its children: exit 1', async () => {
    const f = createFixture();
    f.smoke({ sleep: 60 });
    const started = f.start();
    await started.stderrSeen('SMOKE hanging');
    started.closeStdin();
    const done = await started.finished;
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('the odroid driver went away while the smoke was running');
    expect(result(done)).toContain('status=failed');
    const marker = JSON.parse(readFileSync(join(f.root, 'marker.json'), 'utf8'));
    expect(isAlive(marker.pid)).toBe(false);
    expect(isAlive(marker.child)).toBe(false);
    expect(lockIsFree(f.lockFile)).toBe(true);
  });

  test('the end of stdin while waiting for the browser lock gives up the wait: exit 1, no engine', async () => {
    const f = createFixture({ lock_max_wait: 60 });
    f.smoke(PASSED());
    const holder = holdLock(f.lockFile);
    try {
      await holder.ready;
      const started = f.start();
      await started.stderrSeen('waiting for the browser lock');
      started.closeStdin();
      const done = await started.finished;
      expect(done.status).toBe(1);
      expect(done.stderr).toContain('went away before the run started');
      expect(f.smokeRecord()).toBeNull();
    } finally {
      holder.stop();
    }
  });
});

describe('provisioning', () => {
  async function notProvisioned(f: Fixture, message: string): Promise<void> {
    f.smoke(PASSED());
    const done = await f.run();
    expect(done.status).toBe(3);
    expect(done.stderr).toContain(message);
    expect(result(done)).toContain('status=not-provisioned');
    expect(f.smokeRecord()).toBeNull();
  }

  test('no config', async () => {
    const f = createFixture();
    spawnSync('rm', [f.configPath]);
    await notProvisioned(f, 'not found; run scripts/install-stage-qa-browser.sh');
  });

  test('a config others can read, a config that is not JSON, an unknown key, a missing key', async () => {
    const f = createFixture();
    chmodSync(f.configPath, 0o644);
    await notProvisioned(f, 'must be 0600');
    f.config['bogus'] = 1;
    f.writeConfig();
    await notProvisioned(f, 'unknown key(s): bogus');
    delete f.config['bogus'];
    delete f.config['username'];
    f.writeConfig();
    await notProvisioned(f, 'missing required key username');
    writeFileSync(f.configPath, '{nope');
    await notProvisioned(f, 'is not valid JSON');
  });

  test('a username that is not a stage bot or is the production bot', async () => {
    const f = createFixture({ username: PROD_USERNAME });
    await notProvisioned(f, 'must be a Telegram bot username containing stage or stg');
    f.config['username'] = 'SomeStageBot';
    f.config['deny_usernames'] = ['somestagebot'];
    f.writeConfig();
    await notProvisioned(f, 'username is in deny_usernames');
  });

  test('no qa-cli, no python, no engine next to the script', async () => {
    const f = createFixture();
    chmodSync(join(f.home, 'qa'), 0o644);
    await notProvisioned(f, 'not found or not executable');
    chmodSync(join(f.home, 'qa'), 0o755);
    f.config['python'] = 'no-such-python-xyz';
    f.writeConfig();
    await notProvisioned(f, 'python no-such-python-xyz not found in PATH');
    f.config['python'] = 'python3';
    f.writeConfig();
    spawnSync('rm', [join(f.lib, 'stage-smoke.py')]);
    await notProvisioned(f, 'stage-smoke.py not found');
  });

  test('wrong types and values in the config', async () => {
    const f = createFixture({ min_cases: 0 });
    await notProvisioned(f, 'min_cases must be an integer >= 1');
    f.config['min_cases'] = 5;
    f.config['payload_wait'] = 0;
    f.writeConfig();
    await notProvisioned(f, 'payload_wait must be a number > 0');
    f.config['payload_wait'] = 7500;
    f.config['smoke_timeout'] = 0;
    f.writeConfig();
    await notProvisioned(f, 'smoke_timeout must be a number > 0');
    f.config['smoke_timeout'] = 30;
    f.config['state_dir'] = 'relative/dir';
    f.writeConfig();
    await notProvisioned(f, 'state_dir must be an absolute path');
    f.config['state_dir'] = join(f.home, 'state');
    f.config['required_forbid'] = [];
    f.writeConfig();
    await notProvisioned(f, 'required_forbid must not be empty');
  });

  test('a config the installer wrote for the other repository (unknown key) is not accepted', async () => {
    const f = createFixture({ ssh_target: 'root@odroid' });
    await notProvisioned(f, 'unknown key(s): ssh_target');
  });
});

describe('arguments', () => {
  test.each([
    [['not-a-sha']],
    [[SHA.toUpperCase()]],
    [[`${SHA}x`]],
    [['-x']],
    [[]],
    [[SHA, SHA]],
  ])('argv %p is refused with exit 2 and a result line', async (args) => {
    const f = createFixture();
    f.smoke(PASSED());
    const done = await f.run(report(), args);
    expect(done.status).toBe(2);
    expect(result(done)).toBe('STAGE_QA_RESULT status=refused sha=- cases=0 failed=0');
    expect(f.smokeRecord()).toBeNull();
  });

  test('--help is no help: nothing but the result line reaches stdout', async () => {
    const f = createFixture();
    const done = await f.run(report(), ['--help']);
    expect(done.status).toBe(2);
    expect(result(done)).toBe('STAGE_QA_RESULT status=refused sha=- cases=0 failed=0');
  });
});

describe('the lock order: the lock first, then LOCKED, then the payload', () => {
  test('prints LOCKED only once the lock is held, before it reads the payload, then the result line', async () => {
    const f = createFixture();
    f.smoke(PASSED());
    const started = f.start([SHA], null);
    await started.stdoutSeen(LOCKED);
    expect(lockIsFree(f.lockFile)).toBe(false);
    expect(started.stdoutText()).toBe(`${LOCKED}\n`);
    expect(f.smokeRecord()).toBeNull();
    started.send(JSON.stringify(report()));
    const done = await started.finished;
    expect(done.status).toBe(0);
    expect(done.stdout).toBe(
      `${LOCKED}\nSTAGE_QA_RESULT status=passed sha=${SHA} cases=7 failed=0\n`,
    );
    expect(lockIsFree(f.lockFile)).toBe(true);
  });

  test('prints nothing while another QA run holds the lock, and LOCKED when that run lets go', async () => {
    const f = createFixture({ lock_max_wait: 60 });
    f.smoke(PASSED());
    const holder = holdLock(f.lockFile);
    await holder.ready;
    const started = f.start([SHA], null);
    await started.stderrSeen('waiting for the browser lock');
    expect(started.stdoutText()).toBe('');
    holder.stop();
    await started.stdoutSeen(LOCKED);
    started.send(JSON.stringify(report()));
    const done = await started.finished;
    expect(done.status).toBe(0);
  });

  test('no payload within payload_wait of taking the lock: exit 1, the lock is freed, no engine', async () => {
    const f = createFixture({ payload_wait: 0.6 });
    f.smoke(PASSED());
    const started = f.start([SHA], null);
    await started.stdoutSeen(LOCKED);
    const done = await started.finished;
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('no STAGE_REPORT payload within 0s of taking the lock');
    expect(done.stdout).toBe(
      `${LOCKED}\nSTAGE_QA_RESULT status=failed sha=${SHA} cases=0 failed=0\n`,
    );
    expect(lockIsFree(f.lockFile)).toBe(true);
    expect(f.smokeRecord()).toBeNull();
  });

  test('the end of stdin after LOCKED and before the payload (the odroid side ended early): exit 1, the lock is freed at once', async () => {
    const f = createFixture();
    f.smoke(PASSED());
    const started = f.start([SHA], null);
    await started.stdoutSeen(LOCKED);
    expect(lockIsFree(f.lockFile)).toBe(false);
    started.closeStdin();
    const done = await started.finished;
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('went away before the run started');
    expect(done.stdout).toBe(
      `${LOCKED}\nSTAGE_QA_RESULT status=failed sha=${SHA} cases=0 failed=0\n`,
    );
    expect(lockIsFree(f.lockFile)).toBe(true);
    expect(f.smokeRecord()).toBeNull();
  });

  test('a payload that is already waiting when the lock is taken is used after LOCKED', async () => {
    const f = createFixture();
    f.smoke(PASSED());
    const done = await f.run();
    expect(done.status).toBe(0);
    expect(done.stdout.split('\n')[0]).toBe(LOCKED);
  });
});

describe('the browser lock', () => {
  test('is held for the whole run, names this half in its owner file, and is released after', async () => {
    const f = createFixture();
    f.smoke(PASSED());
    expect((await f.run()).status).toBe(0);
    const record = f.smokeRecord();
    expect(record?.lock_held_by_browser).toBe(true);
    expect(record?.owner).toContain('repo=esb-stage-qa-browser');
    expect(readFileSync(`${f.lockFile}.owner`, 'utf8')).toBe('');
    expect(lockIsFree(f.lockFile)).toBe(true);
  });

  test('without lock_file in the config it is the file the HyperCalendarBot browser half uses, open to every user', async () => {
    const f = createFixture();
    f.smoke(PASSED());
    expect((await f.run()).status).toBe(0);
    expect(existsSync(join(f.home, SHARED_LOCK))).toBe(true);
    expect(statSync(join(f.home, SHARED_LOCK)).mode & 0o777).toBe(0o666);
  });

  test('another QA run holding it makes the run wait, then give up with exit 75 and no engine', async () => {
    const f = createFixture({ lock_max_wait: 0.5 });
    f.smoke(PASSED());
    const holder = holdLock(f.lockFile);
    try {
      await holder.ready;
      const done = await f.run();
      expect(done.status).toBe(75);
      expect(result(done)).toContain('status=lock-timeout');
      // Never locked: the odroid driver must not see the LOCKED line, so it never starts its own side.
      expect(done.stdout).not.toContain(LOCKED);
      expect(f.smokeRecord()).toBeNull();
    } finally {
      holder.stop();
    }
  });

  test('a lock released while waiting lets the run proceed', async () => {
    const f = createFixture({ lock_max_wait: 60 });
    f.smoke(PASSED());
    const holder = holdLock(f.lockFile);
    await holder.ready;
    const started = f.start();
    await started.stderrSeen('waiting for the browser lock');
    holder.stop();
    const done = await started.finished;
    expect(done.status).toBe(0);
    expect(done.stdout).toContain('status=passed');
  });

  test('the report is validated only once the lock is held: a refusal frees it at once', async () => {
    const f = createFixture();
    f.smoke(PASSED());
    const done = await f.run(report({ username: PROD_USERNAME }));
    expect(done.status).toBe(2);
    expect(lockIsFree(f.lockFile)).toBe(true);
  });
});

describe('cancellation', () => {
  test('a cancel while waiting for the lock exits 143 with a result line and leaves the other run its lock', async () => {
    const f = createFixture({ lock_max_wait: 60 });
    f.smoke(PASSED());
    const holder = holdLock(f.lockFile);
    try {
      await holder.ready;
      const started = f.start();
      await started.stderrSeen('waiting for the browser lock');
      started.child.kill('SIGTERM');
      const done = await started.finished;
      expect(done.status).toBe(143);
      expect(done.stdout).toContain('STAGE_QA_RESULT status=failed');
      expect(lockIsFree(f.lockFile)).toBe(false);
    } finally {
      holder.stop();
    }
  });

  test('a cancel while the engine runs kills it and its children and frees the lock', async () => {
    const f = createFixture();
    f.smoke({ sleep: 60 });
    const started = f.start();
    await started.stderrSeen('SMOKE hanging');
    started.child.kill('SIGTERM');
    const done = await started.finished;
    expect(done.status).toBe(143);
    const marker = JSON.parse(readFileSync(join(f.root, 'marker.json'), 'utf8'));
    expect(isAlive(marker.pid)).toBe(false);
    expect(isAlive(marker.child)).toBe(false);
    expect(lockIsFree(f.lockFile)).toBe(true);
  });
});

describe('the odroid script, the browser half and the committed case list agree', () => {
  /** A module-level value of a Python script, printed as JSON. */
  function pythonValue(script: string, expression: string): unknown {
    const done = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.util, json, sys
sys.path.insert(0, sys.argv[2])
spec = importlib.util.spec_from_file_location("m", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(${expression}))`,
        script,
        join(REPO, 'scripts'),
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(done.stdout);
  }

  const odroid = join(REPO, 'scripts/odroid-stage-qa-report.py');

  test('the required case names are the ones the committed list has', () => {
    expect(pythonValue(BROWSER, 'list(module.DEFAULTS["required_cases"])')).toEqual(REQUIRED_CASES);
    expect(pythonValue(odroid, 'list(module.REQUIRED_CASES)')).toEqual(REQUIRED_CASES);
    const names = realCases().map((c) => c.name);
    for (const name of REQUIRED_CASES) expect(names).toContain(name);
  });

  test('the error patterns every case must forbid are the same on both sides and in every committed case', () => {
    const browserForbid = pythonValue(BROWSER, 'list(module.DEFAULTS["required_forbid"])');
    expect(pythonValue(odroid, 'list(module.REQUIRED_FORBID)')).toEqual(browserForbid);
    for (const c of realCases()) expect<unknown>(c.forbid).toEqual(browserForbid);
  });

  test('the case limits live once, in the common module both sides load, and the floor of cases is the same', () => {
    const limits =
      'dict(case=module.MAX_CASE_SECONDS, settle=module.MAX_SETTLE_SECONDS, replies=module.MAX_MIN_REPLIES, probes=list(module.TRIVIAL_REPLIES))';
    expect(pythonValue(COMMON, limits)).toEqual({
      case: 300,
      settle: 60,
      replies: 20,
      probes: ['', 'x', ' ', '1'],
    });
    expect(pythonValue(odroid, 'module.MIN_CASES')).toBe(
      pythonValue(BROWSER, 'module.DEFAULTS["min_cases"]'),
    );
    expect(readFileSync(odroid, 'utf8')).toContain('common.case_problem(case, REQUIRED_FORBID)');
    expect(readFileSync(BROWSER, 'utf8')).toContain('case_problem(case, config.required_forbid)');
  });

  test('the config the installer writes is accepted by the browser half it installs', () => {
    const installer = readFileSync(join(REPO, 'scripts/install-stage-qa-browser.sh'), 'utf8');
    const written = installer.match(/<<'JSON'\n([\s\S]*?)\nJSON\n/)?.[1];
    expect(written).toBeDefined();
    const raw = JSON.parse(written ?? '{}');
    expect(raw.username).toBe(STAGE_USERNAME);
    expect(raw.deny_usernames).toEqual([PROD_USERNAME]);
    expect(raw.required_cases).toEqual(REQUIRED_CASES);
    expect(raw.lock_file).toBe(`~/${SHARED_LOCK}`);
    for (const key of Object.keys(raw)) {
      expect(
        pythonValue(BROWSER, `"${key}" in module.DEFAULTS or "${key}" in module.REQUIRED_KEYS`),
      ).toBe(true);
    }
  });
});
