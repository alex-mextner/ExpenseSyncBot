// How scripts/stage-qa-gate.py binds a `stage-qa` status to the commit that was tested. Stage QA is a
// `workflow_run` workflow: GitHub always runs the copy on the default branch and the REST run object reports
// the default branch commit as its head_sha, so the run cannot say which PR head was tested. Two things bind
// it, both read from the job logs of the run (the runner writes the step header, with the env block of the
// step, before the trusted shell executes anything, and a pull request cannot write it):
//   - the QA job's first trusted step header carries the one HEAD_SHA the workflow injected;
//   - the report job's first trusted step header carries the inputs of the verdict, which must say "this
//     run passed this head with exactly the case count the status reports";
// and the status must have been created while the run's own report job executed. Every log in these tests
// is synthetic (src/test-utils/stage-qa-gate-fixtures.ts); the gate runs against a stand-in `gh`.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, tempRoot, writeExecutable } from '../test-utils/stage-qa-fixtures';
import {
  CASES,
  DRIVER_LINES,
  GATE,
  type Gate,
  type GateRun,
  GOOD_REPORT_ENV,
  gateSession,
  goodJob,
  goodRoutes,
  goodRun,
  goodStatus,
  goodSteps,
  HEAD,
  headerLines,
  JOB,
  JOBS_KEY,
  LOG_KEY,
  MAIN,
  OLD,
  PR_KEY,
  PYTHON,
  QA_STEP,
  qaLog,
  REPORT_JOB,
  REPORT_LOG_KEY,
  REPORT_STEP,
  type Route,
  type Routes,
  RUN,
  RUN_KEY,
  reportJob,
  reportLog,
  SCRIPT_LINES,
  SETUP_LINES,
  SLUG,
  stamped,
  statusesKey,
  VERDICT_INPUTS,
} from '../test-utils/stage-qa-gate-fixtures';

setDefaultTimeout(60_000);

const session = gateSession();

function withLog(route: Route): Routes {
  return { ...goodRoutes(), [LOG_KEY]: route };
}

function logOf(text: string): Routes {
  return withLog({ text });
}

function withJobs(jobs: unknown[]): Routes {
  return { ...goodRoutes(), [JOBS_KEY]: { body: { jobs } } };
}

interface Finished {
  gate: Gate;
  done: GateRun;
}

function notGreen(routes: Routes, ...words: string[]): Finished {
  const gate = session.create();
  const done = gate.run(routes);
  expect(done.status).toBe(1);
  for (const word of words) expect(done.stderr).toContain(word);
  return { gate, done };
}

function cannotEvaluate(routes: Routes, ...words: string[]): Finished {
  const gate = session.create();
  const done = gate.run(routes);
  expect(done.status).toBe(2);
  expect(done.stdout).not.toContain('green');
  for (const word of words) expect(done.stderr).toContain(word);
  return { gate, done };
}

function green(routes: Routes): Finished {
  const gate = session.create();
  const done = gate.run(routes);
  expect(done.stderr).toBe('');
  expect(done.status).toBe(0);
  return { gate, done };
}

function fetchCount(gate: Gate, key: string): number {
  return gate.fetched().filter((call) => call === key).length;
}

