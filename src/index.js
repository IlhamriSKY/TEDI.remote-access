// tedi.remote-access — spawns the native agent (sidecar) that mirrors every
// live PTY daemon session to your self-hosted relay over an outbound WSS, so a
// browser anywhere can attach to the terminals you have open in TEDI.
//
// The heavy lifting (daemon attach, multiplexing, reconnect) lives in the Rust
// agent under sidecar/<platform>/. This module only: reads config from the
// extension settings, spawns the agent, reads its READY handshake, and exposes
// a status-bar indicator. (Enable/disable is the extension's own toggle; there
// is no keyboard shortcut.)

// No default relay: every user must point this at THEIR own relay in Settings.
// Hardcoding a default would make all installs phone home to one host.
const DEFAULT_RELAY = "";

// Accept a bare domain (e.g. "remote.example.com") OR a full endpoint and
// produce the canonical agent WebSocket URL "wss://host/agent". So the user can
// type just the domain: the wss:// scheme and the /agent path are filled in.
function normalizeRelayUrl(input) {
  let s = (input || "").trim();
  if (!s) return "";
  // Force TLS: strip whatever scheme was given and use wss://, so the agent
  // token and the live terminal stream are never sent over plaintext ws:// /
  // http://. The relay only ever listens on wss behind nginx anyway.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = "wss://" + s;
  s = s.replace(/\/+$/, ""); // drop trailing slashes
  if (!/\/agent$/i.test(s)) s += "/agent"; // ensure the /agent endpoint
  return s;
}

let ctxRef = null;
let handle = null;
let booting = false;

// Live status the bar reflects: whether the agent reached the relay, how many
// browsers are attached (reported by the agent on stdout as `CLIENTS <n>`), and
// the relay domain (for the tooltip).
let agentOnline = false;
let clientCount = 0;
let relayHost = "";

