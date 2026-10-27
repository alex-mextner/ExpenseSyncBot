#!/bin/sh
# Launcher: the gate logic and knob docs live in leftover_grep.py (see README.md).
set -eu
_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
if ! command -v python3 >/dev/null 2>&1; then
  echo "[leftover] FAIL — python3 is required but not found on PATH." >&2
  exit 1
fi
if [ ! -f "$_dir/leftover_grep.py" ]; then
  echo "[leftover] FAIL — $_dir/leftover_grep.py is missing (vendor the whole slot)." >&2
  exit 1
fi
exec python3 -B -I "$_dir/leftover_grep.py" "$@"
