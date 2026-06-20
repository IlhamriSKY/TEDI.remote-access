#!/usr/bin/env bash
#
# TEDI Remote Access relay — one-shot setup.
#
# Run this on your VPS from the extracted bundle root (the folder that has
# client/ and server/ side by side), as a user with sudo:
#
#     bash server/install.sh
#
# It is interactive (asks for your domain + login) and idempotent-ish: re-running
# updates the unit and config but never overwrites an existing .env (so your
# secrets are stable). It does NOT obtain the TLS cert for you on the first pass —
# it sets up the HTTP-only vhost, you run certbot once (it prints the command),
# then it switches to the HTTPS vhost.
#
# Requirements: Linux with sudo, nginx, certbot, and Node 18+ (an nvm install is
# auto-detected). Tested on Debian/Ubuntu + RHEL/CentOS family.

set -euo pipefail

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

# --- locate the bundle ------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # .../server
ROOT="$(cd "$HERE/.." && pwd)"                            # bundle root
[ -d "$ROOT/client" ] || die "client/ not found next to server/ — run from the extracted bundle root"
[ -f "$HERE/server.js" ] || die "server/server.js not found"

APPDIR="${APPDIR:-/var/www/html/tedi-remote}"
SVCUSER="${SVCUSER:-$USER}"

# --- prerequisites ----------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node not found (install Node 18+ or load nvm first)"
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required (found $(node -v))"
command -v nginx >/dev/null 2>&1 || warn "nginx not found — install it before the vhost step works"
command -v certbot >/dev/null 2>&1 || warn "certbot not found — install it to obtain the TLS cert"

say "Using node: $NODE_BIN ($(node -v)), service user: $SVCUSER, app dir: $APPDIR"

# --- prompts ----------------------------------------------------------------
read -rp "Relay domain (e.g. remote.example.com): " DOMAIN
[ -n "$DOMAIN" ] || die "domain is required"
read -rp "Browser login username [admin]: " LOGIN_USER
LOGIN_USER="${LOGIN_USER:-admin}"
read -rsp "Browser login password: " LOGIN_PASS; echo
[ -n "$LOGIN_PASS" ] || die "password is required"

# --- build the website ------------------------------------------------------
say "Building the browser UI from client/ (this can take a minute)…"
( cd "$ROOT/client" && npm install && npm run build )   # outputs ../server/public
[ -f "$HERE/public/index.html" ] || die "client build did not produce server/public/index.html"

# --- copy into place --------------------------------------------------------
say "Installing relay into $APPDIR …"
sudo mkdir -p "$APPDIR"
sudo cp -r "$HERE/." "$APPDIR/server.d.tmp" 2>/dev/null || true
# Lay out a flat-ish app dir: server.js + public + deps live directly in $APPDIR.
sudo mkdir -p "$APPDIR"
sudo cp "$HERE/server.js" "$HERE/package.json" "$HERE/package-lock.json" "$HERE/gen-hash.js" "$APPDIR/" 2>/dev/null || \
  sudo cp "$HERE/server.js" "$HERE/gen-hash.js" "$APPDIR/"
sudo rm -rf "$APPDIR/public"; sudo cp -r "$HERE/public" "$APPDIR/public"
sudo rm -rf "$APPDIR/server.d.tmp"
sudo chown -R "$SVCUSER":"$SVCUSER" "$APPDIR"

say "Installing relay dependencies…"
( cd "$APPDIR" && npm install --omit=dev 2>/dev/null || true )

# --- secrets + .env (never overwrite an existing one) -----------------------
ENVFILE="$APPDIR/.env"
if [ -f "$ENVFILE" ]; then
  warn ".env already exists — keeping your existing secrets. Delete it to regenerate."
else
  say "Generating secrets…"
  AGENT_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  PASS_HASH="$(node "$APPDIR/gen-hash.js" "$LOGIN_PASS")"
  umask 177
  cat > "$ENVFILE" <<EOF
PORT=8788
AGENT_TOKEN=$AGENT_TOKEN
SESSION_SECRET=$SESSION_SECRET
LOGIN_USER=$LOGIN_USER
LOGIN_PASS_HASH=$PASS_HASH
TRUST_PROXY=1
# Reject browser WebSocket handshakes whose Origin isn't this relay (defense in
# depth vs cross-site WS hijacking, on top of the SameSite=Strict cookie).
ALLOWED_ORIGIN=https://$DOMAIN
# Optional 2FA: set a base32 secret, add it to your authenticator app, then
# login also requires the 6-digit code.
# TOTP_SECRET=ABCDEFGHIJKLMNOP
EOF
  umask 022
  sudo chown "$SVCUSER":"$SVCUSER" "$ENVFILE"; chmod 600 "$ENVFILE" 2>/dev/null || sudo chmod 600 "$ENVFILE"
fi

# --- systemd unit -----------------------------------------------------------
say "Installing systemd unit tedi-remote…"
sudo tee /etc/systemd/system/tedi-remote.service >/dev/null <<EOF
[Unit]
Description=TEDI remote-access relay (agent <-> browser bridge)
After=network.target

[Service]
Type=simple
User=$SVCUSER
WorkingDirectory=$APPDIR
EnvironmentFile=$APPDIR/.env
ExecStart=$NODE_BIN $APPDIR/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
# The relay writes only login-pass.hash (Change password) into its own dir.
ReadWritePaths=$APPDIR
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
CapabilityBoundingSet=
MemoryMax=256M
TasksMax=128
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now tedi-remote
sleep 1
sudo systemctl is-active --quiet tedi-remote && say "relay is running" || { sudo journalctl -u tedi-remote -n 20 --no-pager; die "relay failed to start"; }
curl -fsS http://127.0.0.1:8788/healthz >/dev/null && say "healthz OK" || warn "healthz did not answer yet"

# --- nginx ------------------------------------------------------------------
NGINX_CONF="/etc/nginx/conf.d/${DOMAIN}.conf"
CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
if command -v nginx >/dev/null 2>&1; then
  if [ -f "$CERT" ]; then
    say "TLS cert found — installing the HTTPS vhost."
    sed "s/remote.example.com/${DOMAIN}/g" "$HERE/deploy/remote.example.com.conf" | sudo tee "$NGINX_CONF" >/dev/null
  else
    say "No TLS cert yet — installing the HTTP-only (ACME) vhost first."
    sed "s/remote.example.com/${DOMAIN}/g" "$HERE/deploy/remote.example.com.http.conf" | sudo tee "$NGINX_CONF" >/dev/null
  fi
  sudo nginx -t && sudo systemctl reload nginx
  if [ ! -f "$CERT" ]; then
    echo
    say "Now obtain the certificate, then re-run this script to switch to HTTPS:"
    echo "    sudo certbot certonly --webroot -w /var/lib/letsencrypt -d ${DOMAIN}"
    echo "    bash server/install.sh    # re-run: it will install the HTTPS vhost"
  fi
else
  warn "nginx missing — skipped the vhost. Install nginx + certbot, then re-run."
fi

# --- done -------------------------------------------------------------------
echo
say "Done. In TEDI -> Settings -> Extensions -> Remote Access set:"
echo "    Relay:       ${DOMAIN}"
if [ -f "$ENVFILE" ]; then
  echo "    Agent token: $(sudo grep -m1 '^AGENT_TOKEN=' "$ENVFILE" | cut -d= -f2-)"
fi
echo "Then enable the extension and open https://${DOMAIN} (login: ${LOGIN_USER})."
