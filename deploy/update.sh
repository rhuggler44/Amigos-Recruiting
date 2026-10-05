#!/usr/bin/env bash
# Pull the latest code and restart.   sudo bash deploy/update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
sudo -u amigos "$APP_DIR/.runtime/bin/node" --disable-warning=ExperimentalWarning scripts/backup.js || true
git pull --ff-only
if [[ "$(cat .deploy-mode 2>/dev/null)" == docker ]]; then
  DOMAIN=$(grep -E '^PUBLIC_URL=' .env | sed -E 's#^PUBLIC_URL=https?://##; s#/.*##')
  AMIGOS_UID=$(id -u amigos) AMIGOS_GID=$(id -g amigos) DOMAIN="$DOMAIN" \
    docker compose -p amigos-outreach -f deploy/docker-compose.traefik.yml up -d --build
  docker ps --filter name=amigos-outreach-app-1 --format '{{.Names}}: {{.Status}}'
else
  export PATH="$APP_DIR/.runtime/bin:$PATH"
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  systemctl restart amigos-outreach
  sleep 2
  systemctl --no-pager --lines=5 status amigos-outreach
fi
