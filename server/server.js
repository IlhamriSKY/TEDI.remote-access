// TEDI remote-access relay.
//
// A deliberately "dumb" broker: it authenticates one host AGENT (bearer token)
// and many browser CLIENTS (login cookie), then pipes opaque JSON frames
// between them. It never parses terminal data. See ../README.md.
//
// Endpoints:
//   GET  /                 -> SPA shell (public/index.html), built from client/
//   GET  /assets/*         -> hashed, immutable build assets
//   GET  /api/me           -> 200 {user} if logged in, else 401
//   POST /api/login        -> {user,pass[,otp]} -> set session cookie
//   POST /api/logout       -> clear cookie
//   GET  /healthz          -> 200 ok
//   WS   /agent            -> host agent, auth: Authorization: Bearer <AGENT_TOKEN>
//   WS   /client           -> browser, auth: session cookie
//
// Binds 127.0.0.1 only; a TLS-terminating reverse proxy (nginx) faces the net.
//
// Config (env): PORT, AGENT_TOKEN (required), LOGIN_USER, LOGIN_PASS_HASH
// ('salt:hash' from gen-hash.js, preferred) or LOGIN_PASS (dev only),
// SESSION_SECRET, TOTP_SECRET (enables 2FA when set), TRUST_PROXY=1,
// ALLOWED_ORIGIN (e.g. https://remote.example.com; enforces the browser WS
// Origin when set).

"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// ----------------------------- config ----------------------------------------

const PORT = parseInt(process.env.PORT || "8788", 10);
const HOST = process.env.HOST || "127.0.0.1";
const AGENT_TOKEN = process.env.AGENT_TOKEN || "";
const LOGIN_USER = process.env.LOGIN_USER || "admin";
const LOGIN_PASS_HASH = process.env.LOGIN_PASS_HASH || "";
const LOGIN_PASS = process.env.LOGIN_PASS || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const TOTP_SECRET = process.env.TOTP_SECRET || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
// When set (e.g. https://remote.example.com), the browser WS upgrade must carry
// a matching Origin header. This is defense-in-depth against cross-site WS
// hijacking on top of the SameSite=Strict session cookie; leave empty to skip
// the check (back-compat). The native agent + SSH bridge use /agent (token /
// ticket) and are unaffected.
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "").replace(/\/+$/, "");
const COOKIE_NAME = "tedi_remote_sess";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 1 << 16;
const MAX_CLIENTS = 50; // browser WS cap (guards the client_join scrollback-replay amplification)
const MAX_AGENT_SOURCES = 4; // native PTY agent + SSH bridge; a handful is plenty

// Login password hash. Starts from LOGIN_PASS_HASH (env); if the user changes it
// from the web UI we persist the new hash to PASS_FILE next to server.js, which
// then overrides the env on the next boot. (The systemd unit grants write access
// to this dir; the relay otherwise writes nothing.)
const PASS_FILE = path.join(__dirname, "login-pass.hash");
let loginPassHash = LOGIN_PASS_HASH;
try {
  const saved = fs.readFileSync(PASS_FILE, "utf8").trim();
  if (saved) loginPassHash = saved;
} catch {
  /* no saved password yet */
}

// Short-lived WS tickets for header-less sources (the webview SSH bridge can't
// set an Authorization header on a WebSocket handshake).
const agentTickets = new Map(); // ticket -> expiry ms

if (!AGENT_TOKEN) {
  console.error("[relay] FATAL: AGENT_TOKEN env is required");
  process.exit(1);
}
if (!LOGIN_PASS_HASH && !LOGIN_PASS) {
  console.error("[relay] FATAL: set LOGIN_PASS_HASH (preferred) or LOGIN_PASS");
  process.exit(1);
}
if (!SESSION_SECRET) {
  // A random per-process default would silently invalidate every session on
  // each restart (the unit is Restart=always) and break a multi-instance deploy.
  console.error("[relay] FATAL: SESSION_SECRET env is required");
  process.exit(1);
}