// "wss://remote.example.com/agent" -> "remote.example.com" for the tooltip.
function hostFromRelay(relayUrl) {
  return String(relayUrl || "")
    .replace(/^wss?:\/\//i, "")
    .replace(/\/agent\/?$/i, "")
    .replace(/\/+$/, "");
}

// Recompute the status-bar item from the live state. The icon "lights up"
// (success tone) only while at least one browser is connected; online-but-idle
// is a neutral tone. Tooltip always names the relay domain + connection state.
function refreshStatus() {
  if (!agentOnline) return;
  const where = relayHost ? " · " + relayHost : "";
  if (clientCount > 0) {
    const n = clientCount === 1 ? "1 client connected" : clientCount + " clients connected";
    setStatus("success", "Remote Access" + where + " · " + n);
  } else {
    setStatus("default", "Remote Access" + where + " · online, no client connected");
  }
}

function setClientCount(n) {
  if (n === clientCount) return;
  clientCount = n;
  refreshStatus();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function platformDir(os) {
  const arch = os && os.arch ? os.arch : "x86_64";
  if (os && os.platform === "windows") return arch === "aarch64" ? null : "windows-x86_64";
  if (os && os.platform === "macos") return arch === "aarch64" ? "macos-aarch64" : "macos-x86_64";
  if (os && os.platform === "linux") return arch === "aarch64" ? null : "linux-x86_64";
  return null;
}

function agentProgram(ctx) {
  const dir = platformDir(ctx.os);
  if (!dir) return null;
  const exe = ctx.os.platform === "windows" ? "tedi-remote-agent.exe" : "tedi-remote-agent";
  return `${ctx.installPath.replace(/\\/g, "/")}/sidecar/${dir}/${exe}`;
}

function setStatus(tone, tooltip) {
  try {
    ctxRef.statusBar.setItem({ id: "remote", icon: "hugeicon:Globe02Icon", tooltip, tone });
  } catch {
    /* statusbar:write missing — non-fatal */
  }
}

// The token may live in the keychain (if the host routes `secret` settings
// there) or in the settings store. Try both so configuration "just works".
async function getToken(ctx) {
  let v = null;
  try {
    v = await ctx.secrets.get("agentToken");
  } catch {
    /* secrets:read not granted */
  }
  if (!v) {
    try {
      v = await ctx.settings.get("agentToken");
    } catch {
      /* ignore */
    }
  }
  return v || "";
}

async function readReady(ctx, h) {
  const deadline = Date.now() + 10000;
  let offset = 0;
  let buf = "";
  while (Date.now() < deadline) {
    const resp = await ctx.invoke("shell_bg_logs", { handle: h, sinceOffset: offset });
    if (resp && resp.bytes) buf += resp.bytes;
    if (resp && typeof resp.next_offset === "number") offset = resp.next_offset;
    if (resp && resp.exited) {
      throw new Error("agent exited before READY (exit " + (resp.exit_code != null ? resp.exit_code : "?") + ")");
    }
    if (buf.includes("READY ")) return;
    await sleep(120);
  }
  throw new Error("agent READY handshake timed out");
}

async function startAgent() {
  const ctx = ctxRef;
  if (!ctx || handle != null || booting) return;

  const program = agentProgram(ctx);
  if (!program) {
    setStatus("error", "Remote Access: unsupported platform");
    return;
  }
  const token = await getToken(ctx);
  if (!token) {
    setStatus("warning", "Remote Access: set the agent token in Settings");
    ctx.ui.toast("Remote Access: set the agent token in Settings -> Extensions", { variant: "warning" });
    return;
  }
  const relayUrl = normalizeRelayUrl((await ctx.settings.get("relayUrl")) || DEFAULT_RELAY);
  if (!relayUrl) {
    setStatus("warning", "Remote Access: set the relay URL in Settings");
    ctx.ui.toast("Remote Access: set your relay URL in Settings -> Extensions", { variant: "warning" });
    return;
  }
  let agentName = String((await ctx.settings.get("agentName")) || "").trim().slice(0, 64);
  if (!agentName) agentName = "TEDI host";

  booting = true;
  setStatus("default", "Remote Access: connecting...");
  try {
    const config = JSON.stringify({ relay_url: relayUrl, agent_token: token, agent_name: agentName });
    handle = await ctx.invoke("shell_bg_spawn_direct", { program, args: [config] });
    await readReady(ctx, handle);
    agentOnline = true;
    clientCount = 0;
    relayHost = hostFromRelay(relayUrl);
    refreshStatus();
    ctx.ui.toast("Remote Access: agent online", { variant: "success" });
    ctx.logger.info("agent online, handle", handle);
    watchAgent(ctx, handle);
    // Also mirror SSH tabs as a second relay source (no-ops on TEDI builds
    // without ssh_attach / ctx.invokeChannel).
    startSshBridge(ctx, relayUrl, token).catch(() => {});
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    setStatus("error", "Remote Access: " + msg);
    ctx.ui.toast("Remote Access failed: " + msg, { variant: "error" });
    if (handle != null) {
      await ctx.invoke("shell_bg_kill", { handle }).catch(() => {});
      handle = null;
    }
  } finally {
    booting = false;
  }
}

async function stopAgent() {
  const ctx = ctxRef;
  stopWatch();
  stopSshBridge();
  agentOnline = false;
  clientCount = 0;
  if (ctx && handle != null) {
    await ctx.invoke("shell_bg_kill", { handle }).catch(() => {});
    handle = null;
  }
  setStatus("default", "Remote Access: off");
}

// Supervise the spawned agent: if it exits (for example the PTY daemon restarts
// and the agent self-exits), clear the handle and reconnect, so mirroring does
// not silently die while the status bar still says "online".
let watchTimer = null;
function stopWatch() {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}
function watchAgent(ctx, h) {
  stopWatch();
  let offset = 0;
  let buf = ""; // accumulates stdout so a `CLIENTS <n>` line split across polls still parses
  watchTimer = setInterval(async () => {
    if (handle !== h) {
      stopWatch();
      return;
    }
    let resp;
    try {
      resp = await ctx.invoke("shell_bg_logs", { handle: h, sinceOffset: offset });
    } catch {
      return;
    }
    if (resp && typeof resp.next_offset === "number") offset = resp.next_offset;
    // Pull the latest browser-count the agent reported (one `CLIENTS <n>` line
    // per relay client connect/disconnect) and reflect it in the status bar.
    if (resp && resp.bytes) {
      buf += resp.bytes;
      const nl = buf.lastIndexOf("\n");
      if (nl >= 0) {
        const lines = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const matches = lines.match(/CLIENTS (\d+)/g);
        if (matches && matches.length) {
          const n = parseInt(matches[matches.length - 1].slice(8), 10);
          if (!Number.isNaN(n)) setClientCount(n);
        }
      }
      if (buf.length > 4096) buf = buf.slice(-4096); // bound the partial-line tail
    }
    if (resp && resp.exited) {
      stopWatch();
      handle = null;
      agentOnline = false;
      clientCount = 0;
      ctx.logger.info("agent exited (code " + (resp.exit_code != null ? resp.exit_code : "?") + "); reconnecting");
      setStatus("warning", "Remote Access: reconnecting...");
      scheduleRestart();
    }
  }, 2000);
}

let restartTimer = null;
function scheduleRestart() {
  // Debounce: several settings can change in quick succession.
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    await stopAgent();
    await startAgent();
  }, 300);
}

