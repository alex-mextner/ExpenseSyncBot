// scripts/stage-qa-driver.py is the odroid half of the per-PR stage QA. It opens the ssh connection to the
// browser host FIRST and does nothing on the odroid until the browser half has taken the shared browser lock
// (the LOCKED line); then it waits (through the read-only report script, run with sudo) until the shared stage
// slot runs exactly the PR head, hands the report to the browser host as the payload, asks the odroid again to
// prove the slot did not move, and maps the browser host's exit status to the verdict. The report script is a
// stand-in that answers from a scenario file, the browser host is a stand-in `ssh` that records what it was
// sent and when and plays a scenario, and the config is the one the installer writes. Nothing here touches
// Telegram, a real ssh, sudo or the net.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  isAlive,
  PROD_USERNAME,
  REPO,
  realCases,
  STAGE_USERNAME,
  startProcess,
  type TempRoot,
  tempRoot,
  writeExecutable,
} from '../test-utils/stage-qa-fixtures';

setDefaultTimeout(60_000);

const DRIVER = join(REPO, 'scripts/stage-qa-driver.py');
const COMMON = join(REPO, 'scripts/stage_qa_common.py');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const PEER = '222222222';
const BROWSER_TARGET = 'ultra@browser.example';

// The report script: answers every call from report_scenario.json, one response per call (the last one
// repeats), and logs each call.
const FAKE_REPORT = `#!/usr/bin/env python3
import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
scenario = json.load(open(os.path.join(here, "report_scenario.json")))
counter = os.path.join(here, "report_count")
count = int(open(counter).read()) if os.path.exists(counter) else 0
open(counter, "w").write(str(count + 1))
with open(scenario["log"], "a") as handle:
    handle.write(json.dumps({"argv": sys.argv[1:], "stdin_tty": sys.stdin.isatty(), "t": time.time()}) + "\\n")
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

// The browser host as the driver sees it through ssh, in the order of the protocol: the connection opens (event
// "call" with the argv), the stand-in takes its "lock" (after lock_delay) and prints the LOCKED line, then reads
// the payload (event "payload") and plays the scenario. With "hang" it behaves like a run in progress: it stays
// until its stdin reaches EOF (the driver went away) or it is terminated, and logs which of the two happened.
// EOF before the payload is logged as "stdin-eof-before-payload" (the real browser half then frees its lock).
const FAKE_SSH = `#!/usr/bin/env python3
import json, os, signal, sys, time
here = os.path.dirname(os.path.abspath(__file__))
scenario = json.load(open(os.path.join(here, "ssh_scenario.json")))

def event(kind, **extra):
    with open(scenario["log"], "a") as handle:
        handle.write(json.dumps({"event": kind, "pid": os.getpid(), "t": time.time(), **extra}) + "\\n")

def play_output():
    for text in scenario.get("stderr", []):
        print(text, file=sys.stderr, flush=True)
    for text in scenario.get("stdout", []):
        print(text, flush=True)

event("call", argv=sys.argv[1:])
signal.signal(signal.SIGTERM, lambda *_: (event("terminated"), os._exit(143)))
if scenario.get("exit_before_lock"):
    play_output()
    sys.exit(scenario.get("rc", 0))
if scenario.get("lock_delay"):
    time.sleep(scenario["lock_delay"])
if not scenario.get("no_lock"):
    event("lock")
    print("STAGE_BROWSER_LOCKED", flush=True)
if scenario.get("exit_after_lock"):
    play_output()
    sys.exit(scenario.get("rc", 0))
line = sys.stdin.readline().rstrip("\\n")
if not line:
    event("stdin-eof-before-payload")
    sys.exit(1)
event("payload", stdin_line=line)
if scenario.get("hang"):
    print("browser host: running", file=sys.stderr, flush=True)
    while sys.stdin.readline():
        pass
    event("stdin-eof")
    sys.exit(scenario.get("hang_rc", 255))
if scenario.get("sleep"):
    time.sleep(scenario["sleep"])
play_output()
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

