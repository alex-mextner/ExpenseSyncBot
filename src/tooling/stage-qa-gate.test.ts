// scripts/stage-qa-gate.py is what `gh ship` asks before it merges: Stage QA must be green for the exact PR
// head AND the status must be bound to a successful run of the trusted `Stage QA` workflow_run (a commit
// status alone can be posted by anyone with write access). This file pins the status and run rules and the
// delegator .claude/scripts/pr-ship.sh; stage-qa-gate-binding.test.ts pins how the tested head and the
// verdict are bound to the run through the runner's job logs. The real gate runs against a stand-in `gh`
// (src/test-utils/stage-qa-gate-fixtures.ts); the real pr-ship.sh runs with a stand-in shared ship to prove
// the gate runs first, from origin/main's copy, and stops the ship.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, type TempRoot, tempRoot, writeExecutable } from '../test-utils/stage-qa-fixtures';
import {
  CASES,
  type Gate,
  gateSession,
  goodJob,
  goodRoutes,
  goodRun,
  goodStatus,
  HEAD,
  JOBS_KEY,
  OLD,
  PR_KEY,
  prBody,
  REPO_KEY,
  type Routes,
  RUN,
  RUN_KEY,
  reportJob,
  SLUG,
  statusesKey,
  WF_KEY,
} from '../test-utils/stage-qa-gate-fixtures';

setDefaultTimeout(60_000);

const PR_SHIP = join(REPO, '.claude/scripts/pr-ship.sh');

// Only the ship tests below keep a temp root of their own; the gate tests use the session's.
let temp: TempRoot | null = null;

afterEach(() => {
  temp?.cleanup();
  temp = null;
});

const session = gateSession();

function expectNotGreen(routes: Routes, ...words: string[]): Gate {
  const gate = session.create();
  const done = gate.run(routes);
  expect(done.status).toBe(1);
  for (const word of words) expect(done.stderr).toContain(word);
  return gate;
}

