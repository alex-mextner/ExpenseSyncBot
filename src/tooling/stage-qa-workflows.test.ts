// .github/workflows/stage-qa.yml (`Stage QA`, workflow_run of `Stage Bot`) is the one workflow that lets a
// pull request cause a job on the odroid's stage QA runner, so its shape is a security property: it always runs
// from main, checks nothing out, hands the root-installed driver a commit SHA and nothing else, and only its
// hosted `report` job may write the `stage-qa` status. These tests read the YAML, evaluate the job guards with
// GitHub's own expression engine, and run the three scripts of the workflow against stand-ins for `gh` and the driver.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { data, Evaluator, Lexer, Parser } from '@actions/expressions';
import { truthy } from '@actions/expressions/result';
import { REPO, type TempRoot, tempRoot, writeExecutable } from '../test-utils/stage-qa-fixtures';

setDefaultTimeout(60_000);

const WORKFLOWS = join(REPO, '.github/workflows');
const SLUG = 'alex-mextner/ExpenseSyncBot';
const SHA = 'a'.repeat(40);
const INSTALLED_DRIVER = '/usr/local/lib/esb-stage-qa/stage-qa-driver.py';
const INSTALLED_DRIVER_CALL = `python3 ${INSTALLED_DRIVER}`;

/** `value[key]` when `value` is an object that has `key`, otherwise undefined. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? Reflect.get(value, key)
    : undefined;
}

function load(file: string): unknown {
  return Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), 'utf8'));
}

function jobs(parsed: unknown): Array<[string, unknown]> {
  const all = field(parsed, 'jobs');
  return all !== null && typeof all === 'object' ? Object.entries(all) : [];
}

function stepsOf(jobValue: unknown): unknown[] {
  const steps = field(jobValue, 'steps');
  return Array.isArray(steps) ? steps : [];
}

function script(parsed: unknown, jobName: string): string {
  const [step] = stepsOf(jobs(parsed).find(([name]) => name === jobName)?.[1]);
  const run = field(step, 'run');
  if (typeof run !== 'string') throw new Error(`${jobName} has no run script in its first step`);
  return run;
}

function condition(parsed: unknown, jobName: string): string {
  const value = field(jobs(parsed).find(([name]) => name === jobName)?.[1], 'if');
  if (typeof value !== 'string') throw new Error(`${jobName} has no if: condition`);
  return value.replace(/\s+/g, ' ').trim();
}

/** A GitHub Actions expression as it appears in the YAML. */
function expression(body: string): string {
  return `\${{ ${body} }}`;
}

const workflowText = readFileSync(join(WORKFLOWS, 'stage-qa.yml'), 'utf8');
const stageQa = load('stage-qa.yml');

