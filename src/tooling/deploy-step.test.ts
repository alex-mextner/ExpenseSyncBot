// Runs the "Deploy via git pull" step of .github/workflows/deploy.yml the way the odroid
// runner does — its script under bash with /var/www relocated into a temp dir and git, bun,
// caddy and pm2 replaced by stand-ins — to check what pm2 is handed. The self-hosted runner
// SIGKILLs every process still carrying the job's RUNNER_TRACKING_ID when the job ends, so
// pm2 must never see it: anything pm2 (re)starts from this step would inherit it.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKFLOW = join(import.meta.dir, '../../.github/workflows/deploy.yml');

// Logs every call; calls that saw the runner's job tracking id also go to $CALLS.tracked.
const stub = (name: string) =>
  `#!/usr/bin/env bash
echo "${name} $*" >> "$CALLS"
[ -n "\${RUNNER_TRACKING_ID:-}" ] && echo "${name} $1" >> "$CALLS.tracked"
exit 0
`;

/** `value[key]` when `value` is an object that has `key`, otherwise undefined. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? Reflect.get(value, key)
    : undefined;
}

async function deployScript(): Promise<string> {
  const workflow: unknown = Bun.YAML.parse(await Bun.file(WORKFLOW).text());
  const steps = field(field(field(workflow, 'jobs'), 'deploy'), 'steps');
  const step = Array.isArray(steps)
    ? steps.find((s) => field(s, 'name') === 'Deploy via git pull')
    : undefined;
  const run = field(step, 'run');
  if (typeof run !== 'string') throw new Error('deploy.yml has no "Deploy via git pull" step');
  return run;
}

async function runDeployStep() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-step-'));
  const www = join(root, 'var/www');
  const bunBin = join(www, '.bun/bin');
  const stubs = join(root, 'stubs');
  const mainDir = join(www, 'ExpenseSyncBot');
  const calls = join(root, 'calls');
  for (const dir of [bunBin, stubs, join(mainDir, 'logs'), join(mainDir, 'miniapp')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(mainDir, 'start.sh'), '#!/bin/sh\n');
  writeFileSync(join(bunBin, 'bun'), stub('bun'), { mode: 0o755 });
  writeFileSync(join(bunBin, 'pm2'), stub('pm2'), { mode: 0o755 });
  writeFileSync(join(stubs, 'git'), stub('git'), { mode: 0o755 });
  writeFileSync(join(stubs, 'caddy'), stub('caddy'), { mode: 0o755 });

  const script = join(root, 'step.sh');
  writeFileSync(script, (await deployScript()).replaceAll('/var/www', www));
  const result = spawnSync('bash', [script], {
    env: {
      PATH: `${stubs}:${process.env['PATH']}`,
      CALLS: calls,
      RUNNER_TRACKING_ID: 'github_test-job',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const read = (file: string) =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return {
    status: result.status,
    stderr: result.stderr,
    pm2: read(calls).filter((call) => call.startsWith('pm2 ')),
    pm2Tracked: read(`${calls}.tracked`).filter((call) => call.startsWith('pm2 ')),
    bunTracked: read(`${calls}.tracked`).filter((call) => call.startsWith('bun ')),
  };
}

describe('deploy.yml deploy step', () => {
  // On 2026-10-12 pm2-logrotate, restarted by `pm2 set`, was SIGKILLed at the end of every
  // deploy job ("Terminate orphan process: … node") because it inherited the tracking id.
  test('pm2 never sees the runner job tracking id', async () => {
    const r = await runDeployStep();
    expect(r.status).toBe(0);
    expect(r.pm2.some((call) => call.startsWith('pm2 reload ecosystem.config.cjs'))).toBe(true);
    expect(r.pm2.some((call) => call.startsWith('pm2 set pm2-logrotate'))).toBe(true);
    expect(r.pm2Tracked).toEqual([]);
  });

  test('installs and builds keep the tracking id, so the runner still reaps their leftovers', async () => {
    const r = await runDeployStep();
    expect(r.bunTracked).toContain('bun install');
    expect(r.bunTracked).toContain('bun run');
  });
});
