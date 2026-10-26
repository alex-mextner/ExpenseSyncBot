// Stand-ins for the odroid's pm2 and curl, plus a fake /proc, shared by the deploy tooling
// tests (deploy-evidence, deploy-health, deploy-step).
//
// The fake pm2 answers `jlist` from a JSON scenario and counts the polls, so a scenario can
// change over time ("dies after the 3rd poll", "restarts twice from the 2nd"). Every call is
// appended to calls.log together with two facts the deploy must guarantee: pm2 never sees the
// runner's RUNNER_TRACKING_ID (it would hand it to the apps it starts, and the runner SIGKILLs
// them when the job ends) and never inherits the file descriptor that holds the host deploy
// lock (a pm2 daemon started by the step would keep the lock after the step ended).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What the fake pm2 reports and how it changes with the number of `jlist` polls so far. */
export interface Scenario {
  /** Process names in the list (default expensesyncbot + bank-sync). */
  apps?: string[];
  /** Names left out of the list. */
  missing?: string[];
  /** Status per app (default online). */
  status?: Record<string, string>;
  /** After this many polls `dies_app` (default expensesyncbot) is `errored`. */
  dies_after?: number;
  dies_app?: string;
  /** restart_time of every app before any scenario restarts. */
  restarts?: number;
  /** From this poll on, expensesyncbot's restart_time is one higher. */
  restart_after?: number;
  /** From this poll on, expensesyncbot's restart_time is two higher (a crash loop). */
  loop_after?: number;
  /** Poll indexes (0-based) where `jlist` fails like an unreachable daemon. */
  unreachable_polls?: number[];
  /** `jlist` fails on every poll. */
  unreachable?: boolean;
  /** `jlist` never answers (a wedged daemon). */
  hang?: boolean;
  /** Printed before the JSON, like pm2's "[PM2] Spawning PM2 daemon" banner. */
  banner?: boolean;
  /** Directory of the apps' log files (set by the fixture). */
  logs?: string;
  /** pm_uptime in epoch ms (default: five seconds before the poll). */
  started_ms?: number;
  /** The apps' log files stop changing: an alive but silent app. */
  stalled?: boolean;
  /** Planted in pm2_env.env and in top-level pm2_env keys: must never reach evidence. */
  env_secret?: string;
  /** `pm2 reload` exits 1. */
  reload_fails?: boolean;
  /** /health answers `ok` only from this poll on. */
  health_after?: number;
  /** While /health does not answer ok it answers HTTP 503 (true) or refuses the connection. */
  answers_503?: boolean;
  /** Body of /health once it answers (default {"status":"ok","uptime":3.5}). */
  health_body?: string;
}

const FAKE_PM2 = String.raw`#!/usr/bin/env python3
import fcntl, json, os, sys, time
from pathlib import Path

fx = Path(os.environ["FX"])
args = sys.argv[1:]
sc_file = fx / "scenario.json"
sc = json.loads(sc_file.read_text()) if sc_file.exists() else {}
lock = os.environ.get("ODROID_DEPLOY_LOCK_FILE", "")
holds_lock_fd = "no"
for name in os.listdir("/proc/self/fd"):
    try:
        if lock and os.readlink("/proc/self/fd/" + name) == lock:
            holds_lock_fd = "yes"
    except OSError:
        pass
# A fresh open file description conflicts with a flock held anywhere else: "held" means the
# deploy step that called us still owns the host deploy lock.
lock_state = "free"
if lock and os.path.exists(lock):
    with open(lock) as probe:
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(probe, fcntl.LOCK_UN)
        except OSError:
            lock_state = "held"
with open(fx / "calls.log", "a") as handle:
    handle.write("pm2 %s | tracking=%s lock_fd=%s lock=%s\n" % (" ".join(args), os.environ.get("RUNNER_TRACKING_ID", ""), holds_lock_fd, lock_state))

if args[:1] == ["reload"] and sc.get("reload_fails"):
    sys.exit(1)
if args[:1] == ["describe"]:
    print("describe " + args[1] + " env BOT_TOKEN=" + sc.get("env_secret", ""))
if args[:1] != ["jlist"]:
    sys.exit(0)

counter = fx / "polls"
n = int(counter.read_text()) if counter.exists() else 0
counter.write_text(str(n + 1))
if sc.get("hang"):
    time.sleep(60)
if sc.get("unreachable") or n in sc.get("unreachable_polls", []):
    print("Error: connect ECONNREFUSED", file=sys.stderr)
    sys.exit(1)
if sc.get("banner"):
    print("[PM2] Spawning PM2 daemon with pm2_home=/home/x/.pm2")
    print("[PM2] PM2 Successfully daemonized")
logs = Path(sc.get("logs", "."))
entries = []
for index, name in enumerate(sc.get("apps", ["expensesyncbot", "bank-sync"])):
    if name in sc.get("missing", []):
        continue
    main = name == "expensesyncbot"
    status = sc.get("status", {}).get(name, "online")
    if name == sc.get("dies_app", "expensesyncbot") and n >= sc.get("dies_after", 10**9):
        status = "errored"
    restarts = sc.get("restarts", 0)
    if main and n >= sc.get("restart_after", 10**9):
        restarts += 1
    if main and n >= sc.get("loop_after", 10**9):
        restarts += 2
    out_log = logs / ("out.log" if main else name + "-out.log")
    err_log = logs / ("error.log" if main else name + "-error.log")
    if not sc.get("stalled") and out_log.exists():
        # A live app keeps writing: its log's mtime moves with every poll.
        stamp = time.time() + n
        os.utime(out_log, (stamp, stamp))
    secret = sc.get("env_secret", "")
    entries.append({
        "pid": 1000 + index,
        "name": name,
        "pm_id": index,
        "monit": {"memory": 123456789, "cpu": 3},
        "pm2_env": {
            "status": status,
            "restart_time": restarts,
            "unstable_restarts": 0,
            "pm_uptime": sc.get("started_ms", int(time.time() * 1000) - 5000),
            "created_at": int(time.time() * 1000) - 86400000,
            "exec_mode": "fork_mode",
            "pm_exec_path": "/var/www/ExpenseSyncBot/start.sh",
            "pm_cwd": "/var/www/ExpenseSyncBot",
            "pm_out_log_path": str(out_log),
            "pm_err_log_path": str(err_log),
            "env": {"BOT_TOKEN": secret, "NODE_ENV": "production"},
            "BOT_TOKEN": secret,
            "ENCRYPTION_KEY": secret,
        },
    })
print(json.dumps(entries))
`;

