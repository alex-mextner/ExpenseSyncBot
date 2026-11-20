// Drives scripts/odroid-disk-recover.sh through its outcomes with stand-in `systemctl`,
// `curl` and `sleep`: unit states live in fixture files, a disk "appears" when its UUID
// file is created in a temp by-uuid dir (optionally by the n-th sleep, i.e. late), and
// Telegram sends are recorded. Asserts which units get started, what the admin is told
// and the exit status the systemd unit reports.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '../../scripts/odroid-disk-recover.sh');
const WD500 = 'wd500-uuid';
const STORAGE = 'storage-uuid';
const CONTAINERD = 'containerd.service';
const DOCKER = 'docker.service';
const SWAP = 'mnt-storage-odroid\\x2drt-swapfile.swap';

// Restart= timeline step shared by the stubs: `apply <unit> <line>` puts the unit into the
// line's first word (default activating) and leaves a job queued on it when the second word
// is "job".
const APPLY_STEP = `apply() {
  s=\${2%% *}; echo "\${s:-activating}" > "$FIX/units/$1"
  if [ "\${2#* }" = job ]; then touch "$FIX/jobs/$1"; else rm -f "$FIX/jobs/$1"; fi
}`;

// Stand-in systemctl: `is-active` answers from $FIX/units/<unit> (missing = active),
// `list-jobs <unit>` lists a job when $FIX/jobs/<unit> exists, `start` takes $FIX/delay/<unit>
// real seconds if that exists and marks the unit active (and its job done). A start fails
// when $FIX/restart/<unit> or $FIX/fail/<unit> exists: with Restart= (restart/) the unit
// takes the first step of that timeline, the sleep count at that moment goes to
// $FIX/failed-at/<unit> and the stub sleep moves the unit along from there; without it
// (fail/) the unit is left failed. Every call is logged.
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FIX/systemctl.log"
${APPLY_STEP}
case "$1" in
  is-system-running)
    # SETTLE_DELAY: how long the boot transaction takes to finish, in real seconds. command -p
    # bypasses the stub sleep: the settle must take real time, or the #172 test proves nothing.
    if [ -n "\${SETTLE_DELAY:-}" ]; then command -p sleep "$SETTLE_DELAY"; fi
    echo running ;;
  is-active)
    s=$(cat "$FIX/units/$2" 2>/dev/null || echo active)
    echo "$s"
    [ "$s" = active ] ;;
  list-jobs)
    u="\${@: -1}"
    if [ -f "$FIX/jobs/$u" ]; then echo "7 $u start waiting"; fi ;;
  start)
    if [ -f "$FIX/delay/$2" ]; then command -p sleep "$(cat "$FIX/delay/$2")"; fi
    rm -f "$FIX/jobs/$2"
    if [ -f "$FIX/restart/$2" ]; then
      apply "$2" "$(sed -n 1p "$FIX/restart/$2")"
      echo "$(cat "$FIX/sleeps" 2>/dev/null || echo 0)" > "$FIX/failed-at/$2"
      echo "Job for $2 failed." >&2; exit 1
    fi
    if [ -f "$FIX/fail/$2" ]; then echo failed > "$FIX/units/$2"; echo "Job for $2 failed." >&2; exit 1; fi
    echo active > "$FIX/units/$2" ;;
  *) exit 1 ;;
