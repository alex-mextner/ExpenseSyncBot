#!/bin/sh
# Launcher: the audit logic lives in dep_audit.py next to this file (see README.md).
set -eu
_dir=$(cd "$(dirname "$0")" && pwd -P)
if ! command -v python3 >/dev/null 2>&1; then
  echo "[dep-audit] python3 not found - FAILING (cannot audit)." >&2
  exit 1
fi
if [ ! -f "$_dir/dep_audit.py" ]; then
  echo "[dep-audit] $_dir/dep_audit.py missing - FAILING (cannot audit)." >&2
  exit 1
fi
exec python3 -B -I "$_dir/dep_audit.py" "$@"
