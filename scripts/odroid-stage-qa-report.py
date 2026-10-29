#!/usr/bin/env python3
"""Read-only report of the shared stage slot, the odroid half of the per-PR stage QA.

Installed by hand (scripts/install-stage-qa.sh) as root-owned code and run as root through sudo by the stage
QA runner's driver (stage-qa-driver.py), on the strength of one sudoers line that allows exactly this file
and no arguments:

    hcb-qa ALL=(root) NOPASSWD: /usr/local/lib/esb-stage-qa/odroid-stage-qa-report.py ""

Root is only the door: before it reads anything the script drops to `www-data`, the account of pm2 and
of the checkouts (with root's pm2 home it would see no processes, and asking would spawn a second
daemon). Started as another user it simply stays that user.

There is no input: sudo resets the environment and passes no argument, and the script answers ONE
line on stdout, `STAGE_REPORT {json}`:

    sha          commit the stage pm2 process runs (HEAD of its code directory), null when the slot
                 is empty or runs from a place that is not the main checkout or one of its worktrees
    online       pm2 status of the process is `online`
    started_at   pm2 start time in ms (a redeploy or a crash restart changes it)
    restarts     pm2 restart counter (a redeploy resets it, a crash raises it)
    username     the stage bot's username (fixed here, proven against Telegram's getMe)
    peer         the stage bot's numeric id, the chat the driver talks to; null when not online
    cases        the PR's own scripts/stage-smoke-cases.json read from the commit (`git show <sha>:`),
                 validated by stage-smoke.py and held to the floor below; null when invalid
    cases_error  why `cases` is null
    slot_error   why `sha` is null

Everything in the report is DATA that the browser host validates again against its own config. The
script never writes, starts, stops or locks anything and never prints a token or any env value.

Exit codes: 0 reported, 2 a bad command line (argparse; sudo allows none), 3 not provisioned or the stage
bot's identity cannot be proven (missing files, cannot drop to www-data, pm2 or Telegram unreachable, token
and username disagree). Any other exit status is a bug in this script (or sudo refusing it); the driver
treats it as a refusal.
"""

import argparse
import functools
import importlib.util
import json
import os
import pwd
import re
import subprocess
import sys
from pathlib import Path

REPORT_PREFIX = "STAGE_REPORT "
EXIT_NOT_PROVISIONED = 3

DEFAULT_MAIN_DIR = "/var/www/ExpenseSyncBot"
DEFAULT_PM2 = "/var/www/.bun/bin/pm2"
# pm2 is a node script; stage-bot.yml puts the same two directories first on PATH.
PM2_PATH = "/var/www/.nvm/versions/node/v22.17.0/bin:/var/www/.bun/bin:/usr/local/bin:/usr/bin:/bin"
SERVICE_USER = "www-data"
STAGE_PROCESS = "expensesyncbot-stage"
STAGE_USERNAME = "ExpenseSyncStageBot"
DENY_USERNAMES = ("ExpenseSyncBot",)
CASES_PATH = "scripts/stage-smoke-cases.json"
MIN_CASES = 5
REQUIRED_CASES = (
    "start",
    "ping",
    "help-lists-commands",
    "categories-read-only-listing",
    "validation-connect-rejected-outside-group",
    "simple-intent-phrase",
    "expense-phrase-redirect",
)
# Every case must forbid these texts (the bot's own error answers), whatever else a PR adds to its list.
REQUIRED_FORBID = (
    "Traceback|Unhandled|\\[object Object\\]|Произошла ошибка|непредвиденная ошибка|Неизвестная ошибка|Не удалось обратиться|Не удалось определить|AI-сервис временно недоступен|AI не настроен|Нет соединения с сервисом|Авторизация истекла",
)
MAX_CASES_BYTES = 262144
COMMAND_TIMEOUT = 30

SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
SMOKE_FILE = Path(__file__).resolve().with_name("stage-smoke.py")
COMMON_FILE = Path(__file__).resolve().with_name("stage_qa_common.py")


class NotProvisioned(Exception):
    pass


# One instance for the whole run: the Refused class raised inside the engine must be the one caught here.
@functools.cache
def load_sibling(name, file):
    if not file.is_file():
        raise NotProvisioned(f"{file} not found; reinstall with scripts/install-stage-qa.sh")
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_smoke():
    return load_sibling("stage_smoke", SMOKE_FILE)


def load_common():
    return load_sibling("stage_qa_common", COMMON_FILE)


