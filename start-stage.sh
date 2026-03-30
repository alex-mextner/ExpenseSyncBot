#!/bin/bash
# Load stage env vars (overrides .env auto-loaded by bun)
set -a
source /var/www/ExpenseSyncBot/.env.stage
set +a
exec /var/www/.bun/bin/bun run /var/www/ExpenseSyncBot/index.ts
