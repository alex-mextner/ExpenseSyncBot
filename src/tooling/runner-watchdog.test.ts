// Drives ci/runner-watchdog/runner-watchdog.sh through its outcomes with stand-in `gh`,
// `curl` and `sleep` binaries: GitHub API answers come from per-test fixtures and Telegram
// sends are recorded, so no network is touched. Asserts what the admin is told, the state
// carried to the next run, and the step outputs the workflow acts on.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '../../ci/runner-watchdog/runner-watchdog.sh');
const REPO = 'owner/repo';
const RUN_ID = 100;

// Stand-in gh: `gh api [-X POST] <path>` answers from $FIX/<path with / ? & = . → _>; a
// `.<n>` suffix answers the n-th call (0-based) to that path; `<key>.fail` makes it fail.
const GH_STUB = `#!/usr/bin/env bash
path="\${@: -1}"
key=$(printf '%s' "$path" | tr '/?&=.' '_____')
counter="$FIX/.calls_$key"
n=$(cat "$counter" 2>/dev/null || echo 0)
echo $((n + 1)) > "$counter"
if [ -f "$FIX/$key.fail" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
if [ -f "$FIX/$key.$n" ]; then cat "$FIX/$key.$n"; exit 0; fi
if [ -f "$FIX/$key" ]; then cat "$FIX/$key"; exit 0; fi
echo "no fixture for $path" >&2
exit 1
`;

// Stand-in curl: records the Telegram message text and answers with $TG_STATUS.
const CURL_STUB = `#!/usr/bin/env bash
prev=""
for arg in "$@"; do
  if [ "$prev" = "-d" ]; then printf '%s' "$arg" | jq -c '.text' >> "$FIX/telegram"; fi
  prev="$arg"
done
printf '%s' "\${TG_STATUS:-200}"
`;

interface Job {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  runner_name: string | null;
  started_at?: string | null;
}

const jobsPath = (runId: number) => `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`;
const IN_PROGRESS = `repos/${REPO}/actions/runs?status=in_progress&per_page=100`;