def drop_to_service_user(environ):
    """Become SERVICE_USER (the owner of pm2 and the checkouts) and return the environment that user would have."""
    try:
        account = pwd.getpwnam(SERVICE_USER)
        if account.pw_uid == 0:
            raise KeyError(SERVICE_USER)
        os.setgroups([])
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
    except (KeyError, OSError) as error:
        raise NotProvisioned(f"cannot drop to {SERVICE_USER} ({type(error).__name__})") from None
    return {key: value for key, value in environ.items() if key != "PM2_HOME"} | {
        "HOME": account.pw_dir
    }


def say(message):
    print(f"odroid-stage-qa-report: {message}", file=sys.stderr, flush=True)


def child_env(environ):
    env = {"PATH": PM2_PATH, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}
    for key in ("HOME", "PM2_HOME"):
        if key in environ:
            env[key] = environ[key]
    return env


def run(argv, environ, what):
    try:
        done = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=COMMAND_TIMEOUT,
            env=child_env(environ),
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise NotProvisioned(f"{what} could not run ({type(error).__name__})") from None
    return done


def pm2_processes(pm2, environ):
    """pm2's process list; None when its daemon is not running (asking would spawn one)."""
    home = environ.get("PM2_HOME") or os.path.join(environ.get("HOME", ""), ".pm2")
    if not os.path.exists(os.path.join(home, "rpc.sock")):
        return None
    done = run([pm2, "jlist"], environ, "pm2 jlist")
    if done.returncode != 0:
        raise NotProvisioned(f"pm2 jlist exited with status {done.returncode}")
    # pm2 may print banner lines before the JSON array, and its banner itself starts with "[PM2]".
    decoder = json.JSONDecoder()
    offset = 0
    for line in done.stdout.splitlines(keepends=True):
        if line.startswith("["):
            try:
                processes, _ = decoder.raw_decode(done.stdout[offset:])
            except ValueError:
                processes = None
            if type(processes) is list:
                return processes
        offset += len(line)
    raise NotProvisioned("pm2 jlist did not print a JSON list")


def code_dir_of(pm2_env):
    """The checkout the stage process runs from, as stage-bot.yml and start-stage.sh start it."""
    parts = [str(pm2_env.get("pm_exec_path") or "")]
    args = pm2_env.get("args")
    if isinstance(args, list):
        parts += [str(arg) for arg in args]
    elif isinstance(args, str):
        parts.append(args)
    tokens = " ".join(parts).split()
    for token in reversed(tokens):
        if token.endswith(("/index.ts", "/start-stage.sh")):
            return os.path.dirname(token)
    return None


def allowed_code_dir(code_dir, main_dir):
    """The real path of the main checkout or of a git worktree below its .claude/worktrees, else None."""
    real = os.path.realpath(code_dir)
    main = os.path.realpath(main_dir)
    worktrees = os.path.join(main, ".claude", "worktrees")
    if real == main:
        return real
    if real.startswith(worktrees + os.sep) and os.path.lexists(os.path.join(real, ".git")):
        return real
    return None


def git_head(code_dir, environ):
    done = run(["git", "-C", code_dir, "rev-parse", "--verify", "HEAD"], environ, "git rev-parse")
    head = done.stdout.strip()
    if done.returncode != 0 or not SHA_PATTERN.fullmatch(head):
        return None
    return head


def refuse_json_constant(name):
    raise ValueError(f"{name} is not valid JSON")


def committed_cases_text(code_dir, sha, environ):
    """(text, None) or (None, reason): the case file as committed, when it is there and of a sane size."""
    # Ask for the size first: `git show` output is buffered whole, and a PR chooses what is at that path.
    sized = run(
        ["git", "-C", code_dir, "cat-file", "-s", f"{sha}:{CASES_PATH}"], environ, "git cat-file"
    )
    if sized.returncode != 0:
        return None, f"{CASES_PATH} is not in commit {sha[:12]}"
    if not sized.stdout.strip().isdigit() or int(sized.stdout) > MAX_CASES_BYTES:
        return None, f"{CASES_PATH} is larger than {MAX_CASES_BYTES} bytes"
    done = run(["git", "-C", code_dir, "show", f"{sha}:{CASES_PATH}"], environ, "git show")
    if done.returncode != 0:
        return None, f"{CASES_PATH} is not in commit {sha[:12]}"
    return done.stdout, None