const FAKE_CURL = String.raw`#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

fx = Path(os.environ["FX"])
sc_file = fx / "scenario.json"
sc = json.loads(sc_file.read_text()) if sc_file.exists() else {}
counter = fx / "polls"
n = int(counter.read_text()) if counter.exists() else 0
url = sys.argv[-1]
with open(fx / "calls.log", "a") as handle:
    handle.write("curl %s\n" % url)
if url.endswith("/health") and n >= sc.get("health_after", 0):
    print(sc.get("health_body", '{"status":"ok","uptime":3.5}'), end="")
    sys.exit(0)
sys.exit(22 if sc.get("answers_503") else 7)
`;

export interface DeployFixture {
  dir: string;
  /** Directory holding the fake pm2 and curl; put it first on PATH. */
  bin: string;
  /** Path of the fake pm2 binary. */
  pm2: string;
  /** Directory of the apps' log files (the repository's logs/). */
  logs: string;
  /** A fake /proc for the host-saturation check. */
  proc: string;
  /** Environment for a script run (FX, PATH with the fakes first, no RUNNER_TRACKING_ID). */
  env: Record<string, string>;
  setScenario: (scenario: Scenario) => void;
  setHost: (io: number, load: number) => void;
  /** Lines of calls.log: every fake pm2 / curl call. */
  calls: () => string[];
  cleanup: () => void;
}

/** A temp tree with fake pm2 + curl in `bin`, a logs dir and a fake /proc. */
export function createDeployFixture(): DeployFixture {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-fixture-'));
  const bin = join(dir, 'bin');
  const logs = join(dir, 'logs');
  const proc = join(dir, 'proc');
  for (const path of [bin, logs, join(proc, 'pressure')]) mkdirSync(path, { recursive: true });
  const pm2 = join(bin, 'pm2');
  writeFileSync(pm2, FAKE_PM2, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
  const inherited = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined || key === 'RUNNER_TRACKING_ID' ? [] : [[key, value]],
    ),
  );
  const fixture: DeployFixture = {
    dir,
    bin,
    pm2,
    logs,
    proc,
    env: { ...inherited, PATH: `${bin}:${process.env['PATH'] ?? ''}`, FX: dir },
    setScenario: (scenario) => {
      writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ logs, ...scenario }));
      rmSync(join(dir, 'polls'), { force: true });
    },
    setHost: (io, load) => {
      writeFileSync(
        join(proc, 'pressure/io'),
        `some avg10=${io.toFixed(2)} avg60=1.00 avg300=1.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`,
      );
      writeFileSync(join(proc, 'loadavg'), `${load} 1.0 1.0 1/100 123\n`);
    },
    calls: () => {
      try {
        return readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  fixture.setScenario({});
  fixture.setHost(0, 0.1);
  return fixture;
}

/** A pm2 log line as `time: true` + `log_date_format: 'YYYY-MM-DD HH:mm:ss Z'` write it. */
export function pm2LogLine(at: Date, payload: object | string): string {
  const stamp = at.toISOString().slice(0, 19).replace('T', ' ');
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `${stamp} +00:00: ${body}`;
}
