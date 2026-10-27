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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

  // `_odl_start_ticks` is what tells a live holder from a recycled pid, so it must return the
  // kernel's own starttime (field 22 of /proc/<pid>/stat) whatever the process is called and
  // whatever the caller's shell state is.
  describe('process start ticks (_odl_start_ticks)', () => {
    /** Independent reference: the comm field may hold spaces and ")", so cut at the LAST ")". */
    function referenceStartTicks(pid: number): string {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trimEnd();
      return afterComm.split(' ')[19] ?? '';
    }

    function bashStartTicks(pid: number, prelude = ':'): { status: number | null; stdout: string } {
      const out = spawnSync(
        'bash',
        ['-c', `source "${LOCK_LIB}"; ${prelude}; _odl_start_ticks ${pid}`],
        { encoding: 'utf8' },
      );
      return { status: out.status, stdout: out.stdout };
    }

    test('returns the kernel starttime of a live process', () => {
      const ticks = bashStartTicks(process.pid);
      expect(ticks.status).toBe(0);
      expect(ticks.stdout).toMatch(/^[0-9]+$/);
      expect(ticks.stdout).toBe(referenceStartTicks(process.pid));
    });

    test('is not thrown off by a comm holding spaces and parentheses', async () => {
      const box = sandbox();
      const comm = 'a) b (c d) 9';
      const binary = join(box.dir, comm);
      const bashPath = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' });
      copyFileSync(bashPath.stdout.trim(), binary);
      // A copy of bash under the odd name: once it prints READY it has certainly exec'd, so the
      // kernel reports the odd comm. (The 'spawn' event alone is not proof of exec on every runtime.)
      const sleeper = spawn(binary, ['-c', 'echo READY; read -r _']);
      try {
        await new Promise<void>((resolve, reject) => {
          let seen = '';
          sleeper.stdout.on('data', (chunk: Buffer) => {
            seen += chunk.toString();
            if (seen.includes('READY')) resolve();
          });
          sleeper.once('error', reject);
          sleeper.once('close', () => reject(new Error('the process exited before READY')));
        });
        const pid = sleeper.pid;
        if (pid === undefined) throw new Error('the sleeper did not start');
        expect(readFileSync(`/proc/${pid}/stat`, 'utf8')).toContain(`(${comm})`);
        const ticks = bashStartTicks(pid);
        expect(ticks.status).toBe(0);
        expect(ticks.stdout).toBe(referenceStartTicks(pid));
      } finally {
        sleeper.kill('SIGKILL');
        box.cleanup();
      }
    });

    test('does not depend on the caller IFS or glob settings', () => {
      const expected = referenceStartTicks(process.pid);
      for (const prelude of ["IFS=''", "IFS=':'", "IFS=$'\\n'", 'set -f']) {
        const ticks = bashStartTicks(process.pid, prelude);
        expect({ prelude, status: ticks.status, stdout: ticks.stdout }).toEqual({
          prelude,
          status: 0,
          stdout: expected,
        });
      }
    });

    test('does not clobber the callers positional parameters', () => {
      const out = spawnSync(
        'bash',
        [
          '-c',
          `source "${LOCK_LIB}"; set -- keep these; _odl_start_ticks ${process.pid} >/dev/null; printf '%s|' "$@"`,
        ],
        { encoding: 'utf8' },
      );
      expect(out.stdout).toBe('keep|these|');
    });

    test('fails with no output for a process that is gone', () => {
      const ticks = bashStartTicks(999_999_999);
      expect(ticks.status).not.toBe(0);
      expect(ticks.stdout).toBe('');
    });
  });
});