describe('the tested head is bound through the runner step header in the QA job log', () => {
  test('green reads the log of the QA job and of the report job once each', () => {
    const { gate, done } = green(goodRoutes());
    expect(done.stdout).toBe(
      `stage-qa gate: green for ${HEAD.slice(0, 12)} cases=${CASES} run=${RUN}\n`,
    );
    expect(fetchCount(gate, LOG_KEY)).toBe(1);
    expect(fetchCount(gate, REPORT_LOG_KEY)).toBe(1);
  });

  test.each([
    ['LF with BOM', '\n', true],
    ['LF without BOM', '\n', false],
    ['CRLF with BOM', '\r\n', true],
    ['CRLF without BOM', '\r\n', false],
  ])('line endings and a BOM do not matter (%s)', (_name, newline, bom) => {
    green(logOf(qaLog({ newline, bom })));
  });

  test.each([OLD, MAIN])('a log of another commit (%p) is refused without echoing it', (sha) => {
    const { done } = notGreen(
      logOf(qaLog({ sha })),
      'tested',
      sha.slice(0, 12),
      `not the PR head ${HEAD.slice(0, 12)}`,
    );
    expect(done.stderr).not.toContain(sha);
  });

  test.each([
    ['upper case', HEAD.toUpperCase()],
    ['39 characters', HEAD.slice(0, 39)],
    ['41 characters', `${HEAD}a`],
    ['a branch name', 'main'],
    ['empty', ''],
    ['trailing space', `${HEAD} `],
    ['trailing comment', `${HEAD} # x`],
    ['0x prefix', `0x${HEAD.slice(2)}`],
  ])('a HEAD_SHA that is not a full lowercase SHA is refused (%s)', (_name, value) => {
    const header = headerLines({ env: [`  HEAD_SHA: ${value}`] });
    notGreen(logOf(qaLog({ header })), 'HEAD_SHA');
  });

  test.each([
    ['three spaces', `   HEAD_SHA: ${HEAD}`],
    ['one space', ` HEAD_SHA: ${HEAD}`],
    ['no space after the colon', `  HEAD_SHA:${HEAD}`],
    ['lower case name', `  head_sha: ${HEAD}`],
  ])('a HEAD_SHA line that is not exactly the runner env line is refused (%s)', (_name, line) => {
    notGreen(logOf(qaLog({ header: headerLines({ env: [line] }) })), 'HEAD_SHA');
  });

  test.each([
    ['declared twice', [`  HEAD_SHA: ${HEAD}`, `  HEAD_SHA: ${HEAD}`]],
    ['wrong then right', [`  HEAD_SHA: ${OLD}`, `  HEAD_SHA: ${HEAD}`]],
    ['right then wrong', [`  HEAD_SHA: ${HEAD}`, `  HEAD_SHA: ${OLD}`]],
    ['not declared', ['  CI: true']],
  ])('a HEAD_SHA declared other than exactly once is refused (%s)', (_name, env) => {
    notGreen(logOf(qaLog({ header: headerLines({ env }) })), 'HEAD_SHA');
  });

  test('a HEAD_SHA line printed by the script instead of the env block does not count', () => {
    const printedByTheScript = headerLines({ script: [...SCRIPT_LINES, `HEAD_SHA: ${HEAD}`] });
    notGreen(logOf(qaLog({ header: printedByTheScript })), 'HEAD_SHA');
    const onlyInTheScript = headerLines({ script: [`HEAD_SHA: ${HEAD}`], env: ['  CI: true'] });
    notGreen(logOf(qaLog({ header: onlyInTheScript })), 'HEAD_SHA');
  });

  test.each([
    ['no shell line', headerLines({ shell: null })],
    ['no env block', headerLines({ envOpen: null })],
    [
      'shell and env swapped',
      [
        '##[group]Run # synthetic first line',
        ...SCRIPT_LINES,
        'env:',
        'shell: /usr/bin/bash -e {0}',
        `  HEAD_SHA: ${HEAD}`,
        '##[endgroup]',
      ],
    ],
  ])('a step header without the shell line followed by the env block is refused (%s)', (_name, header) => {
    notGreen(logOf(qaLog({ header })), 'env block');
  });

  test.each([
    ['setup only', stamped(SETUP_LINES)],
    [
      'the group is not at the line start',
      stamped([...SETUP_LINES, `x${headerLines()[0]}`, ...headerLines().slice(1)]),
    ],
    [
      'the group has another name',
      stamped([
        ...SETUP_LINES,
        ...headerLines().map((line) => line.replace('##[group]Run ', '##[group]Post ')),
      ]),
    ],
  ])('a log without a step header is refused (%s)', (_name, text) => {
    notGreen(logOf(text), 'no step header');
  });

  describe('a header printed later by the driver neither helps nor hurts', () => {
    function variants(sha: string): Array<[string, Parameters<typeof qaLog>[0]]> {
      const plain = headerLines({ sha });
      return [
        ['stamped', { driver: [...DRIVER_LINES, ...plain] }],
        [
          'ansi coloured',
          { driver: [...DRIVER_LINES, ...plain.map((line) => `\x1b[36;1m${line}\x1b[0m`)] },
        ],
        ['glued to an endgroup', { driver: [...DRIVER_LINES, '##[endgroup]', ...plain] }],
        ['unstamped', { rawTail: `${plain.join('\n')}\n` }],
        ['with BOM and CR', { rawTail: `\ufeff${plain.join('\r\n')}\r\n` }],
      ];
    }

    test.each(
      variants(HEAD),
    )('a forged right sha after the real wrong header: %s', (_name, extra) => {
      notGreen(logOf(qaLog({ sha: OLD, ...extra })), 'tested', OLD.slice(0, 12));
    });

    test.each(variants(OLD))('a forged wrong sha after the real header: %s', (_name, extra) => {
      green(logOf(qaLog({ sha: HEAD, ...extra })));
    });
  });

  test('only the first header group of the log counts', () => {
    // A second header placed before the real one would be taken for the real one: only the runner (the setup
    // step) could put it there, never the driver, which runs after the real header.
    const early = [...SETUP_LINES, ...headerLines({ sha: OLD }), ...headerLines({ sha: HEAD })];
    notGreen(logOf(stamped([...early, ...DRIVER_LINES])), 'tested', OLD.slice(0, 12));
  });

  test.each([
    ['step 2 renamed', goodSteps('Run something else')],
    ['step 2 numbered 3', goodSteps(QA_STEP, { number: 3 })],
    ['step 2 failed', goodSteps(QA_STEP, { conclusion: 'failure' })],
    ['step 2 skipped', goodSteps(QA_STEP, { conclusion: 'skipped' })],
    ['step 2 running', goodSteps(QA_STEP, { status: 'in_progress', conclusion: null })],
    ['step 1 is not the setup', [{ number: 1, name: QA_STEP }, ...goodSteps().slice(1)]],
    ['only the setup', goodSteps().slice(0, 1)],
    ['no steps', []],
    ['steps that are not a list', 'steps'],
    ['steps that are not objects', ['Set up job', QA_STEP]],
  ])('the steps of the QA job must be the exact trusted ones (%s): no log is read', (_name, steps) => {
    const { gate } = notGreen(withJobs([goodJob({ steps }), reportJob()]), 'Stage QA run');
    expect(fetchCount(gate, LOG_KEY)).toBe(0);
  });

  test.each([
    ['another run', goodJob({ run_id: RUN + 1 })],
    ['another attempt', goodJob({ run_attempt: 2 })],
    ['a string id', goodJob({ id: String(JOB) })],
    ['a boolean id', goodJob({ id: true })],
    ['no id', Object.fromEntries(Object.entries(goodJob()).filter(([key]) => key !== 'id'))],
  ])('a QA job of %s is refused', (_name, job) => {
    notGreen(withJobs([job, reportJob()]), 'Stage QA run');
  });

  test('the log of another job cannot stand in for the QA job', () => {
    const wrongQaLog: Routes = {
      ...logOf(qaLog({ sha: OLD })),
      [REPORT_LOG_KEY]: { text: qaLog() },
    };
    const first = notGreen(wrongQaLog, 'tested', OLD.slice(0, 12));
    expect(fetchCount(first.gate, REPORT_LOG_KEY)).toBe(0);
    const noQaJob: Routes = { ...withJobs([reportJob()]), [REPORT_LOG_KEY]: { text: qaLog() } };
    const second = notGreen(noQaJob, 'Stage QA run');
    expect(fetchCount(second.gate, REPORT_LOG_KEY)).toBe(0);
  });

  test.each([
    'HTTP 403',
    'HTTP 404',
    'HTTP 410',
    'HTTP 500',
  ])('a log read that fails with %s is exit 2 and leaks nothing', (status) => {
    const detail = 'LEAKED-DETAIL https://signed.example/blob?x=LEAKED-DETAIL';
    const { done } = cannotEvaluate(
      withLog({ error: `gh: failed (${status}) ${detail}`, stdout: `{"message": "${detail}"}` }),
      status,
      `job ${JOB}`,
    );
    expect(done.stdout + done.stderr).not.toContain('LEAKED');
  });

  test('a gh that fails without an HTTP status is exit 2 and leaks nothing', () => {
    const { done } = cannotEvaluate(
      withLog({ error: 'gh: unknown flag LEAKED-DETAIL' }),
      'gh exit 1',
    );
    expect(done.stdout + done.stderr).not.toContain('LEAKED');
  });

  test.each([
    ['empty', { text: '' }],
    ['blank lines', { text: '\n\n\n' }],
    ['plain text', { text: 'this is not a runner log\nat all\n' }],
    [
      'binary',
      {
        b64: Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256)).toString(
          'base64',
        ),
      },
    ],
    [
      'a setup then a line without a timestamp',
      { text: `${stamped(SETUP_LINES)}no timestamp here\n${stamped(headerLines())}` },
    ],
    ['a fraction too short', { text: '2026-10-27T08:23:24.761Z ##[group]Run x\n' }],
    [
      'a header that is never closed',
      { text: stamped([...SETUP_LINES, ...headerLines().slice(0, -1)]) },
    ],
    [
      'a cut inside the header',
      { text: stamped([...SETUP_LINES, ...headerLines().slice(0, 3)]).slice(0, -5) },
    ],
  ])('an empty, garbage or truncated log fails closed (%s)', (_name, route) => {
    cannotEvaluate(withLog(route));
  });

  test('a huge driver output after the header is not read', () => {
    green(withLog({ text: qaLog(), pad: 8 * 1024 * 1024 }));
  });

  test('a header beyond the head of the log cannot be evaluated', () => {
    const padding = Array.from({ length: 9000 }, () => 'setup output that goes on and on and on');
    const { done } = cannotEvaluate(
      logOf(stamped([...SETUP_LINES, ...padding, ...headerLines()])),
      'no complete step header',
    );
    expect(done.stderr).toContain('256 KiB');
  });

  test('bytes that are not UTF-8 after the header are ignored', () => {
    const raw = Buffer.concat([
      Buffer.from(qaLog()),
      Buffer.from('2026-10-27T09:00:00.0000000Z \xff\xfe\x80 driver bytes\n', 'latin1'),
    ]);
    green(withLog({ b64: raw.toString('base64') }));
  });

  test('error texts never echo a log line', () => {
    const marker = 'ATTACKER-LINE-TOKEN';
    const driver = [...DRIVER_LINES, `${marker} https://signed.example/?x=${marker}`];
    const badHeaders = [
      headerLines({ sha: OLD, script: [...SCRIPT_LINES, marker] }),
      headerLines({ env: [`  HEAD_SHA: ${HEAD} ${marker}`] }),
      headerLines({ env: [`  HEAD_SHA: ${HEAD}`, `  HEAD_SHA: ${marker}`] }),
      headerLines({ script: [marker], envOpen: null }),
    ];
    for (const header of badHeaders) {
      const { done } = notGreen(logOf(qaLog({ header, driver })));
      expect(done.stdout + done.stderr).not.toContain(marker);
    }
    for (const line of [`${marker} not a timestamp`, `2026-10-27T08:23:24.0000000Z ${marker}`]) {
      const text = `${stamped(SETUP_LINES)}${line}\n${stamped(headerLines())}`;
      const done = session.create().run(logOf(text));
      expect(done.stdout + done.stderr).not.toContain(marker);
    }
  });

  test.each([
    ['the head moved', { headRefOid: OLD }, 'moved'],
    ['the PR was closed', { state: 'CLOSED' }, 'not open'],
  ])('the PR changing while the gate reads is refused (%s)', (_name, second, word) => {
    const routes = goodRoutes();
    const first = routes[PR_KEY];
    if (first === undefined) throw new Error('no pr route in the fixture');
    const later = {
      body: {
        state: 'OPEN',
        isDraft: false,
        headRefOid: HEAD,
        isCrossRepository: false,
        ...second,
      },
    };
    routes[PR_KEY] = { bodies: [first, later] };
    notGreen(routes, word);
  });

  test('the local receipt of the browser host is not evidence', () => {
    const gate = session.create();
    const done = gate.run(logOf(qaLog({ sha: OLD })), { env: { HOME: gate.dir } });
    expect(done.status).toBe(1);
  });
});

