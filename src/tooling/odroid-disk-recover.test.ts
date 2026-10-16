// Drives scripts/odroid-disk-recover.sh through its outcomes with stand-in `systemctl`,
// `curl` and `sleep`: unit states live in fixture files, a disk "appears" when its UUID
// file is created in a temp by-uuid dir (optionally by the n-th sleep, i.e. late), and
// Telegram sends are recorded. Asserts which units get started, what the admin is told
// and the exit status the systemd unit reports.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '../../scripts/odroid-disk-recover.sh');
const WD500 = 'wd500-uuid';
const STORAGE = 'storage-uuid';
const PM2 = 'pm2-www-data.service';
const RUNNER = 'actions.runner.alex-mextner-ExpenseSyncBot.odroid.service';
const SWAP = 'mnt-storage-odroid\\x2drt-swapfile.swap';

// Stand-in systemctl: `is-active` answers from $FIX/units/<unit> (missing = active),
// `start` marks the unit active unless $FIX/fail/<unit> exists. Every call is logged.
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FIX/systemctl.log"
case "$1" in
  is-system-running) echo running ;;
  is-active)
    s=$(cat "$FIX/units/$2" 2>/dev/null || echo active)
    echo "$s"
    [ "$s" = active ] ;;
  start)
    if [ -f "$FIX/fail/$2" ]; then echo "Job for $2 failed." >&2; exit 1; fi
    echo active > "$FIX/units/$2" ;;
  *) exit 1 ;;
