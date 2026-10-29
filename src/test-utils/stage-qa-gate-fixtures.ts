// Shared pieces of the ship-gate tests (stage-qa-gate.test.ts, stage-qa-gate-binding.test.ts): the real
// scripts/stage-qa-gate.py is run against a stand-in `gh` that serves GitHub's answers from a route table
// and fails loudly on any request it was not told about. Everything GitHub would answer (the status, the
// run, the jobs, the runner's job logs) is built here in the exact shape the gate reads; the logs are
// synthetic, no real log content is committed.

import { afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, type TempRoot, tempRoot, writeExecutable } from './stage-qa-fixtures';

export const GATE = join(REPO, 'scripts/stage-qa-gate.py');
// Absolute: one test runs the gate with a PATH that has no gh (and so no python3 either).
export const PYTHON = Bun.which('python3') ?? 'python3';
export const SLUG = 'alex-mextner/ExpenseSyncBot';
export const HEAD = 'a'.repeat(40);
export const OLD = 'b'.repeat(40);
export const MAIN = 'c'.repeat(40);
export const RUN = 4242;
export const JOB = 9001;
export const REPORT_JOB = 9002;
export const QA_PATH = '.github/workflows/stage-qa.yml';
export const QA_JOB = 'Stage QA run';
export const QA_STEP = 'Run the stage QA through qa-cli';
export const REPORT_STEP = 'Post the stage-qa status';
export const CASES = 7;

export type Json = Record<string, unknown>;
// A route is {body} (a JSON answer), {text|b64, pad?} (raw stdout: the job log, then `pad` bytes of filler
// lines), {error, stdout?} (a failing call) or {bodies} (the n-th call of the same argv gets the n-th route,
// the last repeats).
export type Route =
  | { body: unknown }
  | { text: string; pad?: number }
  | { b64: string }
  | { error: string; stdout?: string }
  | { bodies: Route[] };
export type Routes = Record<string, Route>;

const FAKE_GH = `#!/usr/bin/env python3
import base64, json, os, sys
path = os.environ["FAKE_GH_ROUTES"]
routes = json.load(open(path))
key = " ".join(sys.argv[1:])
seen = open(path + ".log").read().splitlines().count(key) if os.path.exists(path + ".log") else 0
with open(path + ".log", "a") as log:
    log.write(key + "\\n")
hit = routes.get(key)
if hit is None:
    sys.stderr.write("fake gh: no route for " + key + "\\n")
    sys.exit(1)
if "bodies" in hit:
    hit = hit["bodies"][min(seen, len(hit["bodies"]) - 1)]
if "error" in hit:
    sys.stdout.write(hit.get("stdout", ""))
    sys.stderr.write(hit["error"] + "\\n")
    sys.exit(1)
if "body" in hit:
    print(json.dumps(hit["body"]))
    sys.exit(0)
data = base64.b64decode(hit["b64"]) if "b64" in hit else hit["text"].encode()
filler = b"2026-10-27T09:00:00.0000000Z filler line of the driver output\\n"
try:
    sys.stdout.buffer.write(data)
    for _ in range(hit.get("pad", 0) // len(filler)):
        sys.stdout.buffer.write(filler)
    sys.stdout.buffer.flush()
except BrokenPipeError:
    os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
`;

export const PR_KEY = `pr view 7 --repo ${SLUG} --json state,isDraft,headRefOid,isCrossRepository`;
export const WF_KEY = `api repos/${SLUG}/contents/${QA_PATH}`;
export const REPO_KEY = `api repos/${SLUG}`;
export const RUN_KEY = `api repos/${SLUG}/actions/runs/${RUN}`;
export const JOBS_KEY = `api repos/${SLUG}/actions/runs/${RUN}/jobs?per_page=100`;
export const LOG_KEY = `api --allow-escape-sequences repos/${SLUG}/actions/jobs/${JOB}/logs`;
export const REPORT_LOG_KEY = `api --allow-escape-sequences repos/${SLUG}/actions/jobs/${REPORT_JOB}/logs`;

