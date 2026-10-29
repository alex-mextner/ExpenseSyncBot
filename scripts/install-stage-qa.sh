#!/usr/bin/env bash
# Installs the odroid side of the per-PR stage QA (DEPLOY.md "Stage QA") by hand, as root, from a reviewed
# main checkout:   sudo scripts/install-stage-qa.sh [<checkout>]   (default: the cwd)
#
# Why by hand: root runs the report script on behalf of PR runs (through one sudoers line), so it must come
# from code a human reviewed on main, never from a PR or the runner's workspace.
#
# Installs   LIB (/usr/local/lib/esb-stage-qa): odroid-stage-qa-report.py (the read-only report, run as root
#            through sudo), the engine stage-smoke.py it imports, and the QA driver (stage-qa-driver.py +
#            stage_qa_common.py, run by the stage-qa runner's job), copied into a fresh dir (root:root, 0755)
#            and swapped in with one rename;
#            /etc/esb-stage-qa/driver.json (browser host, key, known_hosts): ONLY if absent.
# Keeps      the previous LIB as <LIB>.bak-<UTC stamp> and prints the one-line rollback command.
# Prints     the sudoers line for the runner user, the end-to-end check of the report, and the rollback.
# Refuses    a non-root caller, a host without the service account `www-data` (the script drops to it), a
#            checkout that is not a git checkout, a layout where a listed file is missing, uncommitted changes
#            to (or untracked) listed files, and a HEAD that is not on origin/main.
# Never      touches pm2, the checkouts, the env files, the sudoers files or any log: the QA path only reads
#            them, and the sudoers line is added by hand.
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
  scripts/stage-qa-driver.py
  scripts/stage_qa_common.py
)
readonly REPORT_NAME=odroid-stage-qa-report.py
readonly DRIVER_CONFIG=/etc/esb-stage-qa/driver.json
readonly BROWSER_TARGET=ultra@65.21.40.51
readonly RUNNER_USER=hcb-qa
readonly RUNNER_HOME=/var/lib/hcb-qa-runner

fail() {
  local code="${2:-2}"
  echo "install-stage-qa: $1" >&2
  exit "$code"
}

NEW_LIB=""
NEW_CONFIG=""
CREATED_CONFIG=""
ROLLBACK_CONFIG=""
cleanup() {
  local status=$?
  [[ -z "$NEW_LIB" ]] || rm -rf -- "$NEW_LIB"
  [[ -z "$NEW_CONFIG" ]] || rm -f -- "$NEW_CONFIG"
  [[ -z "$CREATED_CONFIG" || "$status" == 0 ]] || rm -f -- "$CREATED_CONFIG"
}
trap cleanup EXIT

((EUID == REQUIRED_EUID)) || fail 'must run as root (the installed report script is run as root through sudo)'
(($# <= 1)) || fail 'usage: install-stage-qa.sh [<checkout>]'
id -u "$SERVICE_USER" >/dev/null 2>&1 || fail "the service account $SERVICE_USER does not exist (the report script drops to it)"
command -v python3 >/dev/null || fail 'python3 is not installed'
SRC="$(cd "${1:-$PWD}" && pwd -P)" || fail 'checkout directory not found'

for rel in "${LIB_SOURCES[@]}"; do
  [[ -f "$SRC/$rel" && ! -L "$SRC/$rel" ]] || fail "unknown checkout layout: $rel is missing in $SRC"
done

[[ -e "$SRC/.git" ]] || fail "$SRC is not a git checkout; install from a reviewed main checkout"
# safe.directory on the command line only: root must be able to read a checkout owned by another user.
# GIT_OPTIONAL_LOCKS=0: this runs as root in a checkout owned by the deploy user, and a plain `git status` refreshes
# and rewrites .git/index as root:root, which breaks the deploy user's next git job (#230). Read only.
git_in_src() { GIT_OPTIONAL_LOCKS=0 git -c safe.directory="$SRC" -C "$SRC" "$@"; }
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

# The driver's config (browser host, key, known_hosts) only when absent: never overwritten, no secret in it.
# Created before anything is swapped, so a failure up to here leaves the old lib untouched (the swap below
# replaces nothing this creates); a failed install removes the config it just created.
if [[ ! -e "$DRIVER_CONFIG" ]]; then
  install -d -m 0755 -o "${INSTALL_OWNER%%:*}" -g "${INSTALL_OWNER##*:}" -- "$(dirname "$DRIVER_CONFIG")"
  NEW_CONFIG="$DRIVER_CONFIG.new.$$"
  cat >"$NEW_CONFIG" <<EOF
{
  "browser_target": "$BROWSER_TARGET",
  "browser_key": "$RUNNER_HOME/.ssh/esb-stage-browser_ed25519",
  "browser_known_hosts": "$RUNNER_HOME/.ssh/known_hosts"
}
EOF
  chmod 0644 "$NEW_CONFIG"
  chown "$INSTALL_OWNER" "$NEW_CONFIG"
  mv -f -- "$NEW_CONFIG" "$DRIVER_CONFIG"
  NEW_CONFIG=""
  CREATED_CONFIG="$DRIVER_CONFIG"
  ROLLBACK_CONFIG="rm -f -- $(printf '%q' "$DRIVER_CONFIG")"
  printf 'created %s\n' "$DRIVER_CONFIG"
fi

ROLLBACK=()
[[ -z "$ROLLBACK_CONFIG" ]] || ROLLBACK+=("$ROLLBACK_CONFIG")
if [[ -e "$LIB_DIR" ]]; then
  mv -T -- "$LIB_DIR" "$BACKUP_LIB"
  ROLLBACK+=("rm -rf -- $(printf '%q' "$LIB_DIR")" "mv -T -- $(printf '%q %q' "$BACKUP_LIB" "$LIB_DIR")")
else
  ROLLBACK+=("rm -rf -- $(printf '%q' "$LIB_DIR")")
fi
mv -T -- "$NEW_LIB" "$LIB_DIR"
NEW_LIB=""

printf 'installed stage QA from %s (%s) into %s\n' "$HEAD_SHA" "${BRANCH:-detached}" "$LIB_DIR"
printf '\n(1) allow the runner user to run exactly the report script, with no arguments, as root: put this line in\n'
printf '/etc/sudoers.d/esb-stage-qa (by hand, with visudo -f, mode 0440):\n'
printf '%s ALL=(root) NOPASSWD: %s/%s ""\n' "$RUNNER_USER" "$LIB_DIR" "$REPORT_NAME"
printf '\n(2) check the report path as the runner user (prints one STAGE_REPORT line):\n'
printf '    sudo -u %s sudo -n %s/%s\n' "$RUNNER_USER" "$LIB_DIR" "$REPORT_NAME"
ROLLBACK_COMMAND=""
for part in "${ROLLBACK[@]}"; do ROLLBACK_COMMAND+="${ROLLBACK_COMMAND:+ && }$part"; done
printf '\n(3) rollback of this install (the sudoers line and the ssh key are kept):\n'
printf 'rollback: %s\n' "$ROLLBACK_COMMAND"
