#!/usr/bin/env bash
# Installs the odroid side of the per-PR stage QA (DEPLOY.md "Stage QA") by hand, as root, from a reviewed
# main checkout:   scripts/install-stage-qa.sh [<checkout>]   (default: the cwd)
#
# Why by hand: the report script is the forced command of an ssh key that lives in root's authorized_keys,
# so it must come from code a human reviewed on main, never from a PR or the runner's workspace.
#
# Installs   LIB (/usr/local/lib/esb-stage-qa): odroid-stage-qa-report.py and the engine stage-smoke.py it
#            imports, copied into a fresh dir (root:root, 0755) and swapped in with one rename.
# Keeps      the previous LIB as <LIB>.bak-<UTC stamp> and prints the one-line rollback command.
# Prints     the authorized_keys line for the PC driver's public key (the PC installer prints the key) and the
#            command that checks the whole path end to end.
# Refuses    a non-root caller, a host without the service account `www-data` (the script drops to it), a
#            checkout that is not a git checkout, a layout where a listed file is missing, uncommitted changes
#            to (or untracked) listed files, and a HEAD that is not on origin/main.
# Never      touches pm2, the checkouts, the env files or any log: the QA path only reads them.
set -euo pipefail
umask 077

# Fixed on purpose: no environment overrides.
readonly LIB_DIR=/usr/local/lib/esb-stage-qa
readonly REQUIRED_EUID=0
readonly INSTALL_OWNER=root:root
readonly SERVICE_USER=www-data
readonly SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH="$SAFE_PATH"

readonly -a LIB_SOURCES=(
  scripts/odroid-stage-qa-report.py
  scripts/stage-smoke.py
)
readonly ENTRY_NAME=odroid-stage-qa-report.py

fail() { local code="${2:-2}"; echo "install-stage-qa: $1" >&2; exit "$code"; }

NEW_LIB=""
cleanup() { [[ -z "$NEW_LIB" ]] || rm -rf -- "$NEW_LIB"; }
trap cleanup EXIT

(( EUID == REQUIRED_EUID )) || fail 'must run as root (the installed script is the forced command of a root ssh key)'
(( $# <= 1 )) || fail 'usage: install-stage-qa.sh [<checkout>]'
id -u "$SERVICE_USER" >/dev/null 2>&1 || fail "the service account $SERVICE_USER does not exist (the report script drops to it)"
command -v python3 >/dev/null || fail 'python3 is not installed'
SRC="$(cd "${1:-$PWD}" && pwd -P)" || fail 'checkout directory not found'

for rel in "${LIB_SOURCES[@]}"; do
  [[ -f "$SRC/$rel" && ! -L "$SRC/$rel" ]] || fail "unknown checkout layout: $rel is missing in $SRC"
done

[[ -e "$SRC/.git" ]] || fail "$SRC is not a git checkout; install from a reviewed main checkout"
# safe.directory on the command line only: root must be able to read a checkout owned by another user.
git_in_src() { git -c safe.directory="$SRC" -C "$SRC" "$@"; }
DIRTY="$(git_in_src status --porcelain -- "${LIB_SOURCES[@]}")" || fail 'git status failed in the checkout'
[[ -z "$DIRTY" ]] || fail "uncommitted or untracked changes to installed files (install only reviewed, committed code):
$DIRTY"
# Only reviewed, merged code: HEAD must be origin/main or an ancestor of it. There is deliberately no
# override; fetch origin and check out main instead.
git_in_src rev-parse --verify --quiet refs/remotes/origin/main >/dev/null \
  || fail 'the checkout has no origin/main ref: install from a checkout of main (git fetch origin)'
git_in_src merge-base --is-ancestor HEAD refs/remotes/origin/main \
  || fail 'the checkout HEAD is not on origin/main: install only merged, reviewed code'
HEAD_SHA="$(git_in_src rev-parse --short=12 HEAD)" || fail 'cannot read the checkout revision'
BRANCH="$(git_in_src branch --show-current || true)"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_LIB="$LIB_DIR.bak-$STAMP"
[[ ! -e "$BACKUP_LIB" ]] || fail "a backup for $STAMP already exists; retry in a second"

mkdir -p -- "$(dirname "$LIB_DIR")"
NEW_LIB="$(mktemp -d "$LIB_DIR.new.XXXXXX")"
chmod 0755 "$NEW_LIB"
for rel in "${LIB_SOURCES[@]}"; do
  install -m 0755 "$SRC/$rel" "$NEW_LIB/$(basename "$rel")"
done
chown -R "$INSTALL_OWNER" "$NEW_LIB"

ROLLBACK=()
if [[ -e "$LIB_DIR" ]]; then
  mv -T -- "$LIB_DIR" "$BACKUP_LIB"
  ROLLBACK+=("rm -rf -- $(printf '%q' "$LIB_DIR")" "mv -T -- $(printf '%q %q' "$BACKUP_LIB" "$LIB_DIR")")
else
  ROLLBACK+=("rm -rf -- $(printf '%q' "$LIB_DIR")")
fi
mv -T -- "$NEW_LIB" "$LIB_DIR"
NEW_LIB=""

printf 'installed stage QA report from %s (%s) into %s\n' "$HEAD_SHA" "${BRANCH:-detached}" "$LIB_DIR"
printf '\n(1) add this line to /root/.ssh/authorized_keys (by hand, backup first; the PC installer prints <public key>):\n'
printf 'restrict,command="%s/%s" <public key from scripts/install-stage-qa-pc.sh> esb-stage-qa-pc\n' "$LIB_DIR" "$ENTRY_NAME"
printf '\n(2) check the whole path from the PC (prints one STAGE_REPORT line):\n'
printf '    ssh -i ~/.ssh/esb-stage-qa_ed25519 root@<odroid> report\n'
ROLLBACK_COMMAND=""
for part in "${ROLLBACK[@]}"; do ROLLBACK_COMMAND+="${ROLLBACK_COMMAND:+ && }$part"; done
printf '\n(3) rollback of this install:\n'
printf 'rollback: %s\n' "$ROLLBACK_COMMAND"
