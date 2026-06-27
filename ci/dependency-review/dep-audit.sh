#!/usr/bin/env bash
# Dependency vulnerability audit — generic fallback for any CI or a repo WITHOUT GitHub's
# Dependency Graph (where actions/dependency-review-action can't run). Auto-detects the
# package manager and runs its native audit, failing on high/critical advisories.
#
# This is the "what's already in the tree" audit. The PR-time "don't let a new bad dep IN"
# gate is workflow.yml (dependency-review-action) — prefer that on public/GHAS repos.
#
# Detects, in order: bun, npm/pnpm/yarn (node), pip-audit (python), cargo-audit (rust),
# govulncheck (go). Runs every ecosystem it finds a manifest for.
#
# Knobs (env):
#   DEP_AUDIT_LEVEL          minimum severity to FAIL on: low|moderate|high|critical (default high).
#   DEP_AUDIT_ALLOW_MISSING  "1" = DON'T fail when a manifest is found but its scanner isn't
#                            installed (fail-OPEN). Default 0 = fail CLOSED: a detected
#                            ecosystem with no usable scanner is a gate failure, not a silent
#                            skip — otherwise "no audit ran" masquerades as "no vulns".
#
# Usage: sh ci/dependency-review/dep-audit.sh [AUDIT_DIR]
#   AUDIT_DIR (optional, default '.'): the tree whose manifests/lockfiles to audit. The
#   tamper-resistant workflow (pull_request_target) passes the PR head's side worktree here
#   so the TRUSTED base copy of this script audits the PR's lockfiles as DATA — the auditors
#   only read the lockfile, they never run the package's install/lifecycle scripts.
set -eu

LEVEL="${DEP_AUDIT_LEVEL:-high}"
ALLOW_MISSING="${DEP_AUDIT_ALLOW_MISSING:-0}"
AUDIT_DIR="${1:-.}"
rc=0
ran=0
missing=0

# Audit the requested tree (default cwd). Fail closed if it doesn't exist — a vanished
# audit target must not masquerade as "no manifests, nothing to audit".
if [ ! -d "$AUDIT_DIR" ]; then
  echo "[dep-audit] audit dir '$AUDIT_DIR' does not exist — FAILING (cannot audit)." >&2
  exit 1
fi
cd "$AUDIT_DIR"

note() { echo "[dep-audit] $*" >&2; }
# A detected manifest whose scanner is absent: fail closed unless explicitly allowed.
miss() {
  if [ "$ALLOW_MISSING" = "1" ]; then
    note "$* — skipping (DEP_AUDIT_ALLOW_MISSING=1)."
  else
    note "$* — FAILING (no audit performed; set DEP_AUDIT_ALLOW_MISSING=1 to allow)."
    missing=$((missing+1))
  fi
}

# Classify a requirements file $1 for data-safe auditing. Prints exactly one word:
#   pinned — every line is a pinned PyPI spec (`name[extras]==version`) or a benign line (blank /
#            `#` comment / `--hash` / `--require-hashes` / `; marker`), AND at least one real
#            pinned spec is present -> safe to audit as data with `pip-audit --no-deps -r`.
#   empty  — only benign lines, NO pinned spec (empty / comments / options only). NOT a data
#            source: auditing it would check nothing, so the caller must not count it as covering
#            python — an empty/stub requirements.txt must NOT mask an un-auditable pyproject.toml
#            (agent-tools#131).
#   unsafe — at least one DIRECT reference: editable (`-e`), URL/VCS (`://`, `git+…`), a PEP 508
#            `name @ url`, a local path/archive, an `-r`/`-c` include (which could smuggle any of
#            those), a foreign-index option (`--index-url`/`--find-links`), or an UNPINNED/prefix
#            spec. pip-audit must BUILD such input to read its metadata (runs setup.py / a PEP 517
#            backend) = arbitrary PR code under pull_request_target (RCE). `--no-deps` suppresses
#            only TRANSITIVE resolution, not a direct-entry build, so it does NOT close this.
#            Fail closed (the caller's miss()).
req_file_classify() {  # $1 = requirements file -> prints: pinned | empty | unsafe
  awk '
    { line=$0; gsub(/\r/, "", line); sub(/#.*/, "", line)
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line == "") next
      if (line ~ /^--hash([ =])/) next                 # per-spec hash (incl. continuation)
      if (line ~ /^--require-hashes$/) next            # the hardened global option (safe)
      core=line
      sub(/[ \t]*\\$/, "", core)                       # trailing line-continuation
      sub(/[ \t]*;.*/, "", core)                       # environment markers
      sub(/[ \t]+--hash.*/, "", core)                  # inline hashes
      gsub(/^[ \t]+|[ \t]+$/, "", core)
      if (core ~ /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]*\])?==[A-Za-z0-9][A-Za-z0-9.+!_-]*$/) { pinned=1; next }
      bad=1
    }
    END { if (bad) print "unsafe"; else if (pinned) print "pinned"; else print "empty" }
  ' "$1"
}

if [ -f bun.lock ] || [ -f bun.lockb ]; then
  if command -v bun >/dev/null 2>&1; then
    ran=1; note "bun audit --audit-level=$LEVEL"
    bun audit --audit-level="$LEVEL" || rc=1
  else
    miss "bun lockfile present but bun not installed"
  fi
elif [ -f package.json ]; then
  if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
    ran=1; note "pnpm audit --audit-level $LEVEL"; pnpm audit --audit-level "$LEVEL" || rc=1
  elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then
    ran=1; note "yarn npm audit (yarn berry) — failing on $LEVEL+"; yarn npm audit --severity "$LEVEL" || rc=1
  elif command -v npm >/dev/null 2>&1; then
    ran=1; note "npm audit --audit-level=$LEVEL"; npm audit --audit-level="$LEVEL" || rc=1
  else
    miss "package.json present but no usable node package manager (npm/pnpm/yarn)"
  fi
