#!/bin/sh
# Launcher: the gate logic lives in secret_scan.py next to this file (see README.md).
set -eu
_dir="$(cd "$(dirname "$0")" && pwd -P)"
if ! command -v python3 >/dev/null 2>&1; then
  echo "secret-scan: python3 is required but not found on PATH" >&2
  exit 1
fi
if [ ! -f "$_dir/secret_scan.py" ]; then
  echo "secret-scan: missing $_dir/secret_scan.py (vendor the whole slot dir)" >&2
  exit 1
fi
exec python3 -B -I "$_dir/secret_scan.py" "$@"
