#!/usr/bin/env python3
"""PC driver of the per-PR stage QA: `stage-qa-pc.py <sha40> [--config FILE]`.

The stage bot is driven through qa-cli (Telegram Web, logged in on THIS machine) while the stage bot
itself runs on the odroid in ONE slot that every pull request shares (`Stage Bot` workflow deploys the
head of the PR that changed last). The driver therefore does not own the bot; it proves that the slot ran
exactly the requested commit for the whole run:

  1. the PC qa lock (flock, the same file the HyperCalendarBot driver uses: one Telegram Web session
     at a time),
  2. ask the odroid (`ssh <target> report`, a forced command that only reads) until the slot runs the
     requested commit and the bot is online, for at most `slot_wait` seconds,
  3. validate that report against this machine's own config and run its cases with `stage-smoke.py run`
     (qa-cli) as a child,
  4. ask again: when the slot moved to another commit (or was redeployed) meanwhile, the result is
     void (superseded); when the bot restarted by itself the run failed; otherwise the smoke decides,
  5. the final `STAGE_QA_RESULT ...` line goes to stdout and the exit code is the verdict.

Trust: the report arrives from the odroid but the case list originates in the PR, so everything in it
is DATA validated here (username, commit, floor of cases, required scenarios); nothing PR-controlled is
ever executed on this machine. The config is written by the installer, never taken from a PR. No token
is involved: the odroid side needs none.

Streams: only the final STAGE_QA_RESULT line is written to stdout; everything else (odroid stderr, SMOKE
lines, our own messages) goes to stderr.

Exit codes: 0 passed, 1 failed (a case failed, the bot restarted or is not online, the smoke timed
out), 2 refused (the report or the case list is invalid), 3 not provisioned (config, key, qa-cli, the
odroid unreachable), 75 lock wait timed out, 76 superseded (the slot moved, no verdict for this commit),
77 the slot never ran the commit within the wait; a signal exits 128+signal.
"""
import argparse
import fcntl
import json
import math
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import NamedTuple, Optional

SCRIPT_DIR = Path(__file__).resolve().parent
SMOKE_SCRIPT = SCRIPT_DIR / "stage-smoke.py"

DEFAULT_CONFIG = "~/.config/esb-stage-qa/config.json"
LOCK_TAG = "esb-stage-qa-pc"
LOCK_POLL_SECONDS = 0.2
LOCK_LOG_EVERY_SECONDS = 30
DEFAULT_SMOKE_TIMEOUT = 1500
SMOKE_TERM_GRACE_SECONDS = 3
MAX_CASE_SECONDS = 300
MAX_SETTLE_SECONDS = 60
MAX_MIN_REPLIES = 20
# Replies a pattern must not match: an `expect` that any reply satisfies asserts nothing.
TRIVIAL_REPLIES = ("", "x", " ", "1")
REPORT_VERB = "report"
REPORT_PREFIX = "STAGE_REPORT "
RESULT_PREFIX = "STAGE_QA_RESULT"

SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
USERNAME_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_]{4,31}")
TARGET_PATTERN = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9_.:-]*")
PEER_PATTERN = re.compile(r"[0-9]{1,20}")
SMOKE_SUMMARY = re.compile(r"^STAGE_SMOKE_(PASSED|FAILED)\b.*?\bcases=([0-9]+)\b.*?\bfailed=([0-9]+)\b")

EXIT_PASSED, EXIT_FAILED, EXIT_REFUSED, EXIT_NOT_PROVISIONED = 0, 1, 2, 3
EXIT_LOCK_TIMEOUT, EXIT_SUPERSEDED, EXIT_SLOT_NEVER_RAN = 75, 76, 77
SMOKE_REFUSED, SMOKE_UNAVAILABLE = 64, 69
SSH_UNREACHABLE = 255
REPORT_NOT_PROVISIONED, REPORT_REFUSED = 3, 2
STATUS_BY_CODE = {
    EXIT_PASSED: "passed",
    EXIT_REFUSED: "refused",
    EXIT_NOT_PROVISIONED: "not-provisioned",
    EXIT_LOCK_TIMEOUT: "lock-timeout",
    EXIT_SUPERSEDED: "superseded",
    EXIT_SLOT_NEVER_RAN: "slot-never-ran",
}