describe('the shape of stage-qa.yml', () => {
  test('is triggered only by a completed run of the Stage Bot workflow', () => {
    const on = field(stageQa, 'on');
    expect(Object.keys(on as object)).toEqual(['workflow_run']);
    expect(field(on, 'workflow_run')).toEqual({ workflows: ['Stage Bot'], types: ['completed'] });
  });

  test('names a workflow that exists under that name and path', () => {
    const stageBot = load('stage-bot.yml');
    expect(field(stageBot, 'name')).toBe('Stage Bot');
    expect(condition(stageQa, 'eligible')).toContain("== '.github/workflows/stage-bot.yml'");
  });

  test('has no default permissions, and only the hosted report job may write a status', () => {
    expect(field(stageQa, 'permissions')).toEqual({});
    for (const [name, value] of jobs(stageQa)) {
      const permissions = field(value, 'permissions');
      const writes = Object.entries((permissions as object | undefined) ?? {}).filter(
        ([, level]) => level === 'write',
      );
      if (name === 'report') {
        expect(writes).toEqual([['statuses', 'write']]);
        expect(field(value, 'runs-on')).toBe('ubuntu-latest');
      } else {
        expect(writes).toEqual([]);
      }
    }
  });

  test('only the qa job runs on a self-hosted runner, and that runner is the stage-qa label alone', () => {
    for (const [name, value] of jobs(stageQa)) {
      const runsOn = field(value, 'runs-on');
      if (name === 'qa') expect(runsOn).toEqual(['self-hosted', 'stage-qa']);
      else expect(runsOn).toBe('ubuntu-latest');
    }
  });

  test('the qa job has no token and checks nothing out, downloads nothing and uses no action', () => {
    const qa = jobs(stageQa).find(([name]) => name === 'qa')?.[1];
    expect(field(qa, 'permissions')).toEqual({});
    expect(stepsOf(qa).length).toBe(1);
    for (const [, value] of jobs(stageQa)) {
      for (const step of stepsOf(value)) {
        const uses = field(step, 'uses');
        if (typeof uses === 'string') {
          expect(uses).not.toMatch(/checkout|artifact|cache|download|upload/);
        }
      }
    }
    expect(workflowText).not.toMatch(/actions\/checkout|download-artifact|upload-artifact/);
    expect(workflowText).not.toContain('secrets.GITHUB_TOKEN\n      - name');
    const qaStepEnv = field(stepsOf(qa)[0], 'env');
    expect(qaStepEnv).toEqual({ HEAD_SHA: expression('github.event.workflow_run.head_sha') });
  });

  test('the qa job calls the installed driver with the head SHA and nothing else', () => {
    const run = script(stageQa, 'qa');
    const calls = run.split('\n').filter((line) => line.includes('stage-qa-driver.py'));
    expect(calls).toEqual([`${INSTALLED_DRIVER_CALL} "$HEAD_SHA" 2>&1 | tee "$out"`]);
  });

  test('no run script interpolates an expression: every value reaches the shell through env', () => {
    for (const [, value] of jobs(stageQa)) {
      for (const step of stepsOf(value)) {
        const run = field(step, 'run');
        if (typeof run === 'string') expect(run).not.toContain('${{');
      }
    }
  });

  test('the whole workflow is serialised per branch and a newer run replaces an older one', () => {
    expect(field(stageQa, 'concurrency')).toEqual({
      group: `stage-qa-${expression('github.event.workflow_run.head_branch')}`,
      'cancel-in-progress': true,
    });
  });

  test('the qa job time limit outlasts the driver defaults: lock wait, slot wait, cases and the report calls', () => {
    const qa = jobs(stageQa).find(([name]) => name === 'qa')?.[1];
    const minutes = field(qa, 'timeout-minutes');
    const pick = (file: string, pattern: RegExp): number => {
      const value = readFileSync(join(REPO, 'scripts', file), 'utf8').match(pattern)?.[1];
      if (!value) throw new Error(`${file} default ${pattern} not found`);
      return Number(value);
    };
    const driver = (pattern: RegExp): number => pick('stage-qa-driver.py', pattern);
    // One report call may overrun the slot wait by its own timeout, and one more follows the cases.
    const budgetSeconds =
      driver(/DEFAULT_LOCK_TIMEOUT = (\d+)/) +
      driver(/"slot_wait": (\d+)/) +
      driver(/DEFAULT_BROWSER_TIMEOUT = (\d+)/) +
      2 * driver(/"report_timeout": (\d+)/);
    expect(Number(minutes) * 60).toBeGreaterThan(budgetSeconds);
    // The driver's lock_timeout must outlast the browser half's own lock wait, which it covers.
    expect(driver(/DEFAULT_LOCK_TIMEOUT = (\d+)/)).toBeGreaterThan(
      pick('stage-qa-browser.py', /"lock_max_wait": (\d+)/),
    );
    // The browser half keeps the lock for the driver's slot wait before the report arrives, and then the cases.
    expect(pick('stage-qa-browser.py', /DEFAULT_PAYLOAD_WAIT = (\d+)/)).toBeGreaterThan(
      driver(/"slot_wait": (\d+)/) + 2 * driver(/"report_timeout": (\d+)/),
    );
    expect(driver(/DEFAULT_BROWSER_TIMEOUT = (\d+)/)).toBeGreaterThan(
      pick('stage-qa-browser.py', /DEFAULT_SMOKE_TIMEOUT = (\d+)/),
    );
  });

  test('no other workflow lets a pull request run on the stage-qa runner', () => {
    for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'))) {
      if (file === 'stage-qa.yml') continue;
      expect(readFileSync(join(WORKFLOWS, file), 'utf8')).not.toMatch(/self-hosted,\s*stage-qa\b/);
    }
  });

  test('every other job is GitHub-hosted or on the deploying odroid runner alone, and actionlint knows exactly the two labels', () => {
    // The runners carry the default labels self-hosted, Linux and ARM64 besides their own: a job that names
    // only those (or an expression, or a runner group) could land on the stage QA runner.
    for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'))) {
      if (file === 'stage-qa.yml') continue;
      for (const [, value] of jobs(load(file))) {
        const runsOn = field(value, 'runs-on');
        if (runsOn !== 'ubuntu-latest') expect(runsOn).toEqual(['self-hosted', 'odroid']);
      }
    }
    const config = Bun.YAML.parse(readFileSync(join(REPO, '.github/actionlint.yaml'), 'utf8'));
    expect(field(field(config, 'self-hosted-runner'), 'labels')).toEqual(['odroid', 'stage-qa']);
  });
});

