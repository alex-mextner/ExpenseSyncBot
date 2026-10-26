// Structural checks of the two workflows that deploy on the odroid (deploy.yml, stage-bot.yml):
// both must take the host-wide deploy lock (shared with HyperCalendarBot) before their
// install/build phase, and their job time limits must outlast that lock's 40 minute wait.
// The behaviour behind these facts is exercised by deploy-step.test.ts and
// stage-bot-deploy.test.ts, which run the steps; this file keeps the YAML honest.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const WORKFLOWS = join(import.meta.dir, '../../.github/workflows');
const ECOSYSTEM = join(import.meta.dir, '../../ecosystem.config.cjs');
const LOCK_WAIT_SECONDS = 2400; // ODROID_DEPLOY_LOCK_MAX_WAIT default in scripts/odroid-deploy-lock.sh
const VERDICT_HARD_CAP_SECONDS = 900; // scripts/deploy-health.py --hard-cap default

/** `value[key]` when `value` is an object that has `key`, otherwise undefined. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? Reflect.get(value, key)
    : undefined;
}

async function workflow(file: string): Promise<unknown> {
  return Bun.YAML.parse(await Bun.file(join(WORKFLOWS, file)).text());
}

function job(parsed: unknown, name: string): unknown {
  return field(field(parsed, 'jobs'), name);
}

function stepNamed(parsed: unknown, jobName: string, stepName: string): unknown {
  const steps = field(job(parsed, jobName), 'steps');
  const step = Array.isArray(steps) ? steps.find((s) => field(s, 'name') === stepName) : undefined;
  if (step === undefined) throw new Error(`${jobName} has no step "${stepName}"`);
  return step;
}

/** A GitHub Actions expression as it appears in the YAML. */
function expression(body: string): string {
  return `\${{ ${body} }}`;
}

function runScript(step: unknown): string {
  const run = field(step, 'run');
  if (typeof run !== 'string') throw new Error('step has no run script');
  return run;
}

describe('logs set aside by the deploy', () => {
  test('are marked fresh before the rename so a concurrent retention sweep cannot delete them before the reload', async () => {
    const script = runScript(
      stepNamed(await workflow('deploy.yml'), 'deploy', 'Deploy via git pull'),
    );
    const rename = script.indexOf('mv -n "logs/$f" "$target"');
    const touch = script.indexOf('touch "logs/$f"');
    const reload = script.indexOf('$PM2 reload ecosystem.config.cjs');
    expect(rename).toBeGreaterThan(-1);
    expect(touch).toBeGreaterThan(-1);
    expect(touch).toBeLessThan(rename);
    expect(reload).toBeGreaterThan(rename);
  });
});

