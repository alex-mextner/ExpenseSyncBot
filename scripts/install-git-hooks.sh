#!/bin/sh
# postinstall: install this repository's lefthook hooks only into its own hooks directory.
#
# git runs hooks from `git rev-parse --git-path hooks`, which honours core.hooksPath. When that
# resolves outside this repository (for example a global ~/.config/git/hooks that dispatches
# hooks for every repository), a lefthook install would replace hooks that every other
# repository relies on. That happened on 2026-09-26, so in that case nothing is installed.
set -eu

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo 'install-git-hooks: not inside a git work tree; skipping lefthook install'
  exit 0
fi
if ! command -v lefthook >/dev/null 2>&1; then
  echo 'install-git-hooks: lefthook is not installed; skipping'
  exit 0
fi

common=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
hooks=$(git rev-parse --git-path hooks)
case "$hooks" in /*) ;; *) hooks="$(pwd -P)/$hooks" ;; esac
if [ -d "$hooks" ]; then hooks=$(cd "$hooks" && pwd -P); fi

case "$hooks/" in
  "$common"/*)
    # The target belongs to this repository. --force only lifts lefthook's refusal to install
    # while core.hooksPath is set anywhere; the path it writes to was checked above.
    exec lefthook install --force
    ;;
  *)
    echo "install-git-hooks: hooks path $hooks is outside this repository ($common); not installing lefthook hooks there" >&2
    exit 0
    ;;
esac
