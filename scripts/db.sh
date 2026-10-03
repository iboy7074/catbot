#!/usr/bin/env bash

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET="$DIR/data/mysql.sock"
USER="catbot"
PASS="catbot_secret"
DB="catchat_db"

CMD="mariadb --socket=$SOCKET -u $USER -p$PASS $DB"

if [ "$1" == "view" ] || [ "$1" == "all" ] || [ -z "$1" ]; then
  echo "=============================================="
  echo "  catchat_db — MySQL Database Viewer"
  echo "=============================================="
  echo ""
  echo ">>> [1] user_keys table:"
  $CMD -e "SELECT client_id, CONCAT(LEFT(api_key, 8), '...', RIGHT(api_key, 6)) AS masked_key, created_at, updated_at FROM user_keys;"
  echo ""
  echo ">>> [2] sessions table:"
  $CMD -e "SELECT id, client_id, title, FROM_UNIXTIME(ROUND(updated_at/1000)) AS last_active FROM sessions ORDER BY updated_at DESC LIMIT 10;"
  echo ""
  echo ">>> [3] messages table (latest 10):"
  $CMD -e "SELECT id, session_id, role, LEFT(text, 50) AS snippet, created_at FROM messages ORDER BY id DESC LIMIT 10;"
  echo ""
  echo "Tip: Run 'bash scripts/db.sh cli' to open an interactive SQL prompt."
elif [ "$1" == "cli" ] || [ "$1" == "shell" ]; then
  echo "Opening interactive MySQL shell (type 'exit' to quit)..."
  $CMD
elif [ "$1" == "keys" ]; then
  $CMD -e "SELECT client_id, CONCAT(LEFT(api_key, 8), '...', RIGHT(api_key, 6)) AS masked_key, created_at, updated_at FROM user_keys;"
elif [ "$1" == "sessions" ]; then
  $CMD -e "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 20;"
elif [ "$1" == "messages" ]; then
  $CMD -e "SELECT id, session_id, role, text, created_at FROM messages ORDER BY id DESC LIMIT 20;"
else
  # Pass arbitrary SQL query
  $CMD -e "$*"
fi
