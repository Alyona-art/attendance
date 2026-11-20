#!/bin/bash
# Копия БД с VPS на Mac. Запускать с Mac (по cron / launchd раз в 2 дня).
set -euo pipefail

SERVER="${ATT_BACKUP_HOST:-root@195.133.199.57}"
REMOTE_DB="${ATT_BACKUP_REMOTE:-/opt/attendance/data/attendance.db}"
DEST_DIR="${ATT_BACKUP_DIR:-$HOME/Backups/attendance}"

mkdir -p "$DEST_DIR"
STAMP=$(date +%Y-%m-%d_%H%M)
OUT="$DEST_DIR/attendance_$STAMP.db"
REMOTE_TMP="/tmp/attendance-backup-$$.db"

echo "[$(date -Iseconds)] backup from $SERVER → $OUT"

# Консистентная копия через sqlite .backup (учитывает WAL)
ssh "$SERVER" "sqlite3 '$REMOTE_DB' \".backup '$REMOTE_TMP'\""
scp -q "$SERVER:$REMOTE_TMP" "$OUT"
ssh "$SERVER" "rm -f '$REMOTE_TMP'"

ls -1t "$DEST_DIR"/attendance_*.db 2>/dev/null | tail -n +31 | while read -r f; do rm -f "$f"; done

echo "[$(date -Iseconds)] ok ($(du -h "$OUT" | awk '{print $1}'))"
ls -1t "$DEST_DIR"/attendance_*.db | head -5
