# TEDI Remote Access — Relay (server)

The relay is the only public-facing piece. It runs on a small VPS, terminates
TLS via nginx, authenticates the host **agent** (bearer token) and **browser**
clients (login cookie), and pipes opaque frames between them. It never parses
terminal data.

```
browser --wss/TLS--> nginx (:443) --proxy--> relay (127.0.0.1:8788) <--wss out-- agent (your PC)
```

Requirements: a VPS with **SSH**, **nginx**, **Node 18+**, and a domain whose A
record points at the VPS. Everything below assumes `remote.example.com`.

## 1. Files

This `server/` folder is what you deploy:

| File | Purpose |
| --- | --- |
| `server.js` | The relay (Node, only dep is `ws`). |
| `package.json` / `package-lock.json` | Relay deps. |
| `gen-hash.js` | Generates the scrypt password hash for `LOGIN_PASS_HASH`. |
| `public/` | The built browser SPA (run `cd ../client && npm run build` first). |
| `deploy/tedi-remote.service` | systemd unit template. |
| `deploy/remote.ilhamriski.com.http.conf` | nginx phase-1 (ACME challenge only). |
| `deploy/remote.ilhamriski.com.conf` | nginx phase-2 (HTTPS + WS proxy + gzip). |

## 2. Build the browser UI

```bash
cd ../client && npm install && npm run build   # outputs ../server/public
```

## 3. Generate secrets (run locally, keep them safe)

```bash
node -e "const c=require('crypto');console.log('AGENT_TOKEN='+c.randomBytes(32).toString('hex'));console.log('SESSION_SECRET='+c.randomBytes(32).toString('hex'))"
node gen-hash.js 'a-strong-password'    # prints LOGIN_PASS_HASH=salt:hash
```

## 4. Deploy to the VPS

```bash
# create the app dir owned by your user
sudo mkdir -p /var/www/html/tedi-remote && sudo chown -R "$USER":"$USER" /var/www/html/tedi-remote

# copy server.js, package*.json, gen-hash.js, public/, deploy/ up (scp/rsync)
scp server.js package.json package-lock.json gen-hash.js user@vps:/var/www/html/tedi-remote/
scp -r public user@vps:/var/www/html/tedi-remote/

# on the VPS: install deps
cd /var/www/html/tedi-remote && npm install --omit=dev
```

Create `/var/www/html/tedi-remote/.env` (mode 600, **never commit it**):

```ini
PORT=8788
AGENT_TOKEN=<from step 3>
SESSION_SECRET=<from step 3>
LOGIN_USER=admin
LOGIN_PASS_HASH=<from gen-hash.js>
TRUST_PROXY=1
# Optional 2FA: set a base32 secret, add it to your authenticator, then login
# also requires the 6-digit code.
# TOTP_SECRET=ABCDEFGHIJKLMNOP
```

```bash
chmod 600 /var/www/html/tedi-remote/.env
```

## 5. systemd service

Edit `deploy/tedi-remote.service` so `ExecStart` points at your `node` (e.g. an
nvm path: `/home/<user>/.nvm/versions/node/<ver>/bin/node`) and `User=` is your
account, then:

```bash
sudo cp deploy/tedi-remote.service /etc/systemd/system/tedi-remote.service
sudo systemctl daemon-reload
sudo systemctl enable --now tedi-remote
systemctl is-active tedi-remote && curl -s http://127.0.0.1:8788/healthz   # -> ok
```

## 6. nginx + TLS (certbot webroot)

```bash
# phase 1: HTTP-only block so certbot can answer the ACME challenge
sed 's/remote.ilhamriski.com/remote.example.com/g' deploy/remote.ilhamriski.com.http.conf \
  | sudo tee /etc/nginx/conf.d/remote.example.com.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/lib/letsencrypt -d remote.example.com

# phase 2: full HTTPS + WebSocket proxy + gzip
sed 's/remote.ilhamriski.com/remote.example.com/g' deploy/remote.ilhamriski.com.conf \
  | sudo tee /etc/nginx/conf.d/remote.example.com.conf
sudo nginx -t && sudo systemctl reload nginx
```

The vhost proxies everything to `127.0.0.1:8788`, upgrades WebSockets, gzips
JS/CSS/JSON, and serves the SPA. Open `https://remote.example.com` — you should
see the login page.

## 7. Point the extension at it

In TEDI → Settings → Extensions → Remote Access, set **Relay URL** to
`wss://remote.example.com/agent` and **Agent token** to the `AGENT_TOKEN` from
step 3, then enable it.

## Operate

```bash
sudo systemctl restart tedi-remote
sudo journalctl -u tedi-remote -f
```

To update the UI: rebuild the client, copy `public/` + `server.js` up, and
`sudo systemctl restart tedi-remote`.

## Security notes

- The relay binds `127.0.0.1` only; nginx is the sole public surface.
- Login is rate-limited and locks out after repeated failures. Enable `TOTP_SECRET`.
- Rotate `AGENT_TOKEN` / the password periodically; rotating `SESSION_SECRET` logs everyone out.
- Consider an nginx `allow`/`deny` IP allow-list if your access IPs are stable.