function log(...args) {
  console.log(`[relay ${new Date().toISOString()}]`, ...args);
}

// ----------------------------- crypto -----------------------------------------

function safeEqStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyPass(pass) {
  if (loginPassHash) {
    const [saltHex, hashHex] = loginPassHash.split(":");
    if (!saltHex || !hashHex) return false;
    const dk = crypto.scryptSync(pass, Buffer.from(saltHex, "hex"), 32);
    const expect = Buffer.from(hashHex, "hex");
    return dk.length === expect.length && crypto.timingSafeEqual(dk, expect);
  }
  return safeEqStr(pass, LOGIN_PASS);
}

// scrypt hash in the same `salt:hash` (hex) format as gen-hash.js.
function hashPassword(pass) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pass, salt, 32);
  return salt.toString("hex") + ":" + dk.toString("hex");
}

function signSession(user) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ u: user, exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySession(cookie) {
  if (!cookie) return null;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (!safeEqStr(sig, expect)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!o || typeof o.exp !== "number" || o.exp < Date.now()) return null;
    return o;
  } catch {
    return null;
  }
}

// TOTP (RFC 6238, SHA1, 30s, 6 digits) using built-in crypto only.
function base32Decode(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

// Returns the matched 30s counter (>= 0) for a valid code, or -1. The caller
// consumes the counter only on a full login success (see /api/login), which
// prevents replay within the window and stops a wrong-password attacker from
// burning the user's counter. Window is [-1, 0] (past skew only).
// Counters consumed by a successful login, each with an expiry. A code can't be
// replayed within its window, but this does NOT block the legitimate user's
// other concurrent logins the way the old single high-water int did (it rejected
// the CURRENT code on any second login in the same 30s window, locking out a
// second device/tab). Pruned in the heartbeat.
const consumedTotp = new Map(); // counter -> expiry ms
const TOTP_CONSUME_TTL_MS = 90_000;
function verifyTotp(code) {
  if (!TOTP_SECRET) return 0; // TOTP disabled: sentinel "valid", never consumed
  if (!/^\d{6}$/.test(String(code || ""))) return -1;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (const w of [-1, 0]) {
    const c = counter + w;
    if (consumedTotp.has(c)) continue; // already consumed: reject replay
    if (safeEqStr(code, totpAt(TOTP_SECRET, c))) return c;
  }
  return -1;
}

// ----------------------------- rate limiting ----------------------------------

const loginFails = new Map(); // ip -> { n, until }

function clientIp(req) {
  if (TRUST_PROXY) {
    // Trust only nginx's X-Real-IP (the real peer). X-Forwarded-For is
    // client-controllable (nginx APPENDS to it), so its leftmost entry can be
    // spoofed to dodge the login rate-limit — never key the limiter on it.
    const real = req.headers["x-real-ip"];
    if (real) return String(real).trim();
  }
  return req.socket.remoteAddress || "?";
}
function rateBlocked(ip) {
  const e = loginFails.get(ip);
  return e && e.until > Date.now();
}
function noteFail(ip) {
  const e = loginFails.get(ip) || { n: 0, until: 0, ts: 0 };
  e.n += 1;
  e.ts = Date.now();
  if (e.n >= 5) e.until = e.ts + Math.min(60_000 * 2 ** (e.n - 5), 15 * 60_000);
  loginFails.set(ip, e);
}

// ----------------------------- http -------------------------------------------

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function setSessionCookie(res, value) {
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Strict; Secure; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000,
    )}`,
  ]);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Secure; Max-Age=0`,
  ]);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

