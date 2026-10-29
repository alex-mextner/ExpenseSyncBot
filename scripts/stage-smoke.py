#!/usr/bin/env python3
"""Smoke-test a pull request's build on the STAGE bot with real Telegram messages (#840, owner point 2).

Two halves of one engine, split by machine because nothing PR-controlled may run next to a logged-in
Telegram account:
  * `guard` runs on the odroid next to the stage env. It proves the target is not production and
    validates the case list, then prints ONE line `STAGE_GUARD {json}` for the driver.
  * `run` runs on the browser host (stage-qa-browser.py). It validates the list again (never trusting the odroid), sends every case to
    the stage bot through qa-cli (`qa telegram chat send|wait|read`, Telegram Web A in a logged-in
    browser, so blockquote answers are readable), and asserts that answers arrive, match, and arrive
    fast enough. Any failed case fails the PR's `stage-qa` check.

This file is installed from a reviewed `main` checkout and never taken from the PR's artifact. The PR
supplies only the case list (data), which this file therefore validates strictly.

Guards, because a smoke run that talks to production would message real users:
  * the target username comes from the stage env file, must differ from every prod username (the
    prod env's BOT_USERNAME/INLINE_BOT_USERNAME plus --deny), and must look like a stage bot
    (contains "stage"/"stg");
  * the stage token's bot id must differ from the prod token's bot id, and Telegram's getMe for the
    stage token must answer with that very username;
  * an empty case list is an error, never a pass; --min-cases and --require-case let the trusted
    caller fix a floor the PR's own list cannot go below (a PR must not drop coverage to go green);
  * a send text must be one line (qa-cli sends one line per message).

Replay hook (history-derived cases): --extra-cases FILE appends cases of the same schema, optionally
with a "source" label that is printed and kept in the receipt. Extra cases never count toward the
floor and cannot reuse a base case name.

Usage:
  stage-smoke.py guard --cases FILE [--extra-cases FILE ...] --min-cases N [--require-case NAME ...]
                       --stage-env FILE --prod-env FILE [--deny NAME ...]
  stage-smoke.py run --cases-json FILE --username U --peer ID --sha SHA [--deny NAME ...]
                     [--receipt FILE] [--qa-bin PATH] [--timeout-scale F] [--min-cases N] [--base-cases N]
Exit: 0 passed, 1 a case failed, 64 refused (guard, empty cases, bad input, qa-cli safety refusal),
69 qa-cli unavailable or not logged in.
"""

import argparse
import asyncio
import datetime
import http.client
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REFUSED = 64
UNAVAILABLE = 69
STAGE_NAME = re.compile(r"stage|stg", re.IGNORECASE)
USERNAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{4,31}$")


class Refused(Exception):
    pass


def parse_env(path):
    values = {}
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip("\"'")
    return values


def bot_id(token):
    head = token.split(":", 1)[0]
    if not head.isdigit():
        raise Refused("BOT_TOKEN does not look like a Telegram bot token")
    return head


NUMBER_KEYS = ("min_replies", "timeout_s", "settle_s", "max_first_reply_s")
PATTERN_KEYS = ("expect", "forbid")


def check_case_numbers(case):
    for key in NUMBER_KEYS:
        if key in case and (isinstance(case[key], bool) or not isinstance(case[key], (int, float))):
            raise Refused(f"case {case['name']}: {key} must be a number")


def check_case_patterns(case):
    """expect/forbid are lists of non-empty patterns that compile; a string would be iterated per character."""
    for key in PATTERN_KEYS:
        patterns = case.get(key, [])
        if not isinstance(patterns, list) or not all(
            isinstance(pattern, str) and pattern for pattern in patterns
        ):
            raise Refused(f"case {case['name']}: {key} must be a list of non-empty patterns")
    if case.get("min_replies", 1) < 1:
        # Even with a `forbid`, a case that passes on silence lets a dead bot go green.
        raise Refused(f"case {case['name']} asserts nothing: min_replies must be at least 1")
    for key in PATTERN_KEYS:
        for pattern in case.get(key, []):
            try:
                re.compile(pattern)
            except re.error as error:
                raise Refused(f"case {case['name']}: bad {key} pattern ({error})") from None


