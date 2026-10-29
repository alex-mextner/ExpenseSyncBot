#!/usr/bin/env bash
# Installs the browser half of the per-PR stage QA (DEPLOY.md "Stage QA") on the QA browser host (the server), by
# hand, as the NORMAL user the odroid driver's ssh key logs in as, from a reviewed main checkout:
#   scripts/install-stage-qa-browser.sh [<checkout>]      (default: the cwd)
#
# Why by hand: this half decides what is trusted (which bot, which floor of cases, which error patterns), so it
# must come from code a human reviewed on main, never from a PR or a runner workspace.
#
# Installs   ~/esb-stage-qa/lib/{stage-qa-browser.py,stage_qa_common.py,stage-smoke.py}: copied into a fresh dir
#            and swapped in while holding the browser lock (no QA run is in flight);
#            ~/esb-stage-qa/bin/stage-qa-browser: the ssh forced command (sets the browser environment, then
#            runs stage-qa-browser.py with the client's SSH_ORIGINAL_COMMAND, which must be a commit SHA).
#            Own dirs: the HyperCalendarBot browser half lives in ~/hypercal-stage-qa/{lib,bin} and the two
#            never overwrite each other.
# Creates    ~/.config/esb-stage-qa/browser.json ONLY if absent (never overwritten);
#            the browser toolchain SHARED with the HyperCalendarBot browser half under ~/hypercal-stage-qa, each
#            part ONLY if absent (the same pins as that installer): agent-browser (pinned, native binary, no node
#            at run time) + its Chrome in ~/hypercal-stage-qa/npm and ~/.agent-browser, qa-cli (pinned commit,
#            `uv tool`, ~/.local/bin/qa), and the shared libraries and fonts Chrome needs, unpacked from
#            `apt-get download` debs (no root) into ~/hypercal-stage-qa/chrome-libs, plus fonts.conf and tmp/.
# Keeps      the previous lib dir as <lib>.bak-<UTC stamp> and the previous entry as <entry>.bak-<stamp>,
#            and prints the one-line rollback command.
# Prints     the authorized_keys line to add (by hand) for the odroid driver's public key.
# Refuses    root, a checkout that is not a git checkout, a layout where a listed file is missing,
#            uncommitted changes to (or untracked) listed files, and a HEAD that is not on origin/main.
set -euo pipefail
umask 077

# Fixed on purpose: no environment overrides for what is installed (only $HOME decides where the user-level files
# live). The installer itself runs with the caller's PATH: it is run by hand as the account's own user, whose git,
# npm and uv may live outside the system directories; the forced-command entry gets the fixed SAFE_PATH below.
readonly FORBIDDEN_EUID=0
readonly BROWSER_LOCK_WAIT=60
readonly SAFE_PATH=/usr/local/bin:/usr/bin:/bin
readonly KEY_COMMENT=esb-stage-qa-odroid
readonly AGENT_BROWSER_VERSION=0.39.1
readonly QA_CLI_URL=git+https://git.hyperide.ai/ultrabricks/qa-cli
readonly QA_CLI_REF=875b11a0f3965de54e2015d525720008d8926f2f

fail() {
  local code="${2:-2}"
  echo "install-stage-qa-browser: $1" >&2
  exit "$code"
}