/** A GitHub context object as the expression engine's data. */
function context(values: object): data.Dictionary {
  const parsed: unknown = JSON.parse(JSON.stringify(values), data.reviver);
  if (!(parsed instanceof data.Dictionary)) throw new Error('context is not a dictionary');
  return parsed;
}

function evaluates(source: string, values: object): boolean {
  // `always()` is GitHub's status function; the part after it is the guard that is evaluated here.
  const guard = source.replace(/^always\(\) && /, '');
  const lexed = new Lexer(guard).lex();
  const expression = new Parser(lexed.tokens, ['github', 'needs'], []).parse();
  return truthy(new Evaluator(expression, context(values)).evaluate());
}

interface RunEvent {
  event?: string;
  headRepo?: string;
  path?: string;
  actorType?: string;
  conclusion?: string;
}

function githubFor(event: RunEvent): object {
  return {
    repository: SLUG,
    event: {
      workflow_run: {
        event: event.event ?? 'pull_request',
        head_repository: { full_name: event.headRepo ?? SLUG },
        path: event.path ?? '.github/workflows/stage-bot.yml',
        actor: { type: event.actorType ?? 'User' },
        conclusion: event.conclusion ?? 'success',
      },
    },
  };
}

describe('which runs reach the QA runner', () => {
  const eligible = condition(stageQa, 'eligible');

  test('a same-repository pull request run of Stage Bot is eligible', () => {
    expect(evaluates(eligible, { github: githubFor({}) })).toBe(true);
  });

  test.each([
    ['a fork', { headRepo: 'someone/ExpenseSyncBot' }],
    ['a push event', { event: 'push' }],
    ['another workflow file that is also named Stage Bot', { path: '.github/workflows/evil.yml' }],
    ['a run started by a GitHub App bot', { actorType: 'Bot' }],
  ])('%s is not eligible', (_name, event) => {
    expect(evaluates(eligible, { github: githubFor(event) })).toBe(false);
  });

  const qa = condition(stageQa, 'qa');

  test.each([
    ['true', 'success', true],
    ['true', 'failure', false],
    ['true', 'cancelled', false],
    ['false', 'success', false],
    ['', 'success', false],
  ])('qa with eligible=%p and Stage Bot %s runs: %p', (run, conclusion, expected) => {
    expect(
      evaluates(qa, {
        github: githubFor({ conclusion }),
        needs: { eligible: { outputs: { run } } },
      }),
    ).toBe(expected);
  });

  test('report runs after a failed or skipped qa job, but only for an eligible run', () => {
    const report = condition(stageQa, 'report');
    expect(report.startsWith('always() && ')).toBe(true);
    expect(evaluates(report, { needs: { eligible: { outputs: { run: 'true' } } } })).toBe(true);
    expect(evaluates(report, { needs: { eligible: { outputs: { run: 'false' } } } })).toBe(false);
    expect(evaluates(report, { needs: { eligible: { outputs: {} } } })).toBe(false);
  });
});

