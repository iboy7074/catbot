#!/usr/bin/env bash

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "=== catchat Services Status ==="

# MariaDB status
if mariadb-admin --socket="$DIR/data/mysql.sock" ping >/dev/null 2>&1; then
  echo "[✓] MariaDB: Running (Socket: $DIR/data/mysql.sock, Port: 3307)"
else
  echo "[✗] MariaDB: Stopped"
fi

# Backend status
if pgrep -f "node server.js" >/dev/null 2>&1; then
  echo "[✓] Node.js Backend: Running (Port 3001 & $DIR/data/backend.sock)"
else
  echo "[✗] Node.js Backend: Stopped"
fi

# Nginx status
if pgrep -f "nginx: master process" >/dev/null 2>&1 || pgrep -f "nginx: worker process" >/dev/null 2>&1; then
  echo "[✓] Nginx: Running (Port 8085)"
else
  echo "[✗] Nginx: Stopped"
fi

# Health check
echo ""
echo "--- Health Check ---"
curl -s http://127.0.0.1:8085/api/health 2>/dev/null || echo "Unable to query /api/health"
echo ""
