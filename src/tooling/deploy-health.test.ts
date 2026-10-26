// scripts/deploy-health.py decides whether the apps pm2 just reloaded are healthy, dead, or
// merely slow. The old deploy ended at `pm2 reload` with no check at all; the verdict has to
// tell a slow start (not a failure, especially on a host saturated by someone else's deploy)
// from a dead or crash-looping app (a failure, at once) and from an app that never became
// healthy (a failure once the budget, extended only under saturation, runs out).
//
// The real script runs against a fake pm2 and curl whose answers change with the poll count,
// a fake /proc for host pressure, and fixture log files whose lines carry pm2's timestamps.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDeployFixture,
  type DeployFixture,
  pm2LogLine,
  type Scenario,
} from '../test-utils/deploy-fixtures';

setDefaultTimeout(60_000);

const SCRIPT = join(import.meta.dir, '../../scripts/deploy-health.py');
const NEVER = 1_000_000;
const URL = 'http://127.0.0.1:3311/health';

let fixture: DeployFixture | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** A fixture whose apps already have a (quiet) current log, as after any real start. */
function setup(): DeployFixture {
  fixture = createDeployFixture();
  for (const name of ['out.log', 'error.log', 'bank-sync-out.log', 'bank-sync-error.log']) {
    writeFileSync(join(fixture.logs, name), '');
  }
  return fixture;
}

interface Verdict {
  code: number | null;
  line: string;
  out: string;
}

function verdict(
  f: DeployFixture,
  scenario: Scenario,
  flags: string[] = [],
  env: Record<string, string> = {},
): Verdict {
  f.setScenario(scenario);
  const done = spawnSync(
    'python3',
    [
      SCRIPT,
      'wait',
      '--pm2',
      f.pm2,
      '--app',
      'expensesyncbot',
      '--app',
      'bank-sync',
      '--url',
      URL,
      '--poll',
      '0.02',
      '--stable',
      '0.1',
      '--base-budget',
      '0.5',
      '--hard-cap',
      '2',
      '--stall',
      '0.5',
      '--command-timeout',
      '5',
      '--proc-dir',
      f.proc,
      ...flags,
    ],
    { env: { ...f.env, ...env }, encoding: 'utf8', timeout: 60_000 },
  );
  const line = done.stdout.split('\n').find((l) => l.startsWith('RESULT ')) ?? '';
  return { code: done.status, line, out: done.stdout + done.stderr };
}

function writeLog(f: DeployFixture, name: string, lines: string[]): void {
  writeFileSync(join(f.logs, name), `${lines.join('\n')}\n`);
}

