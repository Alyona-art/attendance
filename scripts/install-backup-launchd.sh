#!/bin/bash
# Один раз на Mac: ставит launchd-задачу бекапа раз в 2 дня.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/backup-from-server.sh"
PLIST_SRC="$ROOT/scripts/com.attendance.backup.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.attendance.backup.plist"

chmod +x "$SCRIPT"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HOME/Backups/attendance"

sed -e "s|REPLACE_WITH_FULL_PATH_TO/scripts/backup-from-server.sh|$SCRIPT|g" \
    -e "s|REPLACE_WITH_HOME|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "Установлено: $PLIST_DST"
echo "Интервал: каждые 2 дня (172800 с)."
echo "Проверка сейчас:"
"$SCRIPT"
echo "Лог: $HOME/Library/Logs/attendance-backup.log"
