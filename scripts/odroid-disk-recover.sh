#!/usr/bin/env bash
# Boot guard for odroidn2's USB disks: tell the admin when a disk does not show up, and
# check that everything on a disk that did show up is running.
#
# Installed as /usr/local/sbin/odroid-disk-recover and run once per boot by
# odroid-disk-recover.service (DEPLOY.md, "Late USB disk at boot").
#
# What starts the units is systemd itself: each disk's device unit wants its mount
# (fstab x-systemd.wanted-by= / a .device.wants link), each mount wants the binds and
# services on it (*.mount.wants), and none of them is pulled in by local-fs.target or
# multi-user.target. So a disk that appears at any time - at boot, 40 minutes later,
# after a replug - brings its chain up, and a missing disk neither fails nor delays boot.
# Before that (2026-10-16), a disk detected after the fstab device timeout failed its mount
# and every dependent for good: prod was down for 85 minutes. The healthcheck alert lives
# on the WD500 itself, so this script carries its own alert, with credentials read from
# the SD card.
#
# Per disk: wait up to WAIT_SEC for /dev/disk/by-uuid/<uuid>, let the boot transaction
# finish, then check every listed unit. Active: fine. A job already on it (the chain's own
# start, still queued or activating): wait for that job. Down with no job: the chain missed
# it - start it, log a warning and report it. On a normal boot everything is active and the
# run changes nothing, so it is safe to re-run any time (`systemctl start
# odroid-disk-recover`). A disk that never appears, a unit that will not start, or an alert
# that cannot be delivered: logged at err, exit 1 (the unit then shows in `systemctl --failed`).
#
# Usage: odroid-disk-recover [--dry-run | --test-alert]
#   --dry-run     wait and check as usual, but start nothing and send nothing; print the
#                 units it would start and the message it would send
#   --test-alert  send one test message through the alert path and exit
#
# Env (tests and drills):
#   WD500_UUID, STORAGE_UUID  filesystem UUIDs to wait for
#   WAIT_SEC        how long to wait for a disk                (default: 900)
#   POLL_SEC        seconds between checks for a missing disk  (default: 5)
#   SETTLE_SEC      max wait for the boot transaction to end   (default: 600)
#   BY_UUID_DIR     where the UUID links appear                (default: /dev/disk/by-uuid)
#   ALERT_ENV_FILE  env file with BOT_TOKEN and BOT_ADMIN_ID   (default: /opt/hypercal/.env)
#
# Requires: bash >= 4.4, systemctl, timeout, curl, jq.
set -uo pipefail

WD500_UUID="${WD500_UUID:-83c5bd3c-2cfa-494e-b0a5-17d3c92d0925}"
STORAGE_UUID="${STORAGE_UUID:-8da3f69e-6c2d-4028-8a0e-c344f0922fbb}"
WAIT_SEC="${WAIT_SEC:-900}"
POLL_SEC="${POLL_SEC:-5}"
SETTLE_SEC="${SETTLE_SEC:-600}"
BY_UUID_DIR="${BY_UUID_DIR:-/dev/disk/by-uuid}"
# HyperCalendarBot's env: on the SD card, so readable when the WD500 is missing, and its
# BOT_ADMIN_ID is the same chat as ExpenseSyncBot's BOT_ADMIN_CHAT_ID.
ALERT_ENV_FILE="${ALERT_ENV_FILE:-/opt/hypercal/.env}"
ALERT_ATTEMPTS=3
ALERT_RETRY_SEC=30

# Start order matters only for how soon each unit is back: mounts, then the prod bot's
# path (caddy, pm2, its runner), then the docker stack, whose ha-compose can take minutes.
WD500_UNITS=(
  mnt-wd500.mount
  var-www-ExpenseSyncBot.mount
  'var-www-ExpenseSyncBot\x2dstage.mount'
  'var-www-actions\x2drunner.mount'
  var-lib-containerd.mount
  var-lib-docker.mount
  home-ultra.mount
  caddy.service
  pm2-www-data.service
  actions.runner.alex-mextner-ExpenseSyncBot.odroid.service
  containerd.service
  docker.service
  ha-compose.service
)
STORAGE_UNITS=(
  mnt-storage.mount
  'mnt-storage-odroid\x2drt-swapfile.swap'
)