describe('the status is only the verdict of the workflow when the report step header says so', () => {
  // A forged status can land inside the report job's time window, so the window proves nothing; the
  // runner-written header of `Post the stage-qa status` carries what the trusted workflow decided.
  function withReport(over: Record<string, string | string[] | null>): Routes {
    return { ...goodRoutes(), [REPORT_LOG_KEY]: { text: reportLog(over) } };
  }

  test('a forged success inside the report window fails when the workflow ran no case', () => {
    // The QA driver exited 0 with zero cases: the report step posted `error`, a forger posted `success`.
    notGreen(withReport({ QA_CASES: '0' }), 'did not report a pass', 'QA_CASES');
  });

  test.each([
    '6',
    '8',
    '007',
    '',
  ])('a status whose case count differs from the workflow count (%p) fails', (cases) => {
    notGreen(withReport({ QA_CASES: cases }), 'QA_CASES');
  });

  test.each([
    ['HEAD_SHA', OLD],
    ['RUN_ID', String(RUN + 1)],
    ['BOT_CONCLUSION', 'failure'],
    ['QA_RESULT', 'failure'],
    ['QA_RC', '1'],
  ])('every input of the verdict must say pass: %s=%p fails', (name, value) => {
    notGreen(withReport({ [name]: value }), 'did not report a pass', name);
  });

  test.each(VERDICT_INPUTS)('%s missing is refused', (name) => {
    notGreen(withReport({ [name]: null }), `declares ${name} 0 times`);
  });

  test.each(VERDICT_INPUTS)('%s declared twice is refused, forged value or not', (name) => {
    const value = GOOD_REPORT_ENV[name] ?? '';
    notGreen(withReport({ [name]: [value, value] }), `declares ${name} 2 times`);
    notGreen(withReport({ [name]: [value, '0'] }), `declares ${name} 2 times`);
  });

  test('a report log without an env block is refused', () => {
    const text = stamped([...SETUP_LINES, ...headerLines({ envOpen: null })]);
    notGreen({ ...goodRoutes(), [REPORT_LOG_KEY]: { text } }, 'no env block');
  });

  test.each([
    ['renamed', goodSteps('Post something else')],
    ['failed', goodSteps(REPORT_STEP, { conclusion: 'failure' })],
    ['a single step', goodSteps(REPORT_STEP).slice(0, 1)],
  ])('the report step must be the exact trusted one (%s): its log is not read', (_name, steps) => {
    const { gate } = notGreen(withJobs([goodJob(), reportJob({ steps })]), 'Post stage-qa');
    expect(fetchCount(gate, REPORT_LOG_KEY)).toBe(0);
  });

  test('an unreadable report log cannot be evaluated', () => {
    const routes: Routes = { ...goodRoutes(), [REPORT_LOG_KEY]: { error: 'HTTP 404' } };
    cannotEvaluate(routes, 'cannot read the log');
  });
});

