#!/usr/bin/env bash
# Polls the bot health endpoint every run (called by cron every 2 minutes).
# Sends Telegram alerts to the admin on failure and recovery.
# State file: /tmp/expensesyncbot-down — present while bot is considered down.
#
# Setup on server (one-time):
#   chmod +x /var/www/ExpenseSyncBot/scripts/healthcheck-alert.sh
#   crontab -e   # as www-data
#   Add: */2 * * * * /var/www/ExpenseSyncBot/scripts/healthcheck-alert.sh >> /var/www/ExpenseSyncBot/logs/healthcheck.log 2>&1

set -euo pipefail

HEALTH_URL="https://expense-sync-bot.invntrm.ru/health"
ENV_FILE="/var/www/ExpenseSyncBot/.env"
STATE_FILE="/tmp/expensesyncbot-down"
TIMEOUT=10

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: env file not found: $ENV_FILE"
  exit 1
fi

BOT_TOKEN=$(grep -E '^BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
ADMIN_CHAT_ID=$(grep -E '^BOT_ADMIN_CHAT_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "")

if [[ -z "$BOT_TOKEN" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: BOT_TOKEN not found in $ENV_FILE"
  exit 1
fi

if [[ -z "$ADMIN_CHAT_ID" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: BOT_ADMIN_CHAT_ID not set in $ENV_FILE"
  exit 1
fi

send_telegram() {
  local text="$1"
  local tg_status
  tg_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg chat_id "$ADMIN_CHAT_ID" --arg text "$text" \
      '{chat_id: $chat_id, text: $text, parse_mode: "HTML"}')")
  if [[ "$tg_status" != "200" ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: Telegram API returned $tg_status"
  fi
}

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$HEALTH_URL" 2>/dev/null || echo "000")

if [[ "$HTTP_STATUS" != "200" ]]; then
  if [[ ! -f "$STATE_FILE" ]]; then
    touch "$STATE_FILE"
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M UTC')
    send_telegram "🔴 <b>ExpenseSyncBot is down</b>
HTTP status: <code>${HTTP_STATUS}</code>
Time: ${TIMESTAMP}

Check: <code>pm2 logs expensesyncbot --lines 50 --nostream</code>"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ALERT: bot is down (HTTP $HTTP_STATUS)"
  fi
else
  if [[ -f "$STATE_FILE" ]]; then
    rm -f "$STATE_FILE"
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M UTC')
    send_telegram "✅ <b>ExpenseSyncBot recovered</b>
Time: ${TIMESTAMP}"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] RECOVERY: bot is back up"
  fi
fi
