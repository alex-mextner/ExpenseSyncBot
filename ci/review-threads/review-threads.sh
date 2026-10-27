#!/bin/sh
# Launcher: the gate logic lives in review_threads.py (see README.md in this dir).
set -eu
_dir=$(cd "$(dirname "$0")" && pwd -P)
command -v python3 >/dev/null 2>&1 || {
  echo "review-threads: python3 not found" >&2
  exit 1
}
[ -f "$_dir/review_threads.py" ] || {
  echo "review-threads: $_dir/review_threads.py not found" >&2
  exit 1
}
exec python3 -B -I "$_dir/review_threads.py" "$@"
