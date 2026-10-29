#!/usr/bin/env python3
"""Odroid driver of the per-PR stage QA: `stage-qa-driver.py <sha40> [--config FILE]`.

It is the whole body of the `Stage QA run` job (workflow stage-qa.yml), which runs on the ExpenseSyncBot stage QA
runner of the odroid. The runner user can run nothing as root except the read-only report script, and nothing on
the browser host except one forced command; this driver ties the two together.

The stage bot is not started here: it runs in ONE pm2 slot that every pull request shares (`Stage Bot` workflow
deploys the head of the PR that changed last). The driver therefore proves that the slot ran exactly the
requested commit for the whole run:

  1. open the ssh connection to the browser host FIRST (`ssh` with the key whose authorized_keys entry is
     `restrict,command=".../stage-qa-browser"`; the commit is the command line, stdin stays open). The browser
     half takes the shared browser lock and prints `STAGE_BROWSER_LOCKED`; until then the odroid side does
     nothing, so a queued run waits for the browser host's lock without having touched the stage slot;
  2. only then ask the report script (`sudo -n /usr/local/lib/esb-stage-qa/odroid-stage-qa-report.py`, root
     only as the door: it drops to www-data and only reads) until the slot runs the requested commit and the
     bot is online, for at most `slot_wait` seconds;
  3. forward that report line to the browser host (the first stdin line): there it is validated against that
     host's own config and its cases are driven through qa-cli (Telegram Web) in a headless Chromium;
  4. ask again: when the slot moved to another commit (or was redeployed) meanwhile, the result is void
     (superseded); when the bot restarted by itself the run failed; otherwise the browser host's verdict stands;
  5. the last stdout line is `STAGE_QA_RESULT ...` and the exit code is the verdict. If the odroid side ends
     before the payload, the driver closes the connection's stdin so the browser half exits and frees its lock.

Why the browser is not on this host: the odroid runs production with a few hundred MB of memory to spare, and
Telegram Web needs that much (DEPLOY.md "Stage QA", "Why the browser runs on the server").

Trust: the config is root-installed (scripts/install-stage-qa.sh), never taken from a PR. No GitHub token is
involved. The case list in the report originates in the PR, so it is DATA: this driver only reads the slot
fields it needs for its own judgement, and the browser host validates everything else against its own config
before anything is sent to Telegram.

Streams: only the final STAGE_QA_RESULT line is written to stdout; everything forwarded (the report script's
stderr, the browser host's output, our own messages) goes to stderr.

Exit codes: 0 passed, 1 failed (a case failed, the bot restarted or is not online), 2 refused (the report or the
case list is invalid), 3 not provisioned / could not run (config, key, the report script, the browser host
unreachable or silent, no LOCKED line within `lock_timeout`, an answer for another commit), 75 the browser
host's lock wait timed out, 76 superseded (the slot moved, no verdict for this commit), 77 the slot never ran the
commit within the wait; a signal exits 128+signal.

Timeouts (config keys; the workflow's job limit must cover their sum plus the report calls, see stage-qa.yml):
`lock_timeout` for the browser lock (the browser half waits at most 2700 s), `slot_wait` for the slot, and
`browser_timeout` for the cases (smoke 1500 s).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import NamedTuple

from stage_qa_common import (
    EXIT_FAILED,
    EXIT_LOCK_TIMEOUT,
    EXIT_NOT_PROVISIONED,
    EXIT_PASSED,
    EXIT_REFUSED,
    EXIT_SLOT_NEVER_RAN,
    EXIT_SUPERSEDED,
    LOCKED_LINE,
    RESULT_PREFIX,
    SHA_PATTERN,
    NotProvisioned,
    Refused,
    SignalState,
    Verdict,
    bad,
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

DEFAULT_CONFIG = "/etc/esb-stage-qa/driver.json"
INSTALLER = "scripts/install-stage-qa.sh"
REPORT_SCRIPT = "/usr/local/lib/esb-stage-qa/odroid-stage-qa-report.py"
REPORT_PREFIX = "STAGE_REPORT "
KILL_GRACE_SECONDS = 5
# The browser half waits up to 2700 s for its browser lock; the margin covers ssh connect and start-up.
DEFAULT_LOCK_TIMEOUT = 3000
# The browser half runs the cases for at most 1500 s (its smoke_timeout) once it has the report.
DEFAULT_BROWSER_TIMEOUT = 1800
POLL_SECONDS = 0.2

TARGET_PATTERN = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9_.:-]*")
RESULT_FIELDS = re.compile(
    rf"^{RESULT_PREFIX} status=(\S+) sha=(\S+) cases=([0-9]+) failed=([0-9]+)$"
)

REPORT_NOT_PROVISIONED = 3
# Exit statuses of the browser host's forced command that are verdicts; anything else (ssh's own 255,
# a signal, a crash of the command itself) means the QA could not run, which is not a verdict on the PR.
BROWSER_CODES = (EXIT_PASSED, EXIT_FAILED, EXIT_REFUSED, EXIT_NOT_PROVISIONED, EXIT_LOCK_TIMEOUT)


def say(message):
    log(f"stage-qa-driver: {message}")


# ---------------------------------------------------------------- config


class Config(NamedTuple):
    report_command: tuple
    browser_target: str
    browser_key: str
    browser_known_hosts: str | None
    report_timeout: float
    lock_timeout: float
    slot_wait: float
    slot_poll: float
    browser_timeout: float


DEFAULTS = {
    "report_command": ["sudo", "-n", REPORT_SCRIPT],
    "report_timeout": 120,
    "lock_timeout": DEFAULT_LOCK_TIMEOUT,
    "slot_wait": 600,
    "slot_poll": 20,
    "browser_timeout": DEFAULT_BROWSER_TIMEOUT,
}
REQUIRED_KEYS = ("browser_target", "browser_key")
OPTIONAL_KEYS = ("browser_known_hosts",)


def load_config(path):
    path = os.path.expanduser(path)
    merged = merge_config(
        read_config_file(path, INSTALLER, allow_root_owner=True),
        DEFAULTS,
        REQUIRED_KEYS,
        OPTIONAL_KEYS,
    )
    target = text_value(merged, "browser_target")
    if not TARGET_PATTERN.fullmatch(target):
        raise bad("browser_target must look like user@host")
    known_hosts = (
        path_value(merged, "browser_known_hosts") if "browser_known_hosts" in merged else None
    )
    return Config(
        report_command=string_list_value(merged, "report_command", allow_empty=False),
        browser_target=target,
        browser_key=path_value(merged, "browser_key"),
        browser_known_hosts=known_hosts,
        report_timeout=number_value(merged, "report_timeout", minimum=0, allow_equal=False),
        lock_timeout=number_value(merged, "lock_timeout", minimum=0, allow_equal=False),
        slot_wait=number_value(merged, "slot_wait", minimum=0, allow_equal=True),
        slot_poll=number_value(merged, "slot_poll", minimum=0, allow_equal=False),
        browser_timeout=number_value(merged, "browser_timeout", minimum=0, allow_equal=False),
    )


def check_provisioned(config):
    """Everything the run needs on this host; returns the resolved report argv and ssh client."""
    if not os.path.isfile(config.browser_key):
        raise NotProvisioned(
            f"ssh key {config.browser_key} not found; see DEPLOY.md, Stage QA install"
        )
    if config.browser_known_hosts and not os.path.isfile(config.browser_known_hosts):
        raise NotProvisioned(f"ssh known_hosts file {config.browser_known_hosts} not found")
    ssh = shutil.which("ssh")
    if ssh is None:
        raise NotProvisioned("ssh client not found in PATH")
    first = shutil.which(config.report_command[0])
    if first is None:
        raise NotProvisioned(f"report command {config.report_command[0]} not found in PATH")
    report_command = [first, *config.report_command[1:]]
    if not os.path.isfile(report_command[-1]):
        raise NotProvisioned(
            f"report script {report_command[-1]} is not installed; run {INSTALLER} as root"
        )
    return report_command, ssh


# ---------------------------------------------------------------- the report script


class Report(NamedTuple):
    sha: str | None
    online: bool
    started_at: int
    restarts: int
    slot_error: str | None
    # The report as the script printed it: forwarded as is to the browser host, which validates the rest.
    text: str


def refuse_json_constant(name):
    raise ValueError(f"{name} is not valid JSON")


def _count(data, key):
    value = data.get(key)
    if type(value) is not int or value < 0:
        raise Refused(f"STAGE_REPORT {key} is not a non-negative integer")
    return value


def parse_report(payload_text):
    """The slot fields of the report; the case list and the bot identity are the browser host's to judge."""
    try:
        data = json.loads(payload_text, parse_constant=refuse_json_constant)
    except (ValueError, RecursionError):
        raise Refused("STAGE_REPORT is not valid JSON") from None
    if type(data) is not dict:
        raise Refused("STAGE_REPORT payload is not an object")
    sha = data.get("sha")
    if sha is not None and (type(sha) is not str or not SHA_PATTERN.fullmatch(sha)):
        raise Refused("STAGE_REPORT sha is not a full lowercase commit SHA")
    online = data.get("online")
    if type(online) is not bool:
        raise Refused("STAGE_REPORT online is not a boolean")
    slot_error = data.get("slot_error")
    if slot_error is not None and type(slot_error) is not str:
        raise Refused("STAGE_REPORT slot_error is not text")
    return Report(
        sha=sha,
        online=online,
        started_at=_count(data, "started_at"),
        restarts=_count(data, "restarts"),
        slot_error=slot_error,
        text=payload_text,
    )


