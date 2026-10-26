// Real bash processes contend for the host-wide odroid deploy lock
// (scripts/odroid-deploy-lock.sh, the same file and protocol as in HyperCalendarBot).
// The lock is a kernel flock(2), so nothing is mocked: two processes, one lock file. Every
// fake deploy runs under `set -e`, the way the workflow steps do, because the waiting loop
// (flock -w failing once per slice) must not trip errexit.
//
// Real time cannot be faked here: the lock waits in real one-second flock slices and the
// holders hold it for real seconds. Tests wait for the holder's HELD/RELEASED line instead of
// guessing a delay, so the only real durations left are the ones under test.
import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_LIB = join(import.meta.dir, '../../scripts/odroid-deploy-lock.sh');
const HAVE_FLOCK = spawnSync('flock', ['--version']).status === 0;
const TEST_TIMEOUT_MS = 30_000;

interface Sandbox {
  dir: string;
  lock: string;
  trace: string;
  cleanup: () => void;
}

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunningDeploy {
  pid: number;
  /** Resolves once the script printed `marker` on stdout. */
  reached: (marker: string) => Promise<void>;
  done: Promise<Finished>;
}

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-lock-'));
  return {
    dir,
    lock: join(dir, 'lock/odroid-deploy.lock'),
    trace: join(dir, 'trace.log'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function lockEnv(lock: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).flatMap(([k, v]) => (v ? [[k, v]] : []))),
    ODROID_DEPLOY_LOCK_FILE: lock,
    ODROID_DEPLOY_LOCK_SLICE: '1',
    ODROID_DEPLOY_LOCK_MAX_WAIT: '30',
    ...extra,
  };
}

