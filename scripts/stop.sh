#!/usr/bin/env bash

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "=== Stopping catchat Services ==="

# Stop Nginx
if [ -f "$DIR/data/nginx/nginx.pid" ]; then
  echo "[-] Stopping Nginx..."
  /usr/sbin/nginx -c "$DIR/nginx.conf" -s stop 2>/dev/null || true
  rm -f "$DIR/data/nginx/nginx.pid"
fi
killall nginx 2>/dev/null || true
echo "[+] Nginx stopped."

# Stop Node backend
echo "[-] Stopping Node.js backend..."
pkill -f "node server.js" 2>/dev/null || true
echo "[+] Backend stopped."

# Stop MariaDB
echo "[-] Stopping MariaDB..."
if mariadb-admin --socket="$DIR/data/mysql.sock" ping >/dev/null 2>&1; then
  mariadb-admin --socket="$DIR/data/mysql.sock" -u catbot -pcatbot_secret shutdown 2>/dev/null || mariadb-admin --socket="$DIR/data/mysql.sock" shutdown 2>/dev/null || true
fi
pkill -f "mariadbd --defaults-file" 2>/dev/null || true
echo "[+] MariaDB stopped."

echo "=== All services stopped ==="

