#!/usr/bin/env bash
# `gh ship` delegator of ExpenseSyncBot: the shared ship owns review, local CI and merge; before it
# merges, Stage QA must be green for the exact PR head (DEPLOY.md "Stage QA"). Deployment follows the
# merge (deploy.yml), nothing of the QA sits inside it.
set -euo pipefail
common="$(git rev-parse --path-format=absolute --git-common-dir)"
[[ "$common" == */.git ]] || {
  echo 'Canonical repository location required' >&2
  exit 2
}
canonical="${common%/.git}"
root="${AGENT_TOOLS_ROOT:-}"
env_file="${XDG_CONFIG_HOME:-$HOME/.config}/agent-tools/env"
# The per-user agent-tools env file lives in the invoking user's config directory (path decided at run time,
# not in this repository), so there is nothing for shellcheck to follow (SC1090).
# shellcheck source=/dev/null
if [[ -f "$env_file" && ! -L "$env_file" ]]; then . "$env_file"; fi
root="${root:-${AGENT_TOOLS_ROOT:-}}"
[[ -n "$root" && -x "$root/ci/ship/ship.sh" ]] || {
  echo 'Shared gh ship unavailable' >&2
  exit 127
}
shared="$root/ci/ship/ship.sh"
pr="${1:-}"
[[ "$pr" =~ ^[0-9]+$ ]] || exec "$shared" "$@"
for argument in "$@"; do
  [[ "$argument" != --dry-run ]] || exec "$shared" "$@"
done
name="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
previous=""
for argument in "$@"; do
  if [[ "$previous" == --repo && "$argument" != "$name" ]]; then
    echo 'Repository override differs from the local repository' >&2
    exit 2
  fi
  if [[ "$argument" == --repo=* && "${argument#--repo=}" != "$name" ]]; then
    echo 'Repository override differs from the local repository' >&2
    exit 2
  fi
  previous="$argument"
done
# The gate that runs is origin/main's copy, never the PR checkout's: a PR could otherwise edit its own
# gate. Until the script exists on main (bootstrap) there is nothing to run, and the notice says so.
git -C "$canonical" fetch -q origin main 2>/dev/null || true
gate="$(mktemp)"
gate_rc=0
if git -C "$canonical" show origin/main:scripts/stage-qa-gate.py >"$gate" 2>/dev/null; then
  (cd "$(git rev-parse --show-toplevel)" && python3 -B "$gate" --repo "$name" --pr "$pr") || gate_rc=$?
else
  echo 'stage-qa gate: scripts/stage-qa-gate.py is not on origin/main yet (bootstrap); Stage QA is NOT enforced for this ship.' >&2
fi
rm -f "$gate"
((gate_rc == 0)) || exit "$gate_rc"
exec "$shared" "$@"