def validate_case(case, index, seen):
    if (
        not isinstance(case, dict)
        or not case.get("name")
        or not isinstance(case.get("send"), str)
        or not case["send"]
    ):
        raise Refused(f"case #{index} needs a name and a send text")
    if case["name"] in seen:
        raise Refused(f"duplicate case name '{case['name']}'")
    seen.add(case["name"])
    require_one_line(case["send"], case["name"])
    check_case_numbers(case)
    check_case_patterns(case)


def validate_cases(cases, label, what="smoke"):
    if not isinstance(cases, list) or not cases:
        raise Refused(f"{label} has no {what} cases; an empty list must never pass a check")
    seen = set()
    for index, case in enumerate(cases):
        validate_case(case, index, seen)
    return cases


def require_one_line(text, name):
    # qa-cli sends one line per message; a newline would silently become several messages or a draft.
    if "\n" in text or "\r" in text:
        raise Refused(f"case {name}: the send text must be one line")


def load_cases(path, what="smoke"):
    return validate_cases(json.loads(Path(path).read_text()), path, what)


def assemble_cases(base_path, extra_paths, min_cases, required):
    """Base list checked against the caller's floor, then the replay cases appended."""
    base = load_cases(base_path)
    if len(base) < min_cases:
        raise Refused(f"{base_path} has {len(base)} smoke cases, at least {min_cases} are required")
    names = {case["name"] for case in base}
    for name in required:
        if name not in names:
            raise Refused(f"required case '{name}' is missing from {base_path}")
    cases = list(base)
    for path in extra_paths:
        if not Path(path).is_file():
            raise Refused(f"replay cases file {path} does not exist")
        for case in load_cases(path, what="replay"):
            if case["name"] in names:
                raise Refused(f"duplicate case name '{case['name']}' in {path}")
            names.add(case["name"])
            cases.append(case)
    return cases


def guard_target(stage_env, prod_env, deny):
    """Return the stage username after proving it is not production. Raises Refused otherwise."""
    username = stage_env.get("BOT_USERNAME", "").lstrip("@")
    token = stage_env.get("BOT_TOKEN", "")
    if not USERNAME.fullmatch(username):
        raise Refused("stage BOT_USERNAME is missing or malformed")
    if not token:
        raise Refused("stage BOT_TOKEN is missing")
    denied = {name.lstrip("@").lower() for name in deny}
    if prod_env.get("BOT_USERNAME"):
        denied.add(prod_env["BOT_USERNAME"].lstrip("@").lower())
    if prod_env.get("INLINE_BOT_USERNAME"):
        denied.add(prod_env["INLINE_BOT_USERNAME"].lstrip("@").lower())
    if username.lower() in denied:
        raise Refused(f"refusing to smoke-test @{username}: it is a production bot")
    if not STAGE_NAME.search(username):
        raise Refused(
            f"@{username} does not look like a stage bot (its username must contain 'stage' or 'stg')"
        )
    if prod_env.get("BOT_TOKEN") and bot_id(token) == bot_id(prod_env["BOT_TOKEN"]):
        raise Refused("the stage token is the production token")
    return username


def telegram_get_me(token):
    """Username Telegram reports for the token. The token travels in the URL path only, never in argv or logs."""
    try:
        # No environment proxy: the token is in the URL path and this host's answer must come from Telegram itself.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"https://api.telegram.org/bot{token}/getMe", timeout=20) as response:
            return json.load(response)["result"]["username"]
    except (OSError, http.client.HTTPException, ValueError, LookupError, TypeError) as error:
        # the message of a urllib error would contain the token URL
        raise Refused(f"getMe for the stage token failed ({type(error).__name__})") from None


# qa-cli's own wording for a page, a search result or a chat that did not show up in time, all before any text is typed.
COLD_START_TIMEOUT = re.compile(
    r"timed out after \d+s waiting for (Telegram Web to load|search result|chat \S+ to open)"
)