def fetch_report(config, report_command):
    try:
        done = subprocess.run(
            report_command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdin=subprocess.DEVNULL,
            timeout=config.report_timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise NotProvisioned(
            f"the report script did not answer within {int(config.report_timeout)}s"
        ) from None
    except OSError as error:
        raise NotProvisioned(f"cannot run the report script ({error.strerror})") from None
    for line in done.stderr.splitlines():
        log(f"report: {line}")
    if done.returncode == REPORT_NOT_PROVISIONED:
        raise NotProvisioned(
            "the report script is not provisioned or cannot prove the stage identity"
        )
    if done.returncode != 0:
        raise Refused(
            f"the report script ended with exit status {done.returncode} (sudo refused it or it failed)"
        )
    lines = [line for line in done.stdout.splitlines() if line.startswith(REPORT_PREFIX)]
    if len(lines) != 1:
        raise Refused(f"expected one STAGE_REPORT line from the report script, got {len(lines)}")
    return parse_report(lines[0][len(REPORT_PREFIX) :])


class SlotNeverRan(Exception):
    def __init__(self, last):
        super().__init__()
        self.last = last


class BrowserGone(Exception):
    """The browser host's connection ended while the driver waited for the slot."""


def wait_for_slot(config, report_command, sha, browser):
    """The report that shows the slot running `sha` with the bot online; SlotNeverRan after slot_wait,
    BrowserGone when the browser host's connection ends first."""
    deadline = time.monotonic() + config.slot_wait
    while True:
        report = fetch_report(config, report_command)
        if report.sha == sha and report.online:
            return report
        shown = report.sha[:12] if report.sha else f"nothing ({report.slot_error or 'bot offline'})"
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SlotNeverRan(report)
        say(f"the stage slot runs {shown}, waiting for {sha[:12]} ({int(remaining)}s left)")
        if browser.pause(min(config.slot_poll, remaining)):
            raise BrowserGone()


# ---------------------------------------------------------------- the browser host


class Child:
    """A subprocess whose stdout lines go to `on_line` and whose stderr goes to the log."""

    def __init__(self, argv, on_line):
        self.gone = threading.Event()
        self._on_line = on_line
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            # Own session: a ^C or group signal aimed at the driver must not cut the child before we decide to.
            start_new_session=True,
        )
        self.threads = [
            threading.Thread(target=self._read_stdout, daemon=True),
            threading.Thread(target=self._read_stderr, daemon=True),
        ]
        for thread in self.threads:
            thread.start()

    def _read_stdout(self):
        try:
            for raw in self.proc.stdout:
                self._on_line(raw.rstrip("\r\n"))
        finally:
            self.gone.set()

    def _read_stderr(self):
        for raw in self.proc.stderr:
            log(raw.rstrip("\r\n"))

    def write_line(self, text):
        try:
            self.proc.stdin.write(text + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError):
            pass

    def close_stdin(self):
        try:
            self.proc.stdin.close()
        except (OSError, ValueError):
            pass

    def wait(self, timeout):
        """Waits for the exit and for the reader threads to drain the pipes; False when it outlived `timeout`."""
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return False
        for thread in self.threads:
            thread.join(timeout=5)
        return True

    def stop(self):
        """TERM the whole process group, give it a moment, KILL what is left and reap the child."""
        terminate_group(self.proc, KILL_GRACE_SECONDS)