describe('the gate', () => {
  test('is green for a success posted by the Actions bot, bound to a successful workflow_run of the trusted QA workflow', () => {
    const gate = session.create();
    const done = gate.run(goodRoutes());
    expect(done.status).toBe(0);
    expect(done.stdout).toBe(
      `stage-qa gate: green for ${HEAD.slice(0, 12)} cases=${CASES} run=${RUN}\n`,
    );
    expect(done.stderr).toBe('');
  });

  test('no stage-qa status: says to wait for Stage QA or re-run Stage Bot', () => {
    const routes = goodRoutes();
    routes[statusesKey()] = { body: [{ context: 'typecheck', state: 'success' }] };
    expectNotGreen(routes, 'No `stage-qa` status', 'Stage Bot', 're-run');
  });

  test('pending: says to wait and shows the run', () => {
    const routes = goodRoutes();
    routes[statusesKey()] = {
      body: [goodStatus({ state: 'pending', description: 'waiting', target_url: 'https://x/y' })],
    };
    expectNotGreen(routes, 'pending', 'wait', 'https://x/y');
  });

  test('failure: says to fix and push', () => {
    const routes = goodRoutes();
    routes[statusesKey()] = {
      body: [goodStatus({ state: 'failure', description: `failed run=${RUN}` })],
    };
    expectNotGreen(routes, 'failure', 'push a new commit');
  });

  test('error: says the QA could not run and to re-run Stage Bot, with the reason', () => {
    const routes = goodRoutes();
    routes[statusesKey()] = {
      body: [
        goodStatus({
          state: 'error',
          description: 'could not run: the stage slot never ran the commit',
        }),
      ],
    };
    expectNotGreen(
      routes,
      'could not run on head',
      'the stage slot never ran',
      'Re-run the `Stage Bot` workflow',
    );
  });

  test('a success on an older head says nothing about this head', () => {
    const routes = goodRoutes();
    routes[statusesKey()] = { body: [] };
    routes[statusesKey(1, OLD)] = { body: [goodStatus()] };
    expectNotGreen(routes, 'head');
  });

  test('the newest stage-qa status wins over an older success', () => {
    const routes = goodRoutes();
    routes[statusesKey()] = {
      body: [goodStatus({ state: 'failure', description: `failed run=${RUN}` }), goodStatus()],
    };
    expectNotGreen(routes, 'failure');
  });

  test.each([
    'passed cases=0 run=4242',
    'passed cases=3 run=4242 extra',
    'ok',
    'passed cases=3 run=0',
    'passed cases=3 run=4242\nforged',
  ])('the description %p is not a QA result', (description) => {
    const routes = goodRoutes();
    routes[statusesKey()] = { body: [goodStatus({ description })] };
    expectNotGreen(routes, 'description');
  });

  test('a status posted by a person is not trusted', () => {
    const routes = goodRoutes();
    routes[statusesKey()] = { body: [goodStatus({ creator: { login: 'alex-mextner' } })] };
    expectNotGreen(routes, 'not trusted');
  });

  test.each([
    `https://github.com/evil/fork/actions/runs/${RUN}`,
    `https://github.com/${SLUG}/actions/runs/999`,
    `https://github.com/${SLUG}/pull/7`,
    null,
  ])('a target_url of %p is not the QA run', (url) => {
    const routes = goodRoutes();
    routes[statusesKey()] = { body: [goodStatus({ target_url: url })] };
    expectNotGreen(routes, 'target_url');
  });

  test('the run reports the default branch commit as its head_sha: that is not what binds the tested head', () => {
    const run = goodRun();
    expect(run['head_sha']).not.toBe(HEAD);
    expect(session.create().run(goodRoutes()).status).toBe(0);
  });

  test.each([
    ['event', { event: 'pull_request' }],
    ['path', { path: '.github/workflows/other.yml' }],
    ['head branch', { head_branch: 'feature' }],
    ['head branch missing', { head_branch: null }],
    ['head branch case', { head_branch: 'Main' }],
    ['id', { id: RUN + 1 }],
    ['not completed', { status: 'in_progress', conclusion: null }],
    ['conclusion', { conclusion: 'failure' }],
    ['repository', { repository: { full_name: 'evil/fork' } }],
    ['head repository', { head_repository: { full_name: 'evil/fork' } }],
  ])('a run whose %s is wrong is not a trusted QA run', (_name, over) => {
    const routes = goodRoutes();
    routes[RUN_KEY] = { body: goodRun(over) };
    expectNotGreen(routes, 'not a trusted QA run');
  });

  test('a default branch that is not the one of the run is refused', () => {
    const routes = goodRoutes();
    routes[REPO_KEY] = { body: { default_branch: 'trunk' } };
    expectNotGreen(routes, "default branch 'trunk'");
  });

  test.each([
    ['no jobs', []],
    ['only the report job', [reportJob()]],
    ['the QA job failed', [goodJob({ conclusion: 'failure' }), reportJob()]],
    ['the QA job is running', [goodJob({ status: 'in_progress', conclusion: null }), reportJob()]],
    ['two QA jobs', [goodJob(), goodJob({ id: 9005 }), reportJob()]],
  ])('%s: the successful `Stage QA run` job is required', (_name, jobs) => {
    const routes = goodRoutes();
    routes[JOBS_KEY] = { body: { jobs } };
    expectNotGreen(routes, 'Stage QA run');
  });

  test.each([
    [{ isDraft: true }, 'draft'],
    [{ state: 'CLOSED' }, 'not open'],
    [{ state: 'MERGED' }, 'not open'],
    [{ isCrossRepository: true }, 'fork'],
  ])('the PR state %p is refused (%s)', (over, word) => {
    const routes = goodRoutes();
    routes[PR_KEY] = { body: prBody(over) };
    expectNotGreen(routes, word);
  });

  test('is inactive, and says so, while stage-qa.yml is not on the default branch (bootstrap)', () => {
    const done = session.create().run({ [WF_KEY]: { error: 'gh: Not Found (HTTP 404)' } });
    expect(done.status).toBe(0);
    expect(done.stdout).toContain('stage-qa gate inactive');
    expect(done.stdout).toContain('NOT enforced');
  });

  test.each([
    'gh: rate limit, installation 40412 throttled',
    'gh: Server Error (HTTP 5040)',
    'gh: remaining: 404 requests',
  ])('an error that merely contains 404 (%p) is not a bootstrap pass', (message) => {
    const done = session.create().run({ [WF_KEY]: { error: message } });
    expect(done.status).toBe(2);
    expect(done.stdout).not.toContain('gate inactive');
  });

  test.each([
    ['workflow check', { [WF_KEY]: { error: 'gh: Server Error (HTTP 500)' } }],
    ['pr view', { ...goodRoutes(), [PR_KEY]: { error: 'boom' } }],
    ['statuses', { ...goodRoutes(), [statusesKey()]: { error: 'boom' } }],
    ['run', { ...goodRoutes(), [RUN_KEY]: { error: 'boom' } }],
    ['jobs', { ...goodRoutes(), [JOBS_KEY]: { error: 'boom' } }],
    ['default branch', { ...goodRoutes(), [REPO_KEY]: { error: 'boom' } }],
    ['default branch missing', { ...goodRoutes(), [REPO_KEY]: { body: {} } }],
    ['missing route', { [WF_KEY]: { body: {} } }],
  ])('a gh failure at %s is exit 2, never a silent pass', (_name, routes) => {
    const done = session.create().run(routes);
    expect(done.status).toBe(2);
    expect(done.stdout).not.toContain('green');
    expect(done.stderr).toContain('refusing to ship blind');
  });

  test('a missing gh is exit 2', () => {
    const done = session.create().run(goodRoutes(), { path: '/nonexistent' });
    expect(done.status).toBe(2);
  });

  test('reads the second page of statuses when the first holds no stage-qa entry', () => {
    const routes = goodRoutes();
    routes[statusesKey(1)] = {
      body: Array.from({ length: 100 }, () => ({ context: 'ci', state: 'success' })),
    };
    routes[statusesKey(2)] = { body: [goodStatus()] };
    const gate = session.create();
    const done = gate.run(routes);
    expect(done.status).toBe(0);
    expect(gate.fetched().join('\n')).toContain('page=2');
  });
});

