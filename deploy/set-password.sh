#!/usr/bin/env bash
# Change the dashboard password.   sudo bash deploy/set-password.sh
# (Or non-interactively: sudo bash deploy/set-password.sh 'new-password')
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASSWORD="${1:-}"
if [[ -z "$PASSWORD" ]]; then
  read -rsp "New dashboard password: " PASSWORD; echo
  read -rsp "Type it again: " CONFIRM; echo
  [[ "$PASSWORD" == "$CONFIRM" ]] || { echo "Passwords don't match. Nothing changed."; exit 1; }
fi
[[ ${#PASSWORD} -ge 8 ]] || { echo "Use at least 8 characters. Nothing changed."; exit 1; }
[[ "$PASSWORD" != *'$'* ]] || { echo "Please don't use the \$ character (Docker treats it specially). Nothing changed."; exit 1; }
# Write the line with awk so special characters in the password can't break anything.
TMP=$(mktemp)
P="$PASSWORD" awk 'BEGIN{done=0} /^ADMIN_PASSWORD=/{print "ADMIN_PASSWORD=" ENVIRON["P"]; done=1; next} {print} END{if(!done) print "ADMIN_PASSWORD=" ENVIRON["P"]}' "$APP_DIR/.env" > "$TMP"
cat "$TMP" > "$APP_DIR/.env" && rm -f "$TMP"
echo "Password saved. Restarting…"
bash "$APP_DIR/deploy/restart.sh"
echo "Done. Log in with the new password."