export function statusesKey(page = 1, head = HEAD): string {
  return `api repos/${SLUG}/commits/${head}/statuses?per_page=100&page=${page}`;
}

export function goodStatus(over: Json = {}): Json {
  return {
    context: 'stage-qa',
    state: 'success',
    creator: { login: 'github-actions[bot]' },
    description: `passed cases=${CASES} run=${RUN}`,
    target_url: `https://github.com/${SLUG}/actions/runs/${RUN}`,
    created_at: '2026-10-27T08:37:17Z',
    ...over,
  };
}

export function goodRun(over: Json = {}): Json {
  return {
    id: RUN,
    run_attempt: 1,
    path: QA_PATH,
    event: 'workflow_run',
    status: 'completed',
    conclusion: 'success',
    // A workflow_run run reports the default branch commit as its head_sha, never the tested PR head.
    head_sha: MAIN,
    head_branch: 'main',
    repository: { full_name: SLUG },
    head_repository: { full_name: SLUG },
    ...over,
  };
}

export function prBody(over: Json = {}): Json {
  return { state: 'OPEN', isDraft: false, headRefOid: HEAD, isCrossRepository: false, ...over };
}

export function goodSteps(step = QA_STEP, qaOver: Json = {}): Json[] {
  return [
    { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
    { number: 2, name: step, status: 'completed', conclusion: 'success', ...qaOver },
    { number: 3, name: 'Complete job', status: 'completed', conclusion: 'success' },
  ];
}

export function goodJob(over: Json = {}): Json {
  return {
    id: JOB,
    name: QA_JOB,
    run_id: RUN,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    steps: goodSteps(),
    ...over,
  };
}

export function reportJob(over: Json = {}): Json {
  return goodJob({
    id: REPORT_JOB,
    name: 'Post stage-qa',
    steps: goodSteps(REPORT_STEP),
    started_at: '2026-10-27T08:37:15Z',
    completed_at: '2026-10-27T08:37:18Z',
    ...over,
  });
}

// ---------------------------------------------------------------- the runner's job logs

export const SETUP_LINES = [
  "Current runner version: '2.0.0'",
  '##[group]GITHUB_TOKEN Permissions',
  'Contents: read',
  '##[endgroup]',
  'Complete job name: Stage QA run',
];
export const SCRIPT_LINES = [
  '\x1b[36;1m# synthetic first line\x1b[0m',
  '\x1b[36;1mset -uo pipefail\x1b[0m',
];
export const DRIVER_LINES = [
  'SMOKE PASS start replies=1',
  `STAGE_QA_RESULT status=passed sha=${HEAD} cases=7 failed=0`,
];

/** A log as the runner writes it: BOM, one timestamp per line. */
export function stamped(lines: string[], newline = '\n', bom = true): string {
  const body = lines
    .map((line, index) => `2026-10-27T08:23:24.${String(index).padStart(7, '0')}Z ${line}`)
    .join(newline);
  return `${bom ? '\ufeff' : ''}${body}${newline}`;
}

export interface HeaderOptions {
  sha?: string;
  env?: string[];
  script?: string[];
  shell?: string | null;
  envOpen?: string | null;
}

/** The runner's header of a step: its script, `shell:`, the `env:` block with the injected values. */
export function headerLines(options: HeaderOptions = {}): string[] {
  const env = options.env ?? [`  HEAD_SHA: ${options.sha ?? HEAD}`];
  const shell = options.shell === undefined ? 'shell: /usr/bin/bash -e {0}' : options.shell;
  const envOpen = options.envOpen === undefined ? 'env:' : options.envOpen;
  return [
    '##[group]Run # synthetic first line',
    ...(options.script ?? SCRIPT_LINES),
    ...(shell === null ? [] : [shell]),
    ...(envOpen === null ? [] : [envOpen]),
    ...env,
    '##[endgroup]',
  ];
}

export interface QaLogOptions {
  sha?: string;
  header?: string[];
  driver?: string[];
  newline?: string;
  bom?: boolean;
  rawTail?: string;
}

export function qaLog(options: QaLogOptions = {}): string {
  const lines = [
    ...SETUP_LINES,
    ...(options.header ?? headerLines({ sha: options.sha ?? HEAD })),
    ...(options.driver ?? DRIVER_LINES),
    'Evaluate and set job outputs',
  ];
  return stamped(lines, options.newline, options.bom) + (options.rawTail ?? '');
}

/** The report step's own inputs of the verdict, as the runner renders them. */
export const GOOD_REPORT_ENV: Record<string, string> = {
  REPO: SLUG,
  HEAD_SHA: HEAD,
  RUN_ID: String(RUN),
  BOT_CONCLUSION: 'success',
  QA_RESULT: 'success',
  QA_RC: '0',
  QA_CASES: String(CASES),
};
export const VERDICT_INPUTS = [
  'HEAD_SHA',
  'RUN_ID',
  'BOT_CONCLUSION',
  'QA_RESULT',
  'QA_RC',
  'QA_CASES',
];

/** `over` replaces a value; a null value drops the line; an array prints the line once per item. */
export function reportLog(over: Record<string, string | string[] | null> = {}): string {
  const env: Record<string, string | string[] | null> = { ...GOOD_REPORT_ENV, ...over };
  const envLines: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null) envLines.push(`  ${name}: ${item}`);
    }
  }
  const header = headerLines({
    env: envLines,
    script: ['\x1b[36;1mset -euo pipefail\x1b[0m'],
  });
  return stamped([...SETUP_LINES, ...header, 'Evaluate and set job outputs']);
}