describe('.claude/scripts/pr-ship.sh', () => {
  interface Ship {
    repo: string;
    log: string;
    setGate: (code: number) => void;
    run: (...args: string[]) => { status: number | null; stderr: string };
    calls: () => string[];
    tmpEntries: () => string[];
    commitFileOnMain: (path: string, body: string) => void;
    dropOriginMain: () => void;
  }

  function git(cwd: string, ...args: string[]): void {
    const done = spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8' },
    );
    if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
  }

  function createShip(): Ship {
    temp = tempRoot('stage-qa-ship-');
    const root = temp.dir;
    const repo = join(root, 'repo');
    const log = join(root, 'calls.log');
    mkdirSync(join(repo, '.claude/scripts'), { recursive: true });
    mkdirSync(join(repo, 'scripts'));
    mkdirSync(join(root, 'tmp'));
    copyFileSync(PR_SHIP, join(repo, '.claude/scripts/pr-ship.sh'));
    spawnSync('git', ['init', '-q', repo]);
    writeExecutable(
      join(root, 'tools/ci/ship/ship.sh'),
      `#!/usr/bin/env bash\necho "ship $*" >> "${log}"\n`,
    );
    writeExecutable(
      join(root, 'bin/gh'),
      `#!/usr/bin/env bash\nif [[ "$1 $2" == "repo view" ]]; then echo ${SLUG}; exit 0; fi\nexit 1\n`,
    );
    const ship: Ship = {
      repo,
      log,
      // The gate that ships is origin/main's copy: commit it and point refs/remotes/origin/main at it.
      commitFileOnMain: (path, body) => {
        writeExecutable(join(repo, path), body);
        git(repo, 'add', path);
        git(repo, 'commit', '-qm', 'gate');
        git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      },
      // Records cwd and args so the test can assert where and how the gate ran.
      setGate: (code) =>
        ship.commitFileOnMain(
          'scripts/stage-qa-gate.py',
          `import os, sys\nopen("${log}", "a").write("gate cwd=" + os.getcwd() + " " + " ".join(sys.argv[1:]) + "\\n")\n` +
            `sys.stderr.write("gate says no\\n") if ${code} else None\nsys.exit(${code})\n`,
        ),
      run: (...args) => {
        const done = spawnSync('bash', [join(repo, '.claude/scripts/pr-ship.sh'), ...args], {
          cwd: repo,
          encoding: 'utf8',
          env: {
            PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}`,
            HOME: root,
            XDG_CONFIG_HOME: join(root, 'cfg'),
            TMPDIR: join(root, 'tmp'),
            AGENT_TOOLS_ROOT: join(root, 'tools'),
          },
        });
        return { status: done.status, stderr: done.stderr };
      },
      tmpEntries: () => readdirSync(join(root, 'tmp')),
      calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
      dropOriginMain: () => {
        git(repo, 'update-ref', '-d', 'refs/remotes/origin/main');
      },
    };
    ship.setGate(0);
    return ship;
  }

  test('runs the gate first, in the checkout root with the repository and PR, then the shared ship with the same arguments', () => {
    const ship = createShip();
    ship.run('7', '--squash');
    const calls = ship.calls();
    expect(calls.length).toBe(2);
    expect(calls[0]?.startsWith('gate cwd=')).toBe(true);
    expect(calls[0]).toContain(`--repo ${SLUG} --pr 7`);
    expect(calls[1]).toBe('ship 7 --squash');
  });

  test('a failing gate stops the ship and shows the gate message', () => {
    const ship = createShip();
    ship.setGate(1);
    const done = ship.run('7');
    expect(done.status).not.toBe(0);
    expect(done.stderr).toContain('gate says no');
    expect(ship.calls().filter((c) => c.startsWith('ship'))).toEqual([]);
  });

  test('the exit code of the gate is the exit code of the ship command', () => {
    const ship = createShip();
    ship.setGate(2);
    expect(ship.run('7').status).toBe(2);
  });

  test('a dry run skips the gate', () => {
    const ship = createShip();
    ship.setGate(1);
    const done = ship.run('7', '--dry-run');
    expect(done.status).toBe(0);
    expect(ship.calls()).toEqual(['ship 7 --dry-run']);
  });

  test('a PR that edits its own gate cannot wave itself through: origin/main decides', () => {
    const ship = createShip();
    ship.setGate(1);
    writeExecutable(join(ship.repo, 'scripts/stage-qa-gate.py'), 'import sys\nsys.exit(0)\n');
    const done = ship.run('7');
    expect(done.status).not.toBe(0);
    expect(done.stderr).toContain('gate says no');
    expect(ship.calls().filter((c) => c.startsWith('ship'))).toEqual([]);
  });

  test('while origin/main has no gate yet it says Stage QA is not enforced, then ships', () => {
    const ship = createShip();
    ship.dropOriginMain();
    const done = ship.run('7');
    expect(done.stderr).toContain('stage-qa-gate.py is not on origin/main');
    expect(done.stderr).toContain('NOT enforced');
    expect(ship.calls()).toEqual(['ship 7']);
  });

  test('a repository override that is not this repository is refused before the gate', () => {
    const ship = createShip();
    const done = ship.run('7', '--repo', 'someone/else');
    expect(done.status).toBe(2);
    expect(ship.calls()).toEqual([]);
    expect(ship.run('7', '--repo=someone/else').status).toBe(2);
    expect(ship.run('7', '--repo', SLUG).status).toBe(0);
  });

  test('a call without a PR number goes straight to the shared ship', () => {
    const ship = createShip();
    ship.setGate(1);
    expect(ship.run('--help').status).toBe(0);
    expect(ship.calls()).toEqual(['ship --help']);
  });

  test('leaves no temporary gate copy behind', () => {
    const ship = createShip();
    ship.run('7');
    ship.setGate(1);
    ship.run('7');
    expect(ship.tmpEntries()).toEqual([]);
  });
});