_log_lock = threading.Lock()


def log(message):
    with _log_lock:
        try:
            sys.stderr.write(message + "\n")
            sys.stderr.flush()
        except OSError:
            pass


def say(message):
    log(f"stage-qa-pc: {message}")


class Refused(Exception):
    pass


class NotProvisioned(Exception):
    pass


class LockTimeout(Exception):
    pass


class Terminated(BaseException):
    """Raised by the signal handler; BaseException so no `except Exception` swallows a cancel."""

    def __init__(self, signum):
        super().__init__(signum)
        self.signum = signum


class SignalState:
    signum = None
    cleaning = False


def _on_signal(signum, _frame):
    first = SignalState.signum is None
    if first:
        SignalState.signum = signum
    # Once the cleanup (lock release) runs it must not be interrupted; a signal that lands then is
    # only remembered for the exit code.
    if first and not SignalState.cleaning:
        raise Terminated(signum)


def install_signal_handlers():
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, _on_signal)


class Verdict(NamedTuple):
    code: int
    cases: int = 0
    failed: int = 0


def status_for(code):
    return STATUS_BY_CODE.get(code, "failed")


def print_result(sha, verdict):
    line = f"STAGE_QA_RESULT status={status_for(verdict.code)} sha={sha} cases={verdict.cases} failed={verdict.failed}"
    try:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except OSError:
        pass


# ---------------------------------------------------------------- config


class Config(NamedTuple):
    ssh_target: str
    ssh_key: str
    ssh_known_hosts: Optional[str]
    username: str
    deny_usernames: tuple
    qa_bin: str
    python: str
    lock_file: str
    lock_max_wait: float
    state_dir: str
    min_cases: int
    required_cases: tuple
    required_forbid: tuple
    smoke_timeout: float
    slot_wait: float
    slot_poll: float
    report_timeout: float


DEFAULTS = {
    "deny_usernames": ["ExpenseSyncBot"],
    "qa_bin": "~/.local/bin/qa",
    "python": "python3",
    # The HyperCalendarBot driver's lock file: both repositories share one Telegram Web session.
    "lock_file": "~/.local/state/hypercal-stage-qa/qa.lock",
    "lock_max_wait": 2700,
    "state_dir": "~/.local/state/esb-stage-qa",
    "min_cases": 5,
    "required_cases": [
        "start",
        "ping",
        "help-lists-commands",
        "categories-read-only-listing",
        "validation-connect-rejected-outside-group",
        "simple-intent-phrase",
        "expense-phrase-redirect",
    ],
    # Every case must forbid these texts (the bot's own error answers), whatever else a PR adds to its list.
    "required_forbid": [
        "Traceback|Unhandled|\\[object Object\\]|Произошла ошибка|непредвиденная ошибка|Неизвестная ошибка|Не удалось обратиться|Не удалось определить|AI-сервис временно недоступен|AI не настроен|Нет соединения с сервисом|Авторизация истекла",
    ],
    "smoke_timeout": DEFAULT_SMOKE_TIMEOUT,
    "slot_wait": 600,
    "slot_poll": 20,
    "report_timeout": 120,
}
REQUIRED_KEYS = ("ssh_target", "ssh_key", "username")
OPTIONAL_KEYS = ("ssh_known_hosts",)


def normalized_username(name):
    return name.strip().lstrip("@").lower()


def has_stage_marker(username):
    lowered = username.lower()
    return "stage" in lowered or "stg" in lowered


def _bad(message):
    return NotProvisioned(f"config: {message}")


