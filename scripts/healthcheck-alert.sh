#!/usr/bin/env bash
# Polls the bot health endpoint every run (called by cron every 2 minutes).
# Sends Telegram alerts to the admin on failure and recovery.
# State file: /tmp/expensesyncbot-down — present while bot is considered down.
#
# A failed probe is re-tried before alerting: a deploy's PM2 restart leaves /health
# unreachable for ~10 s, and the 2-minute cron regularly lands inside that window,
# which used to fire a false "down" alert followed by a recovery 2 minutes later.
# Worst case per run: (1 + RETRIES) * TIMEOUT + RETRIES * RETRY_DELAY = 85 s, plus
# the 15 s Telegram call = 100 s, which ends before the next 2-minute cron tick.
#
# All timestamps (log lines and Telegram messages) are UTC.
# HEALTH_URL, ENV_FILE, STATE_FILE and RETRY_DELAY can be overridden from the
# environment to exercise the script locally.
#
# Setup on server (one-time):
#   chmod +x /var/www/ExpenseSyncBot/scripts/healthcheck-alert.sh
#   crontab -e   # as www-data
#   Add: */2 * * * * /var/www/ExpenseSyncBot/scripts/healthcheck-alert.sh >> /var/www/ExpenseSyncBot/logs/healthcheck.log 2>&1

set -euo pipefail

HEALTH_URL="${HEALTH_URL:-https://finbot.mextner.com/health}"
ENV_FILE="${ENV_FILE:-/var/www/ExpenseSyncBot/.env}"
STATE_FILE="${STATE_FILE:-/tmp/expensesyncbot-down}"
TIMEOUT=10
HEALTH_RETRIES=3                       # extra probes after a failed one
RETRY_DELAY="${RETRY_DELAY:-15}"       # seconds between probes
# A malformed override would make `sleep` fail under set -e and silence every alert.
[[ "$RETRY_DELAY" =~ ^[0-9]+$ ]] || RETRY_DELAY=15

log() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S') UTC] $*"
}

if [[ ! -f "$ENV_FILE" ]]; then
  log "ERROR: env file not found: $ENV_FILE"
  exit 1
fi

BOT_TOKEN=$(grep -E '^BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
ADMIN_CHAT_ID=$(grep -E '^BOT_ADMIN_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "")

if [[ -z "$BOT_TOKEN" ]]; then
  log "ERROR: BOT_TOKEN not found in $ENV_FILE"
  exit 1
fi

if [[ -z "$ADMIN_CHAT_ID" ]]; then
  log "ERROR: BOT_ADMIN_CHAT_ID not set in $ENV_FILE"
  exit 1
fi

send_telegram() {
  local text="$1"
  local tg_status
  tg_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg chat_id "$ADMIN_CHAT_ID" --arg text "$text" \
      '{chat_id: $chat_id, text: $text, parse_mode: "HTML"}')" || true)
  if [[ "$tg_status" != "200" ]]; then
    log "WARNING: Telegram API returned ${tg_status:-000}"
  fi
}

# curl prints 000 via -w on connection failure and then exits non-zero; `|| true`
# keeps that single 000 instead of appending another one.
probe() {
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$HEALTH_URL" 2>/dev/null || true)
  echo "${status:-000}"
}

HTTP_STATUS=$(probe)
attempt=0
while [[ "$HTTP_STATUS" != "200" && "$attempt" -lt "$HEALTH_RETRIES" ]]; do
  attempt=$((attempt + 1))
  sleep "$RETRY_DELAY"
  HTTP_STATUS=$(probe)
done

if [[ "$HTTP_STATUS" != "200" ]]; then
  if [[ ! -f "$STATE_FILE" ]]; then
    touch "$STATE_FILE"
    TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M UTC')
    send_telegram "🔴 <b>ExpenseSyncBot is down</b>
HTTP status: <code>${HTTP_STATUS}</code>
Time: ${TIMESTAMP}

Check: <code>pm2 logs expensesyncbot --lines 50 --nostream</code>"
    log "ALERT: bot is down (HTTP $HTTP_STATUS after $((HEALTH_RETRIES + 1)) attempts)"
  fi
else
  if [[ -f "$STATE_FILE" ]]; then
    rm -f "$STATE_FILE"
    TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M UTC')
    send_telegram "✅ <b>ExpenseSyncBot recovered</b>
Time: ${TIMESTAMP}"
    log "RECOVERY: bot is back up"
  fi
fi
