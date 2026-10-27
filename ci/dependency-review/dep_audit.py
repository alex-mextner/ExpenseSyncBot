#!/usr/bin/env python3
"""Dependency vulnerability audit.

Generic fallback for any CI or a repo WITHOUT GitHub's Dependency Graph (where
actions/dependency-review-action can't run). Auto-detects the package manager and runs
its native audit, failing on high/critical advisories.

This is the "what's already in the tree" audit. The PR-time "don't let a new bad dep IN"
gate is workflow.yml (dependency-review-action) - prefer that on public/GHAS repos.

Detects, in order: bun, npm/pnpm/yarn (node), pip-audit (python), cargo-audit (rust),
govulncheck (go). Runs every ecosystem it finds a manifest for.

Knobs (env):
  DEP_AUDIT_LEVEL          minimum severity to FAIL on: low|moderate|high|critical
                           (default high).
  DEP_AUDIT_ALLOW_MISSING  "1" = DON'T fail when a manifest is found but its scanner
                           isn't installed (fail-OPEN). Default 0 = fail CLOSED: a
                           detected ecosystem with no usable scanner is a gate failure,
                           not a silent skip - otherwise "no audit ran" masquerades as
                           "no vulns".

Usage: sh ci/dependency-review/dep-audit.sh [AUDIT_DIR]
  (dep-audit.sh is a POSIX-sh launcher that execs this file.)
  AUDIT_DIR (optional, default '.'): the tree whose manifests/lockfiles to audit. The
  tamper-resistant workflow (pull_request_target) passes the PR head's side worktree here
  so the TRUSTED base copy of this script audits the PR's lockfiles as DATA - the
  auditors only read the lockfile, they never run the package's install/lifecycle
  scripts.

Exit codes: 0 pass / nothing to audit, 1 advisories found, scanner missing (fail
closed) or audit dir absent.

SECURITY (agent-tools#129, #131): pip-audit is the ONE auditor that can EXECUTE input.
A RESOLVING run (`-r <file>`, `-e .`, or a project/VCS/local-path requirement)
downloads and BUILDS sdists - running their setup.py - i.e. arbitrary PR code under a
privileged trigger (RCE). So this script never resolves/builds:
  - requirements*.txt (and the `requirements/<env>.txt` layout) -> `pip-audit --no-deps
    -r <file>`, but ONLY after req_file_classify() confirms the file is purely PINNED
    specs. A direct-reference / unpinned line fails CLOSED (miss()).
  - uv.lock / poetry.lock are parsed as TEXT (never `uv export` / `poetry export`).
    name==version is emitted for registry/PyPI packages only; editable/path/git/url/
    virtual/directory are skipped. The pins go to a temp file OUTSIDE the audited tree,
    are classified, then `pip-audit --no-deps -r <temp>`. A package record that cannot
    be emitted as name==version is written as a non-pin line so classification fails
    CLOSED - a sibling valid pin must not mask an omitted record.
  - pyproject.toml WITHOUT a pinned requirements*.txt AND without auditable lockfile
    pins fails CLOSED. Never fall back to env-only `pip-audit` (it would audit the
    runner's environment, not the tree).
HARD RULE: never give pip-audit a resolving `-r`/`-e`/project-path invocation here
without `--no-deps` AND the pinned-only data-safe scan (tests/test_ci_gate_bugs_129.py
guards pin this).
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile

_PIN_RE = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]*\])?"
    r"==[A-Za-z0-9][A-Za-z0-9.+!_-]*"
)
_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_VER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+!_-]*")
_EDGE_WS = re.compile(r"^[ \t]+|[ \t]+$")
_SKIP_SRC = re.compile(r"(editable|path|git|url|virtual|directory)[ \t]*=")
_REG_SRC = re.compile(r"registry[ \t]*=")


def note(msg: str) -> None:
    print("[dep-audit] " + msg, file=sys.stderr, flush=True)


def _trim(text: str) -> str:
    return _EDGE_WS.sub("", text)


def _read_lines(path: str) -> list[str]:
    # latin-1: never fails on odd bytes; every pattern here is ASCII-only.
    with open(path, encoding="latin-1", newline="") as fh:
        return fh.read().split("\n")


def req_file_classify(path: str) -> str:
    """Classify a requirements file: 'pinned' | 'empty' | 'unsafe'."""
    pinned = False
    bad = False
    for raw in _read_lines(path):
        line = raw.replace("\r", "")
        line = re.sub(r"#.*", "", line, count=1)
        line = _trim(line)
        if line == "":
            continue
        if re.match(r"--hash[ =]", line):
            continue
        if line == "--require-hashes":
            continue
        core = re.sub(r"[ \t]*\\$", "", line, count=1)
        core = re.sub(r"[ \t]*;.*", "", core, count=1)
        core = re.sub(r"[ \t]+--hash.*", "", core, count=1)
        core = _trim(core)
        if _PIN_RE.fullmatch(core):
            pinned = True
            continue
        bad = True
    if bad:
        return "unsafe"
    return "pinned" if pinned else "empty"


def _unquote(text: str, key: str) -> str:
    value = re.sub(r"^[ \t]*" + key + r"[ \t]*=[ \t]*", "", text, count=1)
    value = value.replace('"', "").replace("'", "")
    return _trim(value)


class _LockRecord:
    """One [[package]] record of a lockfile, accumulated line by line."""

    def __init__(self) -> None:
        self.name = ""
        self.ver = ""
        self.skip = False
        self.reg = False

    def pin(self, uv_mode: bool) -> str | None:
        """name==version if the record is a registry pin, else None."""
        usable = self.ver != "" and not self.skip and (not uv_mode or self.reg)
        if usable and _NAME_RE.fullmatch(self.name) and _VER_RE.fullmatch(self.ver):
            return self.name + "==" + self.ver
        return None

    def feed(self, line: str) -> None:
        if line.startswith("[package.source]"):
            self.skip = True
        elif line.startswith("["):
            return
        elif re.match(r"name[ \t]*=", line):
            self.name = self.name or _unquote(line, "name")
        elif re.match(r"version[ \t]*=", line):
            self.ver = self.ver or _unquote(line, "version")
        elif re.match(r"source[ \t]*=", line):
            self.skip = self.skip or bool(_SKIP_SRC.search(line))
            self.reg = self.reg or bool(_REG_SRC.search(line))


def _flush_record(rec: _LockRecord, uv_mode: bool, out: list[str]) -> None:
    if rec.name == "":
        return
    pin = rec.pin(uv_mode)
    if pin is not None:
        out.append(pin)
    elif not rec.skip:
        out.append("UNPARSED-LOCK-RECORD")


def extract_python_lock_pins(path: str) -> list[str]:
    """Emit name==version lines for registry packages of uv.lock / poetry.lock."""
    uv_mode = path.endswith("uv.lock")
    out: list[str] = []
    rec = _LockRecord()
    for line in _read_lines(path):
        if line.startswith("[[package]]"):
            _flush_record(rec, uv_mode, out)
            rec = _LockRecord()
        else:
            rec.feed(line)
    _flush_record(rec, uv_mode, out)
    return out


def _found(*names: str) -> bool:
    return any(os.path.isfile(n) for n in names)


def _which(tool: str) -> bool:
    return shutil.which(tool) is not None


class Audit:
    def __init__(self, level: str, allow_missing: bool) -> None:
        self.level = level
        self.allow_missing = allow_missing
        self.rc = 0
        self.ran = 0
        self.missing = 0

    def miss(self, msg: str) -> None:
        """A detected manifest whose scanner is absent: fail closed unless allowed."""
        if self.allow_missing:
            note(msg + " \u2014 skipping (DEP_AUDIT_ALLOW_MISSING=1).")
        else:
            note(
                msg + " \u2014 FAILING (no audit performed; "
                "set DEP_AUDIT_ALLOW_MISSING=1 to allow)."
            )
            self.missing += 1

    def run(self, argv: list[str]) -> None:
        try:
            code = subprocess.call(argv)
        except OSError:
            code = 127
        if code != 0:
            self.rc = 1

    def tool(self, msg: str, argv: list[str]) -> None:
        self.ran = 1
        note(msg)
        self.run(argv)

    def audit_node(self) -> None:
        lvl = self.level
        if _found("bun.lock", "bun.lockb"):
            if _which("bun"):
                self.tool(
                    "bun audit --audit-level=" + lvl,
                    ["bun", "audit", "--audit-level=" + lvl],
                )
            else:
                self.miss("bun lockfile present but bun not installed")
        elif _found("package.json"):
            if _found("pnpm-lock.yaml") and _which("pnpm"):
                self.tool(
                    "pnpm audit --audit-level " + lvl,
                    ["pnpm", "audit", "--audit-level", lvl],
                )
            elif _found("yarn.lock") and _which("yarn"):
                self.tool(
                    "yarn npm audit (yarn berry) \u2014 failing on " + lvl + "+",
                    ["yarn", "npm", "audit", "--severity", lvl],
                )
            elif _which("npm"):
                self.tool(
                    "npm audit --audit-level=" + lvl,
                    ["npm", "audit", "--audit-level=" + lvl],
                )
            else:
                self.miss(
                    "package.json present but no usable node package manager (npm/pnpm/yarn)",
                )

    def audit_python_lockfile_as_data(self, lock: str, state: dict) -> None:
        """Pins go to a temp file OUTSIDE the audited tree; never the lockfile."""
        if not os.path.isfile(lock):
            return
        fd, tmp = tempfile.mkstemp(prefix="dep-audit-py.", dir="/tmp")
        try:
            with os.fdopen(fd, "w", encoding="latin-1", newline="") as fh:
                for pin in extract_python_lock_pins(lock):
                    fh.write(pin + "\n")
            verdict = req_file_classify(tmp)
            if verdict == "pinned":
                self.ran = 1
                state["audited"] = True
                note("pip-audit --no-deps -r (extracted registry pins)")
                self.run(["pip-audit", "--no-deps", "-r", tmp])
            elif verdict == "empty":
                msg = "skipping " + lock + " \u2014 no registry/PyPI pins to audit"
                note(msg + " as data")
            else:
                state["refused"] = True
                self.miss(
                    "extracted pins from " + lock + " were not data-safe \u2014 "
                    "auditing them would BUILD PR code under pull_request_target "
                    "(RCE); pin name==version, or set DEP_AUDIT_ALLOW_MISSING=1"
                )
        finally:
            os.unlink(tmp)

    def audit_python(self) -> None:
        req_files = sorted(glob.glob("requirements*.txt"))
        req_files += sorted(glob.glob("requirements/*.txt"))
        py_manifest = any(os.path.isfile(f) for f in req_files)
        lockish = _found("pyproject.toml", "poetry.lock", "uv.lock")
        if not (py_manifest or lockish):
            return
        if not _which("pip-audit"):
            self.miss(
                "python manifest present but pip-audit not installed (pipx install pip-audit)"
            )
            return
        state = {"audited": False, "refused": False}
        for f in req_files:
            if not os.path.isfile(f):
                continue
            verdict = req_file_classify(f)
            if verdict == "pinned":
                self.ran = 1
                state["audited"] = True
                note("pip-audit --no-deps -r " + f)
                self.run(["pip-audit", "--no-deps", "-r", f])
            elif verdict == "empty":
                note(
                    "skipping " + f + " \u2014 no pinned spec to audit "
                    "(empty / comments / options only)"
                )
            else:
                state["refused"] = True
                self.miss(
                    "python requirements file " + f + " has a non-pinned or "
                    "direct-reference line (editable/URL/VCS/local-path/-r include/"
                    "foreign index) \u2014 auditing it would BUILD PR code under "
                    "pull_request_target (RCE); pin every line to name==version, "
                    "or set DEP_AUDIT_ALLOW_MISSING=1"
                )
        # Lockfile pins cover pyproject when no pinned requirements file was audited
        # (an empty stub requirements.txt must not mask pyproject - agent-tools#131).
        if not state["audited"] and not state["refused"]:
            self.audit_python_lockfile_as_data("uv.lock", state)
            self.audit_python_lockfile_as_data("poetry.lock", state)
        if not state["audited"] and not state["refused"] and lockish:
            self.miss(
                "python project present but no pinned requirements*.txt and no "
                "auditable uv.lock/poetry.lock registry pins to audit as data "
                "(commit uv.lock/poetry.lock or pin a requirements*.txt; a building "
                "project-audit would execute PR code under pull_request_target)"
            )

    def audit_rust(self) -> None:
        if not _found("Cargo.lock"):
            return
        if _which("cargo-audit") or self._cargo_audit_subcommand():
            self.tool("cargo audit", ["cargo", "audit"])
        else:
            self.miss(
                "Cargo.lock present but cargo-audit not installed (cargo install cargo-audit)"
            )

    @staticmethod
    def _cargo_audit_subcommand() -> bool:
        try:
            return (
                subprocess.call(
                    ["cargo", "audit", "--version"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                == 0
            )
        except OSError:
            return False

    def audit_go(self) -> None:
        if not _found("go.mod"):
            return
        if _which("govulncheck"):
            self.tool("govulncheck ./...", ["govulncheck", "./..."])
        else:
            self.miss(
                "go.mod present but govulncheck not installed (go install "
                "golang.org/x/vuln/cmd/govulncheck@latest)"
            )

    def verdict(self) -> int:
        if self.ran == 0 and self.missing == 0:
            note("no supported manifest/lockfile found \u2014 nothing to audit.")
            return 0
        if self.missing > 0:
            note(
                "FAIL \u2014 " + str(self.missing) + " detected ecosystem(s) had no "
                "usable scanner (fail-closed). Install the tool(s) above, or set "
                "DEP_AUDIT_ALLOW_MISSING=1."
            )
            return 1
        if self.rc == 0:
            note("PASS \u2014 no advisories at " + self.level + "+.")
        else:
            note("FAIL \u2014 advisories at " + self.level + "+ above.")
        return self.rc


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    audit_dir = (args[0] if args else "") or "."
    audit = Audit(
        os.environ.get("DEP_AUDIT_LEVEL") or "high",
        (os.environ.get("DEP_AUDIT_ALLOW_MISSING") or "0") == "1",
    )
    # Fail closed if the target vanished: must not masquerade as "nothing to audit".
    if not os.path.isdir(audit_dir):
        print(
            "[dep-audit] audit dir '" + audit_dir + "' does not exist "
            "\u2014 FAILING (cannot audit).",
            file=sys.stderr,
        )
        return 1
    try:
        os.chdir(audit_dir)
    except OSError as exc:
        print(
            "[dep-audit] cannot enter '" + audit_dir + "': " + str(exc),
            file=sys.stderr,
        )
        return 1
    audit.audit_node()
    audit.audit_python()
    audit.audit_rust()
    audit.audit_go()
    return audit.verdict()


if __name__ == "__main__":
    sys.exit(main())