// ---- SSH bridge -------------------------------------------------------------
// SSH tabs live in the GUI process (not the PTY daemon), so the native agent
// can't see them. This webview bridge attaches to each SSH session via the host
// `ssh_attach` command and forwards it to the relay as a SECOND source (the
// relay merges sources; browser input is broadcast and each source handles only
// its own ids). Requires a TEDI build exposing `ssh_list_sessions` /
// `ssh_attach` + `ctx.invokeChannel`; otherwise it no-ops.

let sshWs = null;
let sshAttached = new Set(); // numeric ssh session ids we've attached
let sshPollTimer = null;
let sshReconnectTimer = null;
let sshStop = false;
// Desktop tab numbers (terminalOrdinal) keyed by daemon ptyId, from ctx.app
// context. Mirrored to the browser over the relay so its tabs match the app.
let tabMeta = [];
let tabMetaUnsub = null;

function httpBaseFromRelay(relayUrl) {
  try {
    return new URL(relayUrl.replace(/^ws/, "http")).origin; // ws->http, wss->https
  } catch {
    return "";
  }
}
function b64ToStr(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function sshSend(obj) {
  if (sshWs && sshWs.readyState === 1) {
    try {
      sshWs.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }
}

// Push the desktop tab numbers to the browser (no-op until the relay WS is up).
function sendTabMeta() {
  sshSend({ t: "tabmeta", items: tabMeta });
}

async function startSshBridge(ctx, relayUrl, token) {
  sshStop = false;
  try {
    await ctx.invoke("ssh_list_sessions");
  } catch {
    ctx.logger.info("ssh mirroring unavailable on this TEDI build; skipping");
    return;
  }
  connectSshRelay(ctx, relayUrl, token);
}

function stopSshBridge() {
  sshStop = true;
  if (sshPollTimer) {
    clearInterval(sshPollTimer);
    sshPollTimer = null;
  }
  if (sshReconnectTimer) {
    clearTimeout(sshReconnectTimer);
    sshReconnectTimer = null;
  }
  if (sshWs) {
    try {
      sshWs.close();
    } catch {
      /* ignore */
    }
    sshWs = null;
  }
  sshAttached = new Set();
}

async function connectSshRelay(ctx, relayUrl, token) {
  if (sshStop) return;
  let ticket = null;
  try {
    const r = await fetch(httpBaseFromRelay(relayUrl) + "/api/agent-ticket", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
    });
    if (r.ok) ticket = (await r.json()).ticket;
  } catch {
    /* retry below */
  }
  if (!ticket) {
    sshReconnectTimer = setTimeout(() => connectSshRelay(ctx, relayUrl, token), 5000);
    return;
  }
  const wsUrl = relayUrl + (relayUrl.includes("?") ? "&" : "?") + "ticket=" + encodeURIComponent(ticket);
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    sshReconnectTimer = setTimeout(() => connectSshRelay(ctx, relayUrl, token), 5000);
    return;
  }
  sshWs = ws;
  ws.onopen = () => {
    ctx.logger.info("ssh bridge connected to relay");
    if (sshPollTimer) clearInterval(sshPollTimer);
    sshPollTimer = setInterval(() => pollSsh(ctx), 2000);
    pollSsh(ctx);
    sendTabMeta(); // mirror the current desktop tab numbers to the browser
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleSshRelayFrame(ctx, m);
  };
  ws.onclose = () => {
    if (sshPollTimer) {
      clearInterval(sshPollTimer);
      sshPollTimer = null;
    }
    if (sshStop) return;
    sshReconnectTimer = setTimeout(() => connectSshRelay(ctx, relayUrl, token), 3000);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

async function pollSsh(ctx) {
  let list;
  try {
    list = await ctx.invoke("ssh_list_sessions");
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  const liveIds = new Set(list.map((s) => s.id));
  for (const id of [...sshAttached]) if (!liveIds.has(id)) sshAttached.delete(id);
  for (const s of list) {
    if (!s.alive || sshAttached.has(s.id)) continue;
    sshAttached.add(s.id);
    const rid = "ssh:" + s.id;
    // Announce the tab + reset its terminal before data flows.
    sshSend({ t: "attached", id: rid, scrollback: "", cols: s.cols, rows: s.rows, alive: true });
    try {
      await ctx.invokeChannel("ssh_attach", { id: s.id }, (e) => onSshEvent(rid, e));
    } catch (err) {
      sshAttached.delete(s.id);
      ctx.logger.warn("ssh_attach failed", err);
    }
  }
  sshSend({
    t: "sessions",
    items: list.map((s) => ({
      id: "ssh:" + s.id,
      title: s.user + "@" + s.host,
      cols: s.cols,
      rows: s.rows,
      alive: s.alive,
      kind: "ssh",
    })),
  });
}

function onSshEvent(rid, e) {
  if (!e || !e.type) return;
  if (e.type === "data" || e.type === "stderr") {
    sshSend({ t: "data", id: rid, b64: e.data });
  } else if (e.type === "exit") {
    sshSend({ t: "exit", id: rid, code: e.code | 0 });
  }
  // connected / hostKeyPrompt are handled by the GUI; ignore here.
}

function handleSshRelayFrame(ctx, m) {
  if (!m || typeof m.t !== "string") return;
  if (m.t === "input" && typeof m.id === "string" && m.id.startsWith("ssh:")) {
    const id = parseInt(m.id.slice(4), 10);
    // Only act on sessions THIS bridge actually mirrors. The relay broadcasts
    // every browser frame to all sources, and an attacker-chosen id must never
    // reach `ssh_write` for a session we never attached. Mirrors the native
    // agent's `sessions.contains_key(&id)` ownership gate.
    if (!Number.isNaN(id) && sshAttached.has(id) && m.b64) {
      ctx.invoke("ssh_write", { id, data: b64ToStr(m.b64) }).catch(() => {});
    }
  } else if (m.t === "close" && typeof m.id === "string" && m.id.startsWith("ssh:")) {
    // Close a tab from the browser: end the SSH session. ssh_close tears down the
    // PTY; the pump's exit event reaches the browser and the next pollSsh drops
    // it from the published list. (Daemon "close" for uuid ids is the agent's job.)
    const id = parseInt(m.id.slice(4), 10);
    if (!Number.isNaN(id) && sshAttached.has(id)) {
      ctx.invoke("ssh_close", { id }).catch(() => {});
      sshAttached.delete(id);
      // ssh_close aborts the pump, so its Exit event isn't guaranteed; tell the
      // browser the tab is dead now (the next pollSsh authoritatively drops it).
      sshSend({ t: "exit", id: m.id, code: 0 });
    }
  } else if (m.t === "resize" && typeof m.id === "string" && m.id.startsWith("ssh:")) {
    // Browser "fit host to my screen": resize the SSH PTY so its output matches
    // the browser width. This reflows the same SSH terminal in the desktop app --
    // the intended trade-off for a full-size remote view (mirrors the native
    // agent's daemon resize).
    const id = parseInt(m.id.slice(4), 10);
    const cols = m.cols | 0;
    const rows = m.rows | 0;
    // Same ownership gate as input/close, plus bound the dimensions so a bogus
    // frame can't drive an absurd reflow of the shared desktop terminal.
    if (!Number.isNaN(id) && sshAttached.has(id) && cols > 0 && cols <= 1000 && rows > 0 && rows <= 1000) {
      ctx.invoke("ssh_resize", { id, cols, rows }).catch(() => {});
    }
  } else if (m.t === "client_join") {
    // Re-publish the session list (no re-attach: that would add a duplicate
    // sink). SSH late-joiners get live output, not replayed scrollback.
    pollSsh(ctx);
    sendTabMeta(); // give the new browser the desktop tab numbers
  } else if (m.t === "ping") {
    sshSend({ t: "pong" });
  }
}

export async function activate(ctx) {
  ctxRef = ctx;

  // The extension's own enable/disable toggle is the single on/off: TEDI calls
  // activate() / deactivate() when it is flipped, so there is no separate
  // "enabled" setting. Just (re)start the agent when the relay config changes.
  for (const key of ["agentToken", "relayUrl", "agentName"]) {
    ctx.settings.onChange(key, scheduleRestart);
  }

  // Mirror the desktop tab numbers (terminalOrdinal) to the browser so its tabs
  // match the app. The map arrives via the host app-context bridge and is sent
  // over the relay by the SSH-bridge connection. No-op on older TEDI builds that
  // don't expose ctx.app / the terminals field.
  try {
    if (ctx.app && typeof ctx.app.onContextChange === "function") {
      tabMetaUnsub = ctx.app.onContextChange((c) => {
        tabMeta = c && Array.isArray(c.terminals) ? c.terminals : [];
        sendTabMeta();
      });
    }
  } catch {
    /* ctx.app unavailable on this TEDI build */
  }

  await startAgent();
}

export async function deactivate() {
  if (restartTimer) clearTimeout(restartTimer);
  if (tabMetaUnsub) {
    try {
      tabMetaUnsub();
    } catch {
      /* ignore */
    }
    tabMetaUnsub = null;
  }
  await stopAgent();
}
