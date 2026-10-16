#!/usr/bin/env bash
# Boot guard for odroidn2's USB disks: start what lives on a disk that showed up late,
# and tell the admin when a disk never shows up.
#
# Installed as /usr/local/sbin/odroid-disk-recover and run once per boot by
# odroid-disk-recover.service (DEPLOY.md, "Late USB disk at boot").
#
# The fstab mounts on these disks are `nofail` with x-systemd.device-timeout. When a disk
# is detected after that timeout, systemd fails its mount and every unit that needs it
# ("Dependency failed") and never retries them once the disk does appear. The UAS Toshiba
# (/mnt/storage) hangs its first read for ~30 s on every boot, and on 2026-10-16 that held
# back detection of both disks past the timeout: prod stayed down for 85 minutes. The
# healthcheck alert lives on the WD500 itself, so this script carries its own alert, with
# credentials read from the SD card.
#
# Per disk: wait up to WAIT_SEC for /dev/disk/by-uuid/<uuid>, let the boot transaction
# finish, then `systemctl start` every listed unit that is not active. On a normal boot
# everything is already active and the run changes nothing, so it is safe to re-run any
# time (`systemctl start odroid-disk-recover`). A unit it had to start means the boot path
# failed: logged as a warning and reported. A disk that never appears or a unit that will
# not start: logged at err, reported, exit 1 (the unit then shows in `systemctl --failed`).
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
# Requires: systemctl, timeout, curl, jq.
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

DRY_RUN=false
case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=true ;;
  --test-alert) ;;
  *)
    echo "usage: $0 [--dry-run | --test-alert]" >&2
    exit 2
    ;;
esac

HOST=$(hostname)

# Under systemd the <N> prefix sets the journal priority (3 err, 4 warning, 6 info).
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
warn() { log 4 "WARNING: $*"; }
err() { log 3 "ERROR: $*"; }

env_value() {
  grep -m1 "^$1=" "$ALERT_ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d "\"'"
}

send_alert() {
  local text="$1"
  if $DRY_RUN; then
    info "[dry-run] would alert: $text"
    return 0
  fi
  local token chat status attempt
  token=$(env_value BOT_TOKEN)
  chat=$(env_value BOT_ADMIN_ID)
  if [[ -z "$token" || -z "$chat" ]]; then
    err "cannot alert: BOT_TOKEN or BOT_ADMIN_ID missing in $ALERT_ENV_FILE"
    return 1
  fi
  # The network may still be coming up when a disk is reported missing early.
  for ((attempt = 1; attempt <= ALERT_ATTEMPTS; attempt++)); do
    status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
      -X POST "https://api.telegram.org/bot${token}/sendMessage" \
      -H 'Content-Type: application/json' \
      -d "$(jq -n --arg chat_id "$chat" --arg text "$text" '{chat_id: $chat_id, text: $text}')")
    [[ "$status" == 200 ]] && return 0
    ((attempt < ALERT_ATTEMPTS)) && sleep "$ALERT_RETRY_SEC"
  done
  err "Telegram alert failed (HTTP $status after $ALERT_ATTEMPTS attempts): $text"
  return 1
}

if [[ "${1:-}" == --test-alert ]]; then
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

recover() {
  local disk=$1
  shift
  local unit state
  for unit in "$@"; do
    state=$(systemctl is-active "$unit")
    [[ "$state" == active ]] && continue
    if $DRY_RUN; then
      info "[dry-run] would start $unit ($disk; now $state)"
      started+=("$unit")
    elif systemctl start "$unit"; then
      warn "started $unit ($disk) — the boot left it $state"
      started+=("$unit")
    else
      err "could not start $unit ($disk), it was $state: journalctl -u '$unit'"
      failed+=("$unit")
    fi
  done
}

declare -A uuid_of=([wd500]="$WD500_UUID" [storage]="$STORAGE_UUID")
pending=(wd500 storage)
waited=0
settled=false
while :; do
  still=()
  for disk in "${pending[@]}"; do
    if [[ -e "$BY_UUID_DIR/${uuid_of[$disk]}" ]]; then
      # A disk that appears before the timeout is handled by the boot transaction
      # itself; checking units while their jobs still run would misread them as down.
      if ! $settled; then
        timeout "$SETTLE_SEC" systemctl is-system-running --wait >/dev/null
        settled=true
      fi
      info "$disk is present (/dev/disk/by-uuid/${uuid_of[$disk]})"
      if [[ $disk == wd500 ]]; then
        recover "$disk" "${WD500_UNITS[@]}"
      else
        recover "$disk" "${STORAGE_UNITS[@]}"
      fi
    else
      still+=("$disk")
    fi
  done
  pending=("${still[@]}")
  ((${#pending[@]} == 0 || waited >= WAIT_SEC)) && break
  sleep "$POLL_SEC"
  waited=$((waited + POLL_SEC))
done

for disk in "${pending[@]}"; do
  missing+=("$disk (${uuid_of[$disk]})")
  if [[ $disk == wd500 ]]; then
    unstarted+=("${WD500_UNITS[@]}")
  else
    unstarted+=("${STORAGE_UNITS[@]}")
  fi
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
  msg+=$'\n'"Reconnect the disk, then: systemctl start odroid-disk-recover"
fi
if ((${#failed[@]} > 0)); then
  [[ -n "$msg" ]] && msg+=$'\n\n'
  msg+="🚨 $HOST: would not start after the disk appeared: ${failed[*]}"
  msg+=$'\n'"journalctl -b -u odroid-disk-recover"
fi
if ((${#started[@]} > 0)); then
  [[ -n "$msg" ]] && msg+=$'\n\n'
  if $DRY_RUN; then
    msg+="⚠️ $HOST: boot left these down, would start them: ${started[*]}"
  else
    msg+="⚠️ $HOST: boot left these down (USB disk came up late), started them: ${started[*]}"
  fi
fi
send_alert "$msg"

((${#missing[@]} == 0 && ${#failed[@]} == 0))
