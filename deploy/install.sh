#!/usr/bin/env bash
# Install Amigos Outreach on an Ubuntu/Debian VPS, alongside whatever else the server already runs.
#
#   sudo bash deploy/install.sh go.yourdomain.com [you@email.com]
#
# What it does (safe to re-run):
#   - installs a private copy of Node.js 22 inside this folder (doesn't touch the system Node or other apps)
#   - installs dependencies, creates a locked-down "amigos" system user and /var/lib/amigos-outreach for data
#   - writes .env with a random secret and admin password (kept on re-runs)
#   - runs the app as a systemd service on 127.0.0.1 only, plus a daily database backup
#   - connects the domain through nginx, Apache or Caddy, whichever the server already uses, with HTTPS
#   - checks that the server can reach Gmail's SMTP/IMAP ports (some VPS providers block them)
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=amigos-outreach
APP_USER=amigos
DATA_DIR=/var/lib/amigos-outreach
RUNTIME="$APP_DIR/.runtime"
NODE_MAJOR=22

say()  { printf '\n\033[1;33m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '    \033[31m!\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo bash deploy/install.sh go.yourdomain.com"; exit 1; }
command -v apt-get >/dev/null || { echo "This installer supports Ubuntu/Debian. See docs/DEPLOY.md for other systems."; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required."; exit 1; }
if [[ -d /usr/local/cpanel || -d /usr/local/psa ]]; then
  CONTROL_PANEL=1
  warn "cPanel/Plesk detected: the app will be installed, but the web server config is left to the panel (see the end)."
fi

# --- Node.js (private copy) -------------------------------------------------
say "Node.js ${NODE_MAJOR}"
case "$(uname -m)" in
  x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;;
esac
apt-get install -y -qq curl xz-utils ca-certificates iproute2 sudo >/dev/null
NODE_BIN="$RUNTIME/bin/node"
if [[ -x "$NODE_BIN" ]] && "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  ok "already installed: $("$NODE_BIN" -v)"
else
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  SUMS=$(curl -fsSL "$BASE/SHASUMS256.txt")
  FILE=$(awk -v a="linux-${ARCH}.tar.xz" '$2 ~ a"$" {print $2}' <<<"$SUMS")
  SUM=$(awk -v f="$FILE" '$2 == f {print $1}' <<<"$SUMS")
  TMP=$(mktemp -d)
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  echo "$SUM  $TMP/$FILE" | sha256sum -c --quiet
  rm -rf "$RUNTIME" && mkdir -p "$RUNTIME"
  tar -xJf "$TMP/$FILE" -C "$RUNTIME" --strip-components=1
  rm -rf "$TMP"
  ok "installed $("$NODE_BIN" -v) in $RUNTIME"
fi
export PATH="$RUNTIME/bin:$PATH"

# --- App user, data, dependencies -------------------------------------------
say "App files"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"
if ! sudo -u "$APP_USER" test -r "$APP_DIR/package.json"; then
  echo "The '$APP_USER' user can't read $APP_DIR (home folders are usually private)."
  echo "Move the app somewhere shared, e.g.:  sudo mv $APP_DIR /opt/amigos-outreach  and run the installer from there."
  exit 1
fi
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
ok "dependencies installed"

# --- .env ---------------------------------------------------------------------
say "Configuration"
ENV_FILE="$APP_DIR/.env"
port_free() { [[ -z "$(ss -ltnH "( sport = :$1 )" 2>/dev/null)" ]]; }
random() { "$NODE_BIN" -e "process.stdout.write(require('crypto').randomBytes($1).toString('$2'))"; }
if [[ ! -f "$ENV_FILE" ]]; then
  PORT=3100
  while ! port_free "$PORT"; do PORT=$((PORT + 1)); done
  ADMIN_PASSWORD=$(random 12 base64url)
  cat > "$ENV_FILE" <<EOF
ADMIN_PASSWORD=$ADMIN_PASSWORD
APP_SECRET=$(random 32 hex)
PUBLIC_URL=${DOMAIN:+https://$DOMAIN}
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$DATA_DIR
SEND_MODE=dry-run
ANTHROPIC_API_KEY=
EOF
  [[ -n "$DOMAIN" ]] || sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=http://localhost:$PORT#" "$ENV_FILE"
  NEW_PASSWORD=1
  ok "created .env (port $PORT)"
else
  ok ".env already exists, keeping it"
  if [[ -n "$DOMAIN" ]] && ! grep -q "^PUBLIC_URL=https://$DOMAIN" "$ENV_FILE"; then
    sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" "$ENV_FILE"
    ok "updated PUBLIC_URL to https://$DOMAIN"
  fi
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
PORT=$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)

# --- systemd service + daily backup -----------------------------------------
say "Background service"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Amigos Outreach (cold email planner and sender)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
cat > "/etc/systemd/system/$SERVICE-backup.service" <<EOF
[Unit]
Description=Amigos Outreach database backup

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning scripts/backup.js
EOF
cat > "/etc/systemd/system/$SERVICE-backup.timer" <<EOF
[Unit]
Description=Daily Amigos Outreach backup

[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE-backup.timer" >/dev/null
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
for _ in $(seq 1 20); do curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null; then ok "running on 127.0.0.1:$PORT"; else warn "service didn't start: journalctl -u $SERVICE -n 50"; exit 1; fi

# --- Can this server reach the mail servers? --------------------------------
say "Mail ports"
BLOCKED=0
for target in smtp.gmail.com:465 smtp.gmail.com:587 imap.gmail.com:993; do
  if timeout 6 bash -c "</dev/tcp/${target%:*}/${target#*:}" 2>/dev/null; then ok "$target reachable"
  else warn "$target BLOCKED"; BLOCKED=1; fi
done
[[ $BLOCKED -eq 0 ]] || warn "Your VPS provider blocks outgoing mail ports. Ask their support to open 465/587 (DigitalOcean, Linode and Vultr do this on request)."

# --- Web server / HTTPS -------------------------------------------------------
say "Web address"
proxy_done=""
if [[ -z "$DOMAIN" ]]; then
  warn "No domain given. Reach the dashboard with an SSH tunnel: ssh -L $PORT:127.0.0.1:$PORT you@server, then open http://localhost:$PORT"
elif [[ -n "${CONTROL_PANEL:-}" ]]; then
  warn "Point $DOMAIN to http://127.0.0.1:$PORT in your control panel (see docs/DEPLOY.md, or use the Cloudflare Tunnel option)."
elif systemctl is-active --quiet nginx; then
  CONF=/etc/nginx/sites-available/$SERVICE
  [[ -d /etc/nginx/sites-available ]] || CONF=/etc/nginx/conf.d/$SERVICE.conf
  cat > "$CONF" <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 60m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF
  [[ "$CONF" == /etc/nginx/sites-available/* ]] && ln -sf "$CONF" /etc/nginx/sites-enabled/$SERVICE
  nginx -t -q && systemctl reload nginx && ok "nginx configured for $DOMAIN" && proxy_done=certbot-nginx
elif systemctl is-active --quiet apache2; then
  a2enmod -q proxy proxy_http headers >/dev/null
  cat > /etc/apache2/sites-available/$SERVICE.conf <<EOF
<VirtualHost *:80>
    ServerName $DOMAIN
    ProxyPreserveHost On
    ProxyTimeout 300
    RequestHeader set X-Forwarded-Proto "http"
    ProxyPass / http://127.0.0.1:$PORT/
    ProxyPassReverse / http://127.0.0.1:$PORT/
</VirtualHost>
EOF
  a2ensite -q $SERVICE >/dev/null && apache2ctl -t 2>/dev/null && systemctl reload apache2 && ok "Apache configured for $DOMAIN" && proxy_done=certbot-apache
elif systemctl is-active --quiet caddy || [[ -z "$(ss -ltnH '( sport = :80 or sport = :443 )')" ]]; then
  if ! command -v caddy >/dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  mkdir -p /etc/caddy/sites
  grep -q 'import sites/\*' /etc/caddy/Caddyfile 2>/dev/null || echo 'import sites/*' >> /etc/caddy/Caddyfile
  echo "$DOMAIN {
    reverse_proxy 127.0.0.1:$PORT
}" > /etc/caddy/sites/$SERVICE
  systemctl reload caddy || systemctl restart caddy
  ok "Caddy configured for https://$DOMAIN (certificate is automatic)"
  proxy_done=caddy
else
  warn "Something else is using ports 80/443. Point $DOMAIN to http://127.0.0.1:$PORT in that web server."
fi

if [[ "$proxy_done" == certbot-* ]]; then
  PLUGIN=${proxy_done#certbot-}
  if ! command -v certbot >/dev/null; then apt-get install -y -qq certbot "python3-certbot-$PLUGIN" >/dev/null || true; fi
  if command -v certbot >/dev/null && certbot "--$PLUGIN" -d "$DOMAIN" --non-interactive --agree-tos --redirect \
       ${EMAIL:+-m "$EMAIL"} ${EMAIL:---register-unsafely-without-email} >/dev/null 2>&1; then
    ok "HTTPS certificate installed"
  else
    warn "Couldn't get an HTTPS certificate yet. Make sure $DOMAIN's DNS points to this server, then run: certbot --$PLUGIN -d $DOMAIN"
  fi
fi

# --- Done -------------------------------------------------------------------
say "Done"
if [[ -n "$DOMAIN" ]]; then echo "    Dashboard:  https://$DOMAIN"; else echo "    Dashboard:  http://localhost:$PORT (via SSH tunnel)"; fi
if [[ -n "${NEW_PASSWORD:-}" ]]; then
  echo "    Password:   $ADMIN_PASSWORD   (saved in $ENV_FILE as ADMIN_PASSWORD)"
else
  echo "    Password:   see ADMIN_PASSWORD in $ENV_FILE"
fi
echo "    Mode:       dry-run. Change SEND_MODE=live in .env, then: sudo systemctl restart $SERVICE"
echo "    Logs:       journalctl -u $SERVICE -f"
echo "    Update:     sudo bash deploy/update.sh"
echo "    Backups:    $DATA_DIR/backups (daily)"
