#!/usr/bin/env bash
# Keep the stage bot on main after a prod deploy (called by deploy.yml on the server,
# after `git pull` in the main checkout).
#
# The stage bot (pm2 `expensesyncbot-stage`) runs either a PR worktree (stage-bot.yml)
# or, once no PR holds the stage slot, the main checkout itself — then the pull already
# updated its code and a restart puts stage on the commit prod now runs. A stage bot
# running a PR worktree is left untouched: that PR is under QA. When stage runs main
# but does not come back online, the admin gets a Telegram warning and the script
# exits 1; when it does, the pm2 list is saved so a reboot resurrects it.
#
# Env:
#   BOT_TOKEN, ADMIN_CHAT_ID  Telegram bot + chat for the warning
#   COMMIT_SHA                deployed commit (for messages)
#   PM2                       pm2 binary        (default: /var/www/.bun/bin/pm2)
#   MAIN_DIR                  main checkout     (default: /var/www/ExpenseSyncBot)
set -uo pipefail
# The runner SIGKILLs every process still carrying the job's tracking id when the job
# ends ("Terminate orphan process"); keep it away from pm2 and what pm2 (re)starts.
unset RUNNER_TRACKING_ID

PM2="${PM2:-/var/www/.bun/bin/pm2}"
MAIN_DIR="${MAIN_DIR:-/var/www/ExpenseSyncBot}"
SHORT_SHA="${COMMIT_SHA:0:7}"

warn_admin() {
  local text
  text=$(printf '⚠️ <b>Stage bot was not moved to the new main</b> after deploy <code>%s</code>\n%s' "$SHORT_SHA" "$1")
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg chat_id "$ADMIN_CHAT_ID" --arg text "$text" \
      '{chat_id: $chat_id, text: $text, parse_mode: "HTML"}')" >/dev/null \
    || echo "⚠️  Telegram notification failed"
}

# Exec path + args of the stage process, empty when it is not in pm2. stage-bot.yml
# starts it as `bash -c "<bun> … <code_dir>/index.ts"`; start-stage.sh is the manual
# way to run it from the main checkout.
if ! STAGE_CMD=$($PM2 jlist | jq -r '.[] | select(.name == "expensesyncbot-stage")
    | [.pm2_env.pm_exec_path // "", ((.pm2_env.args // []) | if type == "array" then join(" ") else tostring end)]
    | join(" ")'); then
  warn_admin "could not read the pm2 process list"
  exit 1
fi

case "$STAGE_CMD" in
  "")
    echo "ℹ️  Stage bot is not running — nothing to do"
    exit 0
    ;;
  *" $MAIN_DIR/index.ts" | "$MAIN_DIR/start-stage.sh"*)
    echo "🔄 Stage bot runs main — restarting it on $SHORT_SHA"
    ;;
  *)
    echo "ℹ️  Stage bot runs a PR worktree — left untouched: $STAGE_CMD"
    exit 0
    ;;
esac

# No --update-env: keep the env the stage bot was started with (bun re-reads its merged
# --env-file on start); the deploy job's env must not leak into it.
if ! $PM2 restart expensesyncbot-stage; then
  warn_admin "pm2 restart failed"
  exit 1
fi

sleep 3
STATUS=$($PM2 jlist | jq -r '.[] | select(.name == "expensesyncbot-stage") | .pm2_env.status')
if [ "$STATUS" != "online" ]; then
  echo "❌ Stage bot is not online after restart (status: ${STATUS:-not_found})"
  $PM2 logs expensesyncbot-stage --lines 80 --nostream 2>&1 || true
  warn_admin "status: <code>${STATUS:-not_found}</code>"
  exit 1
fi
echo "✅ Stage bot online on main $SHORT_SHA"
# Persist the process list so a reboot's `pm2 resurrect` brings back this stage bot. It
# is already online, so a failed save warns instead of failing the step.
$PM2 save || echo "⚠️  pm2 save failed — a reboot may resurrect an older stage bot"
