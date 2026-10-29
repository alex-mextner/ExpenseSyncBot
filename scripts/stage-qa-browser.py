#!/usr/bin/env python3
"""Browser half of the per-PR stage QA: `stage-qa-browser.py <sha40> [--config FILE]`, run on the QA browser
host (the server) as the ssh forced command of the odroid driver's key. Protocol with the driver
(stage-qa-driver.py), which opens the connection FIRST: this half takes the browser lock, prints the single
stdout line `STAGE_BROWSER_LOCKED`, and only then waits (at most `payload_wait` seconds) for the first stdin
line, the `STAGE_REPORT` JSON the odroid's report script printed for the shared stage slot (without the
prefix); the driver does its odroid-side work (slot wait) only after LOCKED, so the wait for the lock never
happens after the odroid side has started.

Why a separate host: the stage bot is driven through qa-cli (Telegram Web in a headless Chromium, logged in
with the account whose session lives on THIS host), and that browser needs a few hundred MB that the
odroid, which runs production, does not have to spare (DEPLOY.md "Stage QA", "Why the browser runs on the
server"). The stage bot itself stays on the odroid in the pm2 slot every pull request shares; the odroid
driver (stage-qa-driver.py) waits until the slot runs the requested commit and forwards the report here.

  1. take the browser lock (flock, shared by every stage QA run on this host, also the HyperCalendarBot
  ones) and print LOCKED, 2. read and bound the report, 3. validate the report against THIS host's own
  trusted config (stage username, deny list, the commit asked for, floor of cases, required scenarios,
  error patterns every case must forbid), 4. run `stage-smoke.py run` (qa-cli) as a child, 5. print the
  last line `STAGE_QA_RESULT ...` and exit with the verdict code.

Trust: the odroid is not trusted to say which bot to talk to or which cases are fine. The report (whose case
list originates in the PR) is DATA validated again here; nothing PR-controlled is ever executed. The config is
written by the installer, never taken from a PR. Nothing that reaches this process is a secret.

The driver closing its end (stdin EOF) means the odroid side is gone: before the payload that is a failed run
(exit 1), later the smoke is stopped; the lock is freed either way.
Whether the slot stayed on the commit during the run is the odroid driver's judgement (it asks the odroid again
after this process ends); this process only judges the cases.

Streams: stdout carries the LOCKED line and then the final STAGE_QA_RESULT line, nothing else; everything else
(SMOKE lines, our own messages) goes to stderr.

Exit codes: 0 passed, 1 failed (a case failed, the smoke timed out, the driver went away, no payload within
`payload_wait`), 2 refused (the report or the case list is invalid), 3 not provisioned (config, qa-cli not
logged in or missing), 75 lock wait timed out; a signal exits 128+signal.
"""

from __future__ import annotations

import fcntl
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import NamedTuple

from stage_qa_common import (
    EXIT_FAILED,
    EXIT_NOT_PROVISIONED,
    EXIT_PASSED,
    EXIT_REFUSED,
    LOCKED_LINE,
    ClientGone,
    LockTimeout,
    NotProvisioned,
    Refused,
    SignalState,
    Verdict,
    bad,
    case_problem,
    log,
    merge_config,
    number_value,
    path_value,
    read_config_file,
    run_cli,
    string_list_value,
    terminate_group,
    text_value,
)

SCRIPT_DIR = Path(__file__).resolve().parent
SMOKE_SCRIPT = SCRIPT_DIR / "stage-smoke.py"

DEFAULT_CONFIG = "~/.config/esb-stage-qa/browser.json"
INSTALLER = "scripts/install-stage-qa-browser.sh"
LOCK_TAG = "esb-stage-qa-browser"
LOCK_POLL_SECONDS = 0.2
LOCK_LOG_EVERY_SECONDS = 30
DEFAULT_SMOKE_TIMEOUT = 1500
# The driver does its odroid-side work (slot wait up to 600 s by default) only after it saw LOCKED and sends the
# report when the slot is confirmed: this is how long the lock is held for that.
DEFAULT_PAYLOAD_WAIT = 7500
SMOKE_TERM_GRACE_SECONDS = 3
# The report of one PR is a few KB (its case list is capped at 256 KB on the odroid); a megabyte is far beyond
# any real report and keeps a confused or hostile peer from making this process buffer without bound.
MAX_REPORT_BYTES = 1 << 20

USERNAME_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_]{4,31}")
PEER_PATTERN = re.compile(r"[0-9]{1,20}")
SMOKE_SUMMARY = re.compile(
    r"^STAGE_SMOKE_(PASSED|FAILED)\b.*?\bcases=([0-9]+)\b.*?\bfailed=([0-9]+)\b"
)