MODE=run
case "$#:${1:-}" in
  0:) ;;
  1:--dry-run) MODE=dry-run ;;
  1:--test-alert) MODE=test-alert ;;
  *)
    echo "usage: $0 [--dry-run | --test-alert]" >&2
    exit 2
    ;;
esac
DRY_RUN=false
[[ $MODE == dry-run ]] && DRY_RUN=true

HOST=$(hostname)

# Under systemd the <N> prefix sets the journal priority (3 err, 4 warning, 6 info);
# warnings and errors go to stderr, which the journal reads the same way.
log() {
  local prio=$1
  shift
  if [[ -n "${INVOCATION_ID:-}" ]]; then
    printf '<%s>%s\n' "$prio" "$*"
  else
    printf '%s\n' "$*"
  fi
}
info() { log 6 "$*"; }
warn() { log 4 "WARNING: $*" >&2; }
err() { log 3 "ERROR: $*" >&2; }

env_value() {
  grep -m1 "^$1=" "$ALERT_ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d "\"'\r"
}

send_alert() {
  local text="$1"
  if $DRY_RUN; then
    info "[dry-run] would alert: $text"
    return 0
  fi
  local token chat config payload response status attempt
  token=$(env_value BOT_TOKEN)
  chat=$(env_value BOT_ADMIN_ID)
  if [[ -z "$token" || -z "$chat" ]]; then
    err "cannot alert: BOT_TOKEN or BOT_ADMIN_ID missing in $ALERT_ENV_FILE"
    return 1
  fi
  # The URL (with the token) goes in through a curl config on stdin, not argv:
  # /proc/*/cmdline is readable by every local user.
  config=$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"' "$token")
  payload=$(jq -cn --arg chat_id "$chat" --arg text "$text" '{chat_id: $chat_id, text: $text}')
  # The network may still be coming up when a disk is reported missing early. Only
  # Telegram's own `"ok": true` counts as delivered: a proxy or portal can answer 200 too.
  # A description is not a verdict: Telegram answers {"ok": false, "description": ...}.
  local body delivered reason
  for ((attempt = 1; attempt <= ALERT_ATTEMPTS; attempt++)); do
    response=$(printf '%s\n' "$config" |
      curl -K - -s -w '\n%{http_code}' --max-time 15 -X POST \
        -H 'Content-Type: application/json' -d "$payload")
    status=${response##*$'\n'}
    body=${response%$'\n'*}
    # A string compare, not `jq -e`: that exits 0 on an empty body.
    delivered=$(jq -r '.ok == true' <<<"$body" 2>/dev/null)
    [[ "$status" == 200 && "$delivered" == true ]] && return 0
    ((attempt < ALERT_ATTEMPTS)) && sleep "$ALERT_RETRY_SEC"
  done
  reason=$(jq -r '.description // empty' <<<"$body" 2>/dev/null)
  [[ -n "$reason" ]] || reason="no Telegram answer"
  err "Telegram alert failed (HTTP $status, $reason, after $ALERT_ATTEMPTS attempts): $text"
  return 1
}

if [[ $MODE == test-alert ]]; then
  if send_alert "🧪 $HOST: odroid-disk-recover alert path test — no action needed."; then
    info "test alert sent"
    exit 0
  fi
  exit 1
fi

started=()  # units the boot left down and this run brought up
failed=()   # units that would not start
missing=()  # "<disk> (<uuid>)" that never appeared
unstarted=() # units left down because their disk is missing

declare -A uuid_of=([wd500]="$WD500_UUID" [storage]="$STORAGE_UUID")
# units_of <disk> <array name>: fills the named array with the units that live on <disk>.
# shellcheck disable=SC2034 # `into` is a nameref: the assignments fill the caller's array
units_of() {
  local -n into=$2
  case $1 in
    wd500) into=("${WD500_UNITS[@]}") ;;
    storage) into=("${STORAGE_UNITS[@]}") ;;
    *)
      err "units_of: unknown disk '$1'"
      exit 2
      ;;
  esac
}

