// Runs the "Deploy or stop stage bot" step of .github/workflows/stage-bot.yml the way the
// odroid runner does: its env is evaluated from a pull_request event with GitHub's expression
// engine, its script runs under bash with /var/www relocated into a temp dir, and git, bun,
// pm2 and curl are stand-ins that record their calls. The point under test is WHICH code
// the stage bot runs: exactly the commit the (guarded) event was about, never a later push.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { data, Evaluator, Lexer, Parser } from '@actions/expressions';

const WORKFLOW = join(import.meta.dir, '../../.github/workflows/stage-bot.yml');
const REPO = 'alex-mextner/ExpenseSyncBot';
const BRANCH = 'feat/some-change';
const HEAD_SHA = '1111111111111111111111111111111111111111';

// Stand-in git: logs every call; `worktree add` creates the worktree directory (its path is
// the only absolute argument); `rev-parse`/`log` answer what the notification needs.
const GIT_STUB = `#!/usr/bin/env bash
echo "git $*" >> "$CALLS"
case "$1" in
  worktree) [ "$2" = add ] && for a in "$@"; do case "$a" in /*) mkdir -p "$a" ;; esac; done ;;
  rev-parse) echo "${HEAD_SHA}" ;;
  log) echo "commit message" ;;
esac
exit 0
`;
// Stand-in bun: `bun -e …` is the pm2-status probe, everything else (install) succeeds.
const BUN_STUB = `#!/usr/bin/env bash
echo "bun $*" >> "$CALLS"
[ "$1" = -e ] && echo online
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

function eventContext(action: 'opened' | 'synchronize'): data.Dictionary {
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

async function runDeploy({ worktreeExists }: { worktreeExists: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'stage-bot-deploy-'));
  const www = join(root, 'var/www');
  const bunBin = join(www, '.bun/bin');
  const stubs = join(root, 'stubs');
  const mainDir = join(www, 'ExpenseSyncBot');
  const worktree = join(mainDir, '.claude/worktrees', BRANCH);
  const calls = join(root, 'calls');
  mkdirSync(bunBin, { recursive: true });
  mkdirSync(stubs);
  mkdirSync(mainDir, { recursive: true });
  if (worktreeExists) mkdirSync(worktree, { recursive: true });
  writeFileSync(join(mainDir, '.env'), 'BOT_TOKEN=prod\n');
  writeFileSync(join(mainDir, '.env.stage'), 'BOT_TOKEN=stage\n');
  writeFileSync(join(bunBin, 'bun'), BUN_STUB, { mode: 0o755 });
  writeFileSync(join(bunBin, 'pm2'), LOGGING_STUB('pm2'), { mode: 0o755 });
  writeFileSync(join(stubs, 'git'), GIT_STUB, { mode: 0o755 });
  writeFileSync(join(stubs, 'curl'), LOGGING_STUB('curl'), { mode: 0o755 });
  writeFileSync(join(stubs, 'sleep'), '#!/bin/sh\n', { mode: 0o755 });

  const step = await deployStep();
  const script = join(root, 'step.sh');
  writeFileSync(script, step.run.replaceAll('/var/www', www));
  const result = spawnSync('bash', [script], {
    env: {
      ...evaluateEnv(step.env, eventContext(worktreeExists ? 'synchronize' : 'opened')),
      PATH: `${stubs}:${process.env['PATH']}`,
      CALLS: calls,
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const log = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
  return {
    status: result.status,
    stderr: result.stderr,
    git: log.filter((l) => l.startsWith('git ')),
  };
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
});
