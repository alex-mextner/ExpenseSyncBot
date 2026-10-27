#!/usr/bin/env python3
"""Leftover-marker gate: fail if the CODE introduces debugging/forbidden leftovers.

Catches the classic "oops, left it in" mistakes before they merge:
  * focused tests         - the .only modifier, fdescribe, fit   (silently skip the rest of a suite)
  * debugger statements   - `debugger;`
  * stray console logs    - console.log/debug (configurable; warn vs block)
  * untracked TODOs       - TODO/FIXME WITHOUT an issue reference (TODO(ABC-123) is ok)
  * merge conflict markers - <<<<<<< / >>>>>>>

By default it scans only the lines ADDED in the PR diff (so it doesn't punish you for
pre-existing debt), falling back to a full-tree scan when no base ref is available.

Knobs (env):
  LEFTOVER_BASE        diff base. Default origin/main -> main -> full-tree scan.
  LEFTOVER_INCLUDE     regex of file paths to scan. Default: source-ish extensions.
  LEFTOVER_EXCLUDE     regex of paths to skip. Default: vendored/build/lock dirs.
  TICKET_REGEX         what makes an open-item marker "tracked". Default: the marker
                       followed by (ABC-123) or (#123) or a URL. Customize for your tracker.
  ALLOW_CONSOLE        "1" = console.log is a WARNING, not a failure (default: block).
  LEFTOVER_FULLTREE    "1" = always scan the whole tree, ignore the diff.
  LEFTOVER_HEAD        head ref/SHA to diff against the base. Default HEAD. Under a
                       tamper-resistant pull_request_target setup this is the PR head
                       SHA, fetched as DATA - `git diff` + regex only READ those lines,
                       they never execute PR code - so the trusted base script still
                       gates.

The three patterns above were POSIX ERE (`grep -E`) and are now Python `re`. POSIX bracket
classes (`[[:space:]]`, `[[:alpha:]]`, ...) and `\\<` / `\\>` word edges are translated;
other ERE/re differences (leftmost-longest vs leftmost-first alternation, which only
matters for what is matched, never whether) are irrelevant to the boolean tests used
here. An invalid pattern behaves as it did under grep (error => no match), minus
grep's own diagnostic lines.

Usage: sh ci/leftover-grep/leftover-grep.sh   (a launcher for this file)

Fail-closed rules (agent-tools#129/#130): an explicitly requested LEFTOVER_BASE that does
not resolve fails the gate; a diff/ls-files error fails the gate rather than passing
having scanned nothing. The three-dot diff needs a merge base; when both refs resolve but
none is reachable (shallow checkout; the official workflow fetches enough history, so this
is for direct callers or older copied workflows) it falls back to the two-dot form, which
over-blocks (safe direction) instead of passing on an empty scan.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from typing import TextIO

_POSIX_CLASSES = {
    "alpha": "a-zA-Z",
    "digit": "0-9",
    "alnum": "0-9A-Za-z",
    "upper": "A-Z",
    "lower": "a-z",
    "space": " \\t\\n\\r\\f\\v",
    "blank": " \\t",
    "punct": "!-/:-@\\[-`{-~",
    "xdigit": "0-9A-Fa-f",
    "word": "\\w",
    "cntrl": "\\x00-\\x1f\\x7f",
    "print": "\\x20-\\x7e",
    "graph": "\\x21-\\x7e",
}

_SOURCE_EXTS = "ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|c|h|cpp|hpp|cs|php|swift|sh"
DEFAULT_INCLUDE = r"\.(" + _SOURCE_EXTS + r")$"
DEFAULT_EXCLUDE = (
    r"(^|/)(node_modules|dist|build|out|vendor|\.git|coverage|__snapshots__)/"
    r"|\.min\.(js|css)$|lock$"
)
DEFAULT_TICKET = r"[A-Z]+-[0-9]+|#[0-9]+|https?://"

_FOCUSED = re.compile(r"\.only\(|(^|[^a-zA-Z])f(describe|it|test)\(")
_DEBUGGER = re.compile(r"(^|[^a-zA-Z])debugger;?\s*$")
_MARKER = re.compile(r"^(<{7}|>{7})( |$)")
_CONSOLE = re.compile(r"console\.(log|debug)\(")
# The marker words are assembled from parts so this vendored file does not trip the very
# rule it implements when a consumer's gate scans the diff that adds it.
_OPEN_WORD = "TO" + "DO"
_OPEN_ITEM = re.compile("(" + _OPEN_WORD + "|" + "FIX" + "ME)")
_PLUS_NUM = re.compile(r"\+[0-9]+")


def translate_ere(pattern: str) -> str:
    """Translate POSIX-only ERE syntax into Python `re` syntax."""

    def klass(m: re.Match[str]) -> str:
        return _POSIX_CLASSES.get(m.group(1), m.group(0))

    out = re.sub(r"\[:([a-z]+):\]", klass, pattern)
    return out.replace("\\<", "\\b").replace("\\>", "\\b")


def compile_ere(pattern: str) -> re.Pattern[str] | None:
    try:
        return re.compile(translate_ere(pattern))
    except re.error:
        return None


def matches(rx: re.Pattern[str] | None, text: str) -> bool:
    return rx is not None and rx.search(text) is not None


def out(stream: TextIO, message: str) -> None:
    stream.write(message + "\n")
    stream.flush()


def git_ok(*args: str) -> bool:
    try:
        proc = subprocess.run(
            ["git", *args],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return False
    return proc.returncode == 0


def diff_file_name(header: str) -> str:
    """New-side path from a `+++ b/<path>` header (awk `$2`, minus the b/ prefix)."""
    fields = [p for p in re.split(r"[ \t]+", header) if p]
    if len(fields) < 2:
        return ""
    return re.sub(r"^b/", "", fields[1])


def hunk_start(header: str) -> int:
    m = _PLUS_NUM.search(header)
    return int(m.group(0)[1:]) if m else 0


def parse_diff(text: str) -> list[tuple[str, int, str]]:
    """Parse `git diff --unified=0` output into (file, new-line-number, text) rows."""
    result: list[tuple[str, int, str]] = []
    fname = ""
    lineno = 0
    for line in text.split("\n"):
        if line.startswith("+++ "):
            fname = diff_file_name(line)
        elif line.startswith("@@ "):
            lineno = hunk_start(line)
        elif line.startswith("+") and fname:
            result.append((fname, lineno, line[1:]))
            lineno += 1
    return result


def diff_lines(base: str, head: str) -> list[tuple[str, int, str]] | None:
    rng = f"{base}...{head}"
    if not git_ok("merge-base", base, head):
        rng = f"{base}..{head}"
        out(
            sys.stderr,
            f"[leftover] no merge base for {base} <-> {head}; "
            "using two-dot diff (shallow checkout?).",
        )
    cmd = ["git", "diff", "--no-color", "--unified=0", rng, "--", "."]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, check=False)
    except OSError:
        return None
    if proc.returncode != 0:
        return None
    return parse_diff(proc.stdout.decode("utf-8", "surrogateescape"))


def tree_lines() -> list[tuple[str, int, str]] | None:
    try:
        proc = subprocess.run(["git", "ls-files"], stdout=subprocess.PIPE, check=False)
    except OSError:
        return None
    if proc.returncode != 0:
        return None
    result: list[tuple[str, int, str]] = []
    for name in proc.stdout.decode("utf-8", "surrogateescape").split("\n"):
        if not name or not os.path.isfile(name):
            continue
        try:
            with open(name, "rb") as fh:
                data = fh.read()
        except OSError:
            continue
        if b"\0" in data:
            continue
        text = data.decode("utf-8", "surrogateescape")
        lines = text.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        result.extend((name, i, ln) for i, ln in enumerate(lines, 1))
    return result


def resolve_base(env: dict[str, str]) -> str | None:
    """Return the diff base, '' for full-tree; None means fail closed."""
    explicit = "LEFTOVER_BASE" in env
    requested = env.get("LEFTOVER_BASE") or "origin/main"
    if env.get("LEFTOVER_FULLTREE", "0") == "1":
        return ""
    if git_ok("rev-parse", "--verify", "--quiet", requested):
        return requested
    if explicit:
        out(
            sys.stderr,
            f"[leftover] FAIL — requested diff base '{requested}' does not resolve; "
            "refusing to scan nothing (or flood). Fetch enough history, or set "
            "LEFTOVER_FULLTREE=1 to scan the whole tree on purpose.",
        )
        return None
    if git_ok("rev-parse", "--verify", "--quiet", "main"):
        return "main"
    return ""


def report(
    counts: dict[str, int],
    severity: str,
    hit: tuple[str, int, str, str],
) -> None:
    file, ln, rule, text = hit
    counts[severity] += 1
    if severity == "WARN":
        out(sys.stderr, f"  warn  [{rule}] {file}:{ln}  {text}")
        return
    out(sys.stdout, f"::error file={file},line={ln}::[{rule}] {text}")
    out(sys.stderr, f"  BLOCK [{rule}] {file}:{ln}  {text}")


def rules_hit(
    text: str, allow_console: bool, ticket: re.Pattern[str] | None
) -> list[tuple[str, str]]:
    """Return (severity, rule) for every rule the added line trips, in rule order."""
    hits = []
    if _FOCUSED.search(text):
        hits.append(("BLOCK", "focused-test"))
    if _DEBUGGER.search(text):
        hits.append(("BLOCK", "debugger"))
    if _MARKER.search(text):
        hits.append(("BLOCK", "merge-marker"))
    if _CONSOLE.search(text):
        hits.append(("WARN" if allow_console else "BLOCK", "console"))
    if _OPEN_ITEM.search(text) and not matches(ticket, text):
        hits.append(("BLOCK", "untracked-todo"))
    return hits


def collect_lines(env: dict[str, str]) -> list[tuple[str, int, str]] | None:
    """Resolve the base and gather the lines to scan; None means fail closed."""
    base = resolve_base(env)
    if base is None:
        return None
    if base:
        out(sys.stderr, f"[leftover] scanning diff vs {base} ...")
        lines = diff_lines(base, env.get("LEFTOVER_HEAD") or "HEAD")
    else:
        out(sys.stderr, "[leftover] scanning full tree ...")
        lines = tree_lines()
    if lines is None:
        out(
            sys.stderr,
            "[leftover] FAIL — could not compute the lines to scan (diff/base error). "
            "A blocking gate must not pass having scanned nothing.",
        )
        out(
            sys.stderr,
            "[leftover] If this is a shallow CI checkout, deepen it so the head/base "
            "objects are reachable (actions/checkout fetch-depth: 0) or set "
            "LEFTOVER_FULLTREE=1 to scan the whole tree on purpose.",
        )
    return lines


def scan(lines: list[tuple[str, int, str]], env: dict[str, str]) -> dict[str, int]:
    include = compile_ere(env.get("LEFTOVER_INCLUDE") or DEFAULT_INCLUDE)
    exclude = compile_ere(env.get("LEFTOVER_EXCLUDE") or DEFAULT_EXCLUDE)
    ticket = compile_ere("(" + (env.get("TICKET_REGEX") or DEFAULT_TICKET) + ")")
    allow_console = (env.get("ALLOW_CONSOLE") or "0") == "1"
    counts = {"BLOCK": 0, "WARN": 0}
    for file, ln, raw in lines:
        # Mirrors `IFS=$'\t' read -r`: tabs are IFS whitespace, so edge tabs of the
        # text field are stripped.
        text = raw.strip("\t")
        if not file or not matches(include, file) or matches(exclude, file):
            continue
        for severity, rule in rules_hit(text, allow_console, ticket):
            report(counts, severity, (file, ln, rule, text))
    return counts


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(errors="surrogateescape")
    env = dict(os.environ)
    lines = collect_lines(env)
    if lines is None:
        return 1
    counts = scan(lines, env)
    out(
        sys.stderr,
        f"[leftover] {counts['BLOCK']} blocking, {counts['WARN']} warning(s).",
    )
    if counts["BLOCK"]:
        out(
            sys.stderr,
            "[leftover] FAIL — remove the leftovers above "
            f"(or reference a ticket on the {_OPEN_WORD}).",
        )
        return 1
    out(sys.stdout, "[leftover] PASS.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
