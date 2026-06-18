// Headless end-to-end check: login over HTTP, open the /client WS, and report
// which mirror frames arrive. Proves agent -> relay -> browser without a GUI.
const http = require("http");
const https = require("https");
const { WebSocket } = require("ws");

const BASE = process.env.BASE || "http://127.0.0.1:8788";
const USER = process.env.USER_NAME || "admin";
const PASS = process.env.USER_PASS || "test123";

function login() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ user: USER, pass: PASS });
    const u = new URL(BASE + "/api/login");
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          const cookie = (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
          if (res.statusCode === 200 && cookie) resolve(cookie);
          else reject(new Error("login failed " + res.statusCode + " " + b));
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const cookie = await login();
  console.log("LOGIN ok");
  const ws = new WebSocket(BASE.replace("http", "ws") + "/client", { headers: { Cookie: cookie } });
  const seen = {};
  let dataBytes = 0;
  let attachedBytes = 0;

  ws.on("open", () => {
    console.log("WS /client open");
    ws.send(JSON.stringify({ t: "hello" }));
  });
  ws.on("message", (d) => {
    let m;
    try {
      m = JSON.parse(d.toString());
    } catch {
      return;
    }
    seen[m.t] = (seen[m.t] || 0) + 1;
    if (m.t === "host") console.log("host:", m.status, m.name || "");
    if (m.t === "sessions")
      console.log("sessions:", JSON.stringify(m.items.map((i) => ({ id: i.id.slice(0, 8), title: i.title, size: i.cols + "x" + i.rows, alive: i.alive }))));
    if (m.t === "attached") {
      const n = m.scrollback ? Buffer.from(m.scrollback, "base64").length : 0;
      attachedBytes += n;
      console.log("attached:", m.id.slice(0, 8), "scrollback", n, "bytes");
    }
    if (m.t === "data") dataBytes += m.b64 ? Buffer.from(m.b64, "base64").length : 0;
  });
  ws.on("error", (e) => console.error("WS error:", e.message));

  setTimeout(() => {
    console.log("--- SUMMARY ---");
    console.log("frames:", JSON.stringify(seen));
    console.log("attached scrollback bytes:", attachedBytes);
    console.log("live data bytes:", dataBytes);
    const ok = (seen.attached || 0) > 0 || (seen.sessions || 0) > 0;
    console.log(ok ? "RESULT: PASS — mirror frames received" : "RESULT: FAIL — no session frames");
    process.exit(ok ? 0 : 1);
  }, 6000);
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(2);
});
