// The odroid driver (scripts/stage-qa-driver.py), the browser half (scripts/stage-qa-browser.py) and the engine
// (scripts/stage-smoke.py `run`) meet in command lines and in summary lines. stage-qa-driver.test.ts and
// stage-qa-browser.test.ts pin each half against a stub; this file runs the REAL engine under the REAL browser half
// under the REAL driver, with a stand-in report script, an `ssh` that runs the browser half locally (as the forced
// command of the real one does) and a stand-in qa-cli that speaks the JSON the engine expects
// (`qa telegram chat send|wait|read`), so a renamed flag, a changed summary or result format or a case the
// engine judges differently than the halves assume fails here and not on the first PR.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
  holdLock,
  REPO,
  realCases,
  STAGE_USERNAME,
  startProcess,
  type TempRoot,
  tempRoot,
  writeExecutable,
} from '../test-utils/stage-qa-fixtures';

setDefaultTimeout(60_000);

const SHA = 'a'.repeat(40);
const PEER = '222222222';

// The odroid's report script: the same report every time it is asked.
const FAKE_REPORT = `#!/usr/bin/env python3
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
open(os.path.join(here, "report.calls"), "a").write("asked\\n")
sys.stdout.write(open(os.path.join(here, "report.line")).read())
`;

// The browser host's ssh: the last argument is the forced command's SSH_ORIGINAL_COMMAND (the commit); the browser
// half runs here with the driver's stdin and stdout, as it would at the other end of the connection.
const FAKE_SSH = `#!/usr/bin/env python3
import os, sys
lib = os.environ["BROWSER_LIB"]
config = os.path.join(os.environ["HOME"], ".config/esb-stage-qa/browser.json")
os.execv(sys.executable, [sys.executable, os.path.join(lib, "stage-qa-browser.py"), sys.argv[-1], "--config", config])
`;

/** What the stand-in qa-cli does besides answering: not logged in, a cold browser that times out the first sends, a send that fails. */
interface Options {
  notLoggedIn?: boolean;
  coldStartFailures?: number;
  sendError?: string;
}

// qa-cli as the engine drives it: one JSON line per call; message ids grow by 10 per send so the replies of
// one send never collide with the next send.
const FAKE_QA = `#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
scenario = json.load(open(os.path.join(here, "qa_scenario.json")))
args = sys.argv[1:]
with open(scenario["log"], "a") as handle:
    handle.write(json.dumps(args) + "\\n")
if scenario.get("not_logged_in"):
    print(json.dumps({"ok": False, "error": "not logged in"}))
    sys.exit(3)
state_file = os.path.join(here, "qa_state.json")
state = json.load(open(state_file)) if os.path.exists(state_file) else {"next": 10, "sent": {}}
action = args[2]
flag = lambda name: args[args.index(name) + 1]
if action == "send":
    failed = state.get("failed", 0)
    if failed < scenario.get("cold_start_failures", 0):
        state["failed"] = failed + 1
        json.dump(state, open(state_file, "w"))
        print(json.dumps({"ok": False, "error": "timed out after 30s waiting for Telegram Web to load"}))
        sys.exit(1)
    if scenario.get("send_error"):
        print(json.dumps({"ok": False, "error": scenario["send_error"]}))
        sys.exit(1)
    sent_id = state["next"]
    state["next"] += 10
    state["sent"][str(sent_id)] = flag("--text")
    json.dump(state, open(state_file, "w"))
    print(json.dumps({"ok": True, "message": {"id": sent_id}}))
    sys.exit(0)
after = int(flag("--after"))
replies = scenario["replies"].get(state["sent"][str(after)], [])
if action == "wait":
    if not replies:
        print(json.dumps({"ok": False, "error": "timeout"}))
        sys.exit(1)
    print(json.dumps({"ok": True, "message": {"id": after + 1, "out": False, "text": replies[0]}}))
else:
    messages = [{"id": after + 1 + i, "out": False, "text": text} for i, text in enumerate(replies)]
    print(json.dumps({"ok": True, "messages": messages}))
`;

// What the real bot answers in a direct chat (the strings are in src/bot; stage-qa-cases.test.ts pins them).
const ANSWERS: Record<string, string[]> = {
  '/start': ['💬 Бот работает только в группах.', '<b>Как начать:</b> создай группу'],
  '/ping': ['pong\n2026-10-26T05:00:00.000Z'],
  '/help': ['📚 Что умеет бот\n\n💰 Запись расходов'],
  '/categories': ['❌ Эта команда работает только в группах.'],
  '/connect': [
    '❌ Эта команда работает только в группах.\n\nДобавь бота в группу и используй /connect там.',
  ],
  '@ExpenseSyncStageBot сколько я потратил на еду?': ['❌ Эта команда работает только в группах.'],
  '100 еда круассаны и кофе': ['💬 Бот работает только в группах.', 'Как начать: создай группу'],
};