SMOKE_REFUSED, SMOKE_UNAVAILABLE = 64, 69


def say(message):
    log(f"stage-qa-browser: {message}")


# ---------------------------------------------------------------- config


class Config(NamedTuple):
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
    payload_wait: float


DEFAULTS = {
    "deny_usernames": ["ExpenseSyncBot"],
    "qa_bin": "~/.local/bin/qa",
    "python": "python3",
    # The lock file of the HyperCalendarBot browser half too: one Telegram Web session at a time.
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
    "payload_wait": DEFAULT_PAYLOAD_WAIT,
}
REQUIRED_KEYS = ("username",)


def normalized_username(name):
    return name.strip().lstrip("@").lower()


def has_stage_marker(username):
    lowered = username.lower()
    return "stage" in lowered or "stg" in lowered


def load_config(path):
    path = os.path.expanduser(path)
    merged = merge_config(
        read_config_file(path, INSTALLER, allow_root_owner=False), DEFAULTS, REQUIRED_KEYS, ()
    )
    username = text_value(merged, "username")
    if not USERNAME_PATTERN.fullmatch(username) or not has_stage_marker(username):
        raise bad("username must be a Telegram bot username containing stage or stg")
    deny = string_list_value(merged, "deny_usernames", allow_empty=True)
    if normalized_username(username) in {normalized_username(name) for name in deny}:
        raise bad("username is in deny_usernames")
    min_cases = merged["min_cases"]
    if type(min_cases) is not int or min_cases < 1:
        raise bad("min_cases must be an integer >= 1")
    return Config(
        username=username,
        deny_usernames=deny,
        qa_bin=path_value(merged, "qa_bin"),
        python=text_value(merged, "python"),
        lock_file=path_value(merged, "lock_file"),
        lock_max_wait=number_value(merged, "lock_max_wait", minimum=0, allow_equal=True),
        state_dir=path_value(merged, "state_dir"),
        min_cases=min_cases,
        required_cases=string_list_value(merged, "required_cases", allow_empty=False),
        required_forbid=string_list_value(merged, "required_forbid", allow_empty=False),
        smoke_timeout=number_value(merged, "smoke_timeout", minimum=0, allow_equal=False),
        payload_wait=number_value(merged, "payload_wait", minimum=0, allow_equal=False),
    )


def check_provisioned(config):
    """Everything the run needs on this host; returns the resolved python."""
    if not (os.path.isfile(config.qa_bin) and os.access(config.qa_bin, os.X_OK)):
        raise NotProvisioned(
            f"qa binary {config.qa_bin} not found or not executable (install qa-cli)"
        )
    python = shutil.which(config.python)
    if python is None:
        raise NotProvisioned(f"python {config.python} not found in PATH")
    if not SMOKE_SCRIPT.is_file():
        raise NotProvisioned(f"{SMOKE_SCRIPT} not found; reinstall with {INSTALLER}")
    return python


# ---------------------------------------------------------------- browser lock (same protocol as the HyperCalendarBot browser half)


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


class BrowserLock:
    """Advisory flock(2) on the shared browser lock plus an informational owner file.

    One Telegram Web session may be open at a time (Telegram invalidates an auth key that two browsers use
    at once), so the stage runs of both repositories queue here. The kernel drops the flock when the holder
    dies, so a crash never leaves a stale lock; the owner file can go stale and is only used to explain a
    wait (judged by pid + start ticks)."""

    def __init__(self, path, max_wait):
        self.path = path
        self.owner_path = path + ".owner"
        self.max_wait = max_wait
        self.fd = None

    def acquire(self, gone):
        directory = os.path.dirname(self.path)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        # umask 0: the other repository's run may use another account and must still be able to open these
        # files whichever user created them first; the lock carries no secret.
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
            if gone.is_set():
                os.close(fd)
                raise ClientGone()
            if now >= next_log:
                say(
                    f"waiting for the browser lock, held by: {describe_owner(self.owner_path)} "
                    f"(waited {int(waited)}s of {int(self.max_wait)}s)"
                )
                next_log = now + LOCK_LOG_EVERY_SECONDS
            if waited >= self.max_wait:
                os.close(fd)
                say(
                    f"gave up after {int(waited)}s; the other QA run is still going. Re-run this check when it ends."
                )
                raise LockTimeout()
            time.sleep(min(LOCK_POLL_SECONDS, max(self.max_wait - waited, 0.01)))
        self.fd = fd
        waited = time.monotonic() - started
        if waited >= 1:
            say(f"acquired the browser lock after {int(waited)}s")
        # Truncate and rewrite in place: the owner file may belong to another user in a sticky dir.
        try:
            with open(self.owner_path, "w", encoding="utf-8") as handle:
                handle.write(
                    f"repo={LOCK_TAG}\npid={os.getpid()}\nstart_ticks={start_ticks(os.getpid())}\n"
                    f"started={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
                )
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


