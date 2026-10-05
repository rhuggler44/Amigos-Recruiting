#!/usr/bin/env bash
# Restart the app so it picks up changes to .env.   sudo bash deploy/restart.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
if [[ "$(cat .deploy-mode 2>/dev/null)" == docker ]]; then
  # A plain "docker restart" keeps the old settings; recreating the container reloads .env.
  DOMAIN=$(grep -E '^PUBLIC_URL=' .env | sed -E 's#^PUBLIC_URL=https?://##; s#/.*##')
  AMIGOS_UID=$(id -u amigos) AMIGOS_GID=$(id -g amigos) DOMAIN="$DOMAIN" \
    docker compose -p amigos-outreach -f deploy/docker-compose.traefik.yml up -d --force-recreate --no-build 2>&1 | grep -v '^ *$' | tail -2
  for _ in $(seq 1 30); do
    [[ "$(docker inspect -f '{{.State.Health.Status}}' amigos-outreach-app-1 2>/dev/null)" == healthy ]] && break
    sleep 1
  done
  echo "amigos-outreach: $(docker inspect -f '{{.State.Health.Status}}' amigos-outreach-app-1)"
else
  systemctl restart amigos-outreach
  sleep 2
  echo "amigos-outreach: $(systemctl is-active amigos-outreach)"
fi