describe('host deploy lock in the deploying workflows', () => {
  test('deploy.yml takes the lock before the checkout is pulled, then installs', async () => {
    const script = runScript(
      stepNamed(await workflow('deploy.yml'), 'deploy', 'Deploy via git pull'),
    );
    const fetchStep = script.indexOf('git fetch origin main');
    const source = script.indexOf('source "$LOCK_LIB"');
    const pull = script.indexOf('git pull origin main');
    const acquire = script.indexOf('odroid_deploy_lock_acquire esb');
    const install = script.indexOf('/var/www/.bun/bin/bun install');
    expect(fetchStep).toBeGreaterThan(-1);
    expect(source).toBeGreaterThan(fetchStep);
    expect(acquire).toBeGreaterThan(source);
    expect(pull).toBeGreaterThan(acquire);
    expect(install).toBeGreaterThan(pull);
    // A failed acquire (timeout 75 included) must stop the step, not be ignored.
    expect(script).toMatch(/odroid_deploy_lock_acquire esb \|\| \{/);
  });

  test('stage-bot.yml takes the lock before its install phase', async () => {
    const script = runScript(
      stepNamed(await workflow('stage-bot.yml'), 'stage-bot', 'Deploy or stop stage bot'),
    );
    const source = script.indexOf('source "$LOCK_LIB"');
    const acquire = script.indexOf('odroid_deploy_lock_acquire esb || exit $?');
    const installPhase = script.indexOf('install_checkout() {');
    expect(source).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(source);
    expect(installPhase).toBeGreaterThan(acquire);
    // Never source the lock script from PR code: it comes from the main checkout.
    expect(script).toContain('LOCK_LIB="$MAIN_DIR/scripts/odroid-deploy-lock.sh"');
  });

  test.each([
    ['deploy.yml', 'deploy'],
    ['stage-bot.yml', 'stage-bot'],
  ])('%s: the %s job limit outlasts the lock wait plus a deploy', async (file, jobName) => {
    const minutes = field(job(await workflow(file), jobName), 'timeout-minutes');
    expect(typeof minutes).toBe('number');
    if (typeof minutes !== 'number') return;
    // 40 min of waiting + the verdict's 15 min hard cap + room for installs and the build.
    expect(minutes * 60).toBeGreaterThan(LOCK_WAIT_SECONDS + VERDICT_HARD_CAP_SECONDS + 600);
  });
});

describe('deploy.yml failure evidence reaches the alert', () => {
  test('the deploy job exports what the step saved and notify-failure puts it in the message', async () => {
    const parsed = await workflow('deploy.yml');
    const deploy = job(parsed, 'deploy');
    expect(field(stepNamed(parsed, 'deploy', 'Deploy via git pull'), 'id')).toBe('deploy');
    expect(field(field(deploy, 'outputs'), 'failed_evidence')).toBe(
      expression('steps.deploy.outputs.failed_evidence'),
    );
    expect(field(field(deploy, 'outputs'), 'failure_note')).toBe(
      expression('steps.deploy.outputs.failure_note'),
    );
    const alert = stepNamed(parsed, 'notify-failure', 'Send failure notification');
    expect(field(field(alert, 'env'), 'FAILED_EVIDENCE')).toBe(
      expression('needs.deploy.outputs.failed_evidence'),
    );
    expect(field(field(alert, 'env'), 'FAILURE_NOTE')).toBe(
      expression('needs.deploy.outputs.failure_note'),
    );
    const script = runScript(alert);
    expect(script).toContain('Failed-release evidence on the odroid');
    expect(script).toContain('Verdict:');
    // The alert is HTML: both values are escaped before they go in.
    expect(script).toMatch(/escape_html "\$FAILED_EVIDENCE"/);
    expect(script).toMatch(/escape_html "\$FAILURE_NOTE"/);
    expect(field(field(parsed, 'jobs'), 'notify-failure')).toBeDefined();
    expect(field(job(parsed, 'notify-failure'), 'needs')).toEqual(['check', 'deploy']);
  });

  describe.skipIf(spawnSync('jq', ['--version']).status !== 0)('the alert it sends', () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** Runs the real notify-failure script with a curl that records the Telegram message. */
    async function sentText(env: Record<string, string>): Promise<string> {
      const dir = mkdtempSync(join(tmpdir(), 'failure-alert-'));
      dirs.push(dir);
      writeFileSync(
        join(dir, 'curl'),
        '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do [ "$1" = -d ] && printf "%s" "$2" > "$SENT"; shift; done\n',
        { mode: 0o755 },
      );
      const script = runScript(
        stepNamed(await workflow('deploy.yml'), 'notify-failure', 'Send failure notification'),
      );
      const done = spawnSync('bash', ['-c', script], {
        env: {
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          SENT: join(dir, 'sent.json'),
          BOT_TOKEN: 'token',
          ADMIN_CHAT_ID: '7',
          COMMIT_SHA: 'abcdef0123456789',
          COMMIT_MSG: 'fix: a thing\n\nbody',
          RUN_URL: 'https://github.com/o/r/actions/runs/1',
          FAILED_EVIDENCE: '',
          FAILURE_NOTE: '',
          ...env,
        },
        encoding: 'utf8',
      });
      expect(done.status).toBe(0);
      const body: unknown = JSON.parse(readFileSync(join(dir, 'sent.json'), 'utf8'));
      const text = field(body, 'text');
      if (typeof text !== 'string') throw new Error('no text sent');
      return text;
    }

    test('names the evidence directory and the verdict, escaped for Telegram HTML', async () => {
      const text = await sentText({
        FAILED_EVIDENCE: '/var/www/ExpenseSyncBot/logs/failed-abcdef012345-2026-10-25_12-00-00',
        FAILURE_NOTE: 'RESULT verdict=dead reason=2 fatal (level>=60) log lines & more',
      });
      expect(text).toContain(
        'Failed-release evidence on the odroid: <code>/var/www/ExpenseSyncBot/logs/failed-abcdef012345-2026-10-25_12-00-00</code>',
      );
      expect(text).toContain(
        'Verdict: <code>RESULT verdict=dead reason=2 fatal (level&gt;=60) log lines &amp; more</code>',
      );
      expect(text.endsWith('<a href="https://github.com/o/r/actions/runs/1">View run</a>')).toBe(
        true,
      );
    });

    test('a commit subject with <, > or & does not break the Telegram HTML', async () => {
      const text = await sentText({ COMMIT_MSG: 'fix: a < b & c > d' });
      expect(text).toContain('\nfix: a &lt; b &amp; c &gt; d');
    });

    test('a cancelled deploy (timeout, runner lost) is announced too', async () => {
      const workflowFile = await workflow('deploy.yml');
      const condition = field(field(field(workflowFile, 'jobs'), 'notify-failure'), 'if');
      expect(condition).toContain("needs.deploy.result == 'cancelled'");
    });

    test('without evidence (a failed check, say) the alert is what it always was', async () => {
      const text = await sentText({});
      expect(text).toBe(
        '❌ <b>Deploy failed</b> <code>abcdef0</code>\nfix: a thing\n\n<a href="https://github.com/o/r/actions/runs/1">View run</a>',
      );
    });
  });
});