describe('the status must have been created by the report job of the same run', () => {
  // Any pull request workflow can post a status as github-actions[bot]; the gate ties it to the run.
  function withStatus(over: Record<string, unknown>): Routes {
    return { ...goodRoutes(), [statusesKey()]: { body: [goodStatus(over)] } };
  }

  function withoutAttempt(item: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'run_attempt'));
  }

  test.each([
    '2026-10-27T08:37:14Z',
    '2026-10-27T08:37:19Z',
    '2026-10-27T08:00:00Z',
    '2026-10-28T08:37:16Z',
  ])('a status created at %s, outside the report job, is refused', (created) => {
    const { gate } = notGreen(withStatus({ created_at: created }), 'outside its run time');
    expect(fetchCount(gate, LOG_KEY)).toBe(0);
  });

  test.each([
    '2026-10-27T08:37:15Z',
    '2026-10-27T08:37:18Z',
  ])('the window of the report job includes its first and last second (%s)', (created) => {
    green(withStatus({ created_at: created }));
  });

  test.each([
    null,
    '',
    'yesterday',
    '2026-10-27T08:37:17',
    '2026-13-45T08:37:17Z',
    '2026-10-27T08:37:17.000Z',
    1788000000,
  ])('a status without a usable time (%p) cannot be evaluated', (created) => {
    cannotEvaluate(withStatus({ created_at: created }), 'timestamp');
  });

  test.each([
    { started_at: null },
    { completed_at: null },
    { started_at: 'soon' },
  ])('a report job without a usable time (%p) cannot be evaluated', (over) => {
    cannotEvaluate(withJobs([goodJob(), reportJob(over)]), 'timestamp');
  });

  test.each([
    ['missing', [goodJob()]],
    ['failed', [goodJob(), reportJob({ conclusion: 'failure' })]],
    ['still running', [goodJob(), reportJob({ status: 'in_progress', conclusion: null })]],
    ['there twice', [goodJob(), reportJob(), reportJob({ id: REPORT_JOB + 1 })]],
    ['of another run', [goodJob(), reportJob({ run_id: RUN + 1 })]],
  ])('the report job must exist once and have succeeded (%s)', (_name, jobs) => {
    const { gate } = notGreen(withJobs(jobs), 'Post stage-qa');
    expect(fetchCount(gate, LOG_KEY)).toBe(0);
  });

  test('a report-only rerun keeps the earlier QA job', () => {
    const routes: Routes = {
      ...withJobs([goodJob({ run_attempt: 1 }), reportJob({ run_attempt: 2 })]),
      [RUN_KEY]: { body: goodRun({ run_attempt: 2 }) },
    };
    green(routes);
  });

  test.each([
    3,
    0,
    -1,
    '1',
    null,
    true,
    1.5,
  ])('a QA job attempt of %p outside the attempts of the run is refused', (attempt) => {
    const routes: Routes = {
      ...withJobs([goodJob({ run_attempt: attempt }), reportJob({ run_attempt: 2 })]),
      [RUN_KEY]: { body: goodRun({ run_attempt: 2 }) },
    };
    notGreen(routes, 'attempt');
  });

  test.each([
    [
      'the run and both jobs have none',
      withoutAttempt(goodRun()),
      [withoutAttempt(goodJob()), withoutAttempt(reportJob())],
    ],
    ['the run has none', withoutAttempt(goodRun()), [goodJob(), reportJob()]],
    ['the run attempt is a boolean', goodRun({ run_attempt: true }), [goodJob(), reportJob()]],
    [
      'the run attempt is zero',
      goodRun({ run_attempt: 0 }),
      [goodJob({ run_attempt: 0 }), reportJob({ run_attempt: 0 })],
    ],
  ])('a run or jobs without a valid attempt are refused (%s): no log is read', (_name, run, jobs) => {
    const routes: Routes = { ...withJobs(jobs), [RUN_KEY]: { body: run } };
    const { gate } = notGreen(routes, 'attempt');
    expect(fetchCount(gate, LOG_KEY)).toBe(0);
  });
});