export function goodRoutes(): Routes {
  return {
    [WF_KEY]: { body: { name: 'stage-qa.yml' } },
    [PR_KEY]: { body: prBody() },
    [statusesKey()]: { body: [goodStatus()] },
    [RUN_KEY]: { body: goodRun() },
    [REPO_KEY]: { body: { default_branch: 'main' } },
    [JOBS_KEY]: { body: { jobs: [goodJob(), reportJob()] } },
    [LOG_KEY]: { text: qaLog() },
    [REPORT_LOG_KEY]: { text: reportLog() },
  };
}

/** `goodRoutes()` with one route replaced. */
export function routesWith(key: string, route: Route): Routes {
  return { ...goodRoutes(), [key]: route };
}

// ---------------------------------------------------------------- running the gate

export interface GateRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Gate {
  dir: string;
  run: (routes: Routes, options?: { path?: string; env?: Record<string, string> }) => GateRun;
  /** The argv of every gh call of the last run, in order. */
  fetched: () => string[];
}

/** A temp dir per gate, removed after each test of the file that calls this at its top level. */
export function gateSession(): { create: () => Gate } {
  const temps: TempRoot[] = [];
  afterEach(() => {
    for (const temp of temps.splice(0)) temp.cleanup();
  });
  return {
    create: () => {
      const temp = tempRoot('stage-qa-gate-');
      temps.push(temp);
      const root = temp.dir;
      mkdirSync(join(root, 'bin'));
      writeExecutable(join(root, 'bin/gh'), FAKE_GH);
      const routesFile = join(root, 'routes.json');
      return {
        dir: root,
        run: (routes, options = {}) => {
          writeFileSync(routesFile, JSON.stringify(routes));
          const done = spawnSync(PYTHON, [GATE, '--repo', SLUG, '--pr', '7'], {
            encoding: 'utf8',
            env: {
              PATH: options.path ?? `${join(root, 'bin')}:${process.env['PATH'] ?? ''}`,
              FAKE_GH_ROUTES: routesFile,
              ...options.env,
            },
          });
          return { status: done.status, stdout: done.stdout, stderr: done.stderr };
        },
        fetched: () =>
          existsSync(`${routesFile}.log`)
            ? readFileSync(`${routesFile}.log`, 'utf8').split('\n').filter(Boolean)
            : [],
      };
    },
  };
}