esac
`;

// Stand-in sleep: counts calls; the APPEAR_AFTER-th call plugs in the APPEAR_UUID disk.
const SLEEP_STUB = `#!/usr/bin/env bash
n=$(( $(cat "$FIX/sleeps" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FIX/sleeps"
if [ -n "\${APPEAR_AFTER:-}" ] && [ "$n" -ge "$APPEAR_AFTER" ]; then touch "$BY_UUID_DIR/$APPEAR_UUID"; fi
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

interface Scenario {
  /** Disks whose UUID link exists from the start. */
  present: string[];
  /** Unit → state other than active. */
  units?: Record<string, string>;
  /** Units whose `systemctl start` fails. */
  failing?: string[];
  /** Disk plugged in by the n-th sleep. */
  late?: { uuid: string; afterSleeps: number };
  args?: string[];
  waitSec?: number;
  telegramStatus?: string;
  alertEnv?: string;
}

function run(scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'odroid-disk-recover-'));
  const bin = join(dir, 'bin');
  const fix = join(dir, 'fixtures');
  const byUuid = join(dir, 'by-uuid');
  for (const d of [bin, fix, byUuid, join(fix, 'units'), join(fix, 'fail')]) mkdirSync(d);
  writeFileSync(join(bin, 'systemctl'), SYSTEMCTL_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), SLEEP_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), CURL_STUB, { mode: 0o755 });
  for (const uuid of scenario.present) writeFileSync(join(byUuid, uuid), '');
  for (const [unit, state] of Object.entries(scenario.units ?? {})) {
    writeFileSync(join(fix, 'units', unit), `${state}\n`);
  }
  for (const unit of scenario.failing ?? []) writeFileSync(join(fix, 'fail', unit), '');
  const alertEnv = join(dir, 'alert.env');
  writeFileSync(alertEnv, scenario.alertEnv ?? 'BOT_TOKEN="test-token"\nBOT_ADMIN_ID=42\n');

  const result = spawnSync('bash', [SCRIPT, ...(scenario.args ?? [])], {
    env: {
      PATH: `${bin}:${process.env['PATH']}`,
      FIX: fix,
      BY_UUID_DIR: byUuid,
      WD500_UUID: WD500,
      STORAGE_UUID: STORAGE,
      WAIT_SEC: String(scenario.waitSec ?? 20),
      POLL_SEC: '5',
      ALERT_ENV_FILE: alertEnv,
      TG_STATUS: scenario.telegramStatus ?? '200',
      APPEAR_AFTER: scenario.late ? String(scenario.late.afterSleeps) : '',
      APPEAR_UUID: scenario.late?.uuid ?? '',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const lines = (file: string) =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    started: lines(join(fix, 'systemctl.log'))
      .filter((l) => l.startsWith('start '))
      .map((l) => l.slice('start '.length)),
    telegram: lines(join(fix, 'telegram')).map((l): string => JSON.parse(l)),
    sleeps: Number(existsSync(join(fix, 'sleeps')) ? readFileSync(join(fix, 'sleeps'), 'utf8') : 0),
  };
}

describe('odroid-disk-recover.sh', () => {
  test('both disks present and every unit active: changes nothing, tells nobody', () => {
    const r = run({ present: [WD500, STORAGE] });
    expect(r.status).toBe(0);
    expect(r.started).toEqual([]);
    expect(r.telegram).toEqual([]);
    expect(r.sleeps).toBe(0);
    expect(r.stdout).toContain('nothing to do');
  });

  // 2026-10-16: the device job timed out at boot, every dependent ended "Dependency
  // failed", and the WD500 showed up seconds later with nothing retrying them.
  test('WD500 shows up late: starts the units the boot left down, warns the admin', () => {
    const r = run({
      present: [STORAGE],
      late: { uuid: WD500, afterSleeps: 2 },
      units: { 'mnt-wd500.mount': 'failed', [PM2]: 'inactive', [RUNNER]: 'inactive' },
    });
    expect(r.status).toBe(0);
    expect(r.started).toEqual(['mnt-wd500.mount', PM2, RUNNER]);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain('started them: mnt-wd500.mount pm2-www-data.service');
    expect(r.stdout).toContain(`WARNING: started ${PM2}`);
  });

  test('WD500 never shows up: starts nothing on it, alerts and fails', () => {
    const r = run({
      present: [STORAGE],
      units: { 'mnt-wd500.mount': 'failed', [PM2]: 'inactive' },
      waitSec: 20,
    });
    expect(r.status).toBe(1);
    expect(r.started).toEqual([]);
    expect(r.sleeps).toBe(4);
    expect(r.stdout).toContain(
      `ERROR: wd500 never appeared: no /dev/disk/by-uuid/${WD500} after 20s`,
    );
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain(
      `USB disk did not appear at boot (waited 20s): wd500 (${WD500})`,
    );
    expect(r.telegram[0]).toContain(PM2);
    expect(r.telegram[0]).toContain('systemctl start odroid-disk-recover');
  });

  test('a unit that will not start: the rest still start, alert names it, fails', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { [PM2]: 'failed', [RUNNER]: 'failed' },
      failing: [PM2],
    });
    expect(r.status).toBe(1);
    expect(r.started).toEqual([PM2, RUNNER]);
    expect(r.stdout).toContain(`ERROR: could not start ${PM2}`);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain(`would not start after the disk appeared: ${PM2}`);
    expect(r.telegram[0]).toContain(`started them: ${RUNNER}`);
  });

  test('storage swap left down: started on its own, WD500 untouched', () => {
    const r = run({ present: [WD500, STORAGE], units: { [SWAP]: 'inactive' } });
    expect(r.status).toBe(0);
    expect(r.started).toEqual([SWAP]);
    expect(r.telegram).toHaveLength(1);
  });

  test('--dry-run: starts nothing, sends nothing, prints what it would do', () => {
    const r = run({
      args: ['--dry-run'],
      present: [STORAGE],
      units: { [SWAP]: 'inactive', [PM2]: 'failed' },
    });
    expect(r.status).toBe(1);
    expect(r.started).toEqual([]);
    expect(r.telegram).toEqual([]);
    expect(r.stdout).toContain(`[dry-run] would start ${SWAP}`);
    expect(r.stdout).toContain('[dry-run] would alert: 🚨');
    expect(r.stdout).toContain(`wd500 (${WD500})`);
  });

  test('Telegram down: retries, logs the alert at err, still fails', () => {
    const r = run({ present: [STORAGE], telegramStatus: '000' });
    expect(r.status).toBe(1);
    expect(r.telegram).toHaveLength(3);
    expect(r.stdout).toContain('ERROR: Telegram alert failed (HTTP 000 after 3 attempts)');
  });

  test('no alert credentials: says so at err instead of failing silently', () => {
    const r = run({ present: [STORAGE], alertEnv: 'OTHER=1\n' });
    expect(r.status).toBe(1);
    expect(r.telegram).toEqual([]);
    expect(r.stdout).toContain('ERROR: cannot alert: BOT_TOKEN or BOT_ADMIN_ID missing');
  });

  test('--test-alert sends one test message and touches no unit', () => {
    const r = run({ args: ['--test-alert'], present: [] });
    expect(r.status).toBe(0);
    expect(r.started).toEqual([]);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain('alert path test');
  });
});
