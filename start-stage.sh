#!/bin/bash
# Start stage bot with merged env: .env (base) + .env.stage (overrides)
# Result written to stage cwd, never modifies originals

REPO=/var/www/ExpenseSyncBot
STAGE_CWD=/var/www/ExpenseSyncBot-stage

mkdir -p "$STAGE_CWD/data"

# Merge: start with prod .env, override with .env.stage
# grep strips comments and empty lines, awk takes last value per key
cat "$REPO/.env" "$REPO/.env.stage" | grep -v "^#" | grep -v "^$" | awk -F= "{keys[\$1]=\$0} END {for(k in keys) print keys[k]}" > "$STAGE_CWD/.env"

echo "Merged env → $STAGE_CWD/.env ($(wc -l < "$STAGE_CWD/.env") vars)"

exec /var/www/.bun/bin/bun "$REPO/index.ts"