def _text(raw, key):
    value = raw[key]
    if type(value) is not str or not value:
        raise _bad(f"{key} must be a non-empty string")
    return value


def _path(raw, key):
    value = os.path.expanduser(_text(raw, key))
    if not os.path.isabs(value):
        raise _bad(f"{key} must be an absolute path (or start with ~)")
    return value


def _number(raw, key, minimum, allow_equal):
    value = raw[key]
    if type(value) not in (int, float) or value < minimum or (value == minimum and not allow_equal):
        bound = f">= {minimum}" if allow_equal else f"> {minimum}"
        raise _bad(f"{key} must be a number {bound}")
    return value


def _string_list(raw, key, allow_empty):
    value = raw[key]
    if type(value) is not list or not all(type(item) is str and item for item in value):
        raise _bad(f"{key} must be a list of non-empty strings")
    if not value and not allow_empty:
        raise _bad(f"{key} must not be empty")
    return tuple(value)


def load_config(path):
    path = os.path.expanduser(path)
    try:
        info = os.stat(path)
    except FileNotFoundError:
        raise NotProvisioned(f"config {path} not found; run scripts/install-stage-qa-pc.sh") from None
    except OSError as error:
        raise NotProvisioned(f"config {path} is not readable: {error.strerror}") from None
    if not stat.S_ISREG(info.st_mode):
        raise _bad(f"{path} is not a regular file")
    if info.st_uid != os.geteuid():
        raise _bad(f"{path} is not owned by the current user")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise _bad(f"{path} has mode {stat.S_IMODE(info.st_mode):04o}; it must be 0600")
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as error:
        raise _bad(f"{path} is not valid JSON ({error.__class__.__name__})") from None
    if type(raw) is not dict:
        raise _bad(f"{path} must hold a JSON object")
    unknown = sorted(set(raw) - set(DEFAULTS) - set(REQUIRED_KEYS) - set(OPTIONAL_KEYS))
    if unknown:
        raise _bad(f"unknown key(s): {', '.join(unknown)}")
    for key in REQUIRED_KEYS:
        if key not in raw:
            raise _bad(f"missing required key {key}")
    merged = {**DEFAULTS, **raw}

    target = _text(merged, "ssh_target")
    if not TARGET_PATTERN.fullmatch(target):
        raise _bad("ssh_target must look like user@host")
    username = _text(merged, "username")
    if not USERNAME_PATTERN.fullmatch(username) or not has_stage_marker(username):
        raise _bad("username must be a Telegram bot username containing stage or stg")
    deny = _string_list(merged, "deny_usernames", allow_empty=True)
    if normalized_username(username) in {normalized_username(name) for name in deny}:
        raise _bad("username is in deny_usernames")
    min_cases = merged["min_cases"]
    if type(min_cases) is not int or min_cases < 1:
        raise _bad("min_cases must be an integer >= 1")
    known_hosts = _path(merged, "ssh_known_hosts") if "ssh_known_hosts" in merged else None

    return Config(
        ssh_target=target,
        ssh_key=_path(merged, "ssh_key"),
        ssh_known_hosts=known_hosts,
        username=username,
        deny_usernames=deny,
        qa_bin=_path(merged, "qa_bin"),
        python=_text(merged, "python"),
        lock_file=_path(merged, "lock_file"),
        lock_max_wait=_number(merged, "lock_max_wait", 0, True),
        state_dir=_path(merged, "state_dir"),
        min_cases=min_cases,
        required_cases=_string_list(merged, "required_cases", allow_empty=False),
        required_forbid=_string_list(merged, "required_forbid", allow_empty=False),
        smoke_timeout=_number(merged, "smoke_timeout", 0, False),
        slot_wait=_number(merged, "slot_wait", 0, True),
        slot_poll=_number(merged, "slot_poll", 0, False),
        report_timeout=_number(merged, "report_timeout", 0, False),
    )