const jobs = (...list: Job[]) => JSON.stringify({ jobs: list });
const runs = (...ids: number[]) => JSON.stringify({ workflow_runs: ids.map((id) => ({ id })) });
const watch: Job = { name: 'watch', status: 'in_progress', runner_name: 'GitHub Actions 1' };
const pingQueued: Job = { name: 'ping', status: 'queued', runner_name: null };
const pingTaken: Job = { name: 'ping', status: 'in_progress', runner_name: 'odroid' };
const deployRunning = (startedMinutesAgo: number): Job => ({
  name: 'deploy',
  status: 'in_progress',
  runner_name: 'odroid',
  // GitHub's format: whole seconds, e.g. 2026-10-11T08:46:24Z
  started_at: new Date(Date.now() - startedMinutesAgo * 60_000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z'),
});

interface Scenario {
  /** API path (optionally suffixed `.0`/`.1`/`.fail`) → response body. */
  api: Record<string, string>;
  /** Announced state carried over from the previous run; undefined = no cache yet. */
  announced?: 'online' | 'offline';
  telegramStatus?: string;
  pickupTimeout?: number;
}

function runWatchdog(scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-watchdog-'));
  const bin = join(dir, 'bin');
  const fix = join(dir, 'fixtures');
  mkdirSync(bin);
  mkdirSync(fix);
  writeFileSync(join(bin, 'gh'), GH_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), CURL_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n', { mode: 0o755 });
  for (const [path, body] of Object.entries(scenario.api)) {
    const suffix = path.match(/\.(\d+|fail)$/)?.[0] ?? '';
    const key = path.slice(0, path.length - suffix.length).replace(/[/?&=.]/g, '_');
    writeFileSync(join(fix, key + suffix), body);
  }
  const stateFile = join(dir, 'state');
  if (scenario.announced) writeFileSync(stateFile, `${scenario.announced}\n`);
  const outputFile = join(dir, 'github_output');
  writeFileSync(outputFile, '');

  const result = spawnSync('bash', [SCRIPT], {
    env: {
      PATH: `${bin}:${process.env['PATH']}`,
      FIX: fix,
      GH_REPO: REPO,
      WATCHED_RUNNER: 'odroid',
      RUN_ID: String(RUN_ID),
      BOT_TOKEN: 'test-token',
      ADMIN_CHAT_ID: '42',
      STATE_FILE: stateFile,
      GITHUB_OUTPUT: outputFile,
      PICKUP_TIMEOUT: String(scenario.pickupTimeout ?? 0),
      POLL_INTERVAL: '1',
      TG_STATUS: scenario.telegramStatus ?? '200',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const telegramFile = join(fix, 'telegram');
  const telegram = existsSync(telegramFile)
    ? readFileSync(telegramFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line): string => JSON.parse(line))
    : [];
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    telegram,
    announced: existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : undefined,
    outputs: readFileSync(outputFile, 'utf8').split('\n').filter(Boolean),
  };
}

describe('runner-watchdog.sh', () => {
  test('runner picks up the ping, admin already knows it is online: no message', () => {
    const r = runWatchdog({ api: { [jobsPath(RUN_ID)]: jobs(watch, pingTaken) } });
    expect(r.status).toBe(0);
    expect(r.telegram).toEqual([]);
    expect(r.outputs).toEqual(['offline=false', 'state_changed=false']);
  });

  test('ping is picked up on a later poll within the timeout', () => {
    const r = runWatchdog({
      api: {
        [`${jobsPath(RUN_ID)}.0`]: jobs(watch, pingQueued),
        [`${jobsPath(RUN_ID)}.1`]: jobs(watch, pingTaken),
      },
      announced: 'online',
      pickupTimeout: 60,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Runner odroid picked up the ping');
    expect(r.telegram).toEqual([]);
  });

  test('runner idle and not picking up the ping: one offline alert, run marked for cancel', () => {
    const r = runWatchdog({
      api: { [jobsPath(RUN_ID)]: jobs(watch, pingQueued), [IN_PROGRESS]: runs(RUN_ID) },
    });
    expect(r.status).toBe(0);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toStartWith(
      '🔴 <b>Self-hosted runner <code>odroid</code> is offline</b>',
    );
    expect(r.announced).toBe('offline');
    expect(r.outputs).toEqual(['offline=true', 'state_changed=true']);
  });

  test('still offline after the alert went out: no repeat alert, still cancels', () => {
    const r = runWatchdog({
      api: { [jobsPath(RUN_ID)]: jobs(watch, pingQueued), [IN_PROGRESS]: runs(RUN_ID) },
      announced: 'offline',
    });
    expect(r.status).toBe(0);
    expect(r.telegram).toEqual([]);
    expect(r.outputs).toEqual(['offline=true', 'state_changed=false']);
  });

  test('back online after an announced outage: recovery message', () => {
    const r = runWatchdog({
      api: { [jobsPath(RUN_ID)]: jobs(watch, pingTaken) },
      announced: 'offline',
    });
    expect(r.status).toBe(0);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toStartWith(
      '✅ <b>Self-hosted runner <code>odroid</code> is back online</b>',
    );
    expect(r.announced).toBe('online');
    expect(r.outputs).toEqual(['offline=false', 'state_changed=true']);
  });

  test('ping queued behind a recently started deploy: online, no alert', () => {
    const r = runWatchdog({
      api: {
        [jobsPath(RUN_ID)]: jobs(watch, pingQueued),
        [IN_PROGRESS]: runs(RUN_ID, 55),
        [jobsPath(55)]: jobs(deployRunning(3)),
      },
      announced: 'online',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("busy with job 'deploy' of run 55");
    expect(r.telegram).toEqual([]);
    expect(r.outputs).toEqual(['offline=false', 'state_changed=false']);
  });

  test('busy with a recent job after an announced outage: recovery message', () => {
    const r = runWatchdog({
      api: {
        [jobsPath(RUN_ID)]: jobs(watch, pingQueued),
        [IN_PROGRESS]: runs(RUN_ID, 55),
        [jobsPath(55)]: jobs(deployRunning(3)),
      },
      announced: 'offline',
    });
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain('is back online');
    expect(r.announced).toBe('online');
  });

  test('a job "running" on the runner for hours is not proof of life: offline alert', () => {
    const r = runWatchdog({
      api: {
        [jobsPath(RUN_ID)]: jobs(watch, pingQueued),
        [IN_PROGRESS]: runs(RUN_ID, 55),
        [jobsPath(55)]: jobs(deployRunning(180)),
      },
    });
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain('is offline');
    expect(r.outputs).toEqual(['offline=true', 'state_changed=true']);
  });

  test('offline alert fails to send: step fails, state kept so the next run retries', () => {
    const r = runWatchdog({
      api: { [jobsPath(RUN_ID)]: jobs(watch, pingQueued), [IN_PROGRESS]: runs(RUN_ID) },
      announced: 'online',
      telegramStatus: '500',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error::Telegram API returned HTTP 500');
    expect(r.announced).toBe('online');
    // the queued ping is still dropped, but no state_changed=true → the cache is not saved
    expect(r.outputs).toEqual(['offline=true']);
  });

  test('recovery message fails to send: state stays offline so the next run retries', () => {
    const r = runWatchdog({
      api: { [jobsPath(RUN_ID)]: jobs(watch, pingTaken) },
      announced: 'offline',
      telegramStatus: '502',
    });
    expect(r.status).toBe(1);
    expect(r.announced).toBe('offline');
    expect(r.outputs).toEqual(['offline=false']);
  });

  test('GitHub API fails during the busy check: no alert, step fails', () => {
    const r = runWatchdog({
      api: { [jobsPath(RUN_ID)]: jobs(watch, pingQueued), [`${IN_PROGRESS}.fail`]: '' },
      announced: 'online',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('HTTP 502');
    expect(r.telegram).toEqual([]);
    expect(r.outputs).toEqual([]);
  });

  test('GitHub API fails while polling the ping: no alert, step fails', () => {
    const r = runWatchdog({ api: { [`${jobsPath(RUN_ID)}.fail`]: '' }, announced: 'online' });
    expect(r.status).not.toBe(0);
    expect(r.telegram).toEqual([]);
    expect(r.outputs).toEqual([]);
  });
});