describe('deploy-health.py verdict', () => {
  test('healthy apps are ok once /health has stayed ok for the stable window', () => {
    const f = setup();
    const r = verdict(f, {});
    expect(r.code).toBe(0);
    expect(r.line).toContain('verdict=ok');
    expect(r.line).toContain('health=ok');
    expect(f.calls()).toContain(`curl ${URL}`);
  });

  test('pm2 banner lines before the JSON do not hide the process list', () => {
    const f = setup();
    expect(verdict(f, { banner: true }).code).toBe(0);
  });

  // The 2026-10-24 incident: the box was I/O-saturated by another deploy and a healthy release
  // needed longer than the fixed budget. A slow start is not a failure.
  test('a slow start on a saturated host is extended past the budget, not failed', () => {
    const f = setup();
    f.setHost(60, 9);
    // --stall is wide: a slow poll on a busy test machine must not read as "no progress" here.
    const r = verdict(f, { health_after: 14, answers_503: true }, [
      '--base-budget',
      '0.1',
      '--hard-cap',
      '30',
      '--stall',
      '10',
    ]);
    expect(r.code).toBe(0);
    expect(r.line).toContain('verdict=ok');
    expect(r.out).toContain('extended past');
  });

  test('the same slow start on a quiet host fails at the budget', () => {
    const f = setup();
    const r = verdict(f, { health_after: NEVER });
    expect(r.code).toBe(4);
    expect(r.line).toContain('verdict=unhealthy');
    expect(r.line).toContain('host not saturated');
  });

  test('a saturated host never extends the wait past the hard cap', () => {
    const f = setup();
    f.setHost(80, 12);
    const r = verdict(f, { health_after: NEVER, answers_503: true });
    expect(r.code).toBe(4);
    expect(r.line).toContain('hard cap');
  });

  test('an alive but silent app is not extended even on a saturated host', () => {
    const f = setup();
    f.setHost(80, 12);
    const r = verdict(f, { health_after: NEVER, stalled: true });
    expect(r.code).toBe(4);
    expect(r.line).toContain('no progress');
  });

  test('a /health that answers but not ok is not healthy', () => {
    const f = setup();
    const r = verdict(f, { health_body: '{"status":"error"}' });
    expect(r.code).toBe(4);
    expect(r.line).toContain('verdict=unhealthy');
  });

  test('an errored app is dead at once, with no waiting for the budget', () => {
    const f = setup();
    const r = verdict(f, { dies_after: 2, health_after: NEVER }, [
      '--base-budget',
      '30',
      '--hard-cap',
      '60',
    ]);
    expect(r.code).toBe(3);
    expect(r.line).toContain('verdict=dead');
    expect(r.line).toContain('expensesyncbot');
    expect(r.line).toContain('errored');
    expect(r.line).toMatch(/elapsed=[0-5]s/);
  });

  test('an app missing from the pm2 list is dead', () => {
    const f = setup();
    const r = verdict(f, { missing: ['bank-sync'] });
    expect(r.code).toBe(3);
    expect(r.line).toContain('bank-sync is not in the pm2 list');
  });

  test('the second app counts too: an errored bank-sync fails the deploy', () => {
    const f = setup();
    const r = verdict(f, { status: { 'bank-sync': 'errored' } });
    expect(r.code).toBe(3);
    expect(r.line).toContain('bank-sync');
  });

  test('a crash loop (two restarts since the reload) is dead', () => {
    const f = setup();
    const r = verdict(f, { loop_after: 2, health_after: NEVER });
    expect(r.code).toBe(3);
    expect(r.line).toContain('crash loop');
  });

  test('restarts between the reload and the first poll count when the baseline came from `counts`', () => {
    const f = setup();
    // The apps already restarted twice before the first poll; only the baseline taken right
    // after the reload makes that visible.
    const r = verdict(f, { restarts: 2, health_after: NEVER }, ['--baseline', 'expensesyncbot=0']);
    expect(r.code).toBe(3);
    expect(r.line).toContain('crash loop');
    expect(r.line).toContain('0->2');
  });

  test('`counts` prints one <app>=<restart count> line per app, `wait` refuses a malformed --baseline', () => {
    const f = setup();
    f.setScenario({ restarts: 5 });
    const counted = spawnSync(
      'python3',
      [SCRIPT, 'counts', '--pm2', f.pm2, '--app', 'expensesyncbot', '--app', 'bank-sync'],
      { encoding: 'utf8', env: f.env },
    );
    expect(counted.status).toBe(0);
    expect(counted.stdout).toBe('expensesyncbot=5\nbank-sync=5\n');
    const bad = verdict(f, {}, ['--baseline', 'nonsense']);
    expect(bad.code).not.toBe(0);
  });

  test('restarts that predate the deploy are not counted', () => {
    const f = setup();
    expect(verdict(f, { restarts: 41 }).code).toBe(0);
  });

  test('a single restart restarts the stability window but is not a failure', () => {
    const f = setup();
    const r = verdict(f, { restart_after: 3 });
    expect(r.code).toBe(0);
  });

  test('a status that pm2 reports while it waits to restart a crashed app is dead', () => {
    const f = setup();
    const r = verdict(f, { status: { expensesyncbot: 'waiting restart' }, health_after: NEVER });
    expect(r.code).toBe(3);
    expect(r.line).toContain('waiting restart');
  });

  test('one unreachable pm2 poll is tolerated, three in a row are dead', () => {
    const f = setup();
    expect(verdict(f, { unreachable_polls: [1] }).code).toBe(0);
    const dead = verdict(f, { unreachable: true });
    expect(dead.code).toBe(3);
    expect(dead.line).toContain('pm2 did not answer');
  });

  describe('fresh log lines', () => {
    const now = Date.now();
    const started = now - 60_000;
    const fresh = new Date(now - 30_000);
    const stale = new Date(started - 3_600_000);

    test('a fatal line written since the process started is dead', () => {
      const f = setup();
      writeLog(f, 'out.log', [pm2LogLine(fresh, { level: 60, msg: 'boom' })]);
      const r = verdict(f, { started_ms: started });
      expect(r.code).toBe(3);
      expect(r.line).toContain('fatal');
    });

    test('a fatal line is still found when a noisy start buries it under more than 1 MiB of routine logs', () => {
      const f = setup();
      const routine = pm2LogLine(fresh, { level: 30, msg: 'x'.repeat(200) });
      writeLog(f, 'out.log', [
        pm2LogLine(stale, { level: 30, msg: 'old' }),
        pm2LogLine(fresh, { level: 60, msg: 'boom' }),
        ...Array.from({ length: 7000 }, () => routine),
      ]);
      const r = verdict(f, { started_ms: started });
      expect(r.code).toBe(3);
      expect(r.line).toContain('fatal');
    });

    test('fatal and error lines from before the reload are ignored', () => {
      const f = setup();
      writeLog(
        f,
        'out.log',
        Array.from({ length: 30 }, (_, i) =>
          pm2LogLine(stale, { level: i % 2 ? 60 : 50, msg: 'old' }),
        ),
      );
      expect(verdict(f, { started_ms: started }).code).toBe(0);
    });

    test('an error storm fails the verdict, a few errors are only reported', () => {
      const f = setup();
      const errors = Array.from({ length: 25 }, () => pm2LogLine(fresh, { level: 50, msg: 'x' }));
      writeLog(f, 'error.log', errors);
      const storm = verdict(f, { started_ms: started });
      expect(storm.code).toBe(4);
      expect(storm.line).toContain('verdict=unhealthy');
      writeLog(f, 'error.log', errors.slice(0, 2));
      const few = verdict(f, { started_ms: started });
      expect(few.code).toBe(0);
      expect(few.line).toContain('2 level>=50');
    });

    test('lines without a timestamp continue the line before them', () => {
      const f = setup();
      writeLog(f, 'error.log', [
        pm2LogLine(stale, 'old failure'),
        '    at stale (file.ts:1)',
        pm2LogLine(fresh, { level: 60, msg: 'new failure' }),
      ]);
      expect(verdict(f, { started_ms: started }).code).toBe(3);
    });
  });

  test('the result line is safe to hand back to the shell', () => {
    const f = setup();
    const r = verdict(f, { health_body: '{"status":"ok;rm -rf $HOME `x`","uptime":1}' });
    expect(r.line).not.toMatch(/[;$`]/);
  });

  test('pm2 never receives the runner job tracking id', () => {
    const f = setup();
    verdict(f, {}, [], { RUNNER_TRACKING_ID: 'github_job-1' });
    const pm2Calls = f.calls().filter((call) => call.startsWith('pm2 '));
    expect(pm2Calls.length).toBeGreaterThan(0);
    for (const call of pm2Calls) expect(call).toContain('tracking= ');
  });
});