esac
`;

// Stand-in sleep: counts calls; the APPEAR_AFTER-th call plugs in the APPEAR_UUID disk, and
// the k-th call after a unit's failed start applies step k+1 of its $FIX/restart/<unit>
// timeline (past its end the unit stays as it is): what its Restart= does meanwhile.
const SLEEP_STUB = `#!/usr/bin/env bash
${APPLY_STEP}
n=$(( $(cat "$FIX/sleeps" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FIX/sleeps"
if [ -n "\${APPEAR_AFTER:-}" ] && [ "$n" -ge "$APPEAR_AFTER" ]; then touch "$BY_UUID_DIR/$APPEAR_UUID"; fi
for f in "$FIX"/failed-at/*; do
  [ -f "$f" ] || continue
  u=\${f##*/}
  s=$(sed -n "$((n - $(cat "$f") + 1))"p "$FIX/restart/$u")
  if [ -n "$s" ]; then apply "$u" "$s"; fi
done
`;

// Stand-in curl: records the Telegram message text, its argv and the config it reads from
// stdin (where the URL with the token goes); answers $TG_BODY (default {"ok":true}; none
// for status 000, i.e. no connection) and, after a newline, $TG_STATUS, as
// `-w '\n%{http_code}'` does.
const CURL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FIX/curl-argv"
cat >> "$FIX/curl-config"
prev=""
for arg in "$@"; do
  if [ "$prev" = "-d" ]; then printf '%s' "$arg" | jq -c '.text' >> "$FIX/telegram"; fi
  prev="$arg"
done
status=\${TG_STATUS:-200}
body=\${TG_BODY:-}
[ -n "$body" ] || body='{"ok":true}'
[ "$status" = 000 ] && body=''
printf '%s\\n%s' "$body" "$status"
`;

interface Scenario {
  /** Disks whose UUID link exists from the start. */
  present: string[];
  /** Unit → state other than active. */
  units?: Record<string, string>;
  /** Units whose `systemctl start` fails and that end up failed (no Restart=). */
  failing?: string[];
  /**
   * Units whose `systemctl start` fails while Restart= is at it: the step each takes right
   * after the failed start, then after the 1st, 2nd, … sleep; past the end it stays put
   * ([]: activating for good). A step is a state, or "<state> job" for one with a job queued.
   */
  restarting?: Record<string, string[]>;
  /** Real seconds a unit's `systemctl start` blocks before it answers. */
  startDelay?: Record<string, number>;
  /** Units with a start job already queued (the chain's own start). */
  queued?: string[];
  /** Disk plugged in by the n-th sleep. */
  late?: { uuid: string; afterSleeps: number };
  args?: string[];
  waitSec?: number;
  pollSec?: number;
  restartWaitSec?: number;
  /** Real seconds `systemctl is-system-running --wait` takes. */
  settleDelay?: number;
  telegramStatus?: string;
  telegramBody?: string;
  alertEnv?: string;
}

interface Sandbox {
  dir: string;
  bin: string;
  fix: string;
  byUuid: string;
  alertEnv: string;
}

/** Lay out the fake bin dir (stub systemctl/sleep/curl), fixtures and by-uuid dir for a scenario. */
function buildSandbox(scenario: Scenario): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'odroid-disk-recover-'));
  const bin = join(dir, 'bin');
  const fix = join(dir, 'fixtures');
  const byUuid = join(dir, 'by-uuid');
  const fixtureDirs = ['units', 'fail', 'restart', 'failed-at', 'delay', 'jobs'].map((d) =>
    join(fix, d),
  );
  for (const d of [bin, fix, byUuid, ...fixtureDirs]) {
    mkdirSync(d);
  }
  writeFileSync(join(bin, 'systemctl'), SYSTEMCTL_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), SLEEP_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), CURL_STUB, { mode: 0o755 });
  for (const uuid of scenario.present) writeFileSync(join(byUuid, uuid), '');
  for (const [unit, state] of Object.entries(scenario.units ?? {})) {
    writeFileSync(join(fix, 'units', unit), `${state}\n`);
  }
  for (const unit of scenario.failing ?? []) writeFileSync(join(fix, 'fail', unit), '');
  for (const [unit, states] of Object.entries(scenario.restarting ?? {})) {
    writeFileSync(join(fix, 'restart', unit), states.map((s) => `${s}\n`).join(''));
  }
  for (const [unit, seconds] of Object.entries(scenario.startDelay ?? {})) {
    writeFileSync(join(fix, 'delay', unit), String(seconds));
  }
  for (const unit of scenario.queued ?? []) writeFileSync(join(fix, 'jobs', unit), '');
  const alertEnv = join(dir, 'alert.env');
  writeFileSync(alertEnv, scenario.alertEnv ?? 'BOT_TOKEN="test-token"\r\nBOT_ADMIN_ID=42\r\n');
  return { dir, bin, fix, byUuid, alertEnv };
}