interface BrowserScenario {
  rc?: number;
  stdout?: string[];
  stderr?: string[];
  sleep?: number;
  hang?: boolean;
  hang_rc?: number;
  // Seconds between the connection opening and the LOCKED line (the other repository's run holds the lock).
  lock_delay?: number;
  // The browser half never gets its lock: no LOCKED line, it only waits for the driver's end of the connection.
  no_lock?: boolean;
  // The browser half ends (rc, stdout) before it took its lock.
  exit_before_lock?: boolean;
  // The browser half ends (rc, stdout) right after LOCKED, before any payload.
  exit_after_lock?: boolean;
}

function resultLine(status: string, cases: number, failed: number, sha = SHA): string {
  return `STAGE_QA_RESULT status=${status} sha=${sha} cases=${cases} failed=${failed}`;
}

const PASSED = (cases = 7): BrowserScenario => ({
  rc: 0,
  stdout: [resultLine('passed', cases, 0)],
});

interface LoggedEvent {
  event: string;
  pid: number;
  t: number;
  argv?: string[];
  stdin_line?: string;
}

interface Fixture {
  root: string;
  home: string;
  config: Record<string, unknown>;
  configPath: string;
  report: (responses: Response[]) => void;
  browser: (scenario: BrowserScenario) => void;
  writeConfig: () => void;
  run: (args?: string[], env?: Record<string, string>) => SpawnSyncReturns<string>;
  env: () => Record<string, string>;
  reportCalls: () => Array<{ argv: string[]; stdin_tty: boolean; t: number }>;
  browserEvents: () => LoggedEvent[];
  browserCalls: () => LoggedEvent[];
  browserPayloads: () => LoggedEvent[];
  reportScript: string;
  bin: string;
  lib: string;
}

let temp: TempRoot | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

function createFixture(configOverrides: Record<string, unknown> = {}): Fixture {
  temp = tempRoot('stage-qa-driver-');
  const root = temp.dir;
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const lib = join(root, 'lib');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(lib);
  copyFileSync(DRIVER, join(lib, 'stage-qa-driver.py'));
  copyFileSync(COMMON, join(lib, 'stage_qa_common.py'));
  const reportScript = join(root, 'odroid-stage-qa-report.py');
  writeExecutable(reportScript, FAKE_REPORT);
  writeExecutable(join(bin, 'ssh'), FAKE_SSH);
  writeFileSync(join(home, '.ssh/key'), 'not a key');
  const config = {
    report_command: [reportScript],
    browser_target: BROWSER_TARGET,
    browser_key: join(home, '.ssh/key'),
    slot_wait: 1,
    slot_poll: 0.05,
    report_timeout: 20,
    lock_timeout: 20,
    browser_timeout: 30,
    ...configOverrides,
  };
  const configPath = join(root, 'driver.json');
  const env = (): Record<string, string> => ({
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    HOME: home,
  });
  const readLog = (file: string): string[] =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const fixture: Fixture = {
    root,
    home,
    config,
    configPath,
    reportScript,
    bin,
    lib,
    report: (responses) =>
      writeFileSync(
        join(root, 'report_scenario.json'),
        JSON.stringify({ log: join(root, 'report.log'), responses }),
      ),
    browser: (scenario) =>
      writeFileSync(
        join(bin, 'ssh_scenario.json'),
        JSON.stringify({ log: join(root, 'browser.log'), ...scenario }),
      ),
    writeConfig: () => {
      writeFileSync(configPath, JSON.stringify(fixture.config));
      chmodSync(configPath, 0o644);
    },
    env,
    run: (args = [SHA], extraEnv = {}) =>
      spawnSync('python3', [join(lib, 'stage-qa-driver.py'), ...args, '--config', configPath], {
        encoding: 'utf8',
        env: { ...env(), ...extraEnv },
      }),
    reportCalls: () => readLog(join(root, 'report.log')).map((l) => JSON.parse(l)),
    browserEvents: () => readLog(join(root, 'browser.log')).map((l) => JSON.parse(l)),
    browserCalls: () => fixture.browserEvents().filter((e) => e.event === 'call'),
    browserPayloads: () => fixture.browserEvents().filter((e) => e.event === 'payload'),
  };
  fixture.writeConfig();
  return fixture;
}

/** The final result line, which must be the only thing on stdout. */
function result(done: { stdout: string }): string {
  const lines = done.stdout.split('\n').filter(Boolean);
  expect(lines.length).toBe(1);
  const [line] = lines;
  expect(line?.startsWith('STAGE_QA_RESULT ')).toBe(true);
  return line ?? '';
}