function sendFile(res, filePath, buf) {
  const ext = path.extname(filePath);
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else if (ext === ".html") {
    res.setHeader("Cache-Control", "no-cache");
    // Defense-in-depth for the xterm renderer. The SPA uses an inline no-FOUC
    // theme script + inline styles, so script/style need 'unsafe-inline'.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; " +
        "base-uri 'none'; form-action 'self'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  }
  res.writeHead(200).end(buf);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath.replace(/\?.*$/, "");
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA fallback: a route without a file extension serves the shell.
      if (!path.extname(rel)) {
        fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
          if (e2) return res.writeHead(404).end("not found");
          sendFile(res, path.join(PUBLIC_DIR, "index.html"), html);
        });
        return;
      }
      res.writeHead(404).end("not found");
      return;
    }
    sendFile(res, filePath, buf);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  // The webview SSH bridge POSTs /api/agent-ticket cross-origin (from the TEDI
  // app's own origin) with an Authorization header, which makes the browser send
  // a CORS preflight first. Allow it for THIS bearer-gated endpoint ONLY -- not
  // /client, /api/login, or static -- so the bridge can fetch a ticket. Without
  // this the preflight 405s and the SSH source can never connect.
  if (p === "/api/agent-ticket" && req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
    return res.end();
  }

  if (p === "/api/me") {
    const sess = verifySession(getCookie(req, COOKIE_NAME));
    if (!sess) return json(res, 401, { ok: false });
    return json(res, 200, { ok: true, user: sess.u, totp: !!TOTP_SECRET });
  }

  if (p === "/api/login") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method not allowed" });
    const ip = clientIp(req);
    if (rateBlocked(ip)) return json(res, 429, { ok: false, error: "too many attempts" });
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      /* invalid json -> treated as bad creds below */
    }
    // Evaluate all three factors unconditionally before combining, so a wrong
    // username can't short-circuit the expensive scrypt and leak via timing.
    const okUser = safeEqStr(body.user || "", LOGIN_USER);
    const okPass = verifyPass(body.pass || "");
    const totpC = verifyTotp(body.otp);
    const okOtp = totpC >= 0;
    const ok = okUser && okPass && okOtp;
    if (!ok) {
      noteFail(ip);
      return json(res, 401, { ok: false, error: "invalid credentials" });
    }
    // Consume the OTP step only now (full success) so it can't be replayed.
    if (TOTP_SECRET && totpC >= 0) consumedTotp.set(totpC, Date.now() + TOTP_CONSUME_TTL_MS);
    loginFails.delete(ip);
    setSessionCookie(res, signSession(LOGIN_USER));
    return json(res, 200, { ok: true });
  }

  if (p === "/api/logout") {
    if (req.method !== "POST") return json(res, 405, { ok: false });
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  // Change the login password (requires a valid session + the current password).
  if (p === "/api/change-password") {
    if (req.method !== "POST") return json(res, 405, { ok: false });
    const sess = verifySession(getCookie(req, COOKIE_NAME));
    if (!sess) return json(res, 401, { ok: false, error: "not signed in" });
    const ip = clientIp(req);
    if (rateBlocked(ip)) return json(res, 429, { ok: false, error: "too many attempts" });
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      /* invalid json -> bad current password below */
    }
    const current = String(body.current || "");
    const next = String(body.new || "");
    if (!verifyPass(current)) {
      noteFail(ip);
      return json(res, 401, { ok: false, error: "current password is incorrect" });
    }
    if (next.length < 8) {
      return json(res, 400, { ok: false, error: "new password must be at least 8 characters" });
    }
    try {
      const hash = hashPassword(next);
      const tmp = `${PASS_FILE}.tmp`;
      fs.writeFileSync(tmp, hash, { mode: 0o600 });
      fs.renameSync(tmp, PASS_FILE); // atomic swap
      loginPassHash = hash;
    } catch (e) {
      log("change-password: cannot write PASS_FILE:", e && e.message ? e.message : e);
      return json(res, 500, { ok: false, error: "could not save the new password on the server" });
    }
    loginFails.delete(ip);
    log(`password changed by '${sess.u}'`);
    return json(res, 200, { ok: true });
  }

  // Open a SAVED SSH connection on the host, gated by a fresh LOGIN-password
  // re-auth (+ TOTP when enabled). The browser sends only the connection id and
  // its login password here - never the SSH credentials - and cannot open SSH
  // via the WS broadcast (those open-ssh frames are dropped). We verify the user
  // on this HTTP request, then emit the open-ssh frame to the host agent
  // ourselves; the host opens the saved connection using its keychain creds.
  if (p === "/api/open-ssh") {
    if (req.method !== "POST") return json(res, 405, { ok: false });
    const sess = verifySession(getCookie(req, COOKIE_NAME));
    if (!sess) return json(res, 401, { ok: false, error: "not signed in" });
    const ip = clientIp(req);
    if (rateBlocked(ip)) return json(res, 429, { ok: false, error: "too many attempts" });
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      /* invalid json -> fails the checks below */
    }
    const connectionId = String(body.connectionId || "");
    if (!connectionId) return json(res, 400, { ok: false, error: "missing connection" });
    // Evaluate both factors before combining (timing-leak defense, like login).
    const okPass = verifyPass(String(body.pass || ""));
    const totpC = verifyTotp(body.otp);
    const okOtp = totpC >= 0;
    if (!okPass || !okOtp) {
      noteFail(ip);
      return json(res, 401, { ok: false, error: "invalid credentials" });
    }
    if (TOTP_SECRET && totpC >= 0) consumedTotp.set(totpC, Date.now() + TOTP_CONSUME_TTL_MS);
    loginFails.delete(ip);
    // Forward to the host agent(s). The native PTY agent ignores it; the SSH
    // bridge opens the saved connection by id (keychain creds read host-side).
    const frame = JSON.stringify({ t: "open-ssh", connectionId });
    let delivered = 0;
    for (const a of agents) {
      if (a.readyState === 1) {
        try {
          a.send(frame);
          delivered++;
        } catch {
          /* ignore a dead socket */
        }
      }
    }
    if (delivered === 0) return json(res, 503, { ok: false, error: "host is offline" });
    log(`open-ssh requested by '${sess.u}'`);
    return json(res, 200, { ok: true });
  }

  // Issue a one-time WS ticket for a header-less source (the SSH bridge), gated
  // by the agent bearer token (which fetch CAN send).
  if (p === "/api/agent-ticket") {
    // CORS: the bridge fetches this from the webview's origin and must be able to
    // READ the ticket body, so echo the origin on the actual response too.
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Vary", "Origin");
    if (req.method !== "POST") return json(res, 405, { ok: false });
    const auth = req.headers["authorization"] || "";
    if (!safeEqStr(auth, `Bearer ${AGENT_TOKEN}`)) return json(res, 401, { ok: false });
    const now = Date.now();
    for (const [k, exp] of agentTickets) if (exp <= now) agentTickets.delete(k);
    if (agentTickets.size > 100) return json(res, 429, { ok: false, error: "too many tickets" });
    const ticket = crypto.randomBytes(18).toString("base64url");
    agentTickets.set(ticket, now + 60_000);
    return json(res, 200, { ok: true, ticket });
  }

  if (p === "/healthz") return res.writeHead(200).end("ok");

  if (req.method !== "GET" && req.method !== "HEAD")
    return res.writeHead(405).end("method not allowed");
  serveStatic(res, p);
});