let temp: TempRoot | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

interface Shell {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
  root: string;
}

/** Runs a workflow `run:` script the way the runner does (`bash -e`), with the given env. */
function runScript(
  source: string,
  env: Record<string, string>,
  prepare?: (root: string) => void,
): Shell {
  temp = tempRoot('stage-qa-workflow-');
  const root = temp.dir;
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'tmp'));
  prepare?.(root);
  const scriptFile = join(root, 'step.sh');
  writeFileSync(scriptFile, source);
  const outputFile = join(root, 'github-output');
  writeFileSync(outputFile, '');
  const done = spawnSync('bash', ['-e', scriptFile], {
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}`,
      HOME: root,
      RUNNER_TEMP: join(root, 'tmp'),
      GITHUB_OUTPUT: outputFile,
      ...env,
    },
  });
  return {
    status: done.status,
    stdout: done.stdout,
    stderr: done.stderr,
    output: readFileSync(outputFile, 'utf8'),
    root,
  };
}

describe('the eligibility step', () => {
  const eligibleScript = script(stageQa, 'eligible');

  function eligibility(pulls: object[], headSha = SHA): Shell {
    return runScript(
      eligibleScript,
      { GH_TOKEN: 'unused', REPO: SLUG, HEAD_SHA: headSha },
      (root) => {
        writeFileSync(join(root, 'pulls.json'), JSON.stringify(pulls));
        // gh prints the pull requests of the commit; the filter is the script's own jq.
        writeExecutable(
          join(root, 'bin/gh'),
          `#!/usr/bin/env bash\necho "$*" >> "${root}/gh.log"\ncat "${root}/pulls.json"\n`,
        );
      },
    );
  }

  function pull(over: object = {}): object {
    return {
      state: 'open',
      head: { sha: SHA, repo: { full_name: SLUG } },
      user: { type: 'User' },
      ...over,
    };
  }

  test('an open same-repository pull request of exactly this head is eligible', () => {
    const done = eligibility([pull()]);
    expect(done.status).toBe(0);
    expect(done.output).toBe('run=true\n');
    expect(readFileSync(join(done.root, 'gh.log'), 'utf8').trim()).toBe(
      `api repos/${SLUG}/commits/${SHA}/pulls`,
    );
  });

  test.each([
    ['no pull request at all', []],
    ['a closed pull request', [pull({ state: 'closed' })]],
    [
      'a pull request whose head moved on',
      [pull({ head: { sha: 'b'.repeat(40), repo: { full_name: SLUG } } })],
    ],
    ['a fork pull request', [pull({ head: { sha: SHA, repo: { full_name: 'someone/fork' } } })]],
    ['a pull request whose fork was deleted', [pull({ head: { sha: SHA, repo: null } })]],
    ['a pull request opened by a bot', [pull({ user: { type: 'Bot' } })]],
  ])('%s is not eligible', (_name, pulls) => {
    const done = eligibility(pulls);
    expect(done.status).toBe(0);
    expect(done.output).toBe('run=false\n');
  });

  test('another pull request that happens to share the commit does not hide an eligible one', () => {
    const done = eligibility([pull({ state: 'closed' }), pull()]);
    expect(done.output).toBe('run=true\n');
  });

  test('refuses a head that is not a full commit SHA', () => {
    const done = eligibility([pull()], 'main; id');
    expect(done.status).not.toBe(0);
    expect(done.output).toBe('');
    expect(done.stderr).toContain('not a full commit SHA');
  });
});

