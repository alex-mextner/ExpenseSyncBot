// The driver (scripts/stage-qa-pc.py) and the engine (scripts/stage-smoke.py `run`) meet in a command line
// and in one summary line. stage-qa-pc.test.ts pins the driver against a stub engine; this file runs the REAL
// engine under the REAL driver, with a stand-in odroid (`ssh`) and a stand-in qa-cli that speaks the JSON the
// engine expects (`qa telegram chat send|wait|read`), so a renamed flag, a changed summary format or a case the
// engine judges differently than the driver assumes fails here and not on the first PR.
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
  REPO,
  realCases,
  STAGE_USERNAME,
  type TempRoot,
  tempRoot,
  writeExecutable,
} from '../test-utils/stage-qa-fixtures';

setDefaultTimeout(60_000);

const SHA = 'a'.repeat(40);
const PEER = '222222222';

const FAKE_SSH = `#!/usr/bin/env python3
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
sys.stdout.write(open(os.path.join(here, "report.line")).read())
`;

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

function run(answers: Record<string, string[]>, options: { notLoggedIn?: boolean } = {}): Run {
  temp = tempRoot('stage-qa-engine-');
  const root = temp.dir;
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const lib = join(root, 'lib');
  mkdirSync(join(home, '.config/esb-stage-qa'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(lib);
  copyFileSync(join(REPO, 'scripts/stage-qa-pc.py'), join(lib, 'stage-qa-pc.py'));
  copyFileSync(join(REPO, 'scripts/stage-smoke.py'), join(lib, 'stage-smoke.py'));
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
    }),
  );
  const config = join(home, '.config/esb-stage-qa/config.json');
  writeFileSync(
    config,
    JSON.stringify({
      ssh_target: 'root@odroid.example',
      ssh_key: join(home, 'key'),
      username: STAGE_USERNAME,
      qa_bin: join(home, 'qa'),
      state_dir: join(home, 'state'),
      lock_file: join(home, 'qa.lock'),
      slot_wait: 0,
    }),
  );
  chmodSync(config, 0o600);
  const done = spawnSync('python3', [join(lib, 'stage-qa-pc.py'), SHA, '--config', config], {
    encoding: 'utf8',
    cwd: home,
    env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: home },
  });
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

describe('the driver with the real engine', () => {
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

  test('qa-cli that is not logged in is not a verdict on the PR: exit 3, no receipt', () => {
    const done = run(ANSWERS, { notLoggedIn: true });
    expect(done.status).toBe(3);
    expect(done.stdout).toBe(
      `STAGE_QA_RESULT status=not-provisioned sha=${SHA} cases=0 failed=0\n`,
    );
    expect(done.receipt).toBeNull();
  });
});
