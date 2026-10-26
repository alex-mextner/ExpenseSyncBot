// scripts/stage-qa-pc.py is the PC half of the per-PR stage QA: it waits until the shared stage slot on
// the odroid runs exactly the PR head, runs the PR's cases through qa-cli, and asks the odroid again
// to prove the slot did not move. The odroid is a stand-in `ssh` that answers `report` from a script,
// the engine is a stub stage-smoke.py next to a copy of the driver (the driver runs the engine that sits
// beside it), and qa-cli is a file that only has to exist. Nothing here touches Telegram, ssh or the net.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { type ChildProcess, type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
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
  PROD_USERNAME,
  pingCase,
  REPO,
  REQUIRED_CASES,
  realCases,
  type SmokeCase,
  STAGE_USERNAME,
  type TempRoot,
  tempRoot,
  withCase,
  writeExecutable,
} from '../test-utils/stage-qa-fixtures';

setDefaultTimeout(60_000);

const DRIVER = join(REPO, 'scripts/stage-qa-pc.py');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const PEER = '222222222';
const SHARED_LOCK = '.local/state/hypercal-stage-qa/qa.lock';

// The odroid: answers every `ssh ... report` from ssh_scenario.json, one response per call (the last one
// repeats), and logs the argv of each call.
const FAKE_SSH = `#!/usr/bin/env python3
import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
scenario = json.load(open(os.path.join(here, "ssh_scenario.json")))
counter = os.path.join(here, "ssh_count")
count = int(open(counter).read()) if os.path.exists(counter) else 0
open(counter, "w").write(str(count + 1))
with open(scenario["log"], "a") as handle:
    handle.write(json.dumps({"argv": sys.argv[1:], "stdin_tty": sys.stdin.isatty()}) + "\\n")
response = scenario["responses"][min(count, len(scenario["responses"]) - 1)]
if response.get("sleep"):
    time.sleep(response["sleep"])
for line in response.get("stderr", []):
    print(line, file=sys.stderr, flush=True)
if "report" in response:
    print("STAGE_REPORT " + json.dumps(response["report"]), flush=True)
for line in response.get("stdout", []):
    print(line, flush=True)
sys.exit(response.get("rc", 0))
`;

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
        "lock_held_by_driver": held,
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