def read_cases(smoke, code_dir, sha, environ):
    """(cases, None) or (None, reason): the PR's list as committed, validated and held to the floor."""
    text, reason = committed_cases_text(code_dir, sha, environ)
    if text is None:
        return None, reason
    try:
        cases = json.loads(text, parse_constant=refuse_json_constant)
    except (ValueError, RecursionError):
        return None, f"{CASES_PATH} is not valid JSON"
    if type(cases) is not list:
        return None, f"{CASES_PATH} is not a list of cases"
    common = load_common()
    for case in cases:
        problem = common.case_problem(case, REQUIRED_FORBID)
        if problem:
            return None, problem
    try:
        cases = smoke.validate_cases(cases, CASES_PATH)
    except smoke.Refused as error:
        return None, str(error)
    if len(cases) < MIN_CASES:
        return None, f"{CASES_PATH} has {len(cases)} cases, at least {MIN_CASES} are required"
    names = {case["name"] for case in cases}
    missing = [name for name in REQUIRED_CASES if name not in names]
    if missing:
        return None, f"required case(s) missing: {', '.join(missing)}"
    return cases, None


def prove_identity(smoke, main_dir, get_me):
    """The stage bot's numeric id after proving the stage token is the stage bot and not production."""
    stage_file = Path(main_dir) / ".env.stage"
    prod_file = Path(main_dir) / ".env"
    # The production env is what the guard compares the stage identity with: without it the check would
    # silently become "the stage token is not any production token we know of", so it must be there.
    try:
        token = smoke.parse_env(stage_file).get("BOT_TOKEN", "")
        prod_env = smoke.parse_env(prod_file)
    except (OSError, ValueError) as error:
        raise NotProvisioned(
            f"{getattr(error, 'filename', None) or stage_file} is not readable"
        ) from None
    try:
        username = smoke.guard_target(
            {"BOT_USERNAME": STAGE_USERNAME, "BOT_TOKEN": token}, prod_env, DENY_USERNAMES
        )
        actual = get_me(token)
        peer = smoke.bot_id(token)
    except smoke.Refused as error:
        raise NotProvisioned(f"stage identity: {error}") from None
    if actual.lower() != username.lower():
        raise NotProvisioned(
            f"stage identity: the stage token belongs to @{actual}, not @{username}"
        )
    return peer


def report(main_dir, pm2, environ, get_me):
    smoke = load_smoke()
    out = {
        "sha": None,
        "online": False,
        "started_at": 0,
        "restarts": 0,
        "username": STAGE_USERNAME,
        "peer": None,
        "cases": None,
        "cases_error": None,
        "slot_error": None,
    }
    processes = pm2_processes(pm2, environ)
    if processes is None:
        out["slot_error"] = "the pm2 daemon is not running"
        return out
    stage = next(
        (p for p in processes if isinstance(p, dict) and p.get("name") == STAGE_PROCESS), None
    )
    if stage is None:
        out["slot_error"] = f"pm2 has no process {STAGE_PROCESS}"
        return out
    pm2_env = stage.get("pm2_env") if isinstance(stage.get("pm2_env"), dict) else {}
    code_dir = code_dir_of(pm2_env)
    allowed = allowed_code_dir(code_dir, main_dir) if code_dir else None
    if allowed is None:
        out["slot_error"] = (
            "the stage process does not run from the main checkout or one of its worktrees"
        )
        return out
    sha = git_head(allowed, environ)
    if sha is None:
        out["slot_error"] = "the code directory has no readable HEAD"
        return out
    out["sha"] = sha
    out["online"] = pm2_env.get("status") == "online"
    started, restarts = pm2_env.get("pm_uptime"), pm2_env.get("restart_time")
    out["started_at"] = started if type(started) is int and started >= 0 else 0
    out["restarts"] = restarts if type(restarts) is int and restarts >= 0 else 0
    if out["online"]:
        out["peer"] = prove_identity(smoke, main_dir, get_me)
        out["cases"], out["cases_error"] = read_cases(smoke, allowed, sha, environ)
    return out


def main(argv=None, environ=None, get_me=None, euid=os.geteuid, drop=drop_to_service_user):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--main-dir", default=DEFAULT_MAIN_DIR)
    parser.add_argument("--pm2", default=DEFAULT_PM2)
    args = parser.parse_args(argv)
    environ = os.environ if environ is None else environ
    try:
        if euid() == 0:
            environ = drop(environ)
        if get_me is None:
            get_me = load_smoke().telegram_get_me
        result = report(args.main_dir, args.pm2, environ, get_me)
    except NotProvisioned as error:
        say(str(error))
        return EXIT_NOT_PROVISIONED
    print(REPORT_PREFIX + json.dumps(result, separators=(",", ":"), ensure_ascii=True), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
