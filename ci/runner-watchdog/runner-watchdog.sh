#!/usr/bin/env bash
# Watchdog for the self-hosted runner: alert the admin over Telegram when it stops
# picking up jobs, and again when it recovers.
#
# deploy.yml and stage-bot.yml run on the home-server runner. When the board, its
# network or the runner service is down, their jobs just sit in the queue and no
# failure notification ever fires. Listing repo runners (GET .../actions/runners)
# needs admin rights that GITHUB_TOKEN cannot get, so instead the workflow
# (.github/workflows/runner-watchdog.yml) queues a no-op `ping` job on that runner,
# and this script — running on a GitHub-hosted runner in the same workflow run —
# watches whether a runner picks it up:
#
#   picked up within PICKUP_TIMEOUT              → online
#   still queued, runner busy with a job that
#     started less than BUSY_MAX_AGE ago         → online (it reaches the ping later)
#   otherwise                                    → offline
#
# A message goes out only when the observed state differs from the last state the
# admin was told about (STATE_FILE, carried between runs by the workflow's cache;
# missing = online). STATE_FILE is rewritten only after a successful send, so a
# failed send is retried by the next run.
#
# Requires: gh (authenticated via GH_TOKEN with actions:read), jq, curl.
#
# Env:
#   GH_REPO         owner/repo (gh honors it)
#   RUN_ID          id of the current workflow run
#   BOT_TOKEN       Telegram bot token used for the alert
#   ADMIN_CHAT_ID   Telegram chat that receives it
#   STATE_FILE      file holding the last announced state ("online"/"offline")
#   GITHUB_OUTPUT   step outputs: offline=true|false, state_changed=true|false
#   WATCHED_RUNNER  name of the runner to watch (not RUNNER_NAME: GitHub sets that
#                   to the runner executing this script)
#   PING_JOB        name of the ping job                     (default: ping)
#   PICKUP_TIMEOUT  seconds to wait for the pickup           (default: 300)
#   POLL_INTERVAL   seconds between status polls             (default: 15)
#   BUSY_MAX_AGE    seconds a running job counts as liveness (default: 1800; a job
#                   of a runner that died mid-run can stay in_progress for a while)
set -euo pipefail
# Command substitutions must fail the script too: a failed API call must never read
# as "no runner / not busy" and fire a false alert. Every query below is therefore
# called as `var=$(fn)` at top level, never as an `if` condition (where -e is off).
shopt -s inherit_errexit

: "${GH_REPO:?GH_REPO is required}"
: "${RUN_ID:?RUN_ID is required}"
: "${BOT_TOKEN:?BOT_TOKEN is required}"
: "${ADMIN_CHAT_ID:?ADMIN_CHAT_ID is required}"
: "${STATE_FILE:?STATE_FILE is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${WATCHED_RUNNER:?WATCHED_RUNNER is required}"
PING_JOB="${PING_JOB:-ping}"
PICKUP_TIMEOUT="${PICKUP_TIMEOUT:-300}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
BUSY_MAX_AGE="${BUSY_MAX_AGE:-1800}"

# Name of the runner that took this run's ping job; empty while it is queued.
ping_runner() {
  gh api "repos/$GH_REPO/actions/runs/$RUN_ID/jobs?per_page=100" \
    | jq -r --arg job "$PING_JOB" '[.jobs[] | select(.name == $job)][0].runner_name // ""'
}

# "<job> of run <id>" when WATCHED_RUNNER is executing some other job of this repo
# that started less than BUSY_MAX_AGE seconds ago, empty otherwise. Reads the first
# 100 in-progress runs and 100 jobs per run — far beyond what this repo ever has.
runner_busy_with() {
  local run_ids run_id job
  run_ids=$(gh api "repos/$GH_REPO/actions/runs?status=in_progress&per_page=100" \
    | jq -r --argjson self "$RUN_ID" '.workflow_runs[] | select(.id != $self) | .id')
  for run_id in $run_ids; do
    job=$(gh api "repos/$GH_REPO/actions/runs/$run_id/jobs?per_page=100" \
      | jq -r --arg runner "$WATCHED_RUNNER" --argjson max_age "$BUSY_MAX_AGE" \
        '[.jobs[] | select(.status == "in_progress" and .runner_name == $runner
            and (now - (.started_at | fromdateiso8601)) < $max_age) | .name][0] // ""')
    if [ -n "$job" ]; then
      echo "'$job' of run $run_id"
      return 0
    fi
  done
}

send_telegram() {
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg chat_id "$ADMIN_CHAT_ID" --arg text "$1" \
      '{chat_id: $chat_id, text: $text, parse_mode: "HTML", disable_web_page_preview: true}')") || status="000"
  if [ "$status" != "200" ]; then
    echo "::error::Telegram API returned HTTP $status"
    return 1
  fi
}

announced=online
if [ -s "$STATE_FILE" ]; then
  announced=$(cat "$STATE_FILE")
fi

deadline=$((SECONDS + PICKUP_TIMEOUT))
picked_by=""
while :; do
  picked_by=$(ping_runner)
  [ -n "$picked_by" ] && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep "$POLL_INTERVAL"
done

state=offline
if [ -n "$picked_by" ]; then
  echo "Runner $picked_by picked up the ping — online"
  state=online
else
  busy=$(runner_busy_with)
  if [ -n "$busy" ]; then
    echo "Runner $WATCHED_RUNNER is busy with job $busy; the ping is queued behind it — online"
    state=online
  else
    echo "::warning::Runner $WATCHED_RUNNER did not pick up a job in ${PICKUP_TIMEOUT}s and has no recently started job — offline"
  fi
fi

if [ "$state" = offline ]; then
  echo "offline=true" >>"$GITHUB_OUTPUT"
else
  echo "offline=false" >>"$GITHUB_OUTPUT"
fi

if [ "$state" = "$announced" ]; then
  echo "Admin already knows the runner is $state — no message"
  echo "state_changed=false" >>"$GITHUB_OUTPUT"
  exit 0
fi

if [ "$state" = offline ]; then
  send_telegram "🔴 <b>Self-hosted runner <code>${WATCHED_RUNNER}</code> is offline</b>
It has not picked up a job for $((PICKUP_TIMEOUT / 60)) min. Deploys to prod and the stage bot are stuck in the queue until it is back.

Check on the server: <code>systemctl status 'actions.runner.*.${WATCHED_RUNNER}.service'</code>
Runners: https://github.com/${GH_REPO}/settings/actions/runners"
else
  send_telegram "✅ <b>Self-hosted runner <code>${WATCHED_RUNNER}</code> is back online</b>
Queued deploys and stage jobs will run now."
fi
echo "$state" >"$STATE_FILE"
echo "state_changed=true" >>"$GITHUB_OUTPUT"
echo "Announced: runner is $state"
