#!/usr/bin/env bash
# Host-wide deploy lock for the odroid, shared by HyperCalendarBot and ExpenseSyncBot (#823).
#
# Why: on 2026-10-24 both repositories deployed at once (a 16-minute `docker load` next to an
# ESB build and pm2 restarts); the box hit 33-62 % iowait and the HCB health wait ran out. Each
# repository already had its own per-service lock, which does not stop the other repository.
#
# Protocol (identical in both repositories; keep the two copies in step):
#   * lock file  $ODROID_DEPLOY_LOCK_FILE (default /run/lock/odroid-deploy.lock), advisory flock(2);
#   * owner file <lock file>.owner, informational only: repo, pid, process start ticks, start time.
#     The kernel drops the flock when the holder dies, so a crashed deploy never leaves a stale
#     lock. The owner file can go stale; it is judged by pid + start ticks (a recycled pid has other
#     start ticks) and is only ever used to explain a wait.
#   * a contender WAITS (re-trying flock in slices, logging who holds it) up to
#     ODROID_DEPLOY_LOCK_MAX_WAIT seconds (default 2400), then exits 75 so the deploy can simply be
#     re-run; it never breaks a live holder's lock.
# Usage: source this file, then `odroid_deploy_lock_acquire <repo-tag>`; the lock is held until the
# process exits (or odroid_deploy_lock_release).

ODROID_DEPLOY_LOCK_FILE="${ODROID_DEPLOY_LOCK_FILE:-/run/lock/odroid-deploy.lock}"
ODROID_DEPLOY_LOCK_MAX_WAIT="${ODROID_DEPLOY_LOCK_MAX_WAIT:-2400}"
ODROID_DEPLOY_LOCK_SLICE="${ODROID_DEPLOY_LOCK_SLICE:-30}"
ODROID_DEPLOY_LOCK_FD=""

# Process start time in clock ticks since boot (field 22 of /proc/<pid>/stat); empty when gone.
_odl_start_ticks() {
  local stat rest
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  rest="${stat##*) }"
  # After the ")" that closes comm, field 3 is the first word; starttime is field 22 => 20th word.
  set -- $rest
  printf '%s' "${20}"
}

# Prints "<repo> pid=<pid> since=<time>" and returns 0 when the owner file names a live holder;
# prints "stale" and returns 1 otherwise.
_odl_describe_owner() {
  local file="$ODROID_DEPLOY_LOCK_FILE.owner" repo="" pid="" ticks="" started="" line key value live
  [[ -r "$file" ]] || { printf 'unknown'; return 1; }
  while IFS= read -r line; do
    key="${line%%=*}"; value="${line#*=}"
    case "$key" in
      repo) repo="$value" ;; pid) pid="$value" ;; start_ticks) ticks="$value" ;; started) started="$value" ;;
    esac
  done <"$file"
  [[ "$pid" =~ ^[0-9]+$ ]] || { printf 'unknown'; return 1; }
  live="$(_odl_start_ticks "$pid" 2>/dev/null || true)"
  if [[ -n "$live" && "$live" == "$ticks" ]]; then
    printf '%s pid=%s since=%s' "$repo" "$pid" "$started"
    return 0
  fi
  printf 'stale (%s pid=%s is gone)' "${repo:-?}" "$pid"
  return 1
}

odroid_deploy_lock_acquire() {
  local tag="${1:?repo tag required}" waited=0 slice="$ODROID_DEPLOY_LOCK_SLICE" who
  local dir; dir="$(dirname "$ODROID_DEPLOY_LOCK_FILE")"
  [[ -d "$dir" ]] || mkdir -p "$dir" || { echo "deploy-lock: cannot create $dir" >&2; return 1; }
  # umask 0: the other repository's deploy user must be able to open (and the owner file to write) these
  # files whichever user created them first; the lock carries no secret.
  ( umask 0; : >>"$ODROID_DEPLOY_LOCK_FILE"; : >>"$ODROID_DEPLOY_LOCK_FILE.owner" ) \
    || { echo "deploy-lock: cannot create $ODROID_DEPLOY_LOCK_FILE" >&2; return 1; }
  exec {ODROID_DEPLOY_LOCK_FD}<"$ODROID_DEPLOY_LOCK_FILE" || return 1
  while ! flock -w "$slice" "$ODROID_DEPLOY_LOCK_FD"; do
    waited=$((waited + slice))
    who="$(_odl_describe_owner)" || true
    echo "deploy-lock: $tag waiting for the host deploy lock, held by: $who (waited ${waited}s of ${ODROID_DEPLOY_LOCK_MAX_WAIT}s)" >&2
    if (( waited >= ODROID_DEPLOY_LOCK_MAX_WAIT )); then
      echo "deploy-lock: gave up after ${waited}s; the other deploy is still running. Re-run this deploy when it ends." >&2
      exec {ODROID_DEPLOY_LOCK_FD}<&-
      return 75
    fi
  done
  if (( waited > 0 )); then echo "deploy-lock: $tag acquired the host deploy lock after ${waited}s" >&2; fi
  # Truncate and rewrite in place: the owner file sits in a sticky directory and may belong to the
  # other repository's user, so replacing it by rename would be refused.
  printf 'repo=%s\npid=%s\nstart_ticks=%s\nstarted=%s\n' \
    "$tag" "$$" "$(_odl_start_ticks "$$")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$ODROID_DEPLOY_LOCK_FILE.owner" 2>/dev/null || true
  return 0
}

odroid_deploy_lock_release() {
  [[ -n "$ODROID_DEPLOY_LOCK_FD" ]] || return 0
  : >"$ODROID_DEPLOY_LOCK_FILE.owner" 2>/dev/null || true
  exec {ODROID_DEPLOY_LOCK_FD}<&-
  ODROID_DEPLOY_LOCK_FD=""
}