let temp: TempRoot | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  qaCalls: string[][];
  receipt: { passed: boolean; cases: Array<{ name: string; ok: boolean; replies: number }> } | null;
}

interface Prepared {
  root: string;
  home: string;
  bin: string;
  lib: string;
  driverConfig: string;
  env: Record<string, string>;
  collect: (done: { status: number | null; stdout: string; stderr: string }) => Run;
}

/** The tree of stand-ins (report script, ssh, qa-cli) and the configs of both halves, nothing started yet. */
function prepare(answers: Record<string, string[]>, options: Options = {}): Prepared {
  temp = tempRoot('stage-qa-engine-');
  const root = temp.dir;
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const lib = join(root, 'lib');
  mkdirSync(join(home, '.config/esb-stage-qa'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(lib);
  for (const name of [
    'stage-qa-driver.py',
    'stage-qa-browser.py',
    'stage_qa_common.py',
    'stage-smoke.py',
  ]) {
    copyFileSync(join(REPO, 'scripts', name), join(lib, name));
  }
  writeExecutable(join(bin, 'report'), FAKE_REPORT);
  writeExecutable(join(bin, 'ssh'), FAKE_SSH);
  writeExecutable(join(home, 'qa'), FAKE_QA);
  writeFileSync(join(home, 'key'), 'not a key');
  // settle_s 0: the engine stops collecting a case's replies at once instead of polling for 3 s each.
  const cases = realCases().map((c) => ({ ...c, settle_s: 0 }));
  writeFileSync(
    join(bin, 'report.line'),
    `STAGE_REPORT ${JSON.stringify({
      sha: SHA,
      online: true,
      started_at: 1,
      restarts: 0,
      username: STAGE_USERNAME,
      peer: PEER,
      cases,
      cases_error: null,
      slot_error: null,
    })}\n`,
  );
  writeFileSync(
    join(home, 'qa_scenario.json'),
    JSON.stringify({
      log: join(root, 'qa.log'),
      replies: answers,
      not_logged_in: options.notLoggedIn,
      cold_start_failures: options.coldStartFailures,
      send_error: options.sendError,
    }),
  );
  const browserConfig = join(home, '.config/esb-stage-qa/browser.json');
  writeFileSync(
    browserConfig,
    JSON.stringify({
      username: STAGE_USERNAME,
      qa_bin: join(home, 'qa'),
      state_dir: join(home, 'state'),
      lock_file: join(home, 'qa.lock'),
    }),
  );
  chmodSync(browserConfig, 0o600);
  const driverConfig = join(root, 'driver.json');
  writeFileSync(
    driverConfig,
    JSON.stringify({
      report_command: [join(bin, 'report')],
      browser_target: 'ultra@browser.example',
      browser_key: join(home, 'key'),
      slot_wait: 0,
    }),
  );
  chmodSync(driverConfig, 0o644);
  const env = { PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: home, BROWSER_LIB: lib };
  return { root, home, bin, lib, driverConfig, env, collect: (done) => collect(root, home, done) };
}

function collect(
  root: string,
  home: string,
  done: { status: number | null; stdout: string; stderr: string },
): Run {
  const log = join(root, 'qa.log');
  const receipt = join(home, `state/receipts/${SHA}.json`);
  return {
    status: done.status,
    stdout: done.stdout,
    stderr: done.stderr,
    qaCalls: existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [],
    receipt: existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null,
  };
}

function run(answers: Record<string, string[]>, options: Options = {}): Run {
  const setup = prepare(answers, options);
  const done = spawnSync(
    'python3',
    [join(setup.lib, 'stage-qa-driver.py'), SHA, '--config', setup.driverConfig],
    { encoding: 'utf8', cwd: setup.home, env: setup.env },
  );
  return setup.collect(done);
}

describe('the driver and the browser half with the real engine', () => {
  test('passes when the bot answers every case the way its code does', () => {
    const done = run(ANSWERS);
    expect(done.stderr).toContain('STAGE_SMOKE_PASSED');
    expect(done.status).toBe(0);
    expect(done.stdout).toBe(`STAGE_QA_RESULT status=passed sha=${SHA} cases=7 failed=0\n`);
    expect(done.receipt?.passed).toBe(true);
    expect(done.receipt?.cases.map((c) => c.name)).toEqual(realCases().map((c) => c.name));
  });

  test('talks only to the stage bot: every qa call carries its numeric id and username', () => {
    const done = run(ANSWERS);
    expect(done.qaCalls.length).toBeGreaterThan(0);
    for (const call of done.qaCalls) {
      expect(call.slice(0, 2)).toEqual(['telegram', 'chat']);
      expect(call[call.indexOf('--peer') + 1]).toBe(PEER);
      expect(call[call.indexOf('--username') + 1]).toBe(STAGE_USERNAME);
    }
  });

  test('sends exactly the cases of the PR, in order, as single text arguments', () => {
    const done = run(ANSWERS);
    const sent = done.qaCalls
      .filter((call) => call[2] === 'send')
      .map((call) => call[call.indexOf('--text') + 1]);
    expect(sent).toEqual(realCases().map((c) => c.send));
  });

  test('a reply with one of the bot error texts fails that case and the run (exit 1)', () => {
    const done = run({ ...ANSWERS, '/ping': ['Произошла непредвиденная ошибка.', 'pong'] });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('SMOKE FAIL ping');
    expect(done.stdout).toBe(`STAGE_QA_RESULT status=failed sha=${SHA} cases=7 failed=1\n`);
    expect(done.receipt?.passed).toBe(false);
  });

  test('a case the bot never answers fails the run: silence is not a pass', () => {
    const rest = { ...ANSWERS };
    delete rest['/categories'];
    const done = run(rest);
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('SMOKE FAIL categories-read-only-listing');
    expect(
      done.receipt?.cases.find((c) => c.name === 'categories-read-only-listing')?.replies,
    ).toBe(0);
  });

  test('an answer that is not the expected one fails the case', () => {
    const done = run({ ...ANSWERS, '/help': ['что-то совсем другое'] });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('no reply matched any of the expected patterns');
  });

  test('a failed case prints the replies the bot gave, one line each, so a red check can be read from the job log', () => {
    const done = run({ ...ANSWERS, '/help': ['что-то\nсовсем   другое'] });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain('SMOKE REPLY help-lists-commands #1: что-то совсем другое');
    const passing = run(ANSWERS);
    expect(passing.stderr).not.toContain('SMOKE REPLY');
  });

  test('a send that timed out before anything was typed (a cold browser) is retried and the run passes', () => {
    const done = run(ANSWERS, { coldStartFailures: 1 });
    expect(done.status).toBe(0);
    const sends = done.qaCalls.filter((call) => call[2] === 'send');
    expect(sends.length).toBe(realCases().length + 1);
    // The retried send is the first case again, never a different text.
    expect(sends[0]?.[sends[0].indexOf('--text') + 1]).toBe(realCases()[0]?.send);
    expect(sends[1]?.[sends[1].indexOf('--text') + 1]).toBe(realCases()[0]?.send);
  });

  test('a send that fails any other way is not retried: it may have been delivered', () => {
    const done = run(ANSWERS, { sendError: 'chat is read only' });
    expect(done.status).toBe(3);
    expect(done.qaCalls.filter((call) => call[2] === 'send').length).toBe(1);
  });

  test('qa-cli that is not logged in is not a verdict on the PR: exit 3, no receipt', () => {
    const done = run(ANSWERS, { notLoggedIn: true });
    expect(done.status).toBe(3);
    expect(done.stdout).toBe(
      `STAGE_QA_RESULT status=not-provisioned sha=${SHA} cases=0 failed=0\n`,
    );
    expect(done.receipt).toBeNull();
  });
});

describe('the lock order with the real halves', () => {
  test('a browser lock held by another run keeps the odroid side idle: the report script is first asked after the lock is free', async () => {
    const setup = prepare(ANSWERS);
    const holder = holdLock(join(setup.home, 'qa.lock'));
    await holder.ready;
    const started = startProcess(
      'python3',
      [join(setup.lib, 'stage-qa-driver.py'), SHA, '--config', setup.driverConfig],
      setup.env,
    );
    await started.stderrSeen('waiting for the browser lock');
    // The browser half is connected and queued, yet nothing was asked of the odroid.
    expect(existsSync(join(setup.bin, 'report.calls'))).toBe(false);
    holder.stop();
    const done = await started.finished;
    expect(done.status).toBe(0);
    expect(done.stdout).toBe(`STAGE_QA_RESULT status=passed sha=${SHA} cases=7 failed=0\n`);
    expect(
      readFileSync(join(setup.bin, 'report.calls'), 'utf8').split('\n').filter(Boolean).length,
    ).toBe(2);
  });
});