describe('deploy.yml and the pm2 ecosystem agree', () => {
  const ecosystem: unknown = createRequire(import.meta.url)(ECOSYSTEM);
  const apps = field(ecosystem, 'apps');
  if (!Array.isArray(apps)) throw new Error('ecosystem.config.cjs has no apps list');

  test('the apps the deploy saves and verifies are the apps the ecosystem runs', async () => {
    const script = runScript(
      stepNamed(await workflow('deploy.yml'), 'deploy', 'Deploy via git pull'),
    );
    const declared = script.match(/^\s*APPS=\((.*)\)\s*$/m)?.[1]?.split(/\s+/) ?? [];
    const watched = declared.flatMap((word, i) => {
      const name = declared[i + 1];
      return word === '--app' && name !== undefined ? [name] : [];
    });
    const running = apps.flatMap((app) => {
      const name = field(app, 'name');
      return typeof name === 'string' ? [name] : [];
    });
    expect(watched.sort()).toEqual(running.sort());
  });

  test('every app logs under the directory the deploy rotates, saves and sweeps', () => {
    for (const app of apps) {
      for (const key of ['out_file', 'error_file']) {
        const path = field(app, key);
        expect(typeof path).toBe('string');
        if (typeof path === 'string') expect(dirname(path)).toBe('/var/www/ExpenseSyncBot/logs');
      }
    }
  });
});

describe('pm2-logrotate keeps what log retention alone may delete', () => {
  test('keeps every rotated file, rotating at 20M and compressing', async () => {
    const script = runScript(
      stepNamed(await workflow('deploy.yml'), 'deploy', 'Deploy via git pull'),
    );
    // A count no logs directory reaches: pm2-logrotate documents only numbers for `retain`.
    expect(script).toContain('$PM2 set pm2-logrotate:retain 100000');
    expect(script).not.toMatch(/pm2-logrotate:retain (?!100000\b)/);
    expect(script).toContain('$PM2 set pm2-logrotate:max_size 20M');
    expect(script).toContain('$PM2 set pm2-logrotate:compress true');
  });
});
