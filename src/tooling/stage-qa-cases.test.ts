// The case list the per-PR stage QA sends to @ExpenseSyncStageBot (scripts/stage-smoke-cases.json,
// Stage QA section of DEPLOY.md). The list is real data for the real engine: the first and the last test
// run scripts/stage-smoke.py's own validation (`guard`) against the committed file, with Telegram's getMe
// replaced by a stand-in answer, so a case the engine would refuse can never be committed; the others pin
// the list to the bot's source (the answers it expects are strings in src/bot).
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  envText,
  fakeBotCredential,
  loadCases,
  MIN_CASES,
  PROD_USERNAME,
  REPO,
  REQUIRED_CASES,
  STAGE_USERNAME,
  tempRoot,
} from '../test-utils/stage-qa-fixtures';

const CASES = join(REPO, 'scripts/stage-smoke-cases.json');
const SMOKE = join(REPO, 'scripts/stage-smoke.py');

// guard() asks Telegram who owns the stage credential; the stand-in answers with the stage username.
const GUARD_DRIVER = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("stage_smoke", sys.argv[1])
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
sys.exit(smoke.main(sys.argv[2:], get_me=lambda _: "${STAGE_USERNAME}"))
`;

function guard(casesPath: string): { status: number | null; stdout: string; stderr: string } {
  const tmp = tempRoot('stage-qa-cases-');
  const dir = tmp.dir;
  try {
    writeFileSync(
      join(dir, 'stage.env'),
      envText({ BOT_TOKEN: fakeBotCredential('222222222'), BOT_USERNAME: STAGE_USERNAME }),
    );
    writeFileSync(
      join(dir, 'prod.env'),
      envText({ BOT_TOKEN: fakeBotCredential('111111111'), BOT_USERNAME: PROD_USERNAME }),
    );
    const args = [
      'guard',
      '--cases',
      casesPath,
      '--min-cases',
      String(MIN_CASES),
      '--stage-env',
      join(dir, 'stage.env'),
      '--prod-env',
      join(dir, 'prod.env'),
      '--deny',
      PROD_USERNAME,
      ...REQUIRED_CASES.flatMap((name) => ['--require-case', name]),
    ];
    const done = spawnSync('python3', ['-c', GUARD_DRIVER, SMOKE, ...args], { encoding: 'utf8' });
    return { status: done.status, stdout: done.stdout, stderr: done.stderr };
  } finally {
    tmp.cleanup();
  }
}

describe('scripts/stage-smoke-cases.json', () => {
  const cases = loadCases(CASES);

  test('the engine accepts the committed list with the floor the driver enforces', () => {
    const done = guard(CASES);
    expect(done.stderr).toBe('');
    expect(done.status).toBe(0);
    const line = done.stdout.split('\n').find((l) => l.startsWith('STAGE_GUARD '));
    expect(line).toBeDefined();
    const payload: unknown = JSON.parse((line ?? '').slice('STAGE_GUARD '.length));
    expect(payload).toMatchObject({ username: 'ExpenseSyncStageBot', peer: '222222222' });
    expect(payload).toMatchObject({ base_cases: cases.length });
  });

  test('has at least five cases and every required name', () => {
    expect(cases.length).toBeGreaterThanOrEqual(MIN_CASES);
    const names = cases.map((c) => c.name);
    for (const required of REQUIRED_CASES) expect(names).toContain(required);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every case sends one line, expects an answer and forbids the error texts', () => {
    for (const c of cases) {
      expect(c.send).not.toContain('\n');
      expect(c.min_replies ?? 1).toBeGreaterThanOrEqual(1);
      expect((c.expect ?? []).length).toBeGreaterThan(0);
      expect((c.forbid ?? []).length).toBeGreaterThan(0);
    }
  });

  test('the forbidden patterns catch every text the bot answers a failure with, read from its source', () => {
    // formatErrorForUser's answers, the crash path of /start and the AI entry guard: the strings are read
    // from the files, so rewording one without the forbid patterns turns this test red.
    const formatter = readFileSync(join(REPO, 'src/bot/bot-error-formatter.ts'), 'utf8');
    const failures = [...formatter.matchAll(/return '([^']+)';/g)].map((m) => m[1] ?? '');
    expect(failures.length).toBeGreaterThanOrEqual(7);
    for (const [file, text] of [
      ['src/bot/commands/start.ts', 'Не удалось определить пользователя или чат'],
      ['src/bot/commands/ask.ts', 'AI не настроен'],
    ] as const) {
      expect(readFileSync(join(REPO, file), 'utf8')).toContain(text);
      failures.push(text);
    }
    failures.push('Traceback (most recent call last)');
    for (const c of cases) {
      const patterns = (c.forbid ?? []).map((p) => new RegExp(p, 'is'));
      for (const text of failures) {
        expect(patterns.some((p) => p.test(text))).toBe(true);
      }
    }
  });

  test("the expected answers are the bot's real direct-chat texts", () => {
    // Direct chat is all qa-cli can reach, and the bot works only in groups: each of these answers
    // is a string in src/bot (guards.ts, start.ts, connect.ts, ask.ts, message.handler.ts, help.ts, ping.ts).
    const sources = [
      'src/bot/guards.ts',
      'src/bot/commands/start.ts',
      'src/bot/commands/connect.ts',
      'src/bot/commands/ask.ts',
      'src/bot/commands/ping.ts',
      'src/bot/commands/help.ts',
      'src/bot/handlers/message.handler.ts',
    ]
      .map((path) => readFileSync(join(REPO, path), 'utf8'))
      .join('\n');
    const expectations: Array<[string, string]> = [
      ['start', 'Бот работает только в группах'],
      ['ping', 'pong'],
      ['help-lists-commands', 'Что умеет бот'],
      ['categories-read-only-listing', 'работает только в группах'],
      ['validation-connect-rejected-outside-group', 'Добавь бота в группу'],
      ['simple-intent-phrase', 'работает только в группах'],
      ['expense-phrase-redirect', 'Бот работает только в группах'],
    ];
    for (const [name, phrase] of expectations) {
      const patterns = cases.find((c) => c.name === name)?.expect ?? [];
      expect(patterns.some((p) => new RegExp(p, 'is').test(phrase))).toBe(true);
      expect(sources).toContain(phrase);
    }
  });

  test('the intent phrase mentions the stage bot, never the production bot', () => {
    const phrase = cases.find((c) => c.name === 'simple-intent-phrase')?.send ?? '';
    expect(phrase.startsWith('@ExpenseSyncStageBot ')).toBe(true);
    for (const c of cases) expect(c.send).not.toMatch(/@ExpenseSyncBot\b/);
  });

  test('every slash command a case sends is answered before any group handler runs in a direct chat', () => {
    // Registered behind requireGroup (rejects a direct chat first) or one of the four that answer a direct
    // chat themselves (a redirect, pong, the help text, a rejection): no group handler ever sees the case.
    const registrations = readFileSync(join(REPO, 'src/bot/index.ts'), 'utf8');
    const answeredByThemselves = ['start', 'help', 'ping', 'connect'];
    const commands = cases
      .filter((c) => c.send.startsWith('/'))
      .map((c) => c.send.slice(1).split(' ')[0] ?? '');
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const registration = registrations.match(
        new RegExp(`bot\\.command\\(\\s*'${command}',[\\s\\S]*?\\);\\n`),
      );
      expect(registration).not.toBeNull();
      expect(
        (registration?.[0] ?? '').includes('requireGroup(') ||
          answeredByThemselves.includes(command),
      ).toBe(true);
    }
    expect(readFileSync(join(REPO, 'src/bot/commands/start.ts'), 'utf8')).toContain(
      'sendPrivateChatRedirect(telegramId)',
    );
  });

  test('the engine refuses a list below the floor, so a PR cannot shrink the coverage', () => {
    const tmp = tempRoot('stage-qa-cases-short-');
    try {
      const short = join(tmp.dir, 'short.json');
      writeFileSync(short, JSON.stringify(cases.slice(0, MIN_CASES - 1)));
      const done = guard(short);
      expect(done.status).toBe(64);
      expect(done.stderr).toContain(`smoke cases, at least ${MIN_CASES} are required`);
    } finally {
      tmp.cleanup();
    }
  });
});