/** Environment the script under test sees; every knob comes from the scenario. */
function scenarioEnv(scenario: Scenario, sandbox: Sandbox): Record<string, string> {
  return {
    PATH: `${sandbox.bin}:${process.env['PATH']}`,
    FIX: sandbox.fix,
    BY_UUID_DIR: sandbox.byUuid,
    WD500_UUID: WD500,
    STORAGE_UUID: STORAGE,
    WAIT_SEC: String(scenario.waitSec ?? 20),
    POLL_SEC: String(scenario.pollSec ?? 5),
    RESTART_WAIT_SEC: String(scenario.restartWaitSec ?? 20),
    SETTLE_DELAY: scenario.settleDelay ? String(scenario.settleDelay) : '',
    ALERT_ENV_FILE: sandbox.alertEnv,
    TG_STATUS: scenario.telegramStatus ?? '200',
    TG_BODY: scenario.telegramBody ?? '',
    APPEAR_AFTER: scenario.late ? String(scenario.late.afterSleeps) : '',
    APPEAR_UUID: scenario.late?.uuid ?? '',
  };
}

function readLines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function run(scenario: Scenario) {
  const sandbox = buildSandbox(scenario);
  const fix = sandbox.fix;

  const result = spawnSync('bash', [SCRIPT, ...(scenario.args ?? [])], {
    env: scenarioEnv(scenario, sandbox),
    encoding: 'utf8',
    timeout: 20_000,
  });
  const calls = readLines(join(fix, 'systemctl.log'));
  const outcome = {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    /** Every `systemctl start` attempted, including ones that failed. */
    startCalls: calls.filter((l) => l.startsWith('start ')).map((l) => l.slice('start '.length)),
    telegram: readLines(join(fix, 'telegram')).map((l): string => JSON.parse(l)),
    curlArgv: readLines(join(fix, 'curl-argv')),
    curlConfig: readLines(join(fix, 'curl-config')),
    sleeps: Number(existsSync(join(fix, 'sleeps')) ? readFileSync(join(fix, 'sleeps'), 'utf8') : 0),
  };
  rmSync(sandbox.dir, { recursive: true, force: true });
  return outcome;
}