interface Response {
  report?: ReportFields | Record<string, unknown>;
  rc?: number;
  stdout?: string[];
  stderr?: string[];
  sleep?: number;
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

interface Fixture {
  root: string;
  home: string;
  config: Record<string, unknown>;
  ssh: (responses: Response[]) => void;
  smoke: (scenario: SmokeScenario) => void;
  writeConfig: () => void;
  run: (args?: string[], env?: Record<string, string>) => SpawnSyncReturns<string>;
  sshCalls: () => Array<{ argv: string[]; stdin_tty: boolean }>;
  smokeRecord: () => {
    argv: string[];
    cases: unknown;
    cases_mode: number;
    lock_held_by_driver: boolean;
    owner: string;
  } | null;
  lockFile: string;
  bin: string;
  lib: string;
}

let temp: TempRoot | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

function createFixture(configOverrides: Record<string, unknown> = {}): Fixture {
  temp = tempRoot('stage-qa-pc-');
  const root = temp.dir;
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const lib = join(root, 'lib');
  mkdirSync(join(home, '.config/esb-stage-qa'), { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(lib);
  copyFileSync(DRIVER, join(lib, 'stage-qa-pc.py'));
  writeExecutable(join(lib, 'stage-smoke.py'), STUB_SMOKE);
  writeExecutable(join(bin, 'ssh'), FAKE_SSH);
  writeExecutable(join(home, 'qa'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(home, '.ssh/key'), 'not a key');
  const lockFile = join(home, SHARED_LOCK);
  const config = {
    ssh_target: 'root@odroid.example',
    ssh_key: join(home, '.ssh/key'),
    username: STAGE_USERNAME,
    qa_bin: join(home, 'qa'),
    state_dir: join(home, 'state'),
    lock_max_wait: 1,
    smoke_timeout: 30,
    slot_wait: 1,
    slot_poll: 0.05,
    report_timeout: 20,
    ...configOverrides,
  };
  const configPath = join(home, '.config/esb-stage-qa/config.json');
  const fixture: Fixture = {
    root,
    home,
    config,
    lockFile,
    bin,
    lib,
    ssh: (responses) =>
      writeFileSync(
        join(bin, 'ssh_scenario.json'),
        JSON.stringify({ log: join(root, 'ssh.log'), responses }),
      ),
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
    run: (args = [SHA], env = {}) => {
      return spawnSync('python3', [join(lib, 'stage-qa-pc.py'), ...args, '--config', configPath], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          HOME: home,
          ...env,
        },
      });
    },
    sshCalls: () => {
      const log = join(root, 'ssh.log');
      return existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    },
    smokeRecord: () => {
      const file = join(root, 'smoke.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    },
  };
  fixture.writeConfig();
  return fixture;
}

/** The final result line, which must be the only thing on stdout. */
function result(done: SpawnSyncReturns<string>): string {
  const lines = done.stdout.split('\n').filter(Boolean);
  expect(lines.length).toBe(1);
  const [line] = lines;
  expect(line?.startsWith('STAGE_QA_RESULT ')).toBe(true);
  return line ?? '';
}

describe('a pull request head that the slot runs and whose cases pass', () => {
  test('passes: exit 0 and the result line with the case count', () => {
    const f = createFixture();
    f.ssh([{ report: report() }]);
    f.smoke(PASSED(7));
    const done = f.run();
    expect(done.status).toBe(0);
    expect(result(done)).toBe(`STAGE_QA_RESULT status=passed sha=${SHA} cases=7 failed=0`);
  });

  test('asks the odroid for exactly the verb `report`, before and after the cases, and nothing else', () => {
    const f = createFixture();
    f.ssh([{ report: report() }]);
    f.smoke(PASSED());
    f.run();
    const calls = f.sshCalls();
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.argv.slice(-2)).toEqual(['root@odroid.example', 'report']);
      expect(call.argv).toContain('BatchMode=yes');
      expect(call.argv).toContain('StrictHostKeyChecking=yes');
      expect(call.stdin_tty).toBe(false);
    }
  });

  test('hands the validated cases and the stage bot id to the engine, with the production bot denied', () => {
    const f = createFixture();
    f.ssh([{ report: report() }]);
    f.smoke(PASSED());
    f.run();
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

  test('keeps stdout to the result line: the odroid and engine output go to stderr', () => {
    const f = createFixture();
    f.ssh([{ report: report(), stderr: ['odroid says hello'] }]);
    f.smoke(PASSED());
    const done = f.run();
    result(done);
    expect(done.stderr).toContain('odroid: odroid says hello');
    expect(done.stderr).toContain('SMOKE PASS start');
  });

  test('removes the temporary case file and keeps no token anywhere (none is involved)', () => {
    const f = createFixture();
    f.ssh([{ report: report() }]);
    f.smoke(PASSED());
    const done = f.run([SHA], { GH_TOKEN: 'must-never-be-read-0001' });
    expect(done.status).toBe(0);
    const left = spawnSync('find', [join(f.home, 'state'), '-name', 'cases-*'], {
      encoding: 'utf8',
    });
    expect(left.stdout).toBe('');
    expect(done.stdout + done.stderr).not.toContain('must-never-be-read-0001');
    expect(JSON.stringify(f.sshCalls())).not.toContain('must-never-be-read-0001');
  });
});

describe('waiting for the shared slot', () => {
  test('keeps asking while the slot runs another commit or nothing, then runs when it reaches the head', () => {
    const f = createFixture({ slot_wait: 10 });
    f.ssh([
      { report: report({ sha: OTHER_SHA }) },
      {
        report: report({
          sha: null,
          online: false,
          peer: null,
          cases: null,
          slot_error: 'pm2 has no process',
        }),
      },
      { report: report({ online: false, peer: null, cases: null }) },
      { report: report() },
    ]);
    f.smoke(PASSED());
    const done = f.run();
    expect(done.status).toBe(0);
    expect(f.sshCalls().length).toBe(5);
    expect(done.stderr).toContain(`waiting for ${SHA.slice(0, 12)}`);
  });

  test('gives up after slot_wait when the slot never runs the head: exit 77, no cases are run', () => {
    const f = createFixture({ slot_wait: 0.3 });
    f.ssh([{ report: report({ sha: OTHER_SHA }) }]);
    f.smoke(PASSED());
    const done = f.run();
    expect(done.status).toBe(77);
    expect(result(done)).toBe(`STAGE_QA_RESULT status=slot-never-ran sha=${SHA} cases=0 failed=0`);
    expect(f.smokeRecord()).toBeNull();
    expect(done.stderr).toContain('re-run the `Stage Bot` workflow');
  });

  test('a slot that runs the head but whose bot never comes online fails the run (exit 1)', () => {
    const f = createFixture({ slot_wait: 0.3 });
    f.ssh([{ report: report({ online: false, peer: null, cases: null }) }]);
    f.smoke(PASSED());
    const done = f.run();
    expect(done.status).toBe(1);
    expect(f.smokeRecord()).toBeNull();
  });

  test('with slot_wait 0 it asks once', () => {
    const f = createFixture({ slot_wait: 0 });
    f.ssh([{ report: report({ sha: OTHER_SHA }) }]);
    f.smoke(PASSED());
    expect(f.run().status).toBe(77);
    expect(f.sshCalls().length).toBe(1);
  });
});

describe('the slot moving while the cases run', () => {
  function runWithAfter(after: Partial<ReportFields>, smoke: SmokeScenario = PASSED()) {
    const f = createFixture();
    f.ssh([{ report: report() }, { report: report(after) }]);
    f.smoke(smoke);
    return { f, done: f.run() };
  }

  test('another commit took the slot: the passed result is void (exit 76, superseded)', () => {
    const { done } = runWithAfter({ sha: OTHER_SHA, started_at: 1_761_000_999_000 });
    expect(done.status).toBe(76);
    expect(result(done)).toContain('status=superseded');
    expect(done.stderr).toContain('the result is void');
  });

  test('the slot was emptied during a redeploy: void as well', () => {
    const { done } = runWithAfter({ sha: null, online: false, peer: null, cases: null });
    expect(done.status).toBe(76);
  });

  test('a failed result is void too when the slot moved (it is not a verdict on this commit)', () => {
    const { done } = runWithAfter(
      { sha: OTHER_SHA, started_at: 1_761_000_999_000 },
      { rc: 1, stdout: [`STAGE_SMOKE_FAILED sha=${SHA} bot=@${STAGE_USERNAME} cases=7 failed=2`] },
    );
    expect(done.status).toBe(76);
  });

  test('the same commit redeployed (new start time, restart counter reset): void', () => {
    const { done } = runWithAfter({ started_at: 1_761_000_999_000, restarts: 0 });
    expect(done.status).toBe(76);
  });

  test('the bot crashed and pm2 restarted it (restart counter up): the run fails', () => {
    const { done } = runWithAfter({ started_at: 1_761_000_999_000, restarts: 1 });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('restarted by itself');
  });

  test('the restart counter rose with the same start time: the run fails', () => {
    const { done } = runWithAfter({ restarts: 2 });
    expect(done.status).toBe(1);
  });

  test('the bot went offline on the same commit: the run fails', () => {
    const { done } = runWithAfter({ online: false });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('went offline');
  });

  test('an engine that refused or could not reach qa-cli is not a statement about the slot, even if it moved', () => {
    const moved = { sha: OTHER_SHA, started_at: 1_761_000_999_000 };
    expect(runWithAfter(moved, { rc: 64 }).done.status).toBe(2);
    expect(runWithAfter(moved, { rc: 69 }).done.status).toBe(3);
  });

  test('an unchanged slot lets the engine verdict stand: a failed case fails the run', () => {
    const { done } = runWithAfter(
      {},
      {
        rc: 1,
        stdout: [`STAGE_SMOKE_FAILED sha=${SHA} bot=@${STAGE_USERNAME} cases=7 failed=2`],
      },
    );
    expect(done.status).toBe(1);
    expect(result(done)).toBe(`STAGE_QA_RESULT status=failed sha=${SHA} cases=7 failed=2`);
  });

  test('a second report that cannot be fetched never passes the run (exit 3)', () => {
    const f = createFixture();
    f.ssh([
      { report: report() },
      { rc: 255, stderr: ['ssh: connect to host odroid port 22: timed out'] },
    ]);
    f.smoke(PASSED());
    const done = f.run();
    expect(done.status).toBe(3);
    expect(result(done)).toContain('status=not-provisioned');
  });
});

describe('the engine verdicts', () => {
  function runWith(smoke: SmokeScenario, overrides: Record<string, unknown> = {}) {
    const f = createFixture(overrides);
    f.ssh([{ report: report() }]);
    f.smoke(smoke);
    return f.run();
  }

  test('exit 0 without a pass summary is a failure, never a pass', () => {
    expect(runWith({ rc: 0, stdout: [] }).status).toBe(1);
  });

  test('a pass summary that covers fewer cases than the floor is a failure', () => {
    expect(runWith(PASSED(4)).status).toBe(1);
  });

  test('a pass summary that reports failures is a failure', () => {
    const done = runWith({
      rc: 0,
      stdout: [`STAGE_SMOKE_PASSED sha=${SHA} bot=@${STAGE_USERNAME} cases=7 failed=1`],
    });
    expect(done.status).toBe(1);
  });

  test('engine exit 64 (refused) is exit 2, exit 69 (qa-cli unavailable) is exit 3, anything else is 1', () => {
    expect(runWith({ rc: 64 }).status).toBe(2);
    const unavailable = runWith({ rc: 69 });
    expect(unavailable.status).toBe(3);
    expect(unavailable.stderr).toContain('qa-cli is unavailable');
    expect(runWith({ rc: 7 }).status).toBe(1);
  });

  test('a hung engine is killed with its whole process group after smoke_timeout: exit 1', () => {
    const f = createFixture({ smoke_timeout: 1 });
    f.ssh([{ report: report() }]);
    f.smoke({ sleep: 60 });
    const done = f.run();
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('the smoke timed out');
    const marker = JSON.parse(readFileSync(join(f.root, 'marker.json'), 'utf8'));
    const alive = (pid: number): boolean => spawnSync('kill', ['-0', String(pid)]).status === 0;
    expect(alive(marker.pid)).toBe(false);
    expect(alive(marker.child)).toBe(false);
  });
});

describe('the driver does not trust the odroid', () => {
  function refuse(response: Response | Record<string, unknown>, expectedMessage: string) {
    const f = createFixture();
    f.ssh([response]);
    f.smoke(PASSED());
    const done = f.run();
    expect(done.status).toBe(2);
    expect(result(done)).toContain('status=refused');
    expect(done.stderr).toContain(expectedMessage);
    expect(f.smokeRecord()).toBeNull();
  }

  test.each([
    ['another bot', report({ username: 'SomeOtherStageBot' })],
    ['the production bot', report({ username: PROD_USERNAME })],
  ])('a report naming %s', (_name, payload) => {
    refuse({ report: payload }, 'another bot than the configured');
  });

  test('a peer that is not a numeric id', () => {
    refuse({ report: report({ peer: '12; rm -rf /' }) }, 'peer is not a numeric bot id');
  });

  test('a sha that is not a full lowercase commit', () => {
    refuse({ report: report({ sha: 'ABCDEF' }) }, 'sha is not a full lowercase commit SHA');
  });

  test('fields of the wrong type', () => {
    refuse({ report: report({ online: 'yes' as unknown as boolean }) }, 'online is not a boolean');
    refuse({ report: report({ restarts: -1 }) }, 'restarts is not a non-negative integer');
    refuse({ report: report({ started_at: 1.5 }) }, 'started_at is not a non-negative integer');
    refuse({ report: report({ cases: 'nope' }) }, 'cases is not a list');
  });

  test('fewer cases than the floor, even when the odroid says it was fine', () => {
    refuse(
      { report: report({ cases: realCases().slice(0, 4) }) },
      'only 4 cases; at least 5 are required',
    );
  });

  test('a required case missing', () => {
    refuse(
      { report: report({ cases: realCases().filter((c: SmokeCase) => c.name !== 'ping') }) },
      'required case(s) missing: ping',
    );
  });

  test('duplicate case names and cases without a name', () => {
    refuse({ report: report({ cases: [...realCases(), realCases()[0]] }) }, 'duplicate case names');
    refuse(
      { report: report({ cases: [...realCases(), { send: 'x' }] }) },
      'a case has no text name',
    );
  });

  test.each(BAD_CASES)('$title is refused with its reason', ({ mutate, reason }) => {
    refuse({ report: report({ cases: withCase('ping', mutate(pingCase())) }) }, reason);
  });

  test.each([
    'NaN',
    'Infinity',
    '-Infinity',
  ])('the JSON constant %s is not valid JSON', (constant) => {
    const raw = JSON.stringify(report()).replace('"timeout_s":60', `"timeout_s":${constant}`);
    expect(raw).toContain(constant);
    refuse({ stdout: [`STAGE_REPORT ${raw}`] }, 'not valid JSON');
  });

  test('a case list the odroid rejected: refused with the odroid reason', () => {
    refuse(
      { report: report({ cases: null, cases_error: 'required case(s) missing: start' }) },
      "the PR's case list is not usable: required case(s) missing: start",
    );
  });

  test('an online bot without a bot id', () => {
    refuse({ report: report({ peer: null }) }, 'no bot id for an online bot');
  });

  test('every report is validated, also the ones that name another commit while waiting', () => {
    refuse({ report: report({ sha: OTHER_SHA, username: PROD_USERNAME }) }, 'another bot than');
  });

  test('not exactly one STAGE_REPORT line, or not JSON, or not an object', () => {
    refuse({ stdout: [] }, 'expected one STAGE_REPORT line');
    refuse(
      {
        stdout: [
          `STAGE_REPORT ${JSON.stringify(report())}`,
          `STAGE_REPORT ${JSON.stringify(report())}`,
        ],
      },
      'expected one STAGE_REPORT line',
    );
    refuse({ stdout: ['STAGE_REPORT {nope'] }, 'not valid JSON');
    refuse({ stdout: ['STAGE_REPORT [1]'] }, 'payload is not an object');
  });

  test('the odroid script refusing (exit 2) or failing otherwise', () => {
    refuse({ rc: 2, stderr: ['odroid-stage-qa-report: refused'] }, 'ended with exit status 2');
    refuse({ rc: 1 }, 'ended with exit status 1');
  });

  test('lines that merely mention STAGE_REPORT in the middle are not reports', () => {
    refuse(
      { stdout: [`note: STAGE_REPORT ${JSON.stringify(report())}`] },
      'expected one STAGE_REPORT line',
    );
  });
});

describe('the odroid cannot be used', () => {
  test.each([
    [
      { rc: 255, stderr: ['ssh: connect to host odroid port 22: Connection refused'] },
      'cannot reach the odroid',
    ],
    [
      { rc: 3, stderr: ['odroid-stage-qa-report: pm2 jlist exited with status 1'] },
      'not provisioned',
    ],
  ])('%p is exit 3', (response, message) => {
    const f = createFixture();
    f.ssh([response]);
    f.smoke(PASSED());
    const done = f.run();
    expect(done.status).toBe(3);
    expect(result(done)).toContain('status=not-provisioned');
    expect(done.stderr).toContain(message);
  });

  test('an odroid that does not answer within report_timeout is exit 3', () => {
    const f = createFixture({ report_timeout: 0.5 });
    f.ssh([{ report: report(), sleep: 5 }]);
    f.smoke(PASSED());
    const done = f.run();
    expect(done.status).toBe(3);
    expect(done.stderr).toContain('did not answer within');
  });
});

describe('provisioning', () => {
  function notProvisioned(f: Fixture, message: string): void {
    f.ssh([{ report: report() }]);
    f.smoke(PASSED());
    const done = f.run();
    expect(done.status).toBe(3);
    expect(done.stderr).toContain(message);
    expect(result(done)).toContain('status=not-provisioned');
    expect(f.sshCalls()).toEqual([]);
  }

  test('no config', () => {
    const f = createFixture();
    spawnSync('rm', [join(f.home, '.config/esb-stage-qa/config.json')]);
    notProvisioned(f, 'not found; run scripts/install-stage-qa-pc.sh');
  });

  test('a config others can read, a config that is not JSON, an unknown key, a missing key', () => {
    const f = createFixture();
    chmodSync(join(f.home, '.config/esb-stage-qa/config.json'), 0o644);
    notProvisioned(f, 'must be 0600');
    f.config['bogus'] = 1;
    f.writeConfig();
    notProvisioned(f, 'unknown key(s): bogus');
    delete f.config['bogus'];
    delete f.config['username'];
    f.writeConfig();
    notProvisioned(f, 'missing required key username');
    writeFileSync(join(f.home, '.config/esb-stage-qa/config.json'), '{nope');
    notProvisioned(f, 'is not valid JSON');
  });

  test('a username that is not a stage bot or is the production bot', () => {
    const f = createFixture({ username: PROD_USERNAME });
    notProvisioned(f, 'must be a Telegram bot username containing stage or stg');
    f.config['username'] = 'SomeStageBot';
    f.config['deny_usernames'] = ['somestagebot'];
    f.writeConfig();
    notProvisioned(f, 'username is in deny_usernames');
  });

  test('no ssh key, no qa-cli, no engine next to the driver', () => {
    const f = createFixture();
    spawnSync('rm', [join(f.home, '.ssh/key')]);
    notProvisioned(f, 'ssh key');
    writeFileSync(join(f.home, '.ssh/key'), 'k');
    chmodSync(join(f.home, 'qa'), 0o644);
    notProvisioned(f, 'not found or not executable');
    chmodSync(join(f.home, 'qa'), 0o755);
    spawnSync('rm', [join(f.lib, 'stage-smoke.py')]);
    notProvisioned(f, 'stage-smoke.py not found');
  });

  test('a known_hosts file in the config is handed to ssh, and a missing one is not provisioned', () => {
    const f = createFixture();
    const knownHosts = join(f.home, 'known_hosts');
    f.config.ssh_known_hosts = knownHosts;
    f.writeConfig();
    notProvisioned(f, 'ssh known_hosts file');
    writeFileSync(knownHosts, '');
    f.ssh([{ report: report() }]);
    f.smoke(PASSED());
    expect(f.run().status).toBe(0);
    expect(f.sshCalls()[0]?.argv).toContain(`UserKnownHostsFile=${knownHosts}`);
  });

  test('wrong types and values in the config', () => {
    const f = createFixture({ ssh_target: 'not a target' });
    notProvisioned(f, 'ssh_target must look like user@host');
    f.config['ssh_target'] = 'root@odroid';
    f.config['min_cases'] = 0;
    f.writeConfig();
    notProvisioned(f, 'min_cases must be an integer >= 1');
    f.config['min_cases'] = 5;
    f.config['slot_poll'] = 0;
    f.writeConfig();
    notProvisioned(f, 'slot_poll must be a number > 0');
    f.config['slot_poll'] = 1;
    f.config['state_dir'] = 'relative/dir';
    f.writeConfig();
    notProvisioned(f, 'state_dir must be an absolute path');
  });

  test('without lock_file in the config the lock is the one the HyperCalendarBot driver uses', () => {
    const f = createFixture();
    f.ssh([{ report: report() }]);
    f.smoke(PASSED());
    expect(f.run().status).toBe(0);
    expect(existsSync(join(f.home, SHARED_LOCK))).toBe(true);
    expect(statSync(join(f.home, SHARED_LOCK)).mode & 0o777).toBe(0o666);
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
  ])('argv %p is refused with exit 2 and a result line', (args) => {
    const f = createFixture();
    f.ssh([{ report: report() }]);
    f.smoke(PASSED());
    const done = f.run(args);
    expect(done.status).toBe(2);
    expect(result(done)).toBe('STAGE_QA_RESULT status=refused sha=- cases=0 failed=0');
    expect(f.sshCalls()).toEqual([]);
  });
});

/** Holds the shared qa lock from another process until stopped. */
function holdLock(path: string): { stop: () => void; ready: Promise<void> } {
  mkdirSync(join(path, '..'), { recursive: true });
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

interface Finished {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The driver as an async child, with a way to await a line on its stderr instead of guessing a delay. */
function startDriver(f: Fixture): {
  child: ChildProcess;
  stderrSeen: (text: string) => Promise<void>;
  finished: Promise<Finished>;
} {
  const child = spawn(
    'python3',
    [
      join(f.lib, 'stage-qa-pc.py'),
      SHA,
      '--config',
      join(f.home, '.config/esb-stage-qa/config.json'),
    ],
    { env: { PATH: `${f.bin}:${process.env['PATH'] ?? ''}`, HOME: f.home } },
  );
  let stdout = '';
  let stderr = '';
  const waiters: Array<{ text: string; resolve: () => void }> = [];
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
    for (const waiter of waiters.splice(0)) {
      if (stderr.includes(waiter.text)) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  const { promise: finished, resolve } = Promise.withResolvers<Finished>();
  child.on('close', (status) => resolve({ status, stdout, stderr }));
  return {
    child,
    finished,
    stderrSeen: (text) => {
      const seen = Promise.withResolvers<void>();
      if (stderr.includes(text)) seen.resolve();
      else waiters.push({ text, resolve: seen.resolve });
      return seen.promise;
    },
  };
}

function lockIsFree(lockFile: string): boolean {
  return (
    spawnSync('python3', [
      '-c',
      'import fcntl,sys; f=open(sys.argv[1]); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)',
      lockFile,
    ]).status === 0
  );
}

describe('the PC qa lock', () => {
  test('is held for the whole run, names this driver in its owner file, and is released after', () => {
    const f = createFixture();
    f.ssh([{ report: report() }]);
    f.smoke(PASSED());
    expect(f.run().status).toBe(0);
    const record = f.smokeRecord();
    expect(record?.lock_held_by_driver).toBe(true);
    expect(record?.owner).toContain('repo=esb-stage-qa-pc');
    expect(readFileSync(`${f.lockFile}.owner`, 'utf8')).toBe('');
    expect(lockIsFree(f.lockFile)).toBe(true);
  });

  test('another QA run holding it makes the driver wait, then give up with exit 75 and no ssh call', async () => {
    const f = createFixture({ lock_max_wait: 0.5 });
    f.ssh([{ report: report() }]);
    f.smoke(PASSED());
    const holder = holdLock(f.lockFile);
    try {
      await holder.ready;
      const done = f.run();
      expect(done.status).toBe(75);
      expect(result(done)).toContain('status=lock-timeout');
      expect(f.sshCalls()).toEqual([]);
    } finally {
      holder.stop();
    }
  });

  test('a lock released while waiting lets the run proceed', async () => {
    const f = createFixture({ lock_max_wait: 60 });
    f.ssh([{ report: report() }]);
    f.smoke(PASSED());
    const holder = holdLock(f.lockFile);
    await holder.ready;
    const started = startDriver(f);
    await started.stderrSeen('waiting for the PC qa lock');
    holder.stop();
    const done = await started.finished;
    expect(done.status).toBe(0);
    expect(done.stdout).toContain('status=passed');
  });
});

describe('cancellation', () => {
  test('a cancel while waiting for the slot exits 143 with a result line and frees the lock', async () => {
    const f = createFixture({ slot_wait: 60, slot_poll: 30 });
    f.ssh([{ report: report({ sha: OTHER_SHA }) }]);
    f.smoke(PASSED());
    const started = startDriver(f);
    await started.stderrSeen('waiting for');
    started.child.kill('SIGTERM');
    const done = await started.finished;
    expect(done.status).toBe(143);
    expect(done.stdout).toContain('STAGE_QA_RESULT status=failed');
    expect(lockIsFree(f.lockFile)).toBe(true);
  });

  test('a cancel while the engine runs kills it and its children', async () => {
    const f = createFixture();
    f.ssh([{ report: report() }]);
    f.smoke({ sleep: 60 });
    const started = startDriver(f);
    await started.stderrSeen('SMOKE hanging');
    started.child.kill('SIGTERM');
    const done = await started.finished;
    expect(done.status).toBe(143);
    const marker = JSON.parse(readFileSync(join(f.root, 'marker.json'), 'utf8'));
    const alive = (pid: number): boolean => spawnSync('kill', ['-0', String(pid)]).status === 0;
    expect(alive(marker.pid)).toBe(false);
    expect(alive(marker.child)).toBe(false);
    expect(lockIsFree(f.lockFile)).toBe(true);
  });
});

describe('the odroid script, the driver and the committed case list agree', () => {
  /** A module-level value of a Python script, printed as JSON. */
  function pythonValue(script: string, expression: string): unknown {
    const done = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("m", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(${expression}))`,
        script,
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(done.stdout);
  }

  const odroid = join(REPO, 'scripts/odroid-stage-qa-report.py');

  test('the required case names are the ones the committed list has', () => {
    expect(pythonValue(DRIVER, 'list(module.DEFAULTS["required_cases"])')).toEqual(REQUIRED_CASES);
    expect(pythonValue(odroid, 'list(module.REQUIRED_CASES)')).toEqual(REQUIRED_CASES);
    const names = realCases().map((c) => c.name);
    for (const name of REQUIRED_CASES) expect(names).toContain(name);
  });

  test('the error patterns every case must forbid are the same on both sides and in every committed case', () => {
    const driverForbid = pythonValue(DRIVER, 'list(module.DEFAULTS["required_forbid"])');
    expect(pythonValue(odroid, 'list(module.REQUIRED_FORBID)')).toEqual(driverForbid);
    for (const c of realCases()) expect(c.forbid).toEqual(driverForbid);
  });

  test('both sides hold the same numeric limits', () => {
    const limits =
      'dict(case=module.MAX_CASE_SECONDS, settle=module.MAX_SETTLE_SECONDS, replies=module.MAX_MIN_REPLIES, probes=list(module.TRIVIAL_REPLIES))';
    expect(pythonValue(odroid, limits)).toEqual(pythonValue(DRIVER, limits));
  });
});