describe('a pull request head that the slot runs and whose cases pass on the browser host', () => {
  test('passes: exit 0 and the result line with the case count the browser host reported', () => {
    const f = createFixture();
    f.report([{ report: report() }]);
    f.browser(PASSED(7));
    const done = f.run();
    expect(done.status).toBe(0);
    expect(result(done)).toBe(resultLine('passed', 7, 0));
  });

  test('opens the connection with the commit as its command line, then sends the report as the first stdin line, verbatim', () => {
    const f = createFixture();
    f.report([{ report: report() }]);
    f.browser(PASSED());
    f.run();
    const [call] = f.browserCalls();
    expect(call?.argv?.slice(-2)).toEqual([BROWSER_TARGET, SHA]);
    expect(call?.argv).toContain('BatchMode=yes');
    expect(call?.argv).toContain('IdentitiesOnly=yes');
    expect(call?.argv).toContain('StrictHostKeyChecking=yes');
    expect(call?.argv?.[call.argv.indexOf('-i') + 1]).toBe(join(f.home, '.ssh/key'));
    expect(f.browserPayloads().length).toBe(1);
    expect(JSON.parse(f.browserPayloads()[0]?.stdin_line ?? '')).toEqual(report());
  });

  test('asks the report script before and after the browser host, with no argument and no terminal', () => {
    const f = createFixture();
    f.report([{ report: report() }]);
    f.browser(PASSED());
    f.run();
    const calls = f.reportCalls();
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.argv).toEqual([]);
      expect(call.stdin_tty).toBe(false);
    }
  });

  test('judges only the slot: a report that names another bot or has bad cases is the browser host to refuse', () => {
    const f = createFixture();
    const odd = report({ username: PROD_USERNAME, cases: [{ name: 'only' }] });
    f.report([{ report: odd }]);
    f.browser({ rc: 2, stdout: [resultLine('refused', 0, 0)] });
    const done = f.run();
    expect(JSON.parse(f.browserPayloads()[0]?.stdin_line ?? '')).toEqual(odd);
    expect(done.status).toBe(2);
    expect(result(done)).toBe(resultLine('refused', 0, 0));
  });

  test('keeps stdout to the result line: the report script and the browser host output go to stderr', () => {
    const f = createFixture();
    f.report([{ report: report(), stderr: ['odroid says hello'] }]);
    f.browser({ ...PASSED(), stderr: ['SMOKE PASS start'] });
    const done = f.run();
    result(done);
    expect(done.stderr).toContain('report: odroid says hello');
    expect(done.stderr).toContain('SMOKE PASS start');
    expect(done.stderr).toContain(`browser host: ${resultLine('passed', 7, 0)}`);
  });

  test('involves no token: none is read from the environment or stdin, none reaches ssh', () => {
    const f = createFixture();
    f.report([{ report: report() }]);
    f.browser(PASSED());
    const done = f.run([SHA], { GH_TOKEN: 'must-never-be-read-0001' });
    expect(done.status).toBe(0);
    expect(done.stdout + done.stderr).not.toContain('must-never-be-read-0001');
    expect(JSON.stringify(f.browserEvents())).not.toContain('must-never-be-read-0001');
  });

  test('a known_hosts file in the config is handed to ssh', () => {
    const f = createFixture();
    const knownHosts = join(f.home, 'known_hosts');
    writeFileSync(knownHosts, '');
    f.config['browser_known_hosts'] = knownHosts;
    f.writeConfig();
    f.report([{ report: report() }]);
    f.browser(PASSED());
    expect(f.run().status).toBe(0);
    expect(f.browserCalls()[0]?.argv).toContain(`UserKnownHostsFile=${knownHosts}`);
  });
});