describe('odroid-disk-recover.sh', () => {
  test('both disks present and every unit active: changes nothing, tells nobody', () => {
    const r = run({ present: [WD500, STORAGE] });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual([]);
    expect(r.telegram).toEqual([]);
    expect(r.sleeps).toBe(0);
    expect(r.stdout).toContain('nothing to do');
  });

  // 2026-10-16: the WD500 showed up after its device job had timed out. The unit chain now
  // starts its units whenever it appears, so the guard only joins the chain's queued jobs.
  test('WD500 shows up late, chain jobs queued: waits for them, tells nobody', () => {
    const r = run({
      present: [STORAGE],
      late: { uuid: WD500, afterSleeps: 2 },
      units: { 'mnt-wd500.mount': 'inactive', [CONTAINERD]: 'inactive', [DOCKER]: 'inactive' },
      queued: ['mnt-wd500.mount', CONTAINERD, DOCKER],
    });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual(['mnt-wd500.mount', CONTAINERD, DOCKER]);
    expect(r.telegram).toEqual([]);
    expect(r.stderr).toBe('');
  });

  test('a unit down with no job: the chain missed it, start it and warn the admin', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { 'mnt-wd500.mount': 'failed', [CONTAINERD]: 'inactive', [DOCKER]: 'inactive' },
    });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual(['mnt-wd500.mount', CONTAINERD, DOCKER]);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain(
      "the disk's unit chain missed these, started them: mnt-wd500.mount containerd.service",
    );
    expect(r.stderr).toContain(`WARNING: started ${CONTAINERD}`);
  });

  // The bot runs on bananapi-m4 since 2026-11-20 (#287): starting these here would run a second copy.
  test('the retired bot units are never checked or started, even when they are down', () => {
    const retired = [
      'caddy.service',
      'pm2-www-data.service',
      'actions.runner.alex-mextner-ExpenseSyncBot.odroid.service',
    ];
    const r = run({
      present: [WD500, STORAGE],
      units: { ...Object.fromEntries(retired.map((u) => [u, 'inactive'])), [DOCKER]: 'inactive' },
    });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual([DOCKER]);
    for (const unit of retired) expect(r.calls.join('\n')).not.toContain(unit);
  });

  test('a queued chain job that fails: alert names the unit, fails', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { [CONTAINERD]: 'inactive' },
      queued: [CONTAINERD],
      failing: [CONTAINERD],
    });
    expect(r.status).toBe(1);
    expect(r.telegram[0]).toContain(`would not start after the disk appeared: ${CONTAINERD}`);
  });

  test('units are checked only after the boot transaction has finished', () => {
    const r = run({ present: [WD500, STORAGE], units: { [CONTAINERD]: 'failed' } });
    const settle = r.calls.indexOf('is-system-running --wait');
    expect(settle).toBeGreaterThanOrEqual(0);
    expect(settle).toBeLessThan(r.calls.findIndex((c) => c.startsWith('is-active ')));
    expect(r.calls.filter((c) => c.startsWith('is-system-running'))).toHaveLength(1);
  });

  // #172: the settle wait used to be charged to WAIT_SEC, so a slow boot transaction cut
  // the second disk's wait short and it was reported missing although it was on its way.
  test('a slow boot transaction does not shorten the wait for the other disk', () => {
    const r = run({
      present: [STORAGE],
      late: { uuid: WD500, afterSleeps: 2 },
      waitSec: 2,
      pollSec: 1,
      settleDelay: 1,
    });
    expect(r.stderr).not.toContain('never appeared');
    expect(r.telegram).toEqual([]);
    expect(r.sleeps).toBe(2);
    expect(r.status).toBe(0);
  });

  test('a unit still activating: waits for that job, does not report it', () => {
    const r = run({ present: [WD500, STORAGE], units: { 'ha-compose.service': 'activating' } });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual(['ha-compose.service']);
    expect(r.telegram).toEqual([]);
  });

  test('a unit reloading is up: left alone', () => {
    const r = run({ present: [WD500, STORAGE], units: { 'ha-compose.service': 'reloading' } });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual([]);
    expect(r.telegram).toEqual([]);
  });

  test('a unit still activating whose job then fails for good: alert names it, fails', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { 'ha-compose.service': 'activating' },
      failing: ['ha-compose.service'],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "ERROR: could not start ha-compose.service (wd500), it was activating: journalctl -u 'ha-compose.service'",
    );
    // Failed with no job and no Restart= pending: nothing to wait for.
    expect(r.sleeps).toBe(0);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain('would not start after the disk appeared: ha-compose.service');
  });

  // #254: on the 2026-11-14 boot ha-compose's job failed twice, its own Restart= had it up
  // 40 s later, and the guard, having judged it by the failed job, stayed failed.
  test('a joined job fails but Restart= brings the unit up: not reported', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { 'ha-compose.service': 'activating' },
      restarting: { 'ha-compose.service': ['activating', 'activating', 'active'] },
    });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual(['ha-compose.service']);
    expect(r.sleeps).toBe(2);
    expect(r.stdout).toContain('ha-compose.service (wd500) came up after a failed start');
    expect(r.stderr).not.toContain('ERROR');
    expect(r.telegram).toEqual([]);
  });

  test('a unit already up again when its failed start returns: not reported', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { 'ha-compose.service': 'activating' },
      restarting: { 'ha-compose.service': ['active'] },
    });
    expect(r.status).toBe(0);
    expect(r.sleeps).toBe(0);
    expect(r.stderr).not.toContain('ERROR');
    expect(r.telegram).toEqual([]);
  });

  // A retry that starts and then fails runs its stop/cleanup as `deactivating` with no job,
  // before Restart= tries again: not a settled unit.
  test('a retry that fails and cleans up before the next one succeeds: not reported', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { 'ha-compose.service': 'activating' },
      restarting: { 'ha-compose.service': ['activating', 'deactivating', 'activating', 'active'] },
    });
    expect(r.status).toBe(0);
    expect(r.sleeps).toBe(3);
    expect(r.telegram).toEqual([]);
  });

  test('Restart= gives up after a few tries: alert names the unit, fails', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { 'ha-compose.service': 'activating' },
      restarting: { 'ha-compose.service': ['activating', 'activating', 'failed'] },
    });
    expect(r.status).toBe(1);
    expect(r.sleeps).toBe(2);
    expect(r.stderr).toContain(
      'ERROR: could not start ha-compose.service (wd500), it was activating and is now failed',
    );
    expect(r.telegram[0]).toContain('would not start after the disk appeared: ha-compose.service');
  });

  test('a unit Restart= never brings up within RESTART_WAIT_SEC: alert names it, fails', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { 'ha-compose.service': 'activating' },
      restarting: { 'ha-compose.service': [] },
      restartWaitSec: 20,
    });
    expect(r.status).toBe(1);
    expect(r.sleeps).toBe(4);
    expect(r.stderr).toContain(
      'ERROR: could not start ha-compose.service (wd500), it was activating and is still activating after the 20s Restart= wait',
    );
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain('would not start after the disk appeared: ha-compose.service');
  });

  test('units stuck in Restart= are waited for together: no unit holds up a later one', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: {
        [CONTAINERD]: 'activating',
        [DOCKER]: 'activating',
        'ha-compose.service': 'inactive',
      },
      restarting: { [CONTAINERD]: [], [DOCKER]: [] },
      restartWaitSec: 20,
    });
    expect(r.status).toBe(1);
    expect(r.startCalls).toEqual([CONTAINERD, DOCKER, 'ha-compose.service']);
    // ha-compose is started right after containerd's failed start was seen, not after its wait:
    // containerd was only looked at by the first check and the one right after its start failed.
    const haStart = r.calls.indexOf('start ha-compose.service');
    expect(r.calls.slice(0, haStart).filter((c) => c === `is-active ${CONTAINERD}`)).toHaveLength(
      2,
    );
    expect(r.sleeps).toBe(4);
    expect(r.telegram[0]).toContain(
      `would not start after the disk appeared: ${CONTAINERD} ${DOCKER}`,
    );
    expect(r.telegram[0]).toContain('started them: ha-compose.service');
  });

  test('a unit with no job whose start fails until Restart= brings it up: reported as started', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { [CONTAINERD]: 'failed' },
      restarting: { [CONTAINERD]: ['activating', 'active'] },
    });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual([CONTAINERD]);
    expect(r.stderr).toContain(`WARNING: started ${CONTAINERD}`);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain(`started them: ${CONTAINERD}`);
    expect(r.telegram[0]).not.toContain('would not start');
  });

  test('a failed start that leaves a restart job queued is waited for: not reported', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { 'ha-compose.service': 'activating' },
      restarting: { 'ha-compose.service': ['inactive job', 'inactive job', 'active'] },
    });
    expect(r.status).toBe(0);
    expect(r.sleeps).toBe(2);
    expect(r.telegram).toEqual([]);
  });

  test('a retry that cleans up and stops for good: alert names the unit, fails', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { 'ha-compose.service': 'activating' },
      restarting: { 'ha-compose.service': ['activating', 'deactivating', 'inactive'] },
    });
    expect(r.status).toBe(1);
    expect(r.sleeps).toBe(2);
    expect(r.stderr).toContain('it was activating and is now inactive');
  });

  test('a unit deactivating with no job at the first check is started as one the chain missed', () => {
    const r = run({ present: [WD500, STORAGE], units: { 'ha-compose.service': 'deactivating' } });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual(['ha-compose.service']);
    expect(r.stderr).toContain('WARNING: started ha-compose.service');
    expect(r.telegram[0]).toContain('started them: ha-compose.service');
  });

  test("another unit's slow start counts against a retry's RESTART_WAIT_SEC", () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { [CONTAINERD]: 'activating', 'ha-compose.service': 'inactive' },
      restarting: { [CONTAINERD]: [] },
      startDelay: { 'ha-compose.service': 2 },
      restartWaitSec: 2,
      pollSec: 1,
    });
    expect(r.status).toBe(1);
    // ha-compose's start blocked for 2 real seconds: pm2's wait was over before any poll.
    expect(r.sleeps).toBe(0);
    expect(r.stderr).toContain(
      `could not start ${CONTAINERD} (wd500), it was activating and is still activating after the 2s Restart= wait`,
    );
  });

  test('a missed unit whose Restart= gives up: reported as failed only', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { [CONTAINERD]: 'failed' },
      restarting: { [CONTAINERD]: ['activating', 'failed'] },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      `ERROR: could not start ${CONTAINERD} (wd500), it was failed and is now failed`,
    );
    expect(r.stderr).not.toContain('WARNING: started');
    expect(r.telegram[0]).toContain(`would not start after the disk appeared: ${CONTAINERD}`);
    expect(r.telegram[0]).not.toContain('started them');
  });

  test('WD500 shows up late and a unit on it needs a Restart=: started, not reported failed', () => {
    const r = run({
      present: [STORAGE],
      late: { uuid: WD500, afterSleeps: 2 },
      units: { 'ha-compose.service': 'inactive' },
      restarting: { 'ha-compose.service': ['activating', 'activating', 'active'] },
    });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual(['ha-compose.service']);
    expect(r.sleeps).toBe(4);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain('started them: ha-compose.service');
    expect(r.telegram[0]).not.toContain('would not start');
  });

  test('a disk that shows up while a Restart= wait runs is recovered, not reported missing', () => {
    const r = run({
      present: [WD500],
      late: { uuid: STORAGE, afterSleeps: 3 },
      waitSec: 5,
      units: { 'ha-compose.service': 'activating' },
      restarting: {
        'ha-compose.service': ['activating', 'activating', 'activating', 'activating', 'active'],
      },
    });
    expect(r.stderr).not.toContain('never appeared');
    expect(r.calls).toContain(`is-active ${SWAP}`);
    expect(r.sleeps).toBe(4);
    expect(r.telegram).toEqual([]);
    expect(r.status).toBe(0);
  });

  test('--dry-run never starts a unit, so there is no Restart= wait', () => {
    const r = run({
      args: ['--dry-run'],
      present: [WD500, STORAGE],
      units: { 'ha-compose.service': 'activating' },
      restarting: { 'ha-compose.service': [] },
    });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual([]);
    expect(r.sleeps).toBe(0);
  });

  test('WD500 never shows up: starts nothing on it, alerts and fails', () => {
    const r = run({
      present: [STORAGE],
      units: { 'mnt-wd500.mount': 'failed', [CONTAINERD]: 'inactive' },
      waitSec: 20,
    });
    expect(r.status).toBe(1);
    expect(r.startCalls).toEqual([]);
    expect(r.sleeps).toBe(4);
    expect(r.stderr).toContain(
      `ERROR: wd500 never appeared: no /dev/disk/by-uuid/${WD500} after 20s`,
    );
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain(
      `USB disk did not appear at boot (waited 20s): wd500 (${WD500})`,
    );
    expect(r.telegram[0]).toContain(CONTAINERD);
    expect(r.telegram[0]).not.toContain(SWAP);
    expect(r.telegram[0]).toContain('systemctl start odroid-disk-recover');
  });

  test('neither disk shows up: one alert names both and all their units', () => {
    const r = run({ present: [], waitSec: 10 });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain(`wd500 (${WD500}) storage (${STORAGE})`);
    expect(r.telegram[0]).toContain(CONTAINERD);
    expect(r.telegram[0]).toContain(SWAP);
  });

  test('a unit that will not start: the rest still start, alert names it, fails', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { [CONTAINERD]: 'failed', [DOCKER]: 'failed' },
      failing: [CONTAINERD],
    });
    expect(r.status).toBe(1);
    expect(r.startCalls).toEqual([CONTAINERD, DOCKER]);
    expect(r.stderr).toContain(`ERROR: could not start ${CONTAINERD}`);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain(`would not start after the disk appeared: ${CONTAINERD}`);
    expect(r.telegram[0]).toContain(`started them: ${DOCKER}`);
    // #172: one hint for the whole alert, not one per section.
    expect(r.telegram[0]?.split('journalctl -b -u odroid-disk-recover')).toHaveLength(2);
  });

  test('storage swap left down: started on its own, WD500 untouched', () => {
    const r = run({ present: [WD500, STORAGE], units: { [SWAP]: 'inactive' } });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual([SWAP]);
    expect(r.telegram).toHaveLength(1);
  });

  test('--dry-run with a gap: starts nothing, sends nothing, prints what it would do', () => {
    const r = run({
      args: ['--dry-run'],
      present: [STORAGE],
      units: { [SWAP]: 'inactive', [CONTAINERD]: 'failed' },
    });
    expect(r.status).toBe(1);
    expect(r.startCalls).toEqual([]);
    expect(r.telegram).toEqual([]);
    expect(r.stdout).toContain(`[dry-run] would start ${SWAP}`);
    expect(r.stdout).toContain('[dry-run] would alert: 🚨');
    expect(r.stdout).toContain(`wd500 (${WD500})`);
    // Nothing was started, so there is no journal of it to point at.
    expect(r.stdout).not.toContain('journalctl -b');
  });

  test('--dry-run with everything up: nothing to do, exit 0', () => {
    const r = run({ args: ['--dry-run'], present: [WD500, STORAGE] });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to do');
  });

  test('--dry-run with a unit still activating: says it would wait, starts nothing', () => {
    const r = run({
      args: ['--dry-run'],
      present: [WD500, STORAGE],
      units: { 'ha-compose.service': 'activating' },
    });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual([]);
    expect(r.stdout).toContain('[dry-run] ha-compose.service (wd500) has a job running');
  });

  test('the bot token stays out of curl argv; CRLF env values still work', () => {
    const r = run({ present: [STORAGE], waitSec: 5 });
    expect(r.curlArgv.join('\n')).not.toContain('test-token');
    expect(r.curlConfig).toEqual(['url = "https://api.telegram.org/bottest-token/sendMessage"']);
    expect(r.curlArgv.join('\n')).toMatch(/"chat_id": ?"42"/);
  });

  test('Telegram down: retries, logs the alert at err, still fails', () => {
    const r = run({ present: [STORAGE], telegramStatus: '000' });
    expect(r.status).toBe(1);
    expect(r.telegram).toHaveLength(3);
    expect(r.stderr).toContain(
      'ERROR: Telegram alert failed (HTTP 000, no Telegram answer, after 3 attempts)',
    );
  });

  test('HTTP 200 without Telegram\'s "ok": true is not a delivered alert', () => {
    const r = run({ present: [STORAGE], telegramBody: '<html>portal</html>' });
    expect(r.status).toBe(1);
    expect(r.telegram).toHaveLength(3);
    expect(r.stderr).toContain(
      'ERROR: Telegram alert failed (HTTP 200, no Telegram answer, after 3 attempts)',
    );
  });

  // #172: a 200 whose body says ok:false is not a delivery, whatever its description says.
  test('HTTP 200 with "ok": false is not a delivered alert, even with description "ok"', () => {
    const r = run({ present: [STORAGE], telegramBody: '{"ok":false,"description":"ok"}' });
    expect(r.status).toBe(1);
    expect(r.telegram).toHaveLength(3);
    expect(r.stderr).toContain('ERROR: Telegram alert failed (HTTP 200, ok, after 3 attempts)');
  });

  test('Telegram refuses the message: its reason is in the err line', () => {
    const r = run({
      present: [STORAGE],
      telegramStatus: '400',
      telegramBody: '{"ok":false,"description":"Bad Request: chat not found"}',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('(HTTP 400, Bad Request: chat not found, after 3 attempts)');
  });

  test('late recovery whose alert is lost fails the unit: nobody else would know', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { [CONTAINERD]: 'failed' },
      telegramStatus: '000',
    });
    expect(r.startCalls).toEqual([CONTAINERD]);
    expect(r.status).toBe(1);
  });

  test('no alert credentials: says so at err instead of failing silently', () => {
    const r = run({ present: [STORAGE], alertEnv: 'OTHER=1\n' });
    expect(r.status).toBe(1);
    expect(r.telegram).toEqual([]);
    expect(r.stderr).toContain('ERROR: cannot alert: BOT_TOKEN or BOT_ADMIN_ID missing');
  });

  test('--test-alert sends one test message and touches no unit', () => {
    const r = run({ args: ['--test-alert'], present: [] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain('alert path test');
  });

  test('--test-alert that cannot be delivered exits 1', () => {
    const r = run({ args: ['--test-alert'], present: [], telegramStatus: '500' });
    expect(r.status).toBe(1);
  });

  test.each([
    [['--bogus']],
    [['--dry-run', '--test-alert']],
    [['--test-alert', '--dry-run']],
  ])('bad arguments %p: usage, exit 2, nothing done', (args) => {
    const r = run({ args, present: [WD500, STORAGE] });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage:');
    expect(r.calls).toEqual([]);
    expect(r.telegram).toEqual([]);
  });
});
