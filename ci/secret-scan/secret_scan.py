#!/usr/bin/env python3
"""secret-scan: generic, CI-agnostic secret scan with gitleaks.

Launched by secret-scan.sh (POSIX sh launcher, same path and arguments as before).

For any CI that runs a shell step (GitLab CI, Jenkins, Buildkite, CircleCI, Drone,
bare cron, a Makefile target). On GitHub Actions prefer ./secret-scan.yml (the pinned
action). Secret-scanning standard = gitleaks; this is the same engine, scripted.

WHAT IT DOES
  - Installs gitleaks if missing (brew | go install | release tarball), else fails
    clearly.
  - BLOCK tier (default): scans the repo; a high-confidence finding => exit 1.
  - WARN tier (SECRET_SCAN_WARN_CONFIG set): a second pass that only prints findings
    and never fails, for surfacing low-confidence cases without blocking the pipeline.

CONFIG / EXTEND
  - Repo-root .gitleaks.toml is auto-detected by gitleaks (add [[rules]] / [allowlist]).
  - SECRET_SCAN_CONFIG=path        -> explicit block-tier config (overrides
                                      .gitleaks.toml).
  - SECRET_SCAN_WARN_CONFIG=path   -> enable the warn pass with this config.
  - SECRET_SCAN_SCOPE=full|staged  -> "full" (default in CI) scans all history;
                                      "staged" scans only staged changes (for a
                                      local/hook reuse).
  - GITLEAKS_VERSION               -> version used by the install fallbacks.

FALSE POSITIVES: inline `gitleaks:allow` comment, or an [allowlist] entry. Never paper
over a real finding by deleting the step.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile


def log(msg: str) -> None:
    print("secret-scan: " + msg, file=sys.stderr, flush=True)


def _run(argv: list[str], quiet_stderr: bool = False) -> bool:
    err = subprocess.DEVNULL if quiet_stderr else None
    try:
        return subprocess.call(argv, stderr=err) == 0
    except OSError:
        return False


def _install_release(version: str, home: str) -> bool:
    url = (
        "https://github.com/gitleaks/gitleaks/releases/download/"
        f"v{version}/gitleaks_{version}_linux_x64.tar.gz"
    )
    tmp = tempfile.mkdtemp()
    try:
        tgz = os.path.join(tmp, "gl.tgz")
        if not (
            _run(["curl", "-fsSL", url, "-o", tgz])
            and _run(["tar", "-xzf", tgz, "-C", tmp, "gitleaks"])
        ):
            return False
        binary = os.path.join(tmp, "gitleaks")
        if not _run(
            ["install", "-m", "0755", binary, "/usr/local/bin/gitleaks"],
            quiet_stderr=True,
        ):
            local = os.path.join(home, ".local", "bin")
            os.makedirs(local, exist_ok=True)
            _run(["install", "-m", "0755", binary, os.path.join(local, "gitleaks")])
            os.environ["PATH"] = local + ":" + os.environ.get("PATH", "")
        return True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def ensure_gitleaks(version: str) -> bool:
    if shutil.which("gitleaks"):
        return True
    log(f"gitleaks not found — attempting install (v{version}).")
    home = os.environ.get("HOME", "")
    if shutil.which("brew") and _run(["brew", "install", "gitleaks"]):
        return True
    if shutil.which("go"):
        gobin = os.environ.get("GOBIN") or os.path.join(home, "go", "bin")
        os.environ["GOBIN"] = gobin
        if _run(["go", "install", f"github.com/gitleaks/gitleaks/v8@v{version}"]):
            os.environ["PATH"] = gobin + ":" + os.environ.get("PATH", "")
            return True
    if shutil.which("curl") and shutil.which("tar") and _install_release(version, home):
        return True
    log(
        "could not install gitleaks automatically — install it and re-run: "
        "https://github.com/gitleaks/gitleaks"
    )
    return False


def scan(scope: str, cfg: str) -> bool:
    argv = ["gitleaks", "git"]
    if scope == "staged":
        argv.append("--staged")
    argv += ["--redact", "--no-banner", "-v"]
    if cfg:
        argv += ["-c", cfg]
    try:
        return subprocess.call(argv) == 0
    except OSError as exc:
        print(f"gitleaks: {exc.strerror or exc}", file=sys.stderr, flush=True)
        return False


def main() -> int:
    version = os.environ.get("GITLEAKS_VERSION") or "8.30.1"
    scope = os.environ.get("SECRET_SCAN_SCOPE") or "full"
    if not ensure_gitleaks(version):
        return 1

    warn_cfg = os.environ.get("SECRET_SCAN_WARN_CONFIG", "")
    if warn_cfg and not scan(scope, warn_cfg):
        log(
            "WARNING — suspicious string(s) found (not failing the build). Review them above.",
        )

    if not scan(scope, os.environ.get("SECRET_SCAN_CONFIG", "")):
        log(
            "BLOCKED — a high-confidence secret was found. Remove it, rotate it, and re-push.",
        )
        log(
            "  false positive? add a 'gitleaks:allow' comment or an [allowlist] "
            "entry in .gitleaks.toml."
        )
        return 1

    log("clean — no high-confidence secrets found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