describe('the lock order: the browser lock first, the odroid side after it', () => {
  const firstEvent = (f: Fixture, kind: string): LoggedEvent | undefined =>
    f.browserEvents().find((e) => e.event === kind);

  test('the browser host takes its lock before the odroid side starts: no report call precedes LOCKED', () => {
    const f = createFixture();
    f.report([{ report: report() }]);
    f.browser({ ...PASSED(), lock_delay: 0.8 });
    const done = f.run();
    expect(done.status).toBe(0);
    const opened = firstEvent(f, 'call')?.t ?? 0;
    const locked = firstEvent(f, 'lock')?.t ?? Number.POSITIVE_INFINITY;
    const reports = f.reportCalls();
    expect(reports.length).toBe(2);
    // The connection is opened first, the lock is taken a moment later, and only then does the odroid side start.
    expect(locked - opened).toBeGreaterThan(0.7);
    for (const call of reports) expect(call.t).toBeGreaterThan(locked);
  });

  test('the report reaches the browser host as the payload only after the slot is confirmed', () => {
    const f = createFixture({ slot_wait: 10 });
    f.report([{ report: report({ sha: OTHER_SHA }) }, { report: report() }]);
    f.browser(PASSED());
    const done = f.run();
    expect(done.status).toBe(0);
    const [payload] = f.browserPayloads();
    const [firstReport, secondReport] = f.reportCalls();
    expect(payload?.t).toBeGreaterThan(secondReport?.t ?? Number.POSITIVE_INFINITY);
    expect(secondReport?.t).toBeGreaterThan(firstReport?.t ?? Number.POSITIVE_INFINITY);
  });

  test('no LOCKED line within lock_timeout: exit 3, the odroid side never started, the connection is closed', () => {
    const f = createFixture({ lock_timeout: 0.6 });
    f.report([{ report: report() }]);
    f.browser({ ...PASSED(), no_lock: true });
    const done = f.run();
    expect(done.status).toBe(3);
    expect(result(done)).toBe(resultLine('not-provisioned', 0, 0));
    expect(done.stderr).toContain('did not take its lock within');
    expect(f.reportCalls()).toEqual([]);
    expect(f.browserPayloads()).toEqual([]);
    // The driver closed the connection's stdin: the browser half sees EOF before any payload and frees its lock.
    expect(firstEvent(f, 'stdin-eof-before-payload')).toBeDefined();
    expect(isAlive(firstEvent(f, 'call')?.pid ?? 0)).toBe(false);
  });

  test.each([
    [75, resultLine('lock-timeout', 0, 0), 75],
    [1, resultLine('failed', 0, 0), 1],
    [2, resultLine('refused', 0, 0), 2],
    [3, resultLine('not-provisioned', 0, 0), 3],
    [0, resultLine('passed', 7, 0), 1],
    [255, '', 3],
  ])('the browser half ending with %i before LOCKED decides the verdict (exit %i, never a pass), the odroid side never starts', (rc, line, expected) => {
    const f = createFixture();
    f.report([{ report: report() }]);
    f.browser({ exit_before_lock: true, rc, stdout: line ? [line] : [] });
    const done = f.run();
    expect(done.status).toBe(expected);
    expect(f.reportCalls()).toEqual([]);
    expect(f.browserPayloads()).toEqual([]);
    expect(done.stderr).toContain('ended before it took its lock');
  });

  test('the browser half ending while the driver waits for the slot decides the verdict, not the slot wait', () => {
    const f = createFixture({ slot_wait: 30, slot_poll: 5 });
    f.report([{ report: report({ sha: OTHER_SHA }) }]);
    f.browser({ exit_after_lock: true, rc: 1, stdout: [resultLine('failed', 0, 0)] });
    const started = Date.now();
    const done = f.run();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('while the driver waited for the stage slot');
    expect(f.browserPayloads()).toEqual([]);
  });

  test.each([
    [
      'the slot never runs the head (77)',
      { slot_wait: 0.3 },
      [{ report: report({ sha: OTHER_SHA }) }],
      77,
    ],
    [
      'the report script refuses (2)',
      {},
      [{ rc: 2, stderr: ['odroid-stage-qa-report: usage'] }],
      2,
    ],
    ['the report script is not provisioned (3)', {}, [{ rc: 3 }], 3],
    [
      'the bot is not online (1)',
      { slot_wait: 0.3 },
      [{ report: report({ online: false, peer: null, cases: null }) }],
      1,
    ],
  ])('when the odroid side ends before the payload (%s), the browser connection is closed so the browser half frees its lock', (_name, config, responses, status) => {
    const f = createFixture(config);
    f.report(responses);
    f.browser(PASSED());
    const done = f.run();
    expect(done.status).toBe(status);
    expect(f.browserPayloads()).toEqual([]);
    expect(firstEvent(f, 'stdin-eof-before-payload')).toBeDefined();
    expect(isAlive(firstEvent(f, 'call')?.pid ?? 0)).toBe(false);
  });
});

