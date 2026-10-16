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
const PM2 = 'pm2-www-data.service';
const RUNNER = 'actions.runner.alex-mextner-ExpenseSyncBot.odroid.service';
const SWAP = 'mnt-storage-odroid\\x2drt-swapfile.swap';

// Stand-in systemctl: `is-active` answers from $FIX/units/<unit> (missing = active),
// `list-jobs <unit>` lists a job when $FIX/jobs/<unit> exists, `start` marks the unit
// active (and its job done) unless $FIX/fail/<unit> exists. Every call is logged.
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FIX/systemctl.log"
case "$1" in
  is-system-running) echo running ;;
  is-active)
    s=$(cat "$FIX/units/$2" 2>/dev/null || echo active)
    echo "$s"
    [ "$s" = active ] ;;
  list-jobs)
    u="\${@: -1}"
    if [ -f "$FIX/jobs/$u" ]; then echo "7 $u start waiting"; fi ;;
  start)
    rm -f "$FIX/jobs/$2"
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
  /** Units whose `systemctl start` fails. */
  failing?: string[];
  /** Units with a start job already queued (the chain's own start). */
  queued?: string[];
  /** Disk plugged in by the n-th sleep. */
  late?: { uuid: string; afterSleeps: number };
  args?: string[];
  waitSec?: number;
  telegramStatus?: string;
  telegramBody?: string;
  alertEnv?: string;
}

function run(scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'odroid-disk-recover-'));
  const bin = join(dir, 'bin');
  const fix = join(dir, 'fixtures');
  const byUuid = join(dir, 'by-uuid');
  for (const d of [bin, fix, byUuid, join(fix, 'units'), join(fix, 'fail'), join(fix, 'jobs')]) {
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
  for (const unit of scenario.queued ?? []) writeFileSync(join(fix, 'jobs', unit), '');
  const alertEnv = join(dir, 'alert.env');
  writeFileSync(alertEnv, scenario.alertEnv ?? 'BOT_TOKEN="test-token"\r\nBOT_ADMIN_ID=42\r\n');

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
      TG_BODY: scenario.telegramBody ?? '',
      APPEAR_AFTER: scenario.late ? String(scenario.late.afterSleeps) : '',
      APPEAR_UUID: scenario.late?.uuid ?? '',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const lines = (file: string) =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const calls = lines(join(fix, 'systemctl.log'));
  const outcome = {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    /** Every `systemctl start` attempted, including ones that failed. */
    startCalls: calls.filter((l) => l.startsWith('start ')).map((l) => l.slice('start '.length)),
    telegram: lines(join(fix, 'telegram')).map((l): string => JSON.parse(l)),
    curlArgv: lines(join(fix, 'curl-argv')),
    curlConfig: lines(join(fix, 'curl-config')),
    sleeps: Number(existsSync(join(fix, 'sleeps')) ? readFileSync(join(fix, 'sleeps'), 'utf8') : 0),
  };
  rmSync(dir, { recursive: true, force: true });
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
      units: { 'mnt-wd500.mount': 'inactive', [PM2]: 'inactive', [RUNNER]: 'inactive' },
      queued: ['mnt-wd500.mount', PM2, RUNNER],
    });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual(['mnt-wd500.mount', PM2, RUNNER]);
    expect(r.telegram).toEqual([]);
    expect(r.stderr).toBe('');
  });

  test('a unit down with no job: the chain missed it, start it and warn the admin', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { 'mnt-wd500.mount': 'failed', [PM2]: 'inactive', [RUNNER]: 'inactive' },
    });
    expect(r.status).toBe(0);
    expect(r.startCalls).toEqual(['mnt-wd500.mount', PM2, RUNNER]);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain(
      "the disk's unit chain missed these, started them: mnt-wd500.mount pm2-www-data.service",
    );
    expect(r.stderr).toContain(`WARNING: started ${PM2}`);
  });

  test('a queued chain job that fails: alert names the unit, fails', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { [PM2]: 'inactive' },
      queued: [PM2],
      failing: [PM2],
    });
    expect(r.status).toBe(1);
    expect(r.telegram[0]).toContain(`would not start after the disk appeared: ${PM2}`);
  });

  test('units are checked only after the boot transaction has finished', () => {
    const r = run({ present: [WD500, STORAGE], units: { [PM2]: 'failed' } });
    const settle = r.calls.indexOf('is-system-running --wait');
    expect(settle).toBeGreaterThanOrEqual(0);
    expect(settle).toBeLessThan(r.calls.findIndex((c) => c.startsWith('is-active ')));
    expect(r.calls.filter((c) => c.startsWith('is-system-running'))).toHaveLength(1);
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

  test('a unit still activating whose job then fails: alert names it, fails', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { 'ha-compose.service': 'activating' },
      failing: ['ha-compose.service'],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ERROR: could not start ha-compose.service');
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain('would not start after the disk appeared: ha-compose.service');
  });

  test('WD500 never shows up: starts nothing on it, alerts and fails', () => {
    const r = run({
      present: [STORAGE],
      units: { 'mnt-wd500.mount': 'failed', [PM2]: 'inactive' },
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
    expect(r.telegram[0]).toContain(PM2);
    expect(r.telegram[0]).not.toContain(SWAP);
    expect(r.telegram[0]).toContain('systemctl start odroid-disk-recover');
  });

  test('neither disk shows up: one alert names both and all their units', () => {
    const r = run({ present: [], waitSec: 10 });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain(`wd500 (${WD500}) storage (${STORAGE})`);
    expect(r.telegram[0]).toContain(PM2);
    expect(r.telegram[0]).toContain(SWAP);
  });

  test('a unit that will not start: the rest still start, alert names it, fails', () => {
    const r = run({
      present: [WD500, STORAGE],
      units: { [PM2]: 'failed', [RUNNER]: 'failed' },
      failing: [PM2],
    });
    expect(r.status).toBe(1);
    expect(r.startCalls).toEqual([PM2, RUNNER]);
    expect(r.stderr).toContain(`ERROR: could not start ${PM2}`);
    expect(r.telegram).toHaveLength(1);
    expect(r.telegram[0]).toContain(`would not start after the disk appeared: ${PM2}`);
    expect(r.telegram[0]).toContain(`started them: ${RUNNER}`);
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
      units: { [SWAP]: 'inactive', [PM2]: 'failed' },
    });
    expect(r.status).toBe(1);
    expect(r.startCalls).toEqual([]);
    expect(r.telegram).toEqual([]);
    expect(r.stdout).toContain(`[dry-run] would start ${SWAP}`);
    expect(r.stdout).toContain('[dry-run] would alert: 🚨');
    expect(r.stdout).toContain(`wd500 (${WD500})`);
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
    const r = run({ present: [WD500, STORAGE], units: { [PM2]: 'failed' }, telegramStatus: '000' });
    expect(r.startCalls).toEqual([PM2]);
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
