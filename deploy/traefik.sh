#!/usr/bin/env bash
# Switch an install from deploy/install.sh to a Docker container behind an existing Traefik proxy.
# Keeps the same .env (password, secret), data and backups.
#
#   sudo bash deploy/traefik.sh amigos.yourdomain.com
set -euo pipefail

DOMAIN="${1:?Usage: sudo bash deploy/traefik.sh amigos.yourdomain.com}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"

say() { printf '\n\033[1;33m==>\033[0m %s\n' "$*"; }
ok()  { printf '    \033[32m✔\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Run deploy/install.sh first (it creates .env and the data folder)."; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose is required."; exit 1; }

say "Configuration"
sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" "$ENV_FILE"
ok "PUBLIC_URL=https://$DOMAIN"
export DOMAIN AMIGOS_UID AMIGOS_GID
AMIGOS_UID=$(id -u amigos)
AMIGOS_GID=$(id -g amigos)

say "Stopping the non-Docker service (only one copy may run, or emails would go out twice)"
if systemctl list-unit-files amigos-outreach.service >/dev/null 2>&1; then
  systemctl disable --now amigos-outreach >/dev/null 2>&1 || true
fi
ok "stopped"
echo docker > "$APP_DIR/.deploy-mode"

say "Building and starting the container"
docker compose -p amigos-outreach -f "$APP_DIR/deploy/docker-compose.traefik.yml" up -d --build --quiet-pull 2>&1 | tail -3
for _ in $(seq 1 30); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' amigos-outreach-app-1 2>/dev/null)" == healthy ]] && break
  sleep 2
done
docker inspect -f '{{.State.Health.Status}}' amigos-outreach-app-1 | grep -q healthy && ok "container is healthy" || { docker logs --tail 30 amigos-outreach-app-1; exit 1; }

say "Checking https://$DOMAIN (the certificate can take up to a minute the first time)"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "https://$DOMAIN/health" 2>/dev/null; then ok "https://$DOMAIN is live with a valid certificate"; break; fi
  sleep 3
done
curl -fsS -o /dev/null "https://$DOMAIN/health" 2>/dev/null || echo "    Not reachable over HTTPS yet. Wait a minute and open https://$DOMAIN. If it still fails: docker logs traefik-traefik-1 --tail 50"

say "Done"
echo "    Dashboard: https://$DOMAIN   (password: ADMIN_PASSWORD in $ENV_FILE)"
echo "    Logs:      docker logs -f amigos-outreach-app-1"
echo "    Restart:   docker restart amigos-outreach-app-1   (needed after editing .env)"
echo "    Update:    sudo bash deploy/update.sh"
