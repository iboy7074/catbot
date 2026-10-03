#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "=== Starting catchat Services ==="

# 1. Start MariaDB if not running
if ! mariadb-admin --socket="$DIR/data/mysql.sock" ping >/dev/null 2>&1; then
  echo "[-] Starting MariaDB (port 3307)..."
  /usr/sbin/mariadbd --defaults-file="$DIR/data/my.cnf" >/dev/null 2>&1 &
  sleep 2
  if mariadb-admin --socket="$DIR/data/mysql.sock" ping >/dev/null 2>&1; then
    echo "[+] MariaDB is running (socket: $DIR/data/mysql.sock)."
  else
    echo "[!] MariaDB failed to start. Check data/mysql_error.log."
  fi
else
  echo "[+] MariaDB is already running."
fi

# 2. Start Node.js backend if not running
if ! pgrep -f "node server.js" >/dev/null 2>&1; then
  echo "[-] Starting Node.js backend on http://127.0.0.1:3001..."
  node server.js > "$DIR/data/backend.log" 2>&1 &
  sleep 2
  echo "[+] Backend started."
else
  echo "[+] Node backend is already running."
fi

# 3. Start Nginx if not running
if ! pgrep -f "nginx: master process" >/dev/null 2>&1 && ! pgrep -f "nginx: worker process" >/dev/null 2>&1; then
  echo "[-] Starting Nginx reverse proxy on http://127.0.0.1:8085..."
  rm -f "$DIR/data/nginx/nginx.pid"
  /usr/sbin/nginx -c "$DIR/nginx.conf"
  sleep 1
  echo "[+] Nginx started."
else
  echo "[+] Nginx is already running on port 8085."
fi

echo ""
echo "=== All services are up! ==="
echo "Access the app at: http://localhost:8085"
echo "API endpoint:      http://localhost:8085/api/health"
echo "============================"