((EUID != FORBIDDEN_EUID)) || fail 'run as the normal user, not root (the files belong to the account the forced command runs as)'
[[ "${HOME:-}" == /* && -d "$HOME" ]] || fail 'HOME is not set to an existing absolute directory'

readonly BASE_DIR="$HOME/esb-stage-qa"
readonly LIB_DIR="$BASE_DIR/lib"
readonly ENTRY_PATH="$BASE_DIR/bin/stage-qa-browser"
readonly CONFIG_PATH="$HOME/.config/esb-stage-qa/browser.json"
# Shared with the HyperCalendarBot browser half: one toolchain, one Telegram Web session, one lock.
readonly TOOLCHAIN_DIR="$HOME/hypercal-stage-qa"
readonly NPM_DIR="$TOOLCHAIN_DIR/npm"
readonly CHROME_LIBS_DIR="$TOOLCHAIN_DIR/chrome-libs"
readonly FONTS_CONF="$TOOLCHAIN_DIR/fonts.conf"
readonly TMP_DIR="$TOOLCHAIN_DIR/tmp"
readonly LOCK_FILE="$HOME/.local/state/hypercal-stage-qa/qa.lock"

readonly -a LIB_SOURCES=(
  scripts/stage-qa-browser.py
  scripts/stage_qa_common.py
  scripts/stage-smoke.py
)
# Shared libraries Chrome needs that a minimal server image lacks, and fonts (Chrome cannot render without one).
readonly -a CHROME_DEBS=(
  libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 libasound2t64 libgbm1
  libcairo2 libpango-1.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libatspi2.0-0t64 libxres1 libxi6
  libxrender1 libavahi-client3 libavahi-common3 libfontconfig1 libfribidi0 libharfbuzz0b libpixman-1-0 libthai0
  libxcb-render0 libxcb-shm0 libdatrie1 libgraphite2-3 libdbus-1-3 fonts-dejavu-core
)

NEW_LIB=""
NEW_ENTRY=""
NEW_CONFIG=""
NEW_FONTS_CONF=""
cleanup() {
  [[ -z "$NEW_LIB" ]] || rm -rf -- "$NEW_LIB"
  [[ -z "$NEW_ENTRY" ]] || rm -f -- "$NEW_ENTRY"
  [[ -z "$NEW_CONFIG" ]] || rm -f -- "$NEW_CONFIG"
  [[ -z "$NEW_FONTS_CONF" ]] || rm -f -- "$NEW_FONTS_CONF"
}
trap cleanup EXIT

# A directory this installer creates is 0700; one that already exists keeps its mode (the toolchain and the
# lock directory are shared with the HyperCalendarBot half).
ensure_private_dir() { [[ -d "$1" ]] || install -d -m 0700 -- "$1"; }

(($# <= 1)) || fail 'usage: install-stage-qa-browser.sh [<checkout>]'
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

command -v python3 >/dev/null || fail 'python3 is not installed (the entry runs the browser half with it)'

# Hold the browser lock while swapping: a QA run holds it for its whole life, so the install waits instead
# of swapping stage-smoke.py under a running run.
ensure_private_dir "$(dirname "$LOCK_FILE")"
(
  umask 0
  : >>"$LOCK_FILE"
)
exec {LOCK_FD}<"$LOCK_FILE"
flock -w "$BROWSER_LOCK_WAIT" "$LOCK_FD" \
  || fail "a QA run holds $LOCK_FILE; nothing was changed, retry when it ends" 75

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_LIB="$LIB_DIR.bak-$STAMP"
BACKUP_ENTRY="$ENTRY_PATH.bak-$STAMP"
[[ ! -e "$BACKUP_LIB" && ! -e "$BACKUP_ENTRY" ]] || fail "a backup for $STAMP already exists; retry in a second"

# ---------------------------------------------------------------- toolchain (shared; each part only when absent)

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)
    AB_BINARY=agent-browser-linux-x64
    LIB_ARCH=x86_64-linux-gnu
    ;;
  aarch64)
    AB_BINARY=agent-browser-linux-arm64
    LIB_ARCH=aarch64-linux-gnu
    ;;
  *) fail "unsupported architecture $ARCH for agent-browser" ;;
esac
AB_PATH="$NPM_DIR/node_modules/agent-browser/bin/$AB_BINARY"

if [[ ! -x "$AB_PATH" ]]; then
  command -v npm >/dev/null || fail 'npm is not installed (needed once to fetch agent-browser)'
  # Pinned; the package's install script is not needed: the native binary is run directly.
  npm install --prefix "$NPM_DIR" --no-audit --no-fund "agent-browser@$AGENT_BROWSER_VERSION" >&2 \
    || fail 'npm install of agent-browser failed'
  [[ -x "$AB_PATH" ]] || fail "agent-browser installed without $AB_PATH"
fi
if ! compgen -G "$HOME/.agent-browser/browsers/chrome-*/chrome" >/dev/null; then
  "$AB_PATH" install >&2 || fail 'agent-browser could not download its Chrome'
fi
CHROME_PATH="$(compgen -G "$HOME/.agent-browser/browsers/chrome-*/chrome" | sort -V | tail -1 || true)"
[[ -x "$CHROME_PATH" ]] || fail 'no Chrome under ~/.agent-browser/browsers after the install'

if [[ ! -x "$HOME/.local/bin/qa" ]]; then
  command -v uv >/dev/null || fail 'uv is not installed (needed to install qa-cli)'
  uv tool install --force --python python3 "$QA_CLI_URL@$QA_CLI_REF" >&2 || fail 'uv tool install of qa-cli failed'
  [[ -x "$HOME/.local/bin/qa" ]] || fail 'qa is not in ~/.local/bin after the install (add ~/.local/bin to the account PATH or fix uv tool bin)'
fi

CHROME_LIB_PATH="$CHROME_LIBS_DIR/root/usr/lib/$LIB_ARCH:$CHROME_LIBS_DIR/root/lib/$LIB_ARCH"
missing_libs() { LD_LIBRARY_PATH="$CHROME_LIB_PATH" ldd "$CHROME_PATH" 2>&1 | grep -c 'not found' || true; }
if [[ "$(missing_libs)" != 0 || ! -d "$CHROME_LIBS_DIR/root/usr/share/fonts" ]]; then
  if ! { command -v apt-get && command -v dpkg-deb; } >/dev/null; then
    fail 'apt-get and dpkg-deb are needed to unpack the shared libraries Chrome needs'
  fi
  mkdir -p -- "$CHROME_LIBS_DIR/debs" "$CHROME_LIBS_DIR/root"
  (cd "$CHROME_LIBS_DIR/debs" && apt-get download "${CHROME_DEBS[@]}" >&2) || fail 'apt-get download of the Chrome libraries failed'
  for deb in "$CHROME_LIBS_DIR"/debs/*.deb; do dpkg-deb -x "$deb" "$CHROME_LIBS_DIR/root"; done
  [[ "$(missing_libs)" == 0 ]] || fail "Chrome still has missing shared libraries (see: LD_LIBRARY_PATH=$CHROME_LIB_PATH ldd $CHROME_PATH)"
fi

if [[ ! -e "$FONTS_CONF" ]]; then
  NEW_FONTS_CONF="$(mktemp "$FONTS_CONF.new.XXXXXX")"
  cat >"$NEW_FONTS_CONF" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>$CHROME_LIBS_DIR/root/usr/share/fonts/truetype</dir>
  <cachedir>$TOOLCHAIN_DIR/fontcache</cachedir>
  <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>DejaVu Serif</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>DejaVu Sans Mono</family></prefer></alias>
</fontconfig>
EOF
  # -n: a fonts.conf that appeared meanwhile (the other repository's installer) is never overwritten; the
  # temporary file left behind by a declined move is removed by the exit trap.
  mv -n -- "$NEW_FONTS_CONF" "$FONTS_CONF"
fi

# ---------------------------------------------------------------- config (only if absent)

CONFIG_CREATED=0
if [[ ! -e "$CONFIG_PATH" ]]; then
  ensure_private_dir "$(dirname "$CONFIG_PATH")"
  NEW_CONFIG="$(mktemp "$CONFIG_PATH.new.XXXXXX")"
  cat >"$NEW_CONFIG" <<'JSON'
{
  "username": "ExpenseSyncStageBot",
  "deny_usernames": ["ExpenseSyncBot"],
  "qa_bin": "~/.local/bin/qa",
  "python": "python3",
  "lock_file": "~/.local/state/hypercal-stage-qa/qa.lock",
  "lock_max_wait": 2700,
  "state_dir": "~/.local/state/esb-stage-qa",
  "min_cases": 5,
  "required_cases": ["start", "ping", "help-lists-commands", "categories-read-only-listing", "validation-connect-rejected-outside-group", "simple-intent-phrase", "expense-phrase-redirect"]
}
JSON
  chmod 0600 "$NEW_CONFIG"
  # -n: a config that appeared meanwhile is never overwritten.
  mv -n -- "$NEW_CONFIG" "$CONFIG_PATH"
  CONFIG_CREATED=1
fi

# ---------------------------------------------------------------- lib and entry

mkdir -p -- "$(dirname "$LIB_DIR")" "$(dirname "$ENTRY_PATH")"
ensure_private_dir "$TMP_DIR"
NEW_LIB="$(mktemp -d "$LIB_DIR.new.XXXXXX")"
chmod 0755 "$NEW_LIB"
for rel in "${LIB_SOURCES[@]}"; do
  install -m 0755 "$SRC/$rel" "$NEW_LIB/$(basename "$rel")"
done
NEW_ENTRY="$ENTRY_PATH.new.$$"
# The browser environment lives here, not in the client's command: the forced command ignores everything but
# SSH_ORIGINAL_COMMAND. --no-sandbox: unprivileged user namespaces are restricted by AppArmor on this host, and
# the only page Chrome ever loads is Telegram Web. TMPDIR on disk: this host's /tmp is a shared tmpfs that other jobs
# fill (the first live run died with "CDP WebSocket connect failed: Connection refused" until Chrome got its own dir).
{
  printf '#!/usr/bin/env bash\n'
  printf 'export PATH=%q\n' "$HOME/.local/bin:$SAFE_PATH"
  printf 'export QA_BROWSER_BIN=%q\n' "$AB_PATH"
  printf 'export AGENT_BROWSER_ARGS=--no-sandbox\n'
  printf 'export LD_LIBRARY_PATH=%q\n' "$CHROME_LIB_PATH"
  printf 'export FONTCONFIG_FILE=%q\n' "$FONTS_CONF"
  printf 'export TMPDIR=%q\n' "$TMP_DIR"
  # shellcheck disable=SC2016 # the entry script must hold the literal ${SSH_ORIGINAL_COMMAND-}, not its value here
  printf 'exec python3 %q/stage-qa-browser.py "${SSH_ORIGINAL_COMMAND-}"\n' "$LIB_DIR"
} >"$NEW_ENTRY"
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

printf 'installed browser stage QA from %s (%s) into %s and %s\n' "$HEAD_SHA" "${BRANCH:-detached}" "$LIB_DIR" "$ENTRY_PATH"
if ((CONFIG_CREATED)); then
  printf 'created %s (review it; it is never overwritten)\n' "$CONFIG_PATH"
else
  printf 'kept the existing %s\n' "$CONFIG_PATH"
fi
printf '\n(1) add this line to ~/.ssh/authorized_keys of this account (by hand; back the file up first), with the public key\n'
printf 'of /var/lib/hcb-qa-runner/.ssh/esb-stage-browser_ed25519 on the odroid (sudo -u hcb-qa ssh-keygen -y -f that file):\n'
printf 'restrict,command="%s" ssh-ed25519 AAAA... %s\n' "$ENTRY_PATH" "$KEY_COMMENT"
ROLLBACK_COMMAND=""
for part in "${ROLLBACK[@]}"; do ROLLBACK_COMMAND+="${ROLLBACK_COMMAND:+ && }$part"; done
printf '\n(2) rollback of this install (config, toolchain and the Telegram session are kept):\n'
printf 'rollback: %s\n' "$ROLLBACK_COMMAND"