// ----------------------------- websocket --------------------------------------

const wssAgent = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const wssClient = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });

// Multiple agent SOURCES can connect: the native PTY agent and the webview SSH
// bridge. Sessions from every source are merged for browsers; browser input is
// broadcast to all sources, each ignoring ids it doesn't own. Host is "online"
// while at least one source is connected.
const agents = new Set();
const sessionsBySource = new Map(); // ws -> sessions items[]
let agentName = null;
const clients = new Set();
let lastClientJoin = 0;

function broadcastClients(text) {
  for (const c of clients) {
    if (c.readyState === 1) {
      try {
        c.send(text);
      } catch {
        /* drop */
      }
    }
  }
}

// Tell every agent SOURCE how many browsers are currently connected. The native
// agent surfaces this to the TEDI status bar (so its icon lights up while a
// browser is attached); other sources ignore it. Sent on every client connect /
// disconnect, and once to each agent the moment it connects.
function sendClientCount(ws) {
  const msg = JSON.stringify({ t: "clients", count: clients.size });
  const targets = ws ? [ws] : agents;
  for (const a of targets) {
    if (a.readyState === 1) {
      try {
        a.send(msg);
      } catch {
        /* ignore */
      }
    }
  }
}

function mergedSessionItems() {
  const out = [];
  for (const items of sessionsBySource.values()) for (const it of items) out.push(it);
  return out;
}
let lastSessionsStr = null;
function broadcastSessions() {
  const str = JSON.stringify({ t: "sessions", items: mergedSessionItems() });
  if (str === lastSessionsStr) return; // unchanged (e.g. the agent's 2s poll): skip the fan-out
  lastSessionsStr = str;
  broadcastClients(str);
}

