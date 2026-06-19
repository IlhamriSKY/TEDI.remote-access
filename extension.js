// tedi.remote-access — spawns the native agent (sidecar) that mirrors every
// live PTY daemon session to your self-hosted relay over an outbound WSS, so a
// browser anywhere can attach to the terminals you have open in TEDI.
//
// The heavy lifting (daemon attach, multiplexing, reconnect) lives in the Rust
// agent under sidecar/<platform>/. This module only: reads config from the
// extension settings, spawns the agent, reads its READY handshake, and exposes
// a status-bar indicator + a Ctrl+Alt+R toggle.

// No default relay: every user must point this at THEIR own relay in Settings.
// Hardcoding a default would make all installs phone home to one host.
const DEFAULT_RELAY = "";

// Accept a bare domain (e.g. "remote.example.com") OR a full endpoint and
// produce the canonical agent WebSocket URL "wss://host/agent". So the user can
// type just the domain: the wss:// scheme and the /agent path are filled in.
function normalizeRelayUrl(input) {
  let s = (input || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) s = s.replace(/^http/i, "ws"); // http(s):// -> ws(s)://
  else if (!/^wss?:\/\//i.test(s)) s = "wss://" + s; // no scheme -> default wss://
  s = s.replace(/\/+$/, ""); // drop trailing slashes
  if (!/\/agent$/i.test(s)) s += "/agent"; // ensure the /agent endpoint
  return s;
}

let ctxRef = null;
let handle = null;
let booting = false;

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
    ctxRef.statusBar.setItem({ id: "remote", icon: "ext-asset:icon.png", tooltip, tone });
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

  const enabled = await ctx.settings.get("enabled");
  if (!enabled) {
    setStatus("default", "Remote Access: off");
    return;
  }

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
  const agentName = (await ctx.settings.get("agentName")) || "TEDI host";

  booting = true;
  setStatus("default", "Remote Access: connecting...");
  try {
    const config = JSON.stringify({ relay_url: relayUrl, agent_token: token, agent_name: agentName });
    handle = await ctx.invoke("shell_bg_spawn_direct", { program, args: [config] });
    await readReady(ctx, handle);
    setStatus("success", "Remote Access: online (" + agentName + ")");
    ctx.ui.toast("Remote Access: agent online", { variant: "success" });
    ctx.logger.info("agent online, handle", handle);
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
  stopSshBridge();
  if (ctx && handle != null) {
    await ctx.invoke("shell_bg_kill", { handle }).catch(() => {});
    handle = null;
  }
  setStatus("default", "Remote Access: off");
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
    if (!Number.isNaN(id) && m.b64) {
      ctx.invoke("ssh_write", { id, data: b64ToStr(m.b64) }).catch(() => {});
    }
  } else if (m.t === "resize" && typeof m.id === "string" && m.id.startsWith("ssh:")) {
    const id = parseInt(m.id.slice(4), 10);
    if (!Number.isNaN(id)) {
      ctx.invoke("ssh_resize", { id, cols: m.cols | 0, rows: m.rows | 0 }).catch(() => {});
    }
  } else if (m.t === "client_join") {
    // Re-publish the session list (no re-attach: that would add a duplicate
    // sink). SSH late-joiners get live output, not replayed scrollback.
    pollSsh(ctx);
  } else if (m.t === "ping") {
    sshSend({ t: "pong" });
  }
}

export async function activate(ctx) {
  ctxRef = ctx;

  ctx.registerCommandHandler("tedi.remote-access.toggle", async () => {
    const enabled = await ctx.settings.get("enabled");
    await ctx.settings.set("enabled", !enabled);
    // settings.onChange below picks this up and (re)starts/stops the agent.
  });

  for (const key of ["enabled", "agentToken", "relayUrl", "agentName"]) {
    ctx.settings.onChange(key, scheduleRestart);
  }

  setStatus("default", "Remote Access: off");
  await startAgent();
}

export async function deactivate() {
  if (restartTimer) clearTimeout(restartTimer);
  await stopAgent();
}
