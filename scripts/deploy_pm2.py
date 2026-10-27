"""pm2 access shared by scripts/deploy-evidence.py and scripts/deploy-health.py.

Accessed via: the two deploy scripts, which import it from their own directory (Python puts a
script's directory first on sys.path); never run on its own.

Assumptions:
  * `pm2 jlist` is the only pm2 command the scripts need: one JSON array on one stdout line,
    possibly preceded by "[PM2] ..." banner lines when the call had to start the daemon.
  * pm2_env carries the app's whole environment (tokens, keys) at its top level and under "env".
    Evidence therefore copies an allow-list of keys, never a deny-list: a new secret in the
    environment must not be able to leak through a key nobody thought of.
  * Every pm2 call runs without RUNNER_TRACKING_ID. The GitHub runner SIGKILLs every process that
    still carries the job's tracking id when the job ends; a pm2 call that has to start the
    daemon would hand it on to the daemon and, through it, to the apps.
"""

import json
import os
import subprocess

PM2_ENV_KEEP = (
    "status",
    "restart_time",
    "unstable_restarts",
    "pm_uptime",
    "created_at",
    "exec_mode",
    "pm_exec_path",
    "pm_cwd",
    "pm_out_log_path",
    "pm_err_log_path",
)


def child_env():
    return {key: value for key, value in os.environ.items() if key != "RUNNER_TRACKING_ID"}


def run(cmd, timeout=30):
    """(returncode, stdout, stderr). A missing binary or a timeout is a failed run, not an exception."""
    try:
        done = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            errors="replace",
            env=child_env(),
            stdin=subprocess.DEVNULL,
            # A non-zero exit is data here (the caller reads the return code), not an exception.
            check=False,
            # Explicit on purpose: a pm2 daemon started from here must not inherit the host deploy
            # lock's file descriptor (it would keep the lock after the deploy step ended).
            close_fds=True,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return 1, "", type(error).__name__
    return done.returncode, done.stdout, done.stderr


def pm2_processes(pm2, timeout=30):
    """The parsed `pm2 jlist` list, or None when pm2 cannot be reached or answers garbage."""
    code, out, _ = run([pm2, "jlist"], timeout)
    if code != 0:
        return None
    for line in reversed(out.splitlines()):
        line = line.strip()
        if not line.startswith("["):
            continue
        try:
            parsed = json.loads(line)
        except ValueError:
            continue
        if isinstance(parsed, list):
            return parsed
    return None


def find(processes, name):
    for process in processes or []:
        if isinstance(process, dict) and process.get("name") == name:
            return process
    return None


def pm2_env(process):
    env = process.get("pm2_env")
    return env if isinstance(env, dict) else {}


def summarize(process):
    """Allow-listed, secret-free description of one pm2 process."""
    env = pm2_env(process)
    monit = process.get("monit") if isinstance(process.get("monit"), dict) else {}
    summary = {key: process.get(key) for key in ("name", "pm_id", "pid")}
    summary.update({key: env.get(key) for key in PM2_ENV_KEEP})
    summary.update({"memory": monit.get("memory"), "cpu": monit.get("cpu")})
    return summary
