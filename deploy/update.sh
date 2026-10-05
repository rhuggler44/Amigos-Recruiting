#!/usr/bin/env bash
# Pull the latest code and restart.   sudo bash deploy/update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$APP_DIR/.runtime/bin:$PATH"
cd "$APP_DIR"
sudo -u amigos "$APP_DIR/.runtime/bin/node" --disable-warning=ExperimentalWarning scripts/backup.js || true
git pull --ff-only
npm ci --omit=dev --no-audit --no-fund --loglevel=error
systemctl restart amigos-outreach
sleep 2
systemctl --no-pager --lines=5 status amigos-outreach