wssAgent.on("connection", (ws) => {
  agents.add(ws);
  sessionsBySource.set(ws, []);
  ws.isAlive = true;
  // A source set change must always re-publish: clear the dedup so the next
  // sessions frame fans out even if the merged string transiently matches.
  lastSessionsStr = null;
  log(`agent source connected (${agents.size} total)`);
  broadcastClients(JSON.stringify({ t: "host", status: "online", name: agentName }));
  sendClientCount(ws); // let the new source light its indicator if browsers are already attached

  ws.on("message", (data) => {
    const s = data.toString();
    // Only control frames (sessions/host) need parsing and they are tiny; skip
    // JSON.parse on large data/attached frames (the hot path).
    let o = null;
    if (s.length < 65536 && s.charCodeAt(0) === 123 /* '{' */) {
      try {
        o = JSON.parse(s);
      } catch {
        /* opaque */
      }
    }
    if (o && o.t === "sessions") {
      sessionsBySource.set(ws, Array.isArray(o.items) ? o.items : []);
      broadcastSessions();
      return;
    }
    if (o && o.t === "host") {
      if (o.name) {
        agentName = o.name;
        broadcastClients(JSON.stringify({ t: "host", status: "online", name: agentName }));
      }
      return; // host status is derived from connections, not forwarded raw
    }
    // data / attached / exit / pong -> straight to browsers (keyed by session id)
    broadcastClients(s);
  });
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("close", () => {
    agents.delete(ws);
    sessionsBySource.delete(ws);
    log(`agent source disconnected (${agents.size} total)`);
    lastSessionsStr = null; // a source left: force the reduced list to re-publish
    broadcastSessions();
    if (agents.size === 0) broadcastClients(JSON.stringify({ t: "host", status: "offline" }));
  });
  ws.on("error", () => {});
});