describe('the log reader', () => {
  test('a gh that never finishes is killed and refused', () => {
    const temp = tempRoot('stage-qa-gate-slow-gh-');
    try {
      writeExecutable(join(temp.dir, 'gh'), '#!/bin/sh\nexec sleep 30\n');
      const program = [
        'import importlib.util, sys',
        'spec = importlib.util.spec_from_file_location("gate_under_test", sys.argv[1])',
        'gate = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(gate)',
        'gate.LOG_DEADLINE_SECONDS = 1',
        'try:',
        `    gate.read_job_log_head("${SLUG}", ${JOB})`,
        'except gate.CannotEvaluate as error:',
        '    print(error)',
        '    sys.exit(0)',
        'sys.exit(1)',
      ].join('\n');
      const done = spawnSync(PYTHON, ['-c', program, GATE], {
        encoding: 'utf8',
        env: { PATH: `${temp.dir}:${process.env['PATH'] ?? ''}` },
        timeout: 20_000,
      });
      expect(done.status).toBe(0);
      expect(done.stdout).toContain('did not finish within 1s');
    } finally {
      temp.cleanup();
    }
  });
});

describe('the workflow the gate reads', () => {
  // The log binding is only as good as the workflow it reads: pin what it relies on.
  const text = readFileSync(join(REPO, '.github/workflows/stage-qa.yml'), 'utf8');
  const qaJob = text.split('\n  qa:\n')[1]?.split('\n  # Hosted: the only job')[0] ?? '';
  const reportJobText = text.split('\n  report:\n')[1] ?? '';

  function stepsOf(job: string): string {
    return job.split('\n    steps:\n')[1] ?? '';
  }

  function envNames(steps: string): string[] {
    const env = steps.split('        env:\n')[1]?.split('        run:')[0] ?? '';
    return [...env.matchAll(/^ {10}([A-Z_]+): /gm)].map((match) => match[1] ?? '');
  }

  test('the QA job has one step, uses no action, and its only input is the head SHA', () => {
    const steps = stepsOf(qaJob);
    expect([...steps.matchAll(/^ {6}- /gm)].length).toBe(1);
    expect(qaJob).not.toMatch(/^\s*(- )?uses:/m);
    expect(steps).toContain(`- name: ${QA_STEP}`);
    expect(envNames(steps)).toEqual(['HEAD_SHA']);
    expect(steps).toContain(`HEAD_SHA: \${{ github.event.workflow_run.head_sha }}`);
  });

  test('the report job has one step and declares each input of the verdict exactly once', () => {
    const steps = stepsOf(reportJobText);
    expect([...steps.matchAll(/^ {6}- /gm)].length).toBe(1);
    expect(steps).toContain(`- name: ${REPORT_STEP}`);
    const declared = envNames(steps);
    for (const name of VERDICT_INPUTS) {
      expect(declared.filter((candidate) => candidate === name).length).toBe(1);
    }
  });

  test('the jobs are named as the gate looks them up', () => {
    expect(qaJob).toContain('name: Stage QA run');
    expect(reportJobText).toContain('name: Post stage-qa');
  });
});