describe('waiting for the shared slot', () => {
  test('keeps asking while the slot runs another commit or nothing, then runs when it reaches the head', () => {
    const f = createFixture({ slot_wait: 10 });
    f.report([
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
    f.browser(PASSED());
    const done = f.run();
    expect(done.status).toBe(0);
    expect(f.reportCalls().length).toBe(5);
    expect(done.stderr).toContain(`waiting for ${SHA.slice(0, 12)}`);
    expect(done.stderr).toContain('nothing (pm2 has no process)');
  });

  test('gives up after slot_wait when the slot never runs the head: exit 77, the browser host is not called', () => {
    const f = createFixture({ slot_wait: 0.3 });
    f.report([{ report: report({ sha: OTHER_SHA }) }]);
    f.browser(PASSED());
    const done = f.run();
    expect(done.status).toBe(77);
    expect(result(done)).toBe(resultLine('slot-never-ran', 0, 0));
    expect(f.browserPayloads()).toEqual([]);
    expect(done.stderr).toContain('re-run the `Stage Bot` workflow');
  });

  test('a slot that runs the head but whose bot never comes online fails the run (exit 1)', () => {
    const f = createFixture({ slot_wait: 0.3 });
    f.report([{ report: report({ online: false, peer: null, cases: null }) }]);
    f.browser(PASSED());
    const done = f.run();
    expect(done.status).toBe(1);
    expect(f.browserPayloads()).toEqual([]);
  });

  test('with slot_wait 0 it asks once', () => {
    const f = createFixture({ slot_wait: 0 });
    f.report([{ report: report({ sha: OTHER_SHA }) }]);
    f.browser(PASSED());
    expect(f.run().status).toBe(77);
    expect(f.reportCalls().length).toBe(1);
  });
});

describe('the slot moving while the cases run', () => {
  function runWithAfter(after: Partial<ReportFields>, browser: BrowserScenario = PASSED()) {
    const f = createFixture();
    f.report([{ report: report() }, { report: report(after) }]);
    f.browser(browser);
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
      { rc: 1, stdout: [resultLine('failed', 7, 2)] },
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

  test('a browser host that refused, could not run or never got its lock says nothing about the slot, even if it moved', () => {
    const moved = { sha: OTHER_SHA, started_at: 1_761_000_999_000 };
    expect(runWithAfter(moved, { rc: 2 }).done.status).toBe(2);
    expect(runWithAfter(moved, { rc: 3 }).done.status).toBe(3);
    expect(runWithAfter(moved, { rc: 75 }).done.status).toBe(75);
  });

  test('an unchanged slot lets the browser host verdict stand: a failed case fails the run', () => {
    const { done } = runWithAfter({}, { rc: 1, stdout: [resultLine('failed', 7, 2)] });
    expect(done.status).toBe(1);
    expect(result(done)).toBe(resultLine('failed', 7, 2));
  });

  test('a second report that cannot be fetched never passes the run (exit 3)', () => {
    const f = createFixture();
    f.report([
      { report: report() },
      { rc: 3, stderr: ['odroid-stage-qa-report: pm2 jlist exited with status 1'] },
    ]);
    f.browser(PASSED());
    const done = f.run();
    expect(done.status).toBe(3);
    expect(result(done)).toContain('status=not-provisioned');
  });
});

describe('the browser host verdicts', () => {
  function runWith(browser: BrowserScenario, overrides: Record<string, unknown> = {}) {
    const f = createFixture(overrides);
    f.report([{ report: report() }]);
    f.browser(browser);
    return { f, done: f.run() };
  }

  test('exit 0 without a pass result line is a failure, never a pass', () => {
    const { done } = runWith({ rc: 0, stdout: [] });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('without a pass result');
  });

  test("a pass result that covers no case, or reports failures, is a failure (the floor of cases is the browser host's)", () => {
    expect(runWith(PASSED(0)).done.status).toBe(1);
    expect(runWith(PASSED(1)).done.status).toBe(0);
    expect(runWith({ rc: 0, stdout: [resultLine('passed', 7, 1)] }).done.status).toBe(1);
    expect(runWith({ rc: 0, stdout: [resultLine('failed', 7, 0)] }).done.status).toBe(1);
  });

  test('a result line for another commit than the requested one is exit 3, whatever the status says', () => {
    const { done } = runWith({ rc: 0, stdout: [resultLine('passed', 7, 0, OTHER_SHA)] });
    expect(done.status).toBe(3);
    expect(result(done)).toBe(resultLine('not-provisioned', 7, 0));
    expect(done.stderr).toContain(`answered for commit ${OTHER_SHA}, not ${SHA}`);
  });

  test.each([
    [1, 'failed'],
    [2, 'refused'],
    [3, 'not-provisioned'],
    [75, 'lock-timeout'],
  ])('browser host exit %i is our exit %i with status %s', (code, status) => {
    const { done } = runWith({ rc: code, stdout: [resultLine(status, 3, 1)] });
    expect(done.status).toBe(code);
    expect(result(done)).toBe(resultLine(status, 3, 1));
  });

  test.each([
    255, 143, 76, 77, 7,
  ])('browser host exit %i (ssh itself, a signal, a crash) is not a verdict on the PR: exit 3', (code) => {
    const { done } = runWith({ rc: code });
    expect(done.status).toBe(3);
    expect(done.stderr).toContain('not a verdict on the PR');
  });

  test('a line that only resembles a result line is not one', () => {
    const { done } = runWith({
      rc: 0,
      stdout: [`note: ${resultLine('passed', 7, 0)}`, `${resultLine('passed', 7, 0)} extra`],
    });
    expect(done.status).toBe(1);
  });

  test('a browser host that does not finish within browser_timeout is stopped, and the run is exit 3', async () => {
    const f = createFixture({ browser_timeout: 0.6 });
    f.report([{ report: report() }]);
    f.browser({ hang: true });
    const started = startProcess(
      'python3',
      [join(f.lib, 'stage-qa-driver.py'), SHA, '--config', f.configPath],
      f.env(),
    );
    const done = await started.finished;
    expect(done.status).toBe(3);
    expect(done.stderr).toContain('did not finish within');
    // The connection is closed, by EOF on its stdin or by a terminate: either way the browser host sees the driver go.
    const events = f.browserEvents();
    expect(events.some((e) => e.event === 'stdin-eof' || e.event === 'terminated')).toBe(true);
    expect(isAlive(events.find((e) => e.event === 'call')?.pid ?? 0)).toBe(false);
  });
});

describe('the driver does not trust the report script', () => {
  function refuse(response: Response | Record<string, unknown>, expectedMessage: string) {
    const f = createFixture();
    f.report([response]);
    f.browser(PASSED());
    const done = f.run();
    expect(done.status).toBe(2);
    expect(result(done)).toContain('status=refused');
    expect(done.stderr).toContain(expectedMessage);
    expect(f.browserPayloads()).toEqual([]);
  }

  test('a sha that is not a full lowercase commit', () => {
    refuse({ report: report({ sha: 'ABCDEF' }) }, 'sha is not a full lowercase commit SHA');
  });

  test('fields of the wrong type', () => {
    refuse({ report: report({ online: 'yes' as unknown as boolean }) }, 'online is not a boolean');
    refuse({ report: report({ restarts: -1 }) }, 'restarts is not a non-negative integer');
    refuse({ report: report({ started_at: 1.5 }) }, 'started_at is not a non-negative integer');
    refuse({ report: report({ slot_error: 7 as unknown as string }) }, 'slot_error is not text');
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

  test('lines that merely mention STAGE_REPORT in the middle are not reports', () => {
    refuse(
      { stdout: [`note: STAGE_REPORT ${JSON.stringify(report())}`] },
      'expected one STAGE_REPORT line',
    );
  });

  test('the report script refusing (exit 2) or failing otherwise, sudo denial included', () => {
    refuse({ rc: 2, stderr: ['odroid-stage-qa-report: usage'] }, 'ended with exit status 2');
    refuse({ rc: 1, stderr: ['sudo: a password is required'] }, 'ended with exit status 1');
  });
});

describe('the report script cannot be used', () => {
  test('exit 3 (not provisioned, identity not provable) is exit 3', () => {
    const f = createFixture();
    f.report([{ rc: 3, stderr: ['odroid-stage-qa-report: pm2 jlist exited with status 1'] }]);
    f.browser(PASSED());
    const done = f.run();
    expect(done.status).toBe(3);
    expect(result(done)).toContain('status=not-provisioned');
    expect(done.stderr).toContain('not provisioned');
    expect(f.browserPayloads()).toEqual([]);
  });

  test('a report script that does not answer within report_timeout is exit 3', () => {
    const f = createFixture({ report_timeout: 0.5 });
    f.report([{ report: report(), sleep: 5 }]);
    f.browser(PASSED());
    const done = f.run();
    expect(done.status).toBe(3);
    expect(done.stderr).toContain('did not answer within');
  });
});

describe('provisioning', () => {
  function notProvisioned(f: Fixture, message: string): void {
    f.report([{ report: report() }]);
    f.browser(PASSED());
    const done = f.run();
    expect(done.status).toBe(3);
    expect(done.stderr).toContain(message);
    expect(result(done)).toContain('status=not-provisioned');
    expect(f.reportCalls()).toEqual([]);
    expect(f.browserCalls()).toEqual([]);
  }

  test('no config', () => {
    const f = createFixture();
    spawnSync('rm', [f.configPath]);
    notProvisioned(f, 'not found; run scripts/install-stage-qa.sh');
  });

  test('a config others can write, a config that is not JSON, an unknown key, a missing key', () => {
    const f = createFixture();
    chmodSync(f.configPath, 0o666);
    notProvisioned(f, 'group/other must not be able to write it');
    f.config['bogus'] = 1;
    f.writeConfig();
    notProvisioned(f, 'unknown key(s): bogus');
    delete f.config['bogus'];
    delete f.config['browser_target'];
    f.writeConfig();
    notProvisioned(f, 'missing required key browser_target');
    writeFileSync(f.configPath, '{nope');
    notProvisioned(f, 'is not valid JSON');
  });

  test('a config the installer wrote as root (0644) is accepted', () => {
    const f = createFixture();
    chmodSync(f.configPath, 0o644);
    f.report([{ report: report() }]);
    f.browser(PASSED());
    expect(f.run().status).toBe(0);
  });

  test('no ssh key, no known_hosts file, no ssh client', () => {
    const f = createFixture();
    spawnSync('rm', [join(f.home, '.ssh/key')]);
    notProvisioned(f, 'ssh key');
    writeFileSync(join(f.home, '.ssh/key'), 'k');
    f.config['browser_known_hosts'] = join(f.home, 'known_hosts');
    f.writeConfig();
    notProvisioned(f, 'ssh known_hosts file');
    delete f.config['browser_known_hosts'];
    f.writeConfig();
    spawnSync('rm', [join(f.bin, 'ssh')]);
    const done = spawnSync(
      '/usr/bin/python3',
      [join(f.lib, 'stage-qa-driver.py'), SHA, '--config', f.configPath],
      { encoding: 'utf8', env: { PATH: f.lib, HOME: f.home } },
    );
    expect(done.status).toBe(3);
    expect(done.stderr).toContain('ssh client not found in PATH');
  });

  test('a report command that is not on the PATH, or a report script that is not installed', () => {
    const f = createFixture({ report_command: ['no-such-sudo-xyz', '-n', '/x/report.py'] });
    notProvisioned(f, 'report command no-such-sudo-xyz not found in PATH');
    f.config['report_command'] = ['python3', join(f.root, 'missing-report.py')];
    f.writeConfig();
    notProvisioned(f, 'is not installed; run scripts/install-stage-qa.sh as root');
  });

  test('wrong types and values in the config', () => {
    const f = createFixture({ browser_target: 'not a target' });
    notProvisioned(f, 'browser_target must look like user@host');
    f.config['browser_target'] = BROWSER_TARGET;
    f.config['min_cases'] = 5;
    f.writeConfig();
    // The floor of cases is the browser host's: the driver's config has no such key.
    notProvisioned(f, 'unknown key(s): min_cases');
    delete f.config['min_cases'];
    f.config['lock_timeout'] = 0;
    f.writeConfig();
    notProvisioned(f, 'lock_timeout must be a number > 0');
    f.config['lock_timeout'] = 20;
    f.config['slot_poll'] = 0;
    f.writeConfig();
    notProvisioned(f, 'slot_poll must be a number > 0');
    f.config['slot_poll'] = 1;
    f.config['browser_key'] = 'relative/key';
    f.writeConfig();
    notProvisioned(f, 'browser_key must be an absolute path');
    f.config['browser_key'] = join(f.home, '.ssh/key');
    f.config['report_command'] = [];
    f.writeConfig();
    notProvisioned(f, 'report_command must not be empty');
  });

  test('the default report command is sudo on the installed report script, with nothing else', () => {
    const done = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.util, json, sys
sys.path.insert(0, sys.argv[2])
spec = importlib.util.spec_from_file_location("m", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps([module.DEFAULTS["report_command"], module.DEFAULT_CONFIG]))`,
        DRIVER,
        join(REPO, 'scripts'),
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(done.stdout)).toEqual([
      ['sudo', '-n', '/usr/local/lib/esb-stage-qa/odroid-stage-qa-report.py'],
      '/etc/esb-stage-qa/driver.json',
    ]);
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
    f.report([{ report: report() }]);
    f.browser(PASSED());
    const done = f.run(args);
    expect(done.status).toBe(2);
    expect(result(done)).toBe('STAGE_QA_RESULT status=refused sha=- cases=0 failed=0');
    expect(f.reportCalls()).toEqual([]);
  });
});

describe('cancellation', () => {
  function startDriver(f: Fixture) {
    return startProcess(
      'python3',
      [join(f.lib, 'stage-qa-driver.py'), SHA, '--config', f.configPath],
      f.env(),
    );
  }

  test('a cancel while waiting for the slot exits 143 with a result line and closes the browser connection without a payload', async () => {
    const f = createFixture({ slot_wait: 60, slot_poll: 30 });
    f.report([{ report: report({ sha: OTHER_SHA }) }]);
    f.browser(PASSED());
    const started = startDriver(f);
    await started.stderrSeen('waiting for');
    started.child.kill('SIGTERM');
    const done = await started.finished;
    expect(done.status).toBe(143);
    expect(done.stdout).toContain('STAGE_QA_RESULT status=failed');
    expect(f.browserPayloads()).toEqual([]);
    const events = f.browserEvents();
    expect(events.some((e) => e.event === 'stdin-eof-before-payload')).toBe(true);
    expect(isAlive(events.find((e) => e.event === 'call')?.pid ?? 0)).toBe(false);
  });

  test('a cancel while the browser host runs the cases stops that connection: its process is gone', async () => {
    const f = createFixture();
    f.report([{ report: report() }]);
    f.browser({ hang: true });
    const started = startDriver(f);
    await started.stderrSeen('browser host: running');
    started.child.kill('SIGTERM');
    const done = await started.finished;
    expect(done.status).toBe(143);
    expect(done.stdout).toContain('STAGE_QA_RESULT status=failed');
    // The driver closed the connection's stdin first; the stand-in saw the end of it (or was terminated).
    const events = f.browserEvents();
    const pid = events.find((e) => e.event === 'call')?.pid ?? 0;
    expect(events.some((e) => e.event === 'stdin-eof' || e.event === 'terminated')).toBe(true);
    expect(isAlive(pid)).toBe(false);
    // No second report is fetched for a run that was cancelled.
    expect(f.reportCalls().length).toBe(1);
  });
});

describe('the two halves and the installers agree', () => {
  test('the driver and the browser half share the common module and its exit-code table', () => {
    const table = spawnSync(
      'python3',
      [
        '-c',
        `import json, sys
sys.path.insert(0, sys.argv[1])
import stage_qa_common as c
print(json.dumps(c.STATUS_BY_CODE))`,
        join(REPO, 'scripts'),
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(table.stdout)).toEqual({
      '0': 'passed',
      '2': 'refused',
      '3': 'not-provisioned',
      '75': 'lock-timeout',
      '76': 'superseded',
      '77': 'slot-never-ran',
    });
  });

  test('the sudoers line the installer prints names the very script the driver defaults to', () => {
    const installer = readFileSync(join(REPO, 'scripts/install-stage-qa.sh'), 'utf8');
    expect(installer).toContain('readonly LIB_DIR=/usr/local/lib/esb-stage-qa');
    expect(installer).toContain('readonly REPORT_NAME=odroid-stage-qa-report.py');
    expect(installer).toContain('readonly DRIVER_CONFIG=/etc/esb-stage-qa/driver.json');
  });
});