class BrowserOutcome(NamedTuple):
    kind: str  # "exit" | "timeout"
    code: int = 0
    # (status, sha, cases, failed) of the browser host's last STAGE_QA_RESULT line
    result: tuple | None = None


def browser_argv(config, ssh, sha):
    argv = [
        ssh,
        "-i",
        config.browser_key,
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        "-o",
        "ConnectTimeout=30",
    ]
    if config.browser_known_hosts:
        argv += ["-o", f"UserKnownHostsFile={config.browser_known_hosts}"]
    # The forced command on the browser host reads the SHA from SSH_ORIGINAL_COMMAND.
    return [*argv, config.browser_target, sha]


class BrowserSession:
    """The ssh connection to the browser host's forced command: LOCKED line first, then (after the report
    payload line) the cases and the result line. Its stdin stays open: the browser host treats its end as
    "the odroid side is gone" and stops (frees the lock, stops the cases)."""

    def __init__(self, argv):
        self.locked = threading.Event()
        self.result = None
        self._stopped = False
        self.child = Child(argv, self._on_line)

    def _on_line(self, line):
        match = RESULT_FIELDS.match(line)
        if line == LOCKED_LINE:
            self.locked.set()
            log(f"browser host: {line}")
        elif match:
            self.result = (match.group(1), match.group(2), int(match.group(3)), int(match.group(4)))
            log(f"browser host: {line}")
        else:
            log(line)

    @property
    def exited(self):
        return self.child.proc.poll() is not None

    def wait_locked(self, timeout):
        """ "locked" | "exit" the connection ended first | "timeout"."""
        deadline = time.monotonic() + timeout
        while True:
            if self.locked.wait(POLL_SECONDS):
                return "locked"
            if self.exited:
                # The LOCKED line may still be in the pipe when the process is already gone.
                self.child.gone.wait(KILL_GRACE_SECONDS)
                return "locked" if self.locked.is_set() else "exit"
            if time.monotonic() >= deadline:
                return "timeout"

    def pause(self, seconds):
        """Sleeps up to `seconds`; True as soon as the connection has ended."""
        return self.child.gone.wait(seconds)

    def send_payload(self, payload):
        self.child.write_line(payload)

    def wait_verdict(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            try:
                code = self.child.proc.wait(timeout=POLL_SECONDS)
                kind = "exit"
            except subprocess.TimeoutExpired:
                if time.monotonic() < deadline:
                    continue
                say(f"the browser host did not finish within {int(timeout)}s; stopping it")
                kind, code = "timeout", 0
            self.stop()
            return BrowserOutcome(kind, code, self.result)

    def exit_outcome(self):
        """The connection has ended: its exit status and last result line."""
        self.stop()
        return BrowserOutcome("exit", self.child.proc.returncode, self.result)

    def stop(self):
        """Close stdin (the browser half stops and frees its lock), stop what does not follow, join the readers
        (so the last result line is parsed before it is read). Idempotent."""
        if self._stopped:
            return
        self._stopped = True
        self.child.close_stdin()
        try:
            self.child.proc.wait(timeout=KILL_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            self.child.stop()
        self.child.wait(KILL_GRACE_SECONDS)


def browser_verdict(sha, outcome):
    """The browser host's exit status as our verdict. 0 without a pass result line is never a pass."""
    status, result_sha, cases, failed = outcome.result if outcome.result else (None, sha, 0, 0)
    code = outcome.code
    if result_sha != sha:
        say(
            f"the browser host answered for commit {result_sha}, not {sha}; the QA could not run (not a verdict on the PR)"
        )
        return Verdict(EXIT_NOT_PROVISIONED, cases, failed)
    if code == EXIT_PASSED:
        if status == "passed" and failed == 0 and cases >= 1:
            return Verdict(EXIT_PASSED, cases, failed)
        say(
            "the browser host exited 0 without a pass result covering at least one case; treating it as a failure"
        )
        return Verdict(EXIT_FAILED, cases, failed)
    if code in BROWSER_CODES:
        return Verdict(code, cases, failed)
    say(
        f"the browser host connection ended with exit status {code}; the QA could not run (not a verdict on the PR)"
    )
    return Verdict(EXIT_NOT_PROVISIONED, cases, failed)


def browser_ended_early(sha, browser, when):
    """The browser half ended before it was sent the payload: its exit status is the verdict, but never a pass."""
    say(f"the browser host ended {when}")
    outcome = browser.exit_outcome()
    if outcome.code == EXIT_PASSED:
        say("the browser host exited 0 before the cases ran; treating it as a failure")
        return Verdict(EXIT_FAILED)
    return browser_verdict(sha, outcome)


# ---------------------------------------------------------------- the run


def slot_verdict(before, after, sha):
    """What the second report says about the run: None when the slot stayed put and the bot stayed up."""
    if after.sha != sha:
        say(
            f"the stage slot moved to {after.sha[:12] if after.sha else 'nothing'} during the run; the result is void"
        )
        return Verdict(EXIT_SUPERSEDED)
    redeployed = after.started_at != before.started_at
    if after.restarts > before.restarts:
        say(
            f"the stage bot restarted by itself during the run (restarts {before.restarts} -> {after.restarts})"
        )
        return Verdict(EXIT_FAILED)
    if redeployed:
        say("the stage bot was redeployed during the run; the result is void")
        return Verdict(EXIT_SUPERSEDED)
    if not after.online:
        say("the stage bot went offline during the run")
        return Verdict(EXIT_FAILED)
    return None


def await_browser_lock(config, sha, browser):
    """None once the browser host holds its lock (the odroid side may start); otherwise the verdict of this run."""
    kind = browser.wait_locked(config.lock_timeout)
    if kind == "locked":
        return None
    if kind == "timeout":
        say(
            f"the browser host did not take its lock within {int(config.lock_timeout)}s; the QA could not run"
        )
        return Verdict(EXIT_NOT_PROVISIONED)
    return browser_ended_early(sha, browser, "before it took its lock")


def drive(config, report_command, sha, browser):
    """With the browser lock held: the slot, the report to the browser host, its verdict, the slot again."""
    try:
        first = wait_for_slot(config, report_command, sha, browser)
    except SlotNeverRan as never:
        if never.last.sha == sha:
            say("the stage slot runs this commit but the bot is not online; failing the run")
            return Verdict(EXIT_FAILED)
        say(
            f"the stage slot never ran {sha[:12]} within {int(config.slot_wait)}s; "
            f"re-run the `Stage Bot` workflow of this pull request to deploy it again"
        )
        return Verdict(EXIT_SLOT_NEVER_RAN)
    except BrowserGone:
        return browser_ended_early(sha, browser, "while the driver waited for the stage slot")
    browser.send_payload(first.text)
    outcome = browser.wait_verdict(config.browser_timeout)
    if outcome.kind == "timeout":
        return Verdict(EXIT_NOT_PROVISIONED)
    verdict = browser_verdict(sha, outcome)
    if verdict.code in (EXIT_REFUSED, EXIT_NOT_PROVISIONED, EXIT_LOCK_TIMEOUT):
        # Not a statement about the slot: the browser host refused or could not run.
        return verdict
    moved = slot_verdict(first, fetch_report(config, report_command), sha)
    return moved if moved is not None else verdict


def run_session(config, report_command, ssh, sha):
    """The browser connection is opened FIRST and ALWAYS closed before returning: closing its stdin is what makes
    the browser half exit and free the shared browser lock when the odroid side ends before the payload."""
    browser = BrowserSession(browser_argv(config, ssh, sha))
    try:
        verdict = await_browser_lock(config, sha, browser)
        if verdict is None:
            verdict = drive(config, report_command, sha, browser)
    finally:
        SignalState.cleaning = True
        browser.stop()
    return verdict


def execute(sha, config_path):
    config = load_config(config_path)
    report_command, ssh = check_provisioned(config)
    return run_session(config, report_command, ssh, sha)


def main(argv):
    return run_cli(
        "stage-qa-driver.py",
        "Run the per-PR stage QA from the odroid.",
        DEFAULT_CONFIG,
        "driver config",
        argv,
        execute,
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
