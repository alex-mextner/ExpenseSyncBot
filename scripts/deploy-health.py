#!/usr/bin/env python3
"""Decide whether the pm2 apps a deploy just reloaded are healthy, dead, or merely slow.

Why: deploy.yml used to end at `pm2 reload` with no check at all, so a release that crash-looped
was announced as "Deployed". HyperCalendarBot's fixed 163 s poll showed the opposite failure on
2026-10-24: the odroid was I/O saturated by an overlapping deploy, a healthy release needed
longer, and the activator rolled it back. A slow start is not a failure; a dead or crash-looping
app is. The verdict therefore combines (same rules as HyperCalendarBot's scripts/deploy-health.py,
with pm2 in place of docker):

  process     every --app is in pm2's list and `online` (not errored, stopped or waiting to
              restart), and its restart count has not climbed by 2 since the reload (crash loop; the
              baseline is `counts`, taken right after the reload, else the first poll's)
  /health     must answer {"status":"ok"} (the bot's own endpoint, src/web/oauth-callback.ts)
  stability   health stays ok and every app stays online for --stable seconds; a single restart
              only restarts that window
  fresh logs  pino lines written since the app (re)started: any fatal (level >= 60) fails; more
              than --max-error-logs lines at level >= 50 fails (an error storm); fewer are only
              reported. Lines older than the start (earlier releases) never count
  budget      --base-budget seconds; past it the wait continues only while the host is saturated
              (PSI io or load) AND the apps are alive AND made progress within --stall seconds,
              never past --hard-cap. Dead stays immediate: nothing waits for an errored app.

Accessed via: .github/workflows/deploy.yml, after `pm2 reload`, inside the step that holds the
host deploy lock. There is no automatic rollback: a failing verdict fails the job, and the
workflow saves scripts/deploy-evidence.py's bundle before anything else restarts.

Assumptions:
  * The apps log with pm2's `time: true` prefix ("YYYY-MM-DD HH:mm:ss +00:00: <pino json>"), as
    ecosystem.config.cjs configures. A line without a prefix belongs to the line before it.
  * pm2 is momentarily unreachable under heavy load; only --pm2-failures polls in a row count.

Output: progress lines, then one `RESULT verdict=<ok|dead|unhealthy> health=<status> apps=<name:
status:restarts,...> elapsed=<n>s reason=<text>` line. Exit 0 ok, 3 dead, 4 unhealthy (alive,
never became healthy within the budget).
"""

import argparse
import datetime
import json
import os
import re
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
import deploy_pm2  # a sibling file; must follow dont_write_bytecode

DEAD_STATUSES = ("errored", "stopped", "waiting restart")
START_TOLERANCE_SECONDS = 2  # log timestamps have one-second resolution
LOG_READ_BYTES = 1024 * 1024
# A noisy start can push a fatal line far from the end of the file: the window grows (doubling) until it
# reaches a line older than the release's start, up to this cap.
LOG_READ_MAX_BYTES = 64 * 1024 * 1024

STAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?\s*(Z|[+-]\d{2}:?\d{2})?"
)
LEVEL = re.compile(r'"level"\s*:\s*(\d+)')


def sanitize(text):
    return re.sub(r"[^A-Za-z0-9 ()._:-]", "?", str(text).strip())[:80] or "<none>"


def probe(url, timeout):
    code, out, _ = deploy_pm2.run(
        ["curl", "-fsS", "--max-time", str(min(20, timeout)), url], timeout
    )
    return out.strip() if code == 0 else ""


def health_status(body):
    """The `status` of the bot's /health JSON, or the raw (clipped) body when it is something else."""
    try:
        data = json.loads(body)
    except ValueError:
        return body[:80]
    status = data.get("status") if isinstance(data, dict) else None
    return status if isinstance(status, str) else body[:80]