# ---------------------------------------------------------------- report validation


class Ready(NamedTuple):
    cases: list
    base_cases: int
    peer: str


def refuse_json_constant(name):
    raise ValueError(f"{name} is not valid JSON")


def _report_object(payload_text, sha):
    try:
        data = json.loads(payload_text, parse_constant=refuse_json_constant)
    except (ValueError, RecursionError):
        raise Refused("STAGE_REPORT is not valid JSON") from None
    if type(data) is not dict:
        raise Refused("STAGE_REPORT payload is not an object")
    if data.get("sha") != sha:
        raise Refused("STAGE_REPORT names another commit than the one requested")
    return data


def _check_bot(data, config):
    username = data.get("username")
    if type(username) is not str or normalized_username(username) != normalized_username(
        config.username
    ):
        raise Refused("STAGE_REPORT names another bot than the configured stage bot")
    if normalized_username(username) in {
        normalized_username(name) for name in config.deny_usernames
    }:
        raise Refused("STAGE_REPORT names a denied (production) bot")
    if not has_stage_marker(username):
        raise Refused("STAGE_REPORT bot username does not contain stage or stg")
    if data.get("online") is not True:
        raise Refused("STAGE_REPORT does not say the stage bot is online")
    peer = data.get("peer")
    if peer is None:
        raise Refused("STAGE_REPORT carries no bot id for an online bot")
    if type(peer) is not str or not PEER_PATTERN.fullmatch(peer):
        raise Refused("STAGE_REPORT peer is not a numeric bot id")
    return peer


def _check_cases(data, config):
    cases = data.get("cases")
    if cases is None:
        error = data.get("cases_error")
        raise Refused(
            f"the PR's case list is not usable: {error if type(error) is str and error else 'the odroid sent none'}"
        )
    if type(cases) is not list:
        raise Refused("STAGE_REPORT cases is not a list")
    names = []
    for case in cases:
        problem = case_problem(case, config.required_forbid)
        if problem:
            raise Refused(f"STAGE_REPORT {problem}")
        names.append(case["name"])
    if len(set(names)) != len(names):
        raise Refused("STAGE_REPORT has duplicate case names")
    # The floor is enforced here, not trusted from the odroid.
    if len(names) < config.min_cases:
        raise Refused(f"only {len(names)} cases; at least {config.min_cases} are required")
    missing = [name for name in config.required_cases if name not in names]
    if missing:
        raise Refused(f"required case(s) missing: {', '.join(missing)}")
    return cases


def validate_report(payload_text, config, sha):
    """The cases and the bot id this run may use, after every check this host holds the report to."""
    data = _report_object(payload_text, sha)
    peer = _check_bot(data, config)
    cases = _check_cases(data, config)
    return Ready(cases=cases, base_cases=len(cases), peer=peer)


# ---------------------------------------------------------------- smoke child


class SmokeOutcome(NamedTuple):
    kind: str  # "exit" | "timeout" | "client-gone"
    code: int = 0
    # (status, cases, failed) of the last STAGE_SMOKE_* line
    summary: tuple | None = None


def kill_group(proc):
    """TERM the whole process group, then KILL what is left (qa/agent-browser grandchildren)."""
    terminate_group(proc, SMOKE_TERM_GRACE_SECONDS)


def smoke_command(config, python, sha, ready, cases_file):
    command = [
        python,
        str(SMOKE_SCRIPT),
        "run",
        "--cases-json",
        cases_file,
        "--username",
        config.username,
        "--peer",
        ready.peer,
        "--sha",
        sha,
    ]
    for name in config.deny_usernames:
        command += ["--deny", name]
    return [
        *command,
        "--receipt",
        os.path.join(config.state_dir, "receipts", f"{sha}.json"),
        "--qa-bin",
        config.qa_bin,
        "--min-cases",
        str(config.min_cases),
        "--base-cases",
        str(ready.base_cases),
    ]