fi

# Python: audit the audited tree's DECLARED dependencies, never the runner's environment.
# SECURITY (agent-tools#129): under the tamper-resistant pull_request_target workflow this
# script audits the PR's tree as DATA. pip-audit is the ONE auditor that can EXECUTE input: a
# RESOLVING run (`-r <file>`, `-e .`, or a project/VCS/local-path requirement) downloads and
# BUILDS sdists — running their setup.py — i.e. arbitrary PR code under a privileged trigger
# (RCE). So we never resolve/build here.
# COVERAGE (agent-tools#131): the no-argument form (`pip-audit`) audits the runner's INSTALLED
# environment, NOT this tree's manifests — and nothing installs the PR's deps (the workflow's
# HARD RULE forbids it), so a bare run sets ran=1 and "passes" on the runner's base packages
# while the PR's vulnerable deps go unchecked. Audit the manifests as DATA instead:
#   - requirements*.txt (and the `requirements/<env>.txt` layout) -> `pip-audit --no-deps -r
#     <file>`, but ONLY after req_file_classify() confirms the file is purely PINNED specs.
#     `--no-deps` skips TRANSITIVE resolution; the data-safe scan rejects any DIRECT reference
#     (editable / URL / VCS / local path / `-r` include / unpinned) that would make pip-audit
#     BUILD PR code (RCE — see req_file_classify). Together: no sdist is downloaded or built;
#     pip-audit reads the file's pinned entries and queries the advisory DB — auditing the PR's
#     actual declared deps, not the runner's environment.
#   - a requirements file with a direct-reference / unpinned line: can't be audited as data
#     without building -> fail CLOSED (pin every line to name==version, or DEP_AUDIT_ALLOW_MISSING=1).
#   - pyproject.toml / poetry.lock WITHOUT a pinned requirements*.txt: pip-audit can audit these
#     only by BUILDING the project (RCE under pull_request_target) or, for poetry.lock, not at
#     all. So we do NOT fall back to the env-only `pip-audit` (which would check nothing of the
#     PR's) — they fail CLOSED (pin a requirements*.txt, or set DEP_AUDIT_ALLOW_MISSING=1).
# HARD RULE: never give pip-audit a resolving `-r`/`-e`/project-path invocation here without
# `--no-deps` AND the pinned-only data-safe scan (the `tests/test_ci_gate_bugs_129.py` guards pin this).
py_manifest=0
for f in requirements*.txt requirements/*.txt; do
  [ -f "$f" ] && { py_manifest=1; break; }
done
if [ "$py_manifest" = "1" ] || [ -f pyproject.toml ] || [ -f poetry.lock ]; then
  if command -v pip-audit >/dev/null 2>&1; then
    audited_py=0   # a real (pinned) requirements file was audited
    refused_py=0   # a requirements file was refused as unsafe (already fail-closed)
    for f in requirements*.txt requirements/*.txt; do
      [ -f "$f" ] || continue
      case "$(req_file_classify "$f")" in
        pinned)
          ran=1; audited_py=1
          note "pip-audit --no-deps -r $f"
          pip-audit --no-deps -r "$f" || rc=1 ;;
        empty)
          note "skipping $f — no pinned spec to audit (empty / comments / options only)" ;;
        *)  # unsafe
          refused_py=1
          miss "python requirements file $f has a non-pinned or direct-reference line (editable/URL/VCS/local-path/-r include/foreign index) — auditing it would BUILD PR code under pull_request_target (RCE); pin every line to name==version, or set DEP_AUDIT_ALLOW_MISSING=1" ;;
      esac
    done
    # An un-auditable pyproject.toml/poetry.lock fails CLOSED — UNLESS we already audited a pinned
    # requirements file (assumed to represent the deps) or already refused one (already
    # fail-closed). An empty/stub requirements.txt must NOT mask this (agent-tools#131).
    if [ "$audited_py" = "0" ] && [ "$refused_py" = "0" ] && { [ -f pyproject.toml ] || [ -f poetry.lock ]; }; then
      miss "python project (pyproject.toml/poetry.lock) present but no pinned requirements*.txt to audit as data (a building project-audit would execute PR code under pull_request_target)"
    fi
  else
    miss "python manifest present but pip-audit not installed (pipx install pip-audit)"
  fi
fi

if [ -f Cargo.lock ]; then
  if command -v cargo-audit >/dev/null 2>&1 || cargo audit --version >/dev/null 2>&1; then
    ran=1; note "cargo audit"; cargo audit || rc=1
  else
    miss "Cargo.lock present but cargo-audit not installed (cargo install cargo-audit)"
  fi
fi

if [ -f go.mod ]; then
  if command -v govulncheck >/dev/null 2>&1; then
    ran=1; note "govulncheck ./..."; govulncheck ./... || rc=1
  else
    miss "go.mod present but govulncheck not installed (go install golang.org/x/vuln/cmd/govulncheck@latest)"
  fi
fi

if [ "$ran" = "0" ] && [ "$missing" = "0" ]; then
  note "no supported manifest/lockfile found — nothing to audit."
  exit 0
fi
if [ "$missing" -gt 0 ]; then
  note "FAIL — $missing detected ecosystem(s) had no usable scanner (fail-closed). Install the tool(s) above, or set DEP_AUDIT_ALLOW_MISSING=1."
  exit 1
fi
[ "$rc" = "0" ] && note "PASS — no advisories at $LEVEL+." || note "FAIL — advisories at $LEVEL+ above."
exit "$rc"