function start(script: string, env: Record<string, string>): RunningDeploy {
  const child = spawn('bash', ['-c', script], {
    env,
    detached: true, // own process group, so a test can kill the whole deploy like a cancelled job
  });
  if (child.pid === undefined) throw new Error('bash did not start');
  let stdout = '';
  let stderr = '';
  let exited: Finished | null = null;
  const waiting: Array<{ marker: string; resolve: () => void; reject: (error: Error) => void }> =
    [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    for (const w of waiting) if (stdout.includes(w.marker)) w.resolve();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const finished = Promise.withResolvers<Finished>();
  child.on('close', (code) => {
    exited = { code, stdout, stderr };
    // A script that dies before its marker must fail the test with its stderr, not hang it.
    for (const w of waiting) w.reject(new Error(`exited ${code} before ${w.marker}: ${stderr}`));
    finished.resolve(exited);
  });
  return {
    pid: child.pid,
    reached: (marker) => {
      const gate = Promise.withResolvers<void>();
      if (stdout.includes(marker)) gate.resolve();
      else if (exited) gate.reject(new Error(`exited ${exited.code} before ${marker}: ${stderr}`));
      else waiting.push({ marker, resolve: gate.resolve, reject: gate.reject });
      return gate.promise;
    },
    done: finished.promise,
  };
}

/** A deploy that takes the lock, records start/end timestamps, holds it and exits. */
function fakeDeploy(
  box: Sandbox,
  tag: string,
  holdSeconds: number,
  extra: Record<string, string> = {},
): RunningDeploy {
  const script = [
    'set -e',
    `source "${LOCK_LIB}"`,
    `odroid_deploy_lock_acquire ${tag} || exit $?`,
    `echo "${tag} start $(date +%s.%N)" >>"${box.trace}"`,
    'echo HELD',
    `sleep ${holdSeconds}`,
    `echo "${tag} end $(date +%s.%N)" >>"${box.trace}"`,
  ].join('\n');
  return start(script, lockEnv(box.lock, extra));
}

interface Span {
  start?: number;
  end?: number;
}

function spans(trace: string): Record<string, Span> {
  const result: Record<string, Span> = {};
  for (const line of readFileSync(trace, 'utf8').split('\n').filter(Boolean)) {
    const [tag, kind, stamp] = line.split(' ');
    if (!tag || !stamp || (kind !== 'start' && kind !== 'end'))
      throw new Error(`bad trace: ${line}`);
    result[tag] = { ...result[tag], [kind]: Number(stamp) };
  }
  return result;
}

describe.skipIf(!HAVE_FLOCK)('host deploy lock (scripts/odroid-deploy-lock.sh)', () => {
  test(
    'two concurrent deploys from different repositories are serialized',
    async () => {
      const box = sandbox();
      try {
        const first = fakeDeploy(box, 'hcb', 2);
        await first.reached('HELD');
        const second = fakeDeploy(box, 'esb', 0.2);
        const [one, two] = await Promise.all([first.done, second.done]);
        expect([one.code, two.code]).toEqual([0, 0]);
        const trace = spans(box.trace);
        expect(trace['esb']?.start).toBeGreaterThanOrEqual(trace['hcb']?.end ?? Infinity);
        expect(two.stderr).toContain('waiting for the host deploy lock, held by: hcb');
        expect(two.stderr).toContain('acquired the host deploy lock after');
      } finally {
        box.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a waiter gives up with 75 and never breaks a live holder',
    async () => {
      const box = sandbox();
      try {
        const holder = fakeDeploy(box, 'hcb', 4);
        await holder.reached('HELD');
        const waiter = fakeDeploy(box, 'esb', 0, { ODROID_DEPLOY_LOCK_MAX_WAIT: '2' });
        const gaveUp = await waiter.done;
        expect(gaveUp.code).toBe(75);
        expect(gaveUp.stderr).toContain('gave up');
        expect((await holder.done).code).toBe(0);
        expect(readFileSync(box.trace, 'utf8')).not.toContain('esb');
      } finally {
        box.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an owner file naming a dead pid does not block and is not trusted',
    async () => {
      const box = sandbox();
      try {
        mkdirSync(join(box.dir, 'lock'), { recursive: true });
        writeFileSync(
          `${box.lock}.owner`,
          'repo=hcb\npid=999999\nstart_ticks=1\nstarted=2026-10-24T20:00:00Z\n',
        );
        const result = await fakeDeploy(box, 'esb', 0).done;
        expect(result.code).toBe(0);
        expect(readFileSync(box.trace, 'utf8')).toContain('esb start');
      } finally {
        box.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test('an owner file whose pid was recycled (other start ticks) is judged stale', () => {
    const box = sandbox();
    try {
      mkdirSync(join(box.dir, 'lock'), { recursive: true });
      // This very test process is alive, but its start ticks differ from the recorded ones.
      writeFileSync(
        `${box.lock}.owner`,
        `repo=hcb\npid=${process.pid}\nstart_ticks=1\nstarted=2026-10-24T20:00:00Z\n`,
      );
      const out = spawnSync('bash', ['-c', `source "${LOCK_LIB}"; _odl_describe_owner`], {
        env: lockEnv(box.lock),
        encoding: 'utf8',
      });
      expect(out.stdout).toContain('stale');
    } finally {
      box.cleanup();
    }
  });

  test(
    'a holder killed with its whole process group frees the lock at once',
    async () => {
      const box = sandbox();
      try {
        const holder = fakeDeploy(box, 'hcb', 30);
        await holder.reached('HELD');
        // flock(2) lives on the open file description: it is released when every holder of
        // it is gone, so a cancelled job (process group killed) must not wedge the host.
        process.kill(-holder.pid, 'SIGKILL');
        await holder.done;
        expect((await fakeDeploy(box, 'esb', 0).done).code).toBe(0);
      } finally {
        box.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'release lets the next deploy in before the holder process exits',
    async () => {
      const box = sandbox();
      try {
        const script = [
          `source "${LOCK_LIB}"`,
          'odroid_deploy_lock_acquire hcb || exit $?',
          'odroid_deploy_lock_release',
          'echo RELEASED',
          'sleep 2',
        ].join('\n');
        const holder = start(script, lockEnv(box.lock));
        await holder.reached('RELEASED');
        const started = performance.now();
        expect((await fakeDeploy(box, 'esb', 0).done).code).toBe(0);
        // The holder still sleeps for 2 s: getting in sooner proves the lock was dropped.
        expect(performance.now() - started).toBeLessThan(1500);
        await holder.done;
      } finally {
        box.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test('the lock file is created world-writable so both deploy users can open it', () => {
    const box = sandbox();
    try {
      const out = spawnSync(
        'bash',
        ['-c', `umask 077; source "${LOCK_LIB}"; odroid_deploy_lock_acquire esb`],
        { env: lockEnv(box.lock), encoding: 'utf8' },
      );
      expect(out.status).toBe(0);
      expect(existsSync(box.lock)).toBe(true);
      const mode = spawnSync('stat', ['-c', '%a', box.lock, `${box.lock}.owner`], {
        encoding: 'utf8',
      });
      expect(mode.stdout.trim().split('\n')).toEqual(['666', '666']);
    } finally {
      box.cleanup();
    }
  });
});