class QaCliTransport:
    """Drives one chat with the stage bot through `qa telegram chat ...`; each call is a short-lived subprocess."""

    SUBCOMMANDS = ("open", "send", "wait", "read")

    def __init__(self, qa_bin, peer, username):
        self.qa_bin = str(qa_bin)
        self.peer = str(peer)
        self.username = username
        self.poll_interval = 1.0
        self.call_grace = 60  # qa re-opens the chat and may take a while beyond its own --timeout
        self.send_attempts = 3
        self.retry_delay = 5.0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def qa(self, action, *flags, timeout):
        """One qa call: returns (exit code, parsed last stdout line). Raises Refused (exit 2) or ConnectionError."""
        command = ["telegram", "chat"]
        argv = [
            self.qa_bin,
            *command,
            action,
            "--peer",
            self.peer,
            "--username",
            self.username,
            *flags,
        ]
        try:
            proc = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=timeout + self.call_grace,
                stdin=subprocess.DEVNULL,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise ConnectionError(
                f"qa {action} did not finish within {timeout + self.call_grace:g}s"
            ) from None
        except OSError as error:
            raise ConnectionError(f"qa binary is not runnable ({type(error).__name__})") from None
        lines = [line for line in proc.stdout.splitlines() if line.strip()]
        try:
            payload = json.loads(lines[-1])
        except (IndexError, ValueError):
            payload = None
        if not isinstance(payload, dict):
            if proc.returncode == 3:
                raise ConnectionError("qa-cli is not logged in to Telegram") from None
            raise ConnectionError(f"qa {action} printed no JSON (exit {proc.returncode})") from None
        error = payload.get("error", "no details")
        if proc.returncode == 2:
            raise Refused(f"qa refused: {error}")
        if proc.returncode == 3:
            raise ConnectionError(f"qa-cli is not logged in to Telegram: {error}")
        if proc.returncode not in (0, 1):
            raise ConnectionError(f"qa {action} exited {proc.returncode}: {error}")
        return proc.returncode, payload

    @staticmethod
    def text_flag(text):
        # argparse takes a value starting with "-" for an option only in the "--text=VALUE" form.
        return [f"--text={text}"] if text.startswith("-") else ["--text", text]

    @staticmethod
    def sent_message_id(code, sent):
        """The id of the message qa confirmed sending; anything else fails closed."""
        message = sent.get("message") if code == 0 and sent.get("ok") else None
        if not isinstance(message, dict) or "id" not in message:
            raise ConnectionError(f"qa send failed: {sent.get('error', 'no confirmed message')}")
        return message["id"]

    @staticmethod
    def record_incoming(messages, texts, latencies, send_started_at):
        for item in messages:
            if (
                item.get("out") is False
            ):  # latest text per id wins, so edited answers replace their first draft
                texts[item["id"]] = item.get("text") or ""
                latencies.setdefault(item["id"], time.monotonic() - send_started_at)

    async def send_confirmed(self, text, timeout):
        """The id of the confirmed sent message; a send that failed before anything was typed is retried."""
        for attempt in range(1, self.send_attempts + 1):
            code, sent = await asyncio.to_thread(
                self.qa, "send", *self.text_flag(text), timeout=timeout
            )
            try:
                return self.sent_message_id(code, sent)
            except ConnectionError:
                # Only a timeout BEFORE the message is typed is retried: the first call of a run starts a cold
                # headless browser on a busy host, and nothing was sent. Any other failure may have delivered it.
                if attempt == self.send_attempts or not COLD_START_TIMEOUT.search(
                    str(sent.get("error", ""))
                ):
                    raise
            await asyncio.sleep(self.retry_delay)

    async def exchange(self, text, timeout, settle):
        """Send text; return [(reply text, seconds since the send began)] after `settle` quiet seconds or on timeout.

        The clock starts BEFORE `qa send`, which returns only after Telegram Web confirmed the message,
        and is never restarted after the confirmation. The latency is therefore the time since the send
        attempt began (UI send + confirmation + the bot's answer): an upper bound on the reply latency,
        so a slow bot or a slow confirmation can fail max_first_reply_s (#858).
        """
        require_one_line(text, "exchange")
        send_started_at = time.monotonic()
        sent_id = await self.send_confirmed(text, timeout)
        sent_at = time.monotonic()
        code, first = await asyncio.to_thread(
            self.qa,
            "wait",
            "--after",
            str(sent_id),
            "--from",
            "peer",
            "--timeout",
            f"{timeout:g}",
            timeout=timeout,
        )
        if code != 0 or not first.get("ok"):
            return []  # the answer never came; the case fails on min_replies
        latency = time.monotonic() - send_started_at
        reply = first["message"]
        texts = {reply["id"]: reply.get("text") or ""}
        latencies = {reply["id"]: latency}
        # The window for the answer counts from the moment the message was sent, not from the first send attempt:
        # cold-start retries of the send must not eat it.
        deadline = sent_at + timeout
        last_change = time.monotonic()
        snapshot = frozenset(texts.items())
        while time.monotonic() - last_change < settle and time.monotonic() < deadline:
            await asyncio.sleep(self.poll_interval)
            code, read = await asyncio.to_thread(
                self.qa, "read", "--after", str(sent_id), timeout=timeout
            )
            if code != 0 or not read.get("ok"):
                continue  # a flaky read must not turn a good answer into a failure; the next poll retries
            self.record_incoming(read.get("messages", []), texts, latencies, send_started_at)
            current = frozenset(texts.items())
            if current != snapshot:
                snapshot = current
                last_change = time.monotonic()
        return [(texts[message_id], latencies[message_id]) for message_id in texts]


