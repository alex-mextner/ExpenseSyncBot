#!/usr/bin/env bash
# Installs the PC side of the per-PR stage QA (DEPLOY.md "Stage QA") by hand, as the NORMAL user (the one the
# qa-pc self-hosted runner and the logged-in qa-cli session belong to), from a reviewed main checkout:
#   scripts/install-stage-qa-pc.sh [<checkout>]      (default: the cwd)
#
# Why by hand: the driver decides what is trusted (which bot, which odroid, which floor of cases), so it
# must come from code a human reviewed on main, never from a PR or the runner's workspace.
#
# Installs   ~/.local/lib/esb-stage-qa/{stage-qa-pc.py,stage-smoke.py}: copied into a fresh dir and swapped
#            in while holding the PC qa lock (no QA run is in flight);
#            ~/.local/bin/esb-stage-qa-pc: the entry the workflow calls (`exec python3 .../stage-qa-pc.py`).
# Creates    ~/.config/esb-stage-qa/config.json and the ed25519 ssh key ~/.ssh/esb-stage-qa_ed25519, each
#            ONLY if absent (never overwritten).
# Keeps      the previous lib dir as <lib>.bak-<UTC stamp> and the previous entry as <entry>.bak-<stamp>,
#            and prints the one-line rollback command.
# Prints     the exact authorized_keys line for the odroid root account. It never touches the odroid or GitHub.
# Refuses    root, a checkout that is not a git checkout, a layout where a listed file is missing,
#            uncommitted changes to (or untracked) listed files, and a HEAD that is not on origin/main.
set -euo pipefail
umask 077

# Fixed on purpose: no environment overrides (only $HOME decides where the user-level files live).
readonly FORBIDDEN_EUID=0
readonly PC_LOCK_WAIT=60
readonly SAFE_PATH=/usr/local/bin:/usr/bin:/bin
readonly ODROID_ENTRY=/usr/local/lib/esb-stage-qa/odroid-stage-qa-report.py
readonly KEY_COMMENT=esb-stage-qa-pc
export PATH="$SAFE_PATH"

fail() { local code="${2:-2}"; echo "install-stage-qa-pc: $1" >&2; exit "$code"; }