def run_smoke(config, python, sha, ready, gone):
    receipts = os.path.join(config.state_dir, "receipts")
    os.makedirs(receipts, mode=0o700, exist_ok=True)
    # mkstemp creates the file 0600; the cases are PR data but there is no reason to expose them.
    handle, cases_file = tempfile.mkstemp(
        prefix=f"cases-{sha[:12]}-", suffix=".json", dir=config.state_dir
    )
    proc = None
    summary = [None]
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(ready.cases, stream)
        proc = subprocess.Popen(
            smoke_command(config, python, sha, ready, cases_file),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
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
        outcome = None
        while outcome is None:
            try:
                code = proc.wait(timeout=0.2)
                outcome = "exit"
            except subprocess.TimeoutExpired:
                if gone.is_set():
                    say(
                        "the odroid driver went away while the smoke was running; stopping the smoke"
                    )
                    kill_group(proc)
                    outcome, code = "client-gone", 0
                elif time.monotonic() >= deadline:
                    say(
                        f"the smoke timed out after {int(config.smoke_timeout)}s; killing its process group"
                    )
                    kill_group(proc)
                    outcome, code = "timeout", 0
        reader.join(timeout=5)
        return SmokeOutcome(outcome, code, summary[0])
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
    if outcome.code == 0:
        passed = (
            outcome.summary is not None
            and outcome.summary[0] == "PASSED"
            and failed == 0
            and cases >= config.min_cases
        )
        if passed:
            return Verdict(EXIT_PASSED, cases, failed)
        say(
            "the smoke exited 0 without a pass summary covering the required cases; treating it as a failure"
        )
        return Verdict(EXIT_FAILED, cases, failed)
    if outcome.code == SMOKE_REFUSED:
        return Verdict(EXIT_REFUSED, cases, failed)
    if outcome.code == SMOKE_UNAVAILABLE:
        say("qa-cli is unavailable or not logged in on this host")
        return Verdict(EXIT_NOT_PROVISIONED, cases, failed)
    return Verdict(EXIT_FAILED, cases, failed)


# ---------------------------------------------------------------- the run


class DriverLink:
    """The driver's end of the ssh connection: stdin, read by ONE thread so that waiting for the payload has a
    deadline. The first line is the STAGE_REPORT payload; everything after it is ignored, and the end of stdin
    (before or after the payload) sets `gone`."""

    def __init__(self):
        self.gone = threading.Event()
        self._first = queue.Queue(maxsize=1)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            payload_line = sys.stdin.readline(MAX_REPORT_BYTES + 1)
        except (OSError, ValueError):
            payload_line = ""
        self._first.put(payload_line)
        try:
            # Bounded reads: a hostile peer must not make this process buffer an endless line. Nothing is
            # drained when stdin already ended ("" above): there is nothing left to read.
            while payload_line and sys.stdin.readline(1 << 16):
                pass
        except (OSError, ValueError):
            pass
        self.gone.set()

    def wait_payload(self, timeout):
        """The raw first line; None when it did not come in time; ClientGone when stdin ended first."""
        try:
            line = self._first.get(timeout=timeout)
        except queue.Empty:
            return None
        if not line:
            raise ClientGone()
        return line


def clean_payload(line):
    if len(line) > MAX_REPORT_BYTES:
        raise Refused(f"the STAGE_REPORT payload is larger than {MAX_REPORT_BYTES} bytes")
    line = line.rstrip("\r\n")
    if not line:
        raise Refused("the first stdin line must be the STAGE_REPORT JSON payload")
    return line


def announce_locked():
    """The driver starts its odroid-side work only after this line: the one thing besides the result line on stdout."""
    try:
        sys.stdout.write(LOCKED_LINE + "\n")
        sys.stdout.flush()
    except OSError:
        pass


def execute(sha, config_path):
    config = load_config(config_path)
    python = check_provisioned(config)
    link = DriverLink()
    os.makedirs(config.state_dir, mode=0o700, exist_ok=True)
    lock = BrowserLock(config.lock_file, config.lock_max_wait)
    try:
        lock.acquire(link.gone)
        announce_locked()
        line = link.wait_payload(config.payload_wait)
        if line is None:
            say(
                f"no STAGE_REPORT payload within {int(config.payload_wait)}s of taking the lock; giving it up"
            )
            return Verdict(EXIT_FAILED)
        try:
            ready = validate_report(clean_payload(line), config, sha)
        except Refused as error:
            say(f"refusing the report: {error}")
            return Verdict(EXIT_REFUSED)
        outcome = run_smoke(config, python, sha, ready, link.gone)
        if outcome.kind != "exit":
            return Verdict(EXIT_FAILED)
        return smoke_verdict(config, outcome)
    finally:
        SignalState.cleaning = True
        lock.release()


def main(argv):
    return run_cli(
        "stage-qa-browser.py",
        "Run the stage QA cases through qa-cli on this host.",
        DEFAULT_CONFIG,
        "browser config",
        argv,
        execute,
        client_gone_message="the odroid driver went away before the run started",
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