def judge(case, replies):
    """List of problems for one case; empty means the case passed."""
    problems = []
    joined = "\n".join(text for text, _ in replies)
    if len(replies) < case.get("min_replies", 1):
        problems.append(f"{len(replies)} replies, expected at least {case.get('min_replies', 1)}")
    if (
        replies
        and case.get("expect")
        and not any(re.search(p, joined, re.IGNORECASE | re.DOTALL) for p in case["expect"])
    ):
        problems.append("no reply matched any of the expected patterns")
    for pattern in case.get("forbid", []):
        if re.search(pattern, joined, re.IGNORECASE | re.DOTALL):
            problems.append(f"reply matched forbidden pattern {pattern!r}")
    first = min((latency for _, latency in replies), default=None)
    limit = case.get("max_first_reply_s")
    if first is not None and limit is not None and first > limit:
        problems.append(f"first reply took {first:.1f}s, limit {limit}s")
    return problems


REPLY_PREVIEW_CHARS = 200


def print_replies(name, replies):
    for index, (text, _) in enumerate(replies, 1):
        shown = " ".join((text or "").split())[:REPLY_PREVIEW_CHARS]
        print(f"SMOKE REPLY {name} #{index}: {shown}")


async def run_cases(cases, transport, scale):
    results = []
    for case in cases:
        timeout = case.get("timeout_s", 60) * scale
        replies = await transport.exchange(case["send"], timeout, case.get("settle_s", 3))
        problems = judge(case, replies)
        first = min((latency for _, latency in replies), default=None)
        result = {
            "name": case["name"],
            "ok": not problems,
            "problems": problems,
            "replies": len(replies),
            "first_reply_s": None if first is None else round(first, 2),
        }
        if case.get("source"):
            result["source"] = str(case["source"])
        results.append(result)
        status = "PASS" if not problems else "FAIL"
        print(
            f"SMOKE {status} {case['name']} replies={len(replies)} first={result['first_reply_s']}s"
            + (f" source={result['source']}" if "source" in result else "")
            + "".join(f" problem={p}" for p in problems)
        )
        if problems:
            # Only for a failed case: the stage bot's own reply to a fixed test phrase (no user data lives on stage),
            # one line each and cut short, so a red check can be diagnosed from the job log alone.
            print_replies(case["name"], replies)
    return results


def write_receipt(path, sha, username, results, passed):
    record = {
        "sha": sha,
        "bot": username,
        "passed": passed,
        "cases": results,
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(record, indent=2) + "\n")
    tmp.chmod(0o600)  # names, counts and latencies only; the directory is root-only anyway
    os.replace(tmp, path)