describe('the qa step', () => {
  const qaScript = script(stageQa, 'qa');

  /** The step with the installed driver (`python3 <path>`) replaced by an executable stand-in at a temp path. */
  function qaRun(driver: string | null): Shell {
    return runScript(
      qaScript.replace(`python3 ${INSTALLED_DRIVER}`, join('$HOME', 'bin', 'driver')),
      { HEAD_SHA: SHA },
      (root) => {
        if (driver !== null) writeExecutable(join(root, 'bin/driver'), driver);
      },
    );
  }

  test('passes the head SHA as the only argument and no token in the environment, and reports rc and cases', () => {
    const done = qaRun(
      `#!/usr/bin/env bash\necho "args=$*" >&2\necho "token=\${GH_TOKEN:-none}" >&2\necho "STAGE_QA_RESULT status=passed sha=$1 cases=7 failed=0"\n`,
    );
    expect(done.status).toBe(0);
    expect(done.stdout).toContain(`STAGE_QA_RESULT status=passed sha=${SHA} cases=7 failed=0`);
    expect(done.stdout).toContain(`args=${SHA}`);
    expect(done.stdout).toContain('token=none');
    expect(done.output).toBe('rc=0\ncases=7\n');
  });

  test.each([
    1, 2, 3, 75, 76, 77,
  ])('the driver exit code %i is data: the step exits with it after recording it', (code) => {
    const done = qaRun(
      `#!/usr/bin/env bash\necho "STAGE_QA_RESULT status=x sha=$1 cases=0 failed=0"\nexit ${code}\n`,
    );
    expect(done.status).toBe(code);
    expect(done.output).toBe(`rc=${code}\ncases=0\n`);
  });

  test('a driver that printed no result line did not run: rc 70, whatever its exit code was', () => {
    const done = qaRun('#!/usr/bin/env bash\necho "crashed at start"\nexit 0\n');
    expect(done.status).toBe(70);
    expect(done.output).toBe('rc=70\ncases=0\n');
  });

  test('a driver that is not installed is rc 70 as well', () => {
    const done = qaRun(null);
    expect(done.status).toBe(70);
    expect(done.output).toBe('rc=70\ncases=0\n');
  });
});

