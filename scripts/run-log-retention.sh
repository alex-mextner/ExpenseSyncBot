#!/usr/bin/env bash
# Log retention for this checkout's logs/ directory: the only thing that ever deletes logs.
#
# Accessed via: the end of a successful deploy (.github/workflows/deploy.yml) and the hourly
# www-data cron entry (DEPLOY.md, "Deploy reliability"). Extra arguments go to log-retention.py
# (e.g. --dry-run, --max-dir-mb 512); its exit status is returned (0 criteria hold, 2 violated
# with only protected entries left, 3 root refused).
#
# What is managed (scripts/log-retention.py, a byte-identical copy of HyperCalendarBot's):
#   * rotated files only. pm2 holds the CURRENT logs (out.log, error.log, bank-sync-*.log) open;
#     compressing or deleting one would silently lose everything written after, so the sweep is
#     scoped with --only-glob to names with a timestamp: pm2-logrotate's `<name>__<stamp>.log[.gz]`
#     and the deploy step's `<name>_<stamp>.log[.gz]`;
#   * the release-*/failed-* evidence directories (--manage-evidence-dirs); the newest of each
#     (last deploy, last failure) is never deleted, nor is anything modified in the last 5 minutes;
#   * logs/chats/ and every other name is untouched and not counted.
#   Deletion happens only when a criterion is violated: managed bytes > 1024 MB, entries > 400, a
#   file > 200 MB, or free space on the filesystem < 2048 MB / 5 %.
#
# Alert: the script's Telegram alert (deletions, low free space) reads BOT_TOKEN and BOT_ADMIN_ID
# from an env file. This repository's admin chat is BOT_ADMIN_CHAT_ID, so the token and the chat
# are re-labelled into a private temporary env file for the run; .env itself is only read.
#
# Env overrides (for tests and manual runs): LOGS_ROOT (default <checkout>/logs), ENV_FILE
# (default <checkout>/.env).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
LOGS_ROOT="${LOGS_ROOT:-$APP_DIR/logs}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"

read_env() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'"
}

ALERT_ENV="$(umask 077 && mktemp)"
trap 'rm -f "$ALERT_ENV"' EXIT
printf 'BOT_TOKEN=%s\nBOT_ADMIN_ID=%s\n' "$(read_env BOT_TOKEN)" "$(read_env BOT_ADMIN_CHAT_ID)" >"$ALERT_ENV"

python3 "$SCRIPT_DIR/log-retention.py" \
  --root "$LOGS_ROOT" \
  --env-file "$ALERT_ENV" \
  --alert \
  --only-glob '*__*.log' --only-glob '*__*.log.gz' \
  --only-glob '*_????-??-??_??-??-??.log' --only-glob '*_????-??-??_??-??-??.log.gz' \
  --manage-evidence-dirs \
  "$@"