(( EUID != FORBIDDEN_EUID )) || fail 'run as the normal user, not root (the files belong to the runner user'"'"'s home)'
[[ "${HOME:-}" == /* && -d "$HOME" ]] || fail 'HOME is not set to an existing absolute directory'

readonly LIB_DIR="$HOME/.local/lib/esb-stage-qa"
readonly ENTRY_PATH="$HOME/.local/bin/esb-stage-qa-pc"
readonly CONFIG_PATH="$HOME/.config/esb-stage-qa/config.json"
readonly KEY_PATH="$HOME/.ssh/esb-stage-qa_ed25519"
# The HyperCalendarBot driver's lock file: both repositories share the PC's one Telegram Web session.
readonly PC_LOCK_FILE="$HOME/.local/state/hypercal-stage-qa/qa.lock"

readonly -a LIB_SOURCES=(
  scripts/stage-qa-pc.py
  scripts/stage-smoke.py
)

NEW_LIB=""
NEW_ENTRY=""
NEW_CONFIG=""
cleanup() {
  [[ -z "$NEW_LIB" ]] || rm -rf -- "$NEW_LIB"
  [[ -z "$NEW_ENTRY" ]] || rm -f -- "$NEW_ENTRY"
  [[ -z "$NEW_CONFIG" ]] || rm -f -- "$NEW_CONFIG"
}
trap cleanup EXIT

(( $# <= 1 )) || fail 'usage: install-stage-qa-pc.sh [<checkout>]'
SRC="$(cd "${1:-$PWD}" && pwd -P)" || fail 'checkout directory not found'

for rel in "${LIB_SOURCES[@]}"; do
  [[ -f "$SRC/$rel" && ! -L "$SRC/$rel" ]] || fail "unknown checkout layout: $rel is missing in $SRC"
done

[[ -e "$SRC/.git" ]] || fail "$SRC is not a git checkout; install from a reviewed main checkout"
git_in_src() { git -C "$SRC" "$@"; }
DIRTY="$(git_in_src status --porcelain -- "${LIB_SOURCES[@]}")" || fail 'git status failed in the checkout'
[[ -z "$DIRTY" ]] || fail "uncommitted or untracked changes to installed files (install only reviewed, committed code):
$DIRTY"
# Only reviewed, merged code: HEAD must be origin/main or an ancestor of it. There is deliberately
# no override; fetch origin and check out main instead.
git_in_src rev-parse --verify --quiet refs/remotes/origin/main >/dev/null \
  || fail 'the checkout has no origin/main ref: install from a checkout of main (git fetch origin)'
git_in_src merge-base --is-ancestor HEAD refs/remotes/origin/main \
  || fail 'the checkout HEAD is not on origin/main: install only merged, reviewed code'
HEAD_SHA="$(git_in_src rev-parse --short=12 HEAD)" || fail 'cannot read the checkout revision'
BRANCH="$(git_in_src branch --show-current || true)"

command -v python3 >/dev/null || fail 'python3 is not installed (the entry runs the driver with it)'
if [[ ! -e "$KEY_PATH" ]]; then
  command -v ssh-keygen >/dev/null || fail 'ssh-keygen is not installed (needed to create the ssh key)'
fi

# Hold the PC qa lock while swapping: a QA run (this or the HyperCalendarBot driver) holds it for its whole
# life, so the install waits instead of swapping stage-smoke.py under a running driver.
mkdir -p -m 0700 -- "$(dirname "$PC_LOCK_FILE")"
( umask 0; : >>"$PC_LOCK_FILE" )
exec {LOCK_FD}<"$PC_LOCK_FILE"
flock -w "$PC_LOCK_WAIT" "$LOCK_FD" \
  || fail "a QA run holds $PC_LOCK_FILE; nothing was changed, retry when it ends" 75

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_LIB="$LIB_DIR.bak-$STAMP"
BACKUP_ENTRY="$ENTRY_PATH.bak-$STAMP"
[[ ! -e "$BACKUP_LIB" && ! -e "$BACKUP_ENTRY" ]] || fail "a backup for $STAMP already exists; retry in a second"

# The ssh key and the config are created before the swap and never overwritten: they carry local
# state (the key) and owner edits (the config).
if [[ ! -e "$KEY_PATH" ]]; then
  mkdir -p -m 0700 -- "$(dirname "$KEY_PATH")"
  ssh-keygen -q -t ed25519 -N '' -C "$KEY_COMMENT" -f "$KEY_PATH" >/dev/null </dev/null \
    || fail "ssh-keygen failed for $KEY_PATH"
fi
PUBLIC_KEY="$(ssh-keygen -y -f "$KEY_PATH" </dev/null)" || fail "cannot read the public key of $KEY_PATH"
# Only "<type> <base64>": a comment stored inside a pre-existing key must not end up in the printed line.
read -r KEY_TYPE KEY_BLOB _ <<<"$PUBLIC_KEY"
PUBLIC_KEY="$KEY_TYPE $KEY_BLOB"

CONFIG_CREATED=0
if [[ ! -e "$CONFIG_PATH" ]]; then
  mkdir -p -m 0700 -- "$(dirname "$CONFIG_PATH")"
  NEW_CONFIG="$(mktemp "$CONFIG_PATH.new.XXXXXX")"
  cat >"$NEW_CONFIG" <<'JSON'
{
  "ssh_target": "root@odroidn2",
  "ssh_key": "~/.ssh/esb-stage-qa_ed25519",
  "username": "ExpenseSyncStageBot",
  "deny_usernames": ["ExpenseSyncBot"],
  "qa_bin": "~/.local/bin/qa",
  "python": "python3",
  "lock_file": "~/.local/state/hypercal-stage-qa/qa.lock",
  "lock_max_wait": 2700,
  "state_dir": "~/.local/state/esb-stage-qa",
  "min_cases": 5,
  "required_cases": ["start", "ping", "help-lists-commands", "categories-read-only-listing", "validation-connect-rejected-outside-group", "simple-intent-phrase", "expense-phrase-redirect"],
  "slot_wait": 600,
  "slot_poll": 20
}
JSON
  chmod 0600 "$NEW_CONFIG"
  # -n: a config that appeared meanwhile is never overwritten.
  mv -n -- "$NEW_CONFIG" "$CONFIG_PATH"
  CONFIG_CREATED=1
fi

mkdir -p -- "$(dirname "$LIB_DIR")" "$(dirname "$ENTRY_PATH")"
NEW_LIB="$(mktemp -d "$LIB_DIR.new.XXXXXX")"
chmod 0755 "$NEW_LIB"
for rel in "${LIB_SOURCES[@]}"; do
  install -m 0755 "$SRC/$rel" "$NEW_LIB/$(basename "$rel")"
done
NEW_ENTRY="$ENTRY_PATH.new.$$"
printf '#!/usr/bin/env bash\nexec python3 %q/stage-qa-pc.py "$@"\n' "$LIB_DIR" >"$NEW_ENTRY"
chmod 0755 "$NEW_ENTRY"

ROLLBACK=()
if [[ -e "$LIB_DIR" ]]; then
  mv -T -- "$LIB_DIR" "$BACKUP_LIB"
  ROLLBACK+=("rm -rf -- $(printf '%q' "$LIB_DIR")" "mv -T -- $(printf '%q %q' "$BACKUP_LIB" "$LIB_DIR")")
else
  ROLLBACK+=("rm -rf -- $(printf '%q' "$LIB_DIR")")
fi
mv -T -- "$NEW_LIB" "$LIB_DIR"
NEW_LIB=""

if [[ -e "$ENTRY_PATH" ]]; then
  cp -p -- "$ENTRY_PATH" "$BACKUP_ENTRY"
  ROLLBACK+=("mv -f -- $(printf '%q %q' "$BACKUP_ENTRY" "$ENTRY_PATH")")
else
  ROLLBACK+=("rm -f -- $(printf '%q' "$ENTRY_PATH")")
fi
mv -f -- "$NEW_ENTRY" "$ENTRY_PATH"
NEW_ENTRY=""

printf 'installed PC stage QA from %s (%s) into %s and %s\n' "$HEAD_SHA" "${BRANCH:-detached}" "$LIB_DIR" "$ENTRY_PATH"
if (( CONFIG_CREATED )); then
  printf 'created %s (review it; it is never overwritten)\n' "$CONFIG_PATH"
else
  printf 'kept the existing %s\n' "$CONFIG_PATH"
fi
printf '\n(1) add this line to /root/.ssh/authorized_keys on the odroid (by hand, as root, after scripts/install-stage-qa.sh):\n'
printf 'restrict,command="%s" %s %s\n' "$ODROID_ENTRY" "$PUBLIC_KEY" "$KEY_COMMENT"
printf '\nThe odroid host key must be in ~/.ssh/known_hosts (StrictHostKeyChecking=yes); check its fingerprint on the odroid before adding it.\n'
ROLLBACK_COMMAND=""
for part in "${ROLLBACK[@]}"; do ROLLBACK_COMMAND+="${ROLLBACK_COMMAND:+ && }$part"; done
printf '\n(2) rollback of this install (config and ssh key are kept):\n'
printf 'rollback: %s\n' "$ROLLBACK_COMMAND"