describe('the report step', () => {
  const reportScript = script(stageQa, 'report');

  function report(env: Record<string, string>): { posts: string[][]; shell: Shell } {
    const shell = runScript(
      reportScript,
      {
        GH_TOKEN: 'unused',
        REPO: SLUG,
        HEAD_SHA: SHA,
        RUN_ID: '4242',
        RUN_URL: `https://github.com/${SLUG}/actions/runs/4242`,
        BOT_CONCLUSION: 'success',
        BOT_RUN_ID: '4200',
        BOT_RUN_URL: `https://github.com/${SLUG}/actions/runs/4200`,
        QA_RESULT: 'success',
        QA_RC: '0',
        QA_CASES: '7',
        ...env,
      },
      (root) => {
        // One line per gh call, arguments separated by a unit separator so spaces in values survive.
        writeExecutable(
          join(root, 'bin/gh'),
          `#!/usr/bin/env bash\nprintf '%s\\x1f' "$@" >> "${root}/gh.log"\necho >> "${root}/gh.log"\n`,
        );
      },
    );
    const log = join(shell.root, 'gh.log');
    const posts = existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('\x1f').slice(0, -1))
      : [];
    return { posts, shell };
  }

  function posted(args: string[] | undefined): {
    state: string;
    description: string;
    target: string;
  } {
    const get = (flag: string): string => {
      const value = args?.[(args?.indexOf(flag) ?? -2) + 1];
      if (value === undefined) throw new Error(`no ${flag} in ${JSON.stringify(args)}`);
      return value;
    };
    expect(args?.slice(0, 4)).toEqual(['api', '--method', 'POST', `repos/${SLUG}/statuses/${SHA}`]);
    expect(args?.[args.indexOf('-f') + 1]).toMatch(/^state=/);
    expect(args).toContain('context=stage-qa');
    return {
      state: get('-f').replace('state=', ''),
      description: args?.find((a) => a.startsWith('description=')) ?? '',
      target: args?.find((a) => a.startsWith('target_url=')) ?? '',
    };
  }

  test('a passed run posts success with the case count and the QA run id, linked to the QA run', () => {
    const { posts } = report({});
    expect(posts.length).toBe(1);
    expect(posted(posts[0])).toEqual({
      state: 'success',
      description: 'description=passed cases=7 run=4242',
      target: `target_url=https://github.com/${SLUG}/actions/runs/4242`,
    });
  });

  test.each([
    ['0', '0'],
    ['0', ''],
    ['0', 'seven'],
    ['0', '07'],
  ])('a pass that ran %p cases (%p) is an error, never a success', (_unused, cases) => {
    const { posts } = report({ QA_CASES: cases });
    expect(posts.length).toBe(1);
    const status = posted(posts[0]);
    expect(status.state).toBe('error');
    expect(status.description).toBe('description=could not run: no smoke case ran run=4242');
  });

  test.each([
    ['1', 'failure', 'failed run=4242'],
    ['2', 'error', 'could not run: refused run=4242'],
    ['3', 'error', 'could not run: not provisioned run=4242'],
    ['70', 'error', 'could not run: no result from the driver run=4242'],
    ['75', 'error', 'could not run: lock wait timed out run=4242'],
    ['77', 'error', 'could not run: stage slot never ran this commit, re-run Stage Bot run=4242'],
  ])('a driver exit code %s posts %s', (rc, state, description) => {
    const { posts } = report({ QA_RESULT: 'failure', QA_RC: rc });
    expect(posts.length).toBe(1);
    expect(posted(posts[0])).toMatchObject({ state, description: `description=${description}` });
  });

  test('the descriptions fit GitHub 140 character limit', () => {
    const { posts } = report({ QA_RESULT: 'failure', QA_RC: '77', RUN_ID: '99999999999' });
    expect(posted(posts[0]).description.length - 'description='.length).toBeLessThanOrEqual(140);
  });

  test.each([
    ['superseded', 'failure', '76'],
    ['cancelled', 'cancelled', ''],
    ['skipped qa', 'skipped', ''],
    ['a signal exit', 'failure', '143'],
  ])('%s posts nothing: another run carries the verdict', (_name, result, rc) => {
    const { posts, shell } = report({ QA_RESULT: result, QA_RC: rc });
    expect(posts).toEqual([]);
    expect(shell.status).toBe(0);
  });

  test('a failed Stage Bot workflow posts failure linked to that run, without waiting for the QA', () => {
    const { posts } = report({ BOT_CONCLUSION: 'failure', QA_RESULT: 'skipped', QA_RC: '' });
    expect(posts.length).toBe(1);
    expect(posted(posts[0])).toEqual({
      state: 'failure',
      description: 'description=stage bot workflow failed run=4200',
      target: `target_url=https://github.com/${SLUG}/actions/runs/4200`,
    });
  });

  test.each([
    'cancelled',
    'skipped',
    'neutral',
  ])('a Stage Bot workflow that ended %s posts nothing', (conclusion) => {
    const { posts } = report({ BOT_CONCLUSION: conclusion, QA_RESULT: 'skipped', QA_RC: '' });
    expect(posts).toEqual([]);
  });

  test.each(['main', 'abc123', SHA.toUpperCase(), `${SHA}0`, ''])('refuses the head %p', (head) => {
    const { posts, shell } = report({ HEAD_SHA: head });
    expect(shell.status).not.toBe(0);
    expect(posts).toEqual([]);
    expect(shell.stderr).toContain('not a full commit SHA');
  });

  test('a success needs rc 0 together with a successful qa job: a mismatched pair posts nothing', () => {
    expect(report({ QA_RESULT: 'success', QA_RC: '1' }).posts).toEqual([]);
    expect(report({ QA_RESULT: 'failure', QA_RC: '0' }).posts).toEqual([]);
  });
});