def line_time(line):
    """Epoch seconds of a pm2-prefixed log line, or None when the line has no timestamp."""
    match = STAMP.match(line)
    if not match:
        return None
    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    zone = match.group(7)
    if zone is None:
        return datetime.datetime(year, month, day, hour, minute, second).timestamp()  # local time
    if zone == "Z":
        offset = datetime.timedelta(0)
    else:
        digits = zone[1:].replace(":", "")
        offset = datetime.timedelta(hours=int(digits[:2]), minutes=int(digits[2:]))
        offset = -offset if zone[0] == "-" else offset
    stamp = datetime.datetime(
        year, month, day, hour, minute, second, tzinfo=datetime.timezone(offset)
    )
    return stamp.timestamp()


def read_log_window(path, since):
    """Lines of the file's tail, widened (doubling) until it reaches back before `since`; None if unreadable."""
    window = LOG_READ_BYTES
    try:
        with open(path, "rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            while True:
                start = max(0, size - window)
                handle.seek(start)
                lines = handle.read(size - start).decode("utf-8", errors="replace").splitlines()
                if start and lines:
                    lines = lines[1:]  # cut in the middle
                first = next((t for t in map(line_time, lines) if t is not None), None)
                # Done when the window starts at the file's start, or already reaches back before the release.
                if (
                    start == 0
                    or window >= LOG_READ_MAX_BYTES
                    or (first is not None and first < since - START_TOLERANCE_SECONDS)
                ):
                    return lines
                window *= 2
    except OSError:
        return None


def fresh_levels(path, since):
    """(lines at level >= 50, lines at level >= 60) among those written at or after `since`."""
    lines = read_log_window(path, since)
    if lines is None:
        return 0, 0
    errors = fatal = 0
    fresh = False
    for line in lines:
        stamp = line_time(line)
        if stamp is not None:
            fresh = stamp >= since - START_TOLERANCE_SECONDS
        if not fresh:
            continue
        match = LEVEL.search(line)
        if match and int(match.group(1)) >= 50:
            errors += 1
            fatal += int(match.group(1)) >= 60
    return errors, fatal


def log_paths(process):
    env = deploy_pm2.pm2_env(process)
    return [env[key] for key in ("pm_out_log_path", "pm_err_log_path") if env.get(key)]


def log_marker(processes):
    """Cheap progress signal: size and mtime of every app log change while an app is working."""
    marker = []
    for process in processes:
        for path in log_paths(process):
            try:
                info = os.stat(path)
                marker.append((path, info.st_size, info.st_mtime_ns))
            except OSError:
                marker.append((path, None, None))
    return tuple(marker)


def host_saturated(proc_dir, io_threshold, load_factor):
    """True while the host is I/O-bound or overloaded (what made HyperCalendarBot's release slow)."""
    try:
        for line in (Path(proc_dir) / "pressure/io").read_text().splitlines():
            if (
                line.startswith("some")
                and float(re.search(r"avg10=([0-9.]+)", line).group(1)) >= io_threshold
            ):
                return True
    except (OSError, AttributeError, ValueError):
        pass
    try:
        load1 = float((Path(proc_dir) / "loadavg").read_text().split()[0])
        return load1 > load_factor * (os.cpu_count() or 1)
    except (OSError, ValueError, IndexError):
        return False


def describe(apps):
    return (
        ",".join(
            f"{sanitize(name)}:{sanitize(status)}:{restarts}" for name, status, restarts in apps
        )
        or "<none>"
    )


def result(code, verdict, health, apps, reason, started):
    elapsed = int(time.monotonic() - started)
    print(
        f"RESULT verdict={verdict} health={sanitize(health)} apps={describe(apps)} elapsed={elapsed}s reason={reason}"
    )
    return code


def counts(args):
    """Print `<app>=<restart count>` per app: the reload's baseline, taken before the first poll.

    Without it the first poll's counts become the baseline, so restarts between the reload and
    that poll are invisible to the crash-loop check. Exit 1 (nothing printed) when pm2 or an app
    cannot be read; `wait` then falls back to the first-poll baseline.
    """
    processes = deploy_pm2.pm2_processes(args.pm2, args.command_timeout)
    if processes is None:
        return 1
    lines = []
    for name in args.app:
        process = deploy_pm2.find(processes, name)
        if process is None:
            return 1
        restarts = deploy_pm2.pm2_env(process).get("restart_time")
        lines.append(f"{name}={restarts if isinstance(restarts, int) else 0}")
    print("\n".join(lines))
    return 0


def parse_baseline(pairs):
    baseline = {}
    for pair in pairs:
        name, _, value = pair.rpartition("=")
        if not name or not value.isdigit():
            raise SystemExit(
                f"deploy-health: --baseline wants <app>=<restart count>, got {sanitize(pair)!r}"
            )
        baseline[name] = int(value)
    return baseline


class WaitState:
    """What one `wait` run remembers between polls."""

    def __init__(self, args):
        self.started = time.monotonic()
        self.wall_start = time.time()
        self.baseline = parse_baseline(args.baseline)
        self.seen = {}
        self.health = ""
        self.apps = []
        self.wanted = []
        self.ok_since = None
        self.last_marker = self.last_shape = None
        self.last_progress = self.started
        self.last_report = 0.0
        self.unreachable = 0

    def verdict(self, code, name, reason):
        return result(code, name, self.health, self.apps, reason, self.started)


def scan_apps(args, state, processes):
    """Record every app's status/restarts; a dead app or a crash loop is a verdict, else None."""
    state.wanted = []
    state.apps = []
    for name in args.app:
        process = deploy_pm2.find(processes, name)
        if process is None:
            return state.verdict(3, "dead", f"{sanitize(name)} is not in the pm2 list")
        env = deploy_pm2.pm2_env(process)
        status = env.get("status") or "unknown"
        restarts = env.get("restart_time") if isinstance(env.get("restart_time"), int) else 0
        state.baseline.setdefault(name, restarts)
        state.seen.setdefault(name, restarts)
        state.apps.append((name, status, restarts))
        state.wanted.append(process)
        if status in DEAD_STATUSES:
            return state.verdict(3, "dead", f"{sanitize(name)} is {sanitize(status)}")
        if restarts - state.baseline[name] >= 2:
            return state.verdict(
                3,
                "dead",
                f"crash loop: {sanitize(name)} restart count {state.baseline[name]}->{restarts}",
            )
        if restarts != state.seen[name]:
            state.ok_since = (
                None  # one restart is not yet a loop, but it restarts the stability window
            )
            state.seen[name] = restarts
    return None


def stable_verdict(args, state):
    """The verdict once health has stayed ok for --stable seconds: judged by the fresh log lines."""
    errors = fatal = 0
    for process in state.wanted:
        started_ms = deploy_pm2.pm2_env(process).get("pm_uptime")
        since = started_ms / 1000 if isinstance(started_ms, (int, float)) else state.wall_start - 5
        for path in log_paths(process):
            found, fatals = fresh_levels(path, since)
            errors, fatal = errors + found, fatal + fatals
    if fatal:
        return state.verdict(3, "dead", f"{fatal} fatal (level>=60) log lines since start")
    if errors > args.max_error_logs:
        return state.verdict(
            4,
            "unhealthy",
            f"{errors} level>=50 log lines since start (limit {args.max_error_logs})",
        )
    note = f"{errors} level>=50 log lines since start" if errors else "no level>=50 log lines"
    return state.verdict(0, "ok", f"stable for {args.stable:g}s, {note}")


def budget_verdict(args, state, now, elapsed):
    """Past the base budget: a verdict unless the host is saturated and the apps still progress."""
    if elapsed < args.base_budget:
        return None
    saturated = host_saturated(args.proc_dir, args.io_psi_threshold, args.load_factor)
    progressing = (now - state.last_progress) <= args.stall
    if elapsed >= args.hard_cap:
        return state.verdict(4, "unhealthy", f"hard cap {args.hard_cap:g}s reached")
    if not (saturated and progressing):
        why = (
            "host not saturated"
            if not saturated
            else f"no progress for {int(now - state.last_progress)}s"
        )
        return state.verdict(
            4,
            "unhealthy",
            f"not healthy after {int(elapsed)}s of {args.base_budget:g}s budget ({why})",
        )
    if elapsed - state.last_report >= 20 or state.last_report == 0:
        print(
            f"HEALTH extended past the {args.base_budget:g}s budget at {int(elapsed)}s: host saturated, apps alive and progressing"
        )
        state.last_report = elapsed
    return None


def track_progress(state, now, marker):
    shape = (state.health, tuple(status for _, status, _ in state.apps))
    if marker != state.last_marker or shape != state.last_shape:
        state.last_progress = now
    state.last_marker, state.last_shape = marker, shape


def judge_poll(args, state, now, elapsed):
    """Probe /health and decide after a poll where every app is present and not dead: verdict or None."""
    state.health = health_status(probe(args.url, args.command_timeout))
    track_progress(state, now, log_marker(state.wanted))

    healthy = state.health == "ok" and all(status == "online" for _, status, _ in state.apps)
    if healthy:
        state.ok_since = state.ok_since if state.ok_since is not None else now
        if now - state.ok_since >= args.stable:
            return stable_verdict(args, state)
        return None
    state.ok_since = None
    verdict = budget_verdict(args, state, now, elapsed)
    if verdict is not None:
        return verdict
    if elapsed - state.last_report >= 20:
        print(
            f"HEALTH t={int(elapsed)}s health={sanitize(state.health)} apps={describe(state.apps)}"
        )
        state.last_report = elapsed
    return None


def poll_once(args, state):
    """One poll: a verdict (exit code), or None to keep waiting."""
    now = time.monotonic()
    processes = deploy_pm2.pm2_processes(args.pm2, args.command_timeout)
    if processes is None:
        state.unreachable += 1
        if state.unreachable >= args.pm2_failures:
            return state.verdict(
                3, "dead", f"pm2 did not answer {state.unreachable} polls in a row"
            )
        return None
    state.unreachable = 0
    verdict = scan_apps(args, state, processes)
    if verdict is not None:
        return verdict
    return judge_poll(args, state, now, now - state.started)


def wait(args):
    state = WaitState(args)
    while True:
        verdict = poll_once(args, state)
        if verdict is not None:
            return verdict
        time.sleep(args.poll)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["wait", "counts"])
    parser.add_argument("--pm2", default="pm2", help="pm2 binary")
    parser.add_argument(
        "--app", action="append", required=True, help="pm2 app that must come up; repeatable"
    )
    parser.add_argument("--url", help="the bot's /health URL (wait)")
    parser.add_argument(
        "--baseline",
        action="append",
        default=[],
        help="<app>=<restart count> taken right after the reload (see `counts`); repeatable",
    )
    parser.add_argument("--base-budget", type=float, default=240.0)
    parser.add_argument("--hard-cap", type=float, default=900.0)
    parser.add_argument("--poll", type=float, default=4.0)
    parser.add_argument("--stable", type=float, default=30.0)
    parser.add_argument("--stall", type=float, default=120.0)
    parser.add_argument("--max-error-logs", type=int, default=20)
    parser.add_argument("--io-psi-threshold", type=float, default=20.0)
    parser.add_argument("--load-factor", type=float, default=1.5)
    parser.add_argument("--pm2-failures", type=int, default=3)
    parser.add_argument(
        "--command-timeout", type=float, default=30.0, help="seconds one pm2/curl call may take"
    )
    parser.add_argument("--proc-dir", default="/proc")
    args = parser.parse_args(argv)
    if args.command == "counts":
        return counts(args)
    if not args.url:
        parser.error("wait needs --url")
    return wait(args)


if __name__ == "__main__":
    sys.exit(main())
