// TEDI remote-access relay.
//
// A deliberately "dumb" broker: it authenticates one host AGENT (bearer token)
// and many browser CLIENTS (login cookie), then pipes opaque JSON frames
// between them. It never parses terminal data. See ../REMOTE-ACCESS-SPEC.md s.5.
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
// SESSION_SECRET, TOTP_SECRET (enables 2FA when set), TRUST_PROXY=1.

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
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const TOTP_SECRET = process.env.TOTP_SECRET || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const COOKIE_NAME = "tedi_remote_sess";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 1 << 16;

if (!AGENT_TOKEN) {
  console.error("[relay] FATAL: AGENT_TOKEN env is required");
  process.exit(1);
}
if (!LOGIN_PASS_HASH && !LOGIN_PASS) {
  console.error("[relay] FATAL: set LOGIN_PASS_HASH (preferred) or LOGIN_PASS");
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
  if (LOGIN_PASS_HASH) {
    const [saltHex, hashHex] = LOGIN_PASS_HASH.split(":");
    if (!saltHex || !hashHex) return false;
    const dk = crypto.scryptSync(pass, Buffer.from(saltHex, "hex"), 32);
    const expect = Buffer.from(hashHex, "hex");
    return dk.length === expect.length && crypto.timingSafeEqual(dk, expect);
  }
  return safeEqStr(pass, LOGIN_PASS);
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

function verifyTotp(code) {
  if (!TOTP_SECRET) return true;
  if (!/^\d{6}$/.test(String(code || ""))) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (const w of [-1, 0, 1]) if (safeEqStr(code, totpAt(TOTP_SECRET, counter + w))) return true;
  return false;
}

// ----------------------------- rate limiting ----------------------------------

const loginFails = new Map(); // ip -> { n, until }

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "?";
}
function rateBlocked(ip) {
  const e = loginFails.get(ip);
  return e && e.until > Date.now();
}
function noteFail(ip) {
  const e = loginFails.get(ip) || { n: 0, until: 0 };
  e.n += 1;
  if (e.n >= 5) e.until = Date.now() + Math.min(60_000 * 2 ** (e.n - 5), 15 * 60_000);
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
  res.setHeader("Set-Cookie", [`${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Secure; Max-Age=0`]);
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
    const ok = safeEqStr(body.user || "", LOGIN_USER) && verifyPass(body.pass || "") && verifyTotp(body.otp);
    if (!ok) {
      noteFail(ip);
      return json(res, 401, { ok: false, error: "invalid credentials" });
    }
    loginFails.delete(ip);
    setSessionCookie(res, signSession(LOGIN_USER));
    return json(res, 200, { ok: true });
  }

  if (p === "/api/logout") {
    if (req.method !== "POST") return json(res, 405, { ok: false });
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  if (p === "/healthz") return res.writeHead(200).end("ok");

  if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end("method not allowed");
  serveStatic(res, p);
});

// ----------------------------- websocket --------------------------------------

const wssAgent = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
const wssClient = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });

let agentSocket = null;
let agentName = null;
let lastSessionsFrame = null;
const clients = new Set();

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

wssAgent.on("connection", (ws) => {
  if (agentSocket && agentSocket !== ws) {
    try {
      agentSocket.close(4000, "replaced");
    } catch {
      /* ignore */
    }
  }
  agentSocket = ws;
  ws.isAlive = true;
  log("agent connected");
  broadcastClients(JSON.stringify({ t: "host", status: "online", name: agentName }));

  ws.on("message", (data) => {
    const s = data.toString();
    try {
      const o = JSON.parse(s);
      if (o && o.t === "sessions") lastSessionsFrame = s;
      if (o && o.t === "host" && o.name) agentName = o.name;
    } catch {
      /* opaque frame, still forward */
    }
    broadcastClients(s);
  });
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("close", () => {
    if (agentSocket === ws) {
      agentSocket = null;
      lastSessionsFrame = null;
      log("agent disconnected");
      broadcastClients(JSON.stringify({ t: "host", status: "offline" }));
    }
  });
  ws.on("error", () => {});
});

wssClient.on("connection", (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  log(`client connected (${clients.size} total)`);
  if (agentSocket) {
    try {
      ws.send(JSON.stringify({ t: "host", status: "online", name: agentName }));
    } catch {
      /* ignore */
    }
    if (lastSessionsFrame) {
      try {
        ws.send(lastSessionsFrame);
      } catch {
        /* ignore */
      }
    }
    try {
      agentSocket.send(JSON.stringify({ t: "client_join" }));
    } catch {
      /* ignore */
    }
  } else {
    try {
      ws.send(JSON.stringify({ t: "host", status: "offline" }));
    } catch {
      /* ignore */
    }
  }

  ws.on("message", (data) => {
    if (agentSocket && agentSocket.readyState === 1) {
      try {
        agentSocket.send(data.toString());
      } catch {
        /* ignore */
      }
    }
  });
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("close", () => {
    clients.delete(ws);
    log(`client disconnected (${clients.size} total)`);
  });
  ws.on("error", () => clients.delete(ws));
});

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/agent") {
    const auth = req.headers["authorization"] || "";
    if (!safeEqStr(auth, `Bearer ${AGENT_TOKEN}`)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit("connection", ws, req));
  } else if (pathname === "/client") {
    if (!verifySession(getCookie(req, COOKIE_NAME))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
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
  if (agentSocket) check(agentSocket);
  for (const c of clients) check(c);
}, 30_000);
heartbeat.unref();

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT}`);
  log(`TOTP ${TOTP_SECRET ? "ENABLED" : "disabled"}; login user '${LOGIN_USER}'`);
});

// ----------------------------- graceful shutdown ------------------------------

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} received, shutting down`);
  clearInterval(heartbeat);
  try {
    agentSocket?.close(1001, "relay restarting");
  } catch {
    /* ignore */
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
