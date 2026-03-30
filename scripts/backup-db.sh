#!/usr/bin/env bash
# Daily SQLite database backup.
#
# Creates a timestamped gzip archive in data/backups/.
# Keeps the last 30 backups, deletes older ones.
# Uses bun's built-in SQLite for consistent WAL-safe backup.
#
# Usage:
#   ./scripts/backup-db.sh                  # uses default paths
#   DB_PATH=/path/to/db ./scripts/backup-db.sh  # custom DB path
#
# Cron (runs at 03:00 daily):
#   0 3 * * * cd /var/www/ExpenseSyncBot && PATH=/var/www/.bun/bin:$PATH ./scripts/backup-db.sh >> logs/backup.log 2>&1

set -euo pipefail

DB_PATH="${DB_PATH:-./data/expenses.db}"
BACKUP_DIR="$(dirname "$DB_PATH")/backups"
KEEP_DAYS=30

if [ ! -f "$DB_PATH" ]; then
  echo "$(date -Iseconds) ERROR: database not found at $DB_PATH"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_FILE="$BACKUP_DIR/expenses_${TIMESTAMP}.db.gz"

# Use bun's built-in SQLite for WAL-safe backup (sqlite3 CLI may not be installed)
TEMP_BACKUP="/tmp/expenses_backup_$$.db"
bun -e "
const { Database } = require('bun:sqlite');
const src = new Database('${DB_PATH}', { readonly: true });
src.exec('VACUUM INTO \"${TEMP_BACKUP}\"');
src.close();
"

gzip -c "$TEMP_BACKUP" > "$BACKUP_FILE"
rm -f "$TEMP_BACKUP"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "$(date -Iseconds) OK: backup created $BACKUP_FILE ($SIZE)"

# Prune old backups
find "$BACKUP_DIR" -name "expenses_*.db.gz" -mtime +$KEEP_DAYS -delete -print | while read -r f; do
  echo "$(date -Iseconds) PRUNED: $f"
done

TOTAL=$(find "$BACKUP_DIR" -name "expenses_*.db.gz" | wc -l | tr -d ' ')
echo "$(date -Iseconds) Total backups: $TOTAL"