def check_provisioned(config):
    """Everything the run needs on this PC; returns the resolved ssh client and python."""
    if not os.path.isfile(config.ssh_key):
        raise NotProvisioned(f"ssh key {config.ssh_key} not found; run scripts/install-stage-qa-pc.sh")
    if config.ssh_known_hosts and not os.path.isfile(config.ssh_known_hosts):
        raise NotProvisioned(f"ssh known_hosts file {config.ssh_known_hosts} not found")
    if not (os.path.isfile(config.qa_bin) and os.access(config.qa_bin, os.X_OK)):
        raise NotProvisioned(f"qa binary {config.qa_bin} not found or not executable (install qa-cli)")
    ssh = shutil.which("ssh")
    if ssh is None:
        raise NotProvisioned("ssh client not found in PATH")
    python = shutil.which(config.python)
    if python is None:
        raise NotProvisioned(f"python {config.python} not found in PATH")
    if not SMOKE_SCRIPT.is_file():
        raise NotProvisioned(f"{SMOKE_SCRIPT} not found; reinstall with scripts/install-stage-qa-pc.sh")
    return ssh, python


# ---------------------------------------------------------------- PC lock (same protocol as the HyperCalendarBot driver)


def start_ticks(pid):
    """Process start time in clock ticks since boot (field 22 of /proc/<pid>/stat); None when gone."""
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8", errors="replace") as handle:
            stat_line = handle.read()
        # After the ")" that closes comm, field 3 is the first word; starttime is field 22 => 20th word.
        return stat_line.rsplit(") ", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def describe_owner(owner_file):
    try:
        with open(owner_file, encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return "unknown"
    fields = dict(line.split("=", 1) for line in lines if "=" in line)
    pid = fields.get("pid", "")
    if not pid.isdigit():
        return "unknown"
    live = start_ticks(pid)
    if live is not None and live == fields.get("start_ticks"):
        return f"{fields.get('repo', '?')} pid={pid} since={fields.get('started', '?')}"
    return f"stale ({fields.get('repo', '?')} pid={pid} is gone)"


class PcLock:
    """Advisory flock(2) on the shared qa lock plus an informational owner file.

    The kernel drops the flock when the holder dies, so a crash never leaves a stale lock; the owner
    file can go stale and is only used to explain a wait (judged by pid + start ticks)."""

    def __init__(self, path, max_wait):
        self.path = path
        self.owner_path = path + ".owner"
        self.max_wait = max_wait
        self.fd = None

    def acquire(self):
        directory = os.path.dirname(self.path)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        # umask 0: the other repository's driver may run as another user and must still be able to
        # open these files whichever user created them first; the lock carries no secret.
        previous = os.umask(0)
        try:
            os.close(os.open(self.path, os.O_RDWR | os.O_CREAT, 0o666))
            os.close(os.open(self.owner_path, os.O_RDWR | os.O_CREAT, 0o666))
        finally:
            os.umask(previous)
        fd = os.open(self.path, os.O_RDONLY)
        started = time.monotonic()
        next_log = started
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                pass
            now = time.monotonic()
            waited = now - started
            if now >= next_log:
                say(f"waiting for the PC qa lock, held by: {describe_owner(self.owner_path)} "
                    f"(waited {int(waited)}s of {int(self.max_wait)}s)")
                next_log = now + LOCK_LOG_EVERY_SECONDS
            if waited >= self.max_wait:
                os.close(fd)
                say(f"gave up after {int(waited)}s; the other QA run is still going. Re-run this check when it ends.")
                raise LockTimeout()
            time.sleep(min(LOCK_POLL_SECONDS, max(self.max_wait - waited, 0.01)))
        self.fd = fd
        waited = time.monotonic() - started
        if waited >= 1:
            say(f"acquired the PC qa lock after {int(waited)}s")
        # Truncate and rewrite in place: the owner file may belong to another user in a sticky dir.
        try:
            with open(self.owner_path, "w", encoding="utf-8") as handle:
                handle.write(f"repo={LOCK_TAG}\npid={os.getpid()}\nstart_ticks={start_ticks(os.getpid())}\n"
                             f"started={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n")
        except OSError:
            pass

    def release(self):
        if self.fd is None:
            return
        try:
            with open(self.owner_path, "w", encoding="utf-8"):
                pass
        except OSError:
            pass
        os.close(self.fd)
        self.fd = None


# ---------------------------------------------------------------- the odroid's report


class Report(NamedTuple):
    sha: Optional[str]
    online: bool
    started_at: int
    restarts: int
    peer: Optional[str]
    cases: Optional[list]
    cases_error: Optional[str]
    slot_error: Optional[str]


def refuse_json_constant(name):
    raise ValueError(f"{name} is not valid JSON")


def _count(data, key):
    value = data.get(key)
    if type(value) is not int or value < 0:
        raise Refused(f"STAGE_REPORT {key} is not a non-negative integer")
    return value


def _optional_text(data, key):
    value = data.get(key)
    if value is not None and type(value) is not str:
        raise Refused(f"STAGE_REPORT {key} is not text")
    return value


def parse_report(payload_text, config):
    """The odroid's report as data, after the checks that hold for EVERY report, whichever commit it names."""
    try:
        data = json.loads(payload_text, parse_constant=refuse_json_constant)
    except (ValueError, RecursionError):
        raise Refused("STAGE_REPORT is not valid JSON") from None
    if type(data) is not dict:
        raise Refused("STAGE_REPORT payload is not an object")
    username = data.get("username")
    if type(username) is not str or normalized_username(username) != normalized_username(config.username):
        raise Refused("STAGE_REPORT names another bot than the configured stage bot")
    if normalized_username(username) in {normalized_username(name) for name in config.deny_usernames}:
        raise Refused("STAGE_REPORT names a denied (production) bot")
    if not has_stage_marker(username):
        raise Refused("STAGE_REPORT bot username does not contain stage or stg")
    sha = data.get("sha")
    if sha is not None and (type(sha) is not str or not SHA_PATTERN.fullmatch(sha)):
        raise Refused("STAGE_REPORT sha is not a full lowercase commit SHA")
    online = data.get("online")
    if type(online) is not bool:
        raise Refused("STAGE_REPORT online is not a boolean")
    peer = data.get("peer")
    if peer is not None and (type(peer) is not str or not PEER_PATTERN.fullmatch(peer)):
        raise Refused("STAGE_REPORT peer is not a numeric bot id")
    cases = data.get("cases")
    if cases is not None and type(cases) is not list:
        raise Refused("STAGE_REPORT cases is not a list")
    return Report(
        sha=sha, online=online, started_at=_count(data, "started_at"), restarts=_count(data, "restarts"),
        peer=peer, cases=cases, cases_error=_optional_text(data, "cases_error"),
        slot_error=_optional_text(data, "slot_error"),
    )


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def case_problem(case, required_forbid):
    """Why a case may not run, or None: what the engine checks plus what a PR must not weaken.

    The engine accepts a case without `expect`/`forbid`, `"expect": ["."]` and timeouts of any size
    (JSON even allows Infinity and NaN); the trusted side holds the case list to more than the engine does."""
    name = case.get("name") if isinstance(case, dict) else None
    # The name is printed into the `SMOKE PASS <name>` lines the driver reads: one line of printable text.
    if type(name) is not str or not name or not name.isprintable():
        return "a case has no text name"
    if type(case.get("send")) is not str or not case["send"]:
        return f"case {name}: send must be text"
    for key, low, high, low_inclusive in (
        ("timeout_s", 0, MAX_CASE_SECONDS, False), ("max_first_reply_s", 0, MAX_CASE_SECONDS, False),
        ("settle_s", 0, MAX_SETTLE_SECONDS, True), ("min_replies", 1, MAX_MIN_REPLIES, True),
    ):
        if key in case:
            value = case[key]
            if not (finite_number(value) and (low <= value if low_inclusive else low < value) and value <= high):
                return f"case {name}: {key} must be a number {'from' if low_inclusive else 'above'} {low} up to {high}"
    for key in ("expect", "forbid"):
        patterns = case.get(key)
        if type(patterns) is not list or not patterns or not all(type(item) is str and item for item in patterns):
            return f"case {name}: {key} must be a non-empty list of patterns"
        for pattern in patterns:
            try:
                re.compile(pattern)
            except (re.error, RecursionError):
                return f"case {name}: bad {key} pattern"
    for pattern in case["expect"]:
        if any(re.search(pattern, probe, re.IGNORECASE | re.DOTALL) for probe in TRIVIAL_REPLIES):
            return f"case {name}: expect pattern {pattern!r} matches any reply"
    if any(pattern not in case["forbid"] for pattern in required_forbid):
        return f"case {name}: forbid must contain the error patterns the trusted side requires"
    return None


def check_cases(report, config):
    """The case list the smoke may run: the floor is enforced here, not trusted from the odroid."""
    if report.cases is None:
        raise Refused(f"the PR's case list is not usable: {report.cases_error or 'the odroid sent none'}")
    if report.peer is None:
        raise Refused("STAGE_REPORT carries no bot id for an online bot")
    names = []
    for case in report.cases:
        problem = case_problem(case, config.required_forbid)
        if problem:
            raise Refused(f"STAGE_REPORT {problem}")
        names.append(case["name"])
    if len(set(names)) != len(names):
        raise Refused("STAGE_REPORT has duplicate case names")
    if len(names) < config.min_cases:
        raise Refused(f"only {len(names)} cases; at least {config.min_cases} are required")
    missing = [name for name in config.required_cases if name not in names]
    if missing:
        raise Refused(f"required case(s) missing: {', '.join(missing)}")


def ssh_argv(config, ssh):
    argv = [
        ssh, "-i", config.ssh_key,
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", "ConnectTimeout=30",
    ]
    if config.ssh_known_hosts:
        argv += ["-o", f"UserKnownHostsFile={config.ssh_known_hosts}"]
    # The forced command on the odroid accepts exactly this verb (SSH_ORIGINAL_COMMAND).
    return [*argv, config.ssh_target, REPORT_VERB]


def fetch_report(config, ssh):
    try:
        done = subprocess.run(
            ssh_argv(config, ssh), capture_output=True, text=True, encoding="utf-8", errors="replace",
            stdin=subprocess.DEVNULL, timeout=config.report_timeout,
        )
    except subprocess.TimeoutExpired:
        raise NotProvisioned(f"the odroid did not answer within {int(config.report_timeout)}s") from None
    except OSError as error:
        raise NotProvisioned(f"cannot run ssh ({error.strerror})") from None
    for line in done.stderr.splitlines():
        log(f"odroid: {line}")
    if done.returncode == SSH_UNREACHABLE:
        raise NotProvisioned("cannot reach the odroid over ssh (see the lines above)")
    if done.returncode == REPORT_NOT_PROVISIONED:
        raise NotProvisioned("the odroid report script is not provisioned or cannot prove the stage identity")
    if done.returncode != 0:
        raise Refused(f"the odroid report script ended with exit status {done.returncode}")
    lines = [line for line in done.stdout.splitlines() if line.startswith(REPORT_PREFIX)]
    if len(lines) != 1:
        raise Refused(f"expected one STAGE_REPORT line from the odroid, got {len(lines)}")
    return parse_report(lines[0][len(REPORT_PREFIX):], config)


class SlotNeverRan(Exception):
    def __init__(self, last):
        super().__init__()
        self.last = last


def wait_for_slot(config, ssh, sha):
    """The report that shows the slot running `sha` with the bot online; SlotNeverRan after slot_wait."""
    deadline = time.monotonic() + config.slot_wait
    while True:
        report = fetch_report(config, ssh)
        if report.sha == sha and report.online:
            return report
        shown = report.sha[:12] if report.sha else f"nothing ({report.slot_error or 'bot offline'})"
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SlotNeverRan(report)
        say(f"the stage slot runs {shown}, waiting for {sha[:12]} ({int(remaining)}s left)")
        time.sleep(min(config.slot_poll, remaining))


# ---------------------------------------------------------------- smoke child


class SmokeOutcome(NamedTuple):
    kind: str  # "exit" | "timeout"
    code: int = 0
    summary: Optional[tuple] = None  # (status, cases, failed) of the last STAGE_SMOKE_* line


def kill_group(proc):
    """TERM the whole process group, then KILL what is left (qa/agent-browser grandchildren)."""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=SMOKE_TERM_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


def smoke_command(config, python, sha, report, cases_file):
    command = [
        python, str(SMOKE_SCRIPT), "run",
        "--cases-json", cases_file,
        "--username", config.username,
        "--peer", report.peer,
        "--sha", sha,
    ]
    for name in config.deny_usernames:
        command += ["--deny", name]
    return [
        *command,
        "--receipt", os.path.join(config.state_dir, "receipts", f"{sha}.json"),
        "--qa-bin", config.qa_bin,
        "--min-cases", str(config.min_cases),
        "--base-cases", str(len(report.cases)),
    ]


def run_smoke(config, python, sha, report):
    receipts = os.path.join(config.state_dir, "receipts")
    os.makedirs(receipts, mode=0o700, exist_ok=True)
    # mkstemp creates the file 0600; the cases are PR data but there is no reason to expose them.
    handle, cases_file = tempfile.mkstemp(prefix=f"cases-{sha[:12]}-", suffix=".json", dir=config.state_dir)
    proc = None
    summary = [None]
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(report.cases, stream)
        proc = subprocess.Popen(
            smoke_command(config, python, sha, report, cases_file),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
            start_new_session=True,
        )

        def forward():
            for raw in proc.stdout:
                line = raw.rstrip("\r\n")
                log(line)
                match = SMOKE_SUMMARY.match(line)
                if match:
                    summary[0] = (match.group(1), int(match.group(2)), int(match.group(3)))

        reader = threading.Thread(target=forward, daemon=True)
        reader.start()
        deadline = time.monotonic() + config.smoke_timeout
        while True:
            try:
                code = proc.wait(timeout=0.2)
                kind = "exit"
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() >= deadline:
                    say(f"the smoke timed out after {int(config.smoke_timeout)}s; killing its process group")
                    kill_group(proc)
                    kind, code = "timeout", 0
                    break
        reader.join(timeout=5)
        return SmokeOutcome(kind, code, summary[0])
    finally:
        if proc is not None and proc.poll() is None:
            kill_group(proc)
        try:
            os.unlink(cases_file)
        except OSError:
            pass


def smoke_verdict(config, outcome):
    """exit 0 -> 0 (only with a real pass summary), 1 -> 1, 64 -> 2, 69 -> 3, anything else -> 1."""
    cases, failed = (outcome.summary[1], outcome.summary[2]) if outcome.summary else (0, 0)
    if outcome.kind == "timeout":
        return Verdict(EXIT_FAILED, cases, failed)
    if outcome.code == 0:
        passed = (outcome.summary is not None and outcome.summary[0] == "PASSED"
                  and failed == 0 and cases >= config.min_cases)
        if passed:
            return Verdict(EXIT_PASSED, cases, failed)
        say("the smoke exited 0 without a pass summary covering the required cases; treating it as a failure")
        return Verdict(EXIT_FAILED, cases, failed)
    if outcome.code == SMOKE_REFUSED:
        return Verdict(EXIT_REFUSED, cases, failed)
    if outcome.code == SMOKE_UNAVAILABLE:
        say("qa-cli is unavailable or not logged in on this PC")
        return Verdict(EXIT_NOT_PROVISIONED, cases, failed)
    return Verdict(EXIT_FAILED, cases, failed)


# ---------------------------------------------------------------- the run


def slot_verdict(before, after, sha):
    """What the second report says about the run: None when the slot stayed put and the bot stayed up."""
    if after.sha != sha:
        say(f"the stage slot moved to {after.sha[:12] if after.sha else 'nothing'} during the run; the result is void")
        return Verdict(EXIT_SUPERSEDED)
    redeployed = after.started_at != before.started_at
    if after.restarts > before.restarts:
        say(f"the stage bot restarted by itself during the run (restarts {before.restarts} -> {after.restarts})")
        return Verdict(EXIT_FAILED)
    if redeployed:
        say("the stage bot was redeployed during the run; the result is void")
        return Verdict(EXIT_SUPERSEDED)
    if not after.online:
        say("the stage bot went offline during the run")
        return Verdict(EXIT_FAILED)
    return None


def drive(config, ssh, python, sha):
    try:
        first = wait_for_slot(config, ssh, sha)
    except SlotNeverRan as never:
        if never.last.sha == sha:
            say("the stage slot runs this commit but the bot is not online; failing the run")
            return Verdict(EXIT_FAILED)
        say(f"the stage slot never ran {sha[:12]} within {int(config.slot_wait)}s; "
            f"re-run the `Stage Bot` workflow of this pull request to deploy it again")
        return Verdict(EXIT_SLOT_NEVER_RAN)
    check_cases(first, config)
    outcome = run_smoke(config, python, sha, first)
    verdict = smoke_verdict(config, outcome)
    if verdict.code in (EXIT_REFUSED, EXIT_NOT_PROVISIONED):
        # Not a statement about the slot: the engine or qa-cli refused, whatever the slot did.
        return verdict
    moved = slot_verdict(first, fetch_report(config, ssh), sha)
    return moved if moved is not None else verdict


def execute(sha, config_path):
    config = load_config(config_path)
    ssh, python = check_provisioned(config)
    os.makedirs(config.state_dir, mode=0o700, exist_ok=True)
    lock = PcLock(config.lock_file, config.lock_max_wait)
    lock.acquire()
    try:
        return drive(config, ssh, python, sha)
    finally:
        SignalState.cleaning = True
        lock.release()


class Parser(argparse.ArgumentParser):
    def error(self, message):
        log(f"stage-qa-pc: {message}")
        print_result("-", Verdict(EXIT_REFUSED))
        sys.exit(EXIT_REFUSED)


def main(argv):
    parser = Parser(prog="stage-qa-pc.py", description="Run the per-PR stage QA from this PC.")
    parser.add_argument("sha", help="the 40-hex commit to check")
    parser.add_argument("--config", default=DEFAULT_CONFIG, help="driver config (default %(default)s)")
    args = parser.parse_args(argv)
    if not SHA_PATTERN.fullmatch(args.sha):
        say("the argument must be a 40-hex commit SHA")
        print_result("-", Verdict(EXIT_REFUSED))
        return EXIT_REFUSED
    install_signal_handlers()
    try:
        verdict = execute(args.sha, args.config)
    except Refused as error:
        say(str(error))
        verdict = Verdict(EXIT_REFUSED)
    except NotProvisioned as error:
        log(f"STAGE_QA_NOT_PROVISIONED: {error}")
        verdict = Verdict(EXIT_NOT_PROVISIONED)
    except LockTimeout:
        verdict = Verdict(EXIT_LOCK_TIMEOUT)
    except Terminated as signalled:
        say(f"terminated by signal {signalled.signum}")
        verdict = Verdict(128 + signalled.signum)
    if SignalState.signum is not None:
        verdict = Verdict(128 + SignalState.signum, verdict.cases, verdict.failed)
    print_result(args.sha, verdict)
    return verdict.code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