wssClient.on("connection", (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  log(`client connected (${clients.size} total)`);
  sendClientCount(); // light the host's status-bar indicator
  if (agents.size > 0) {
    try {
      ws.send(JSON.stringify({ t: "host", status: "online", name: agentName }));
      ws.send(JSON.stringify({ t: "sessions", items: mergedSessionItems() }));
    } catch {
      /* ignore */
    }
    // Ask every source to replay full scrollback for the newcomer, but at most
    // once per second: the replay broadcasts to ALL clients, so a recent one
    // already covers this newcomer, and a burst of connections can't amplify
    // into a storm of full-scrollback replays.
    const now = Date.now();
    if (now - lastClientJoin > 1000) {
      lastClientJoin = now;
      for (const a of agents) {
        try {
          a.send(JSON.stringify({ t: "client_join" }));
        } catch {
          /* ignore */
        }
      }
    }
  } else {
    try {
      ws.send(JSON.stringify({ t: "host", status: "offline" }));
    } catch {
      /* ignore */
    }
  }

  // Browser input goes to every source; each ignores ids it doesn't own.
  ws.on("message", (data) => {
    const s = data.toString();
    // Browsers may NOT open SSH over the WS broadcast path. `open-ssh` opens a
    // real SSH session and is only permitted via POST /api/open-ssh, which
    // re-verifies the login password. Drop any browser-sent open-ssh so a client
    // can't inject it here and bypass that gate. (Cheap substring pre-check so
    // the common frames aren't parsed.)
    if (s.length < 4096 && s.includes('"open-ssh"')) {
      try {
        if (JSON.parse(s).t === "open-ssh") return;
      } catch {
        /* not JSON; fall through to normal forwarding */
      }
    }
    for (const a of agents) {
      if (a.readyState === 1) {
        try {
          a.send(s);
        } catch {
          /* ignore */
        }
      }
    }
  });
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("close", () => {
    clients.delete(ws);
    log(`client disconnected (${clients.size} total)`);
    sendClientCount(); // dim the host's indicator if that was the last browser
  });
  ws.on("error", () => clients.delete(ws));
});

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/agent") {
    const auth = req.headers["authorization"] || "";
    let ok = safeEqStr(auth, `Bearer ${AGENT_TOKEN}`);
    if (!ok) {
      const ticket = new URL(req.url, "http://localhost").searchParams.get("ticket") || "";
      const exp = agentTickets.get(ticket);
      if (exp && exp > Date.now()) {
        agentTickets.delete(ticket);
        ok = true;
      }
    }
    if (!ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (agents.size >= MAX_AGENT_SOURCES) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit("connection", ws, req));
  } else if (pathname === "/client") {
    // Defense-in-depth against cross-site WS hijacking: reject a browser
    // handshake whose Origin doesn't match the configured public origin. The
    // SameSite=Strict cookie already suppresses cross-site cookie attachment;
    // this closes the gap for embedded WebViews / SameSite regressions.
    if (ALLOWED_ORIGIN) {
      const origin = (req.headers["origin"] || "").replace(/\/+$/, "");
      if (origin !== ALLOWED_ORIGIN) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    if (!verifySession(getCookie(req, COOKIE_NAME))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (clients.size >= MAX_CLIENTS) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    wssClient.handleUpgrade(req, socket, head, (ws) => wssClient.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// Drop half-open sockets so a dead TCP connection doesn't pin state.
const heartbeat = setInterval(() => {
  const check = (ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  };
  for (const a of agents) check(a);
  for (const c of clients) check(c);
  // Prune stale rate-limit + expired ticket entries so the maps stay bounded.
  const now = Date.now();
  for (const [ip, e] of loginFails) if (now - (e.ts || 0) > 15 * 60_000) loginFails.delete(ip);
  for (const [k, exp] of agentTickets) if (exp <= now) agentTickets.delete(k);
  for (const [c, exp] of consumedTotp) if (exp <= now) consumedTotp.delete(c);
}, 30_000);
heartbeat.unref();

// Bound slow-loris: cap how long a peer may take to send headers / the body.
server.requestTimeout = 20_000;
server.headersTimeout = 15_000;
server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT}`);
  log(`TOTP ${TOTP_SECRET ? "ENABLED" : "disabled"}; login user '${LOGIN_USER}'`);
  // The relay binds localhost and expects a reverse proxy. Without TRUST_PROXY
  // the login limiter keys on the socket peer, which is always 127.0.0.1 behind
  // the proxy - every client shares one bucket, so 5 bad guesses lock out
  // everyone. Warn loudly so a hand-rolled deploy doesn't ship this misconfig.
  if (!TRUST_PROXY && (HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost")) {
    log(
      "WARNING: TRUST_PROXY is not set but the relay is bound to localhost (behind a proxy). " +
        "Login rate-limiting will bucket ALL clients as 127.0.0.1. Set TRUST_PROXY=1.",
    );
  }
  log(
    `WS Origin check: ${ALLOWED_ORIGIN ? `enforced (${ALLOWED_ORIGIN})` : "OFF (set ALLOWED_ORIGIN to enable)"}`,
  );
});

// ----------------------------- graceful shutdown ------------------------------

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} received, shutting down`);
  clearInterval(heartbeat);
  for (const a of agents) {
    try {
      a.close(1001, "relay restarting");
    } catch {
      /* ignore */
    }
  }
  for (const c of clients) {
    try {
      c.close(1001, "relay restarting");
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