recover() {
  local disk=$1 unit state
  local -a units
  units_of "$disk" units
  for unit in "${units[@]}"; do
    state=$(systemctl is-active "$unit")
    # reloading: the unit is up; `start` would not wait for the reload anyway.
    [[ $state == active || $state == reloading ]] && continue
    if [[ $state == activating || -n $(systemctl list-jobs --no-legend --plain "$unit") ]]; then
      # The chain (or a Restart=) already has a job on it: `start` joins that job and
      # returns its outcome. Success is the chain working; failure is reported below.
      if $DRY_RUN; then
        info "[dry-run] $unit ($disk) has a job running — would wait for it"
        continue
      fi
      systemctl start "$unit" && continue
    else
      if $DRY_RUN; then
        info "[dry-run] would start $unit ($disk; now $state)"
        started+=("$unit")
        continue
      fi
      if systemctl start "$unit"; then
        warn "started $unit ($disk) — it was $state with no job, the disk's unit chain missed it"
        started+=("$unit")
        continue
      fi
    fi
    err "could not start $unit ($disk), it was $state: journalctl -u '$unit'"
    failed+=("$unit")
  done
}

pending=(wd500 storage)
waited=0 # seconds spent polling for a missing disk; the settle wait has its own SETTLE_SEC
settled=false
while :; do
  still=()
  for disk in "${pending[@]}"; do
    if [[ -e "$BY_UUID_DIR/${uuid_of[$disk]}" ]]; then
      # At boot the chain's jobs may still be queued; wait for the boot transaction once
      # so they are judged by their outcome. Later jobs are joined in recover().
      if ! $settled; then
        timeout "$SETTLE_SEC" systemctl is-system-running --wait >/dev/null
        settled=true
      fi
      info "$disk is present (/dev/disk/by-uuid/${uuid_of[$disk]})"
      recover "$disk"
    else
      still+=("$disk")
    fi
  done
  pending=("${still[@]}")
  ((${#pending[@]} == 0 || waited >= WAIT_SEC)) && break
  sleep "$POLL_SEC"
  waited=$((waited + POLL_SEC))
done

down=()
for disk in "${pending[@]}"; do
  missing+=("$disk (${uuid_of[$disk]})")
  units_of "$disk" down
  unstarted+=("${down[@]}")
  err "$disk never appeared: no /dev/disk/by-uuid/${uuid_of[$disk]} after ${waited}s"
done

if ((${#missing[@]} == 0 && ${#failed[@]} == 0 && ${#started[@]} == 0)); then
  info "all disks present and every unit on them active — nothing to do"
  exit 0
fi

msg=""
if ((${#missing[@]} > 0)); then
  msg+="🚨 $HOST: USB disk did not appear at boot (waited ${waited}s): ${missing[*]}."
  msg+=$'\n'"Down until it does: ${unstarted[*]}"
  msg+=$'\n'"They start by themselves when it appears. To check afterwards: systemctl start odroid-disk-recover"
fi
if ((${#failed[@]} > 0)); then
  [[ -n "$msg" ]] && msg+=$'\n\n'
  msg+="🚨 $HOST: would not start after the disk appeared: ${failed[*]}"
fi
if ((${#started[@]} > 0)); then
  [[ -n "$msg" ]] && msg+=$'\n\n'
  if $DRY_RUN; then
    msg+="⚠️ $HOST: down with nothing starting them, would start: ${started[*]}"
  else
    msg+="⚠️ $HOST: the disk's unit chain missed these, started them: ${started[*]}"
  fi
fi
# One pointer for both sections above: the journal names every unit this run touched.
if ((${#failed[@]} > 0)) || { ((${#started[@]} > 0)) && ! $DRY_RUN; }; then
  msg+=$'\n'"journalctl -b -u odroid-disk-recover"
fi
alerted=true
send_alert "$msg" || alerted=false

# A lost alert fails the unit too: after a recovery it is the only signal left.
if ((${#missing[@]} == 0 && ${#failed[@]} == 0)) && $alerted; then
  exit 0
fi
exit 1