def guard_command(args, get_me):
    cases = assemble_cases(args.cases, args.extra_cases, args.min_cases, args.require_case)
    stage_env = parse_env(args.stage_env)
    prod_env = parse_env(args.prod_env) if Path(args.prod_env).is_file() else {}
    username = guard_target(stage_env, prod_env, args.deny)
    actual = get_me(stage_env["BOT_TOKEN"])
    if actual.lower() != username.lower():
        raise Refused(f"the stage token belongs to @{actual}, not @{username}")
    base = len(load_cases(args.cases))
    payload = {
        "username": username,
        "peer": bot_id(stage_env["BOT_TOKEN"]),
        "cases": cases,
        "base_cases": base,
    }
    print("STAGE_GUARD " + json.dumps(payload, separators=(",", ":"), ensure_ascii=True))
    return 0


def check_run_target(username, peer, deny):
    """The browser host's own copy of the production checks: it only knows the names it was given, never the odroid's env."""
    if not USERNAME.fullmatch(username):
        raise Refused("--username is malformed")
    if username.lower() in {name.lstrip("@").lower() for name in deny}:
        raise Refused(f"refusing to smoke-test @{username}: it is a production bot")
    if not STAGE_NAME.search(username):
        raise Refused(
            f"@{username} does not look like a stage bot (its username must contain 'stage' or 'stg')"
        )
    if not peer.isdigit():
        raise Refused("--peer must be the numeric bot id")


def run_command(args, transport_factory):
    check_run_target(args.username, args.peer, args.deny)
    cases = validate_cases(json.loads(Path(args.cases_json).read_text()), args.cases_json)
    base = len(cases) if args.base_cases is None else args.base_cases
    if not 1 <= base <= len(cases):
        raise Refused(f"--base-cases {base} does not fit a list of {len(cases)} cases")
    if base < args.min_cases:
        raise Refused(
            f"{args.cases_json} has {base} smoke cases, at least {args.min_cases} are required"
        )
    factory = transport_factory or (lambda: QaCliTransport(args.qa_bin, args.peer, args.username))

    async def go():
        async with factory() as transport:
            return await run_cases(cases, transport, args.timeout_scale)

    try:
        results = asyncio.run(go())
    except (ConnectionError, OSError) as error:
        print(f"STAGE_SMOKE_UNAVAILABLE {type(error).__name__}: {error}", file=sys.stderr)
        return UNAVAILABLE
    passed = all(r["ok"] for r in results)
    if args.receipt:
        write_receipt(args.receipt, args.sha, args.username, results, passed)
    word = "PASSED" if passed else "FAILED"
    print(
        f"STAGE_SMOKE_{word} sha={args.sha} bot=@{args.username} cases={len(results)} failed={sum(not r['ok'] for r in results)}"
    )
    return 0 if passed else 1


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    guard = commands.add_parser(
        "guard", help="odroid: prove the target is not production, print STAGE_GUARD"
    )
    guard.add_argument("--cases", required=True)
    guard.add_argument("--extra-cases", action="append", default=[])
    guard.add_argument("--min-cases", type=int, default=1)
    guard.add_argument("--require-case", action="append", default=[])
    guard.add_argument("--stage-env", required=True)
    guard.add_argument("--prod-env", required=True)
    guard.add_argument("--deny", action="append", default=[])
    run = commands.add_parser("run", help="browser host: run the guarded cases through qa-cli")
    run.add_argument("--cases-json", required=True)
    run.add_argument("--username", required=True)
    run.add_argument("--peer", required=True)
    run.add_argument("--sha", required=True)
    run.add_argument("--deny", action="append", default=[])
    run.add_argument("--receipt")
    run.add_argument("--qa-bin", default="qa")
    run.add_argument("--timeout-scale", type=float, default=1.0)
    run.add_argument("--min-cases", type=int, default=1)
    run.add_argument("--base-cases", type=int)
    return parser


def main(argv=None, transport_factory=None, get_me=telegram_get_me):
    args = build_parser().parse_args(argv)
    try:
        if args.command == "guard":
            return guard_command(args, get_me)
        return run_command(args, transport_factory)
    except (Refused, OSError, ValueError, KeyError) as error:
        print(f"STAGE_SMOKE_REFUSED {error}", file=sys.stderr)
        return REFUSED


if __name__ == "__main__":
    sys.exit(main())
