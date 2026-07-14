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
    ctxRef.statusBar.setItem({ id: "remote", icon: "lucide:Globe", tooltip, tone });
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

// Reap any orphaned agent left running from a PREVIOUS extension load. On a
// webview reload the JS state (including our `handle`) is reset, but the native
// agent the core spawned keeps running: its Windows Job object only closes when
// TEDI itself exits, not on a reload. A leftover agent stays attached to the
// relay and mirrors every session a SECOND time, so a key typed in the browser
// is written to the PTY twice and the shell echoes it doubled ("c" -> "cc", and
// "ccc" after a third). The core keeps a background-process registry across
// reloads, so list it and kill anything that is our agent before spawning a
// fresh one, guaranteeing exactly one writer per session.
async function reapOrphanAgents(ctx) {
  let procs;
  try {
    procs = await ctx.invoke("shell_bg_list");
  } catch {
    return; // shell_bg_list not granted on this build -> best-effort
  }
  if (!Array.isArray(procs)) return;
  const killed = [];
  for (const p of procs) {
    if (
      p &&
      !p.exited &&
      typeof p.command === "string" &&
      p.command.includes("tedi-remote-agent")
    ) {
      await ctx.invoke("shell_bg_kill", { handle: p.handle }).catch(() => {});
      killed.push(p.handle);
      try {
        ctx.logger.info("reaped orphaned remote-access agent (handle " + p.handle + ")");
      } catch {
        /* logger optional */
      }
    }
  }
  // Wait (bounded) for the killed agents to actually exit before the caller
  // spawns a fresh one. shell_bg_kill only requests the kill; if we spawn while
  // an orphan is still alive, BOTH attach to the relay and every keystroke is
  // written to the PTY twice ('c' -> 'cc'). Poll until they're gone (or ~2s).
  const deadline = Date.now() + 2000;
  while (killed.length && Date.now() < deadline) {
    let list;
    try {
      list = await ctx.invoke("shell_bg_list");
    } catch {
      break;
    }
    if (!Array.isArray(list)) break;
    const alive = new Set(list.filter((p) => p && !p.exited).map((p) => p.handle));
    if (!killed.some((h) => alive.has(h))) break; // every reaped agent has exited
    await sleep(120);
  }
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
      throw new Error(
        "agent exited before READY (exit " + (resp.exit_code != null ? resp.exit_code : "?") + ")",
      );
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
    ctx.ui.toast("Remote Access: set the agent token in Settings -> Extensions", {
      variant: "warning",
    });
    return;
  }
  const relayUrl = normalizeRelayUrl((await ctx.settings.get("relayUrl")) || DEFAULT_RELAY);
  if (!relayUrl) {
    setStatus("warning", "Remote Access: set the relay URL in Settings");
    ctx.ui.toast("Remote Access: set your relay URL in Settings -> Extensions", {
      variant: "warning",
    });
    return;
  }
  let agentName = String((await ctx.settings.get("agentName")) || "")
    .trim()
    .slice(0, 64);
  if (!agentName) agentName = "TEDI host";

  booting = true;
  setStatus("default", "Remote Access: connecting...");
  try {
    const config = JSON.stringify({
      relay_url: relayUrl,
      agent_token: token,
      agent_name: agentName,
    });
    // Kill any agent left over from a previous load so we never double-write.
    await reapOrphanAgents(ctx);
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
      ctx.logger.info(
        "agent exited (code " + (resp.exit_code != null ? resp.exit_code : "?") + "); reconnecting",
      );
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
let sshChannels = new Map(); // ssh session id -> ssh_attach channel disposer
let sshPollTimer = null;
let sshReconnectTimer = null;
let sshStop = false;
// Desktop tab numbers (terminalOrdinal) keyed by daemon ptyId, from ctx.app
// context. Mirrored to the browser over the relay so its tabs match the app.
let tabMeta = [];
let tabMetaUnsub = null;
// Last serialized tabMeta actually broadcast on a context change, so a context
// tick that leaves the terminals array byte-identical (e.g. a cwd/active-file
// change elsewhere) doesn't re-broadcast and force every browser to re-render.
let lastTabMetaStr = "";

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

// Ask the host to switch the active desktop workspace so a terminal/SSH opened
// next is adopted into it. No-op without a wsId or on a TEDI core that predates
// ctx.app.setActiveWorkspace. Always resolves (never rejects).
function maybeSwitchWorkspace(ctx, wsId) {
  if (wsId && ctx.app && typeof ctx.app.setActiveWorkspace === "function") {
    return Promise.resolve(ctx.app.setActiveWorkspace(wsId)).catch(() => {});
  }
  return Promise.resolve();
}

// Push the desktop tab numbers to the browser (no-op until the relay WS is up).
function sendTabMeta() {
  sshSend({ t: "tabmeta", items: tabMeta });
}

// Push the list of saved SSH connections the browser may open. SECRET-FREE
// metadata only (id/name/host/user/pinned); the host already filters to PINNED
// hosts (a first connect needs desktop host-key verification). No-op on an older
// TEDI core that predates ctx.ssh.
async function sendSshConns(ctx) {
  if (!ctx.ssh || typeof ctx.ssh.listConnections !== "function") return;
  try {
    const items = await ctx.ssh.listConnections();
    sshSend({ t: "ssh-conns", items: Array.isArray(items) ? items : [] });
  } catch (e) {
    ctx.logger.warn("ssh listConnections failed", e);
  }
}

async function startSshBridge(ctx, relayUrl, token) {
  sshStop = false;
  // Connect REGARDLESS of SSH availability: this bridge is also the sole
  // transport for tabmeta (workspace grouping + tab ordinals + AI-CLI status),
  // which the native agent never carries. pollSsh and sendSshConns already no-op
  // when SSH is absent, so on an SSH-less core the bridge simply carries tabmeta
  // with no SSH sessions — the browser still gets correct workspace grouping for
  // pure-local terminals instead of collapsing to a flat, header-less list.
  try {
    await ctx.invoke("ssh_list_sessions");
  } catch {
    ctx.logger.info("ssh mirroring unavailable on this TEDI build; bridge carries tabmeta only");
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
      // Detach handlers before closing so this socket's async onclose can never
      // re-enter the reconnect path after a restart flips sshStop back to false.
      sshWs.onclose = null;
      sshWs.onerror = null;
      sshWs.close();
    } catch {
      /* ignore */
    }
    sshWs = null;
  }
  // Tear down every ssh_attach channel so a restart can't stack a second data
  // sink per session (which would double every SSH byte to the browser).
  for (const dispose of sshChannels.values()) {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  }
  sshChannels.clear();
  sshAttached = new Set();
}

// Tear down the ssh_attach channel for one session (session gone or closed).
function disposeSshChannel(id) {
  const dispose = sshChannels.get(id);
  if (dispose) {
    try {
      dispose();
    } catch {
      /* ignore */
    }
    sshChannels.delete(id);
  }
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
  const wsUrl =
    relayUrl + (relayUrl.includes("?") ? "&" : "?") + "ticket=" + encodeURIComponent(ticket);
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
    sendSshConns(ctx); // give the browser the saved SSH hosts it may open
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
    // Only the CURRENT socket may schedule a reconnect. `sshStop` is a shared
    // boolean that a restart flips back to false before this async onclose fires,
    // so without the identity guard a stale socket's onclose would spawn a SECOND
    // concurrent bridge on top of the fresh one; those pile up per restart and
    // saturate the webview thread until TEDI's own UI hangs.
    if (sshStop || ws !== sshWs) return;
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
  for (const id of [...sshAttached])
    if (!liveIds.has(id)) {
      sshAttached.delete(id);
      disposeSshChannel(id);
    }
  for (const s of list) {
    if (!s.alive || sshAttached.has(s.id)) continue;
    sshAttached.add(s.id);
    const rid = "ssh:" + s.id;
    // Announce the tab + reset its terminal before data flows.
    sshSend({ t: "attached", id: rid, scrollback: "", cols: s.cols, rows: s.rows, alive: true });
    try {
      // Keep the channel disposer so we can detach this exact sink on
      // session-gone / close / bridge restart (else restarts stack duplicate
      // sinks that double every SSH byte to the browser).
      const dispose = await ctx.invokeChannel("ssh_attach", { id: s.id }, (e) => onSshEvent(rid, e));
      if (typeof dispose === "function") sshChannels.set(s.id, dispose);
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
      // Real start time so the client's reconcileOrder sorts SSH newcomers by
      // creation like local PTYs do (else they all sort as 0 and jump ahead of
      // local tabs on first load). Optional field; undefined on older cores.
      createdAt: s.createdAtMs,
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
  // Workspace targeting. The browser can ask the desktop to switch to (or create)
  // a workspace so a terminal/SSH it opens next is adopted there. The native agent
  // does the actual terminal spawn on {t:"open"}; here we only move/create the
  // workspace. No-ops on a core without the ctx.app workspace API.
  if (m.t === "open") {
    maybeSwitchWorkspace(ctx, m.wsId);
    return;
  }
  if (m.t === "ws-create") {
    if (ctx.app && typeof ctx.app.createWorkspace === "function") {
      ctx.app.createWorkspace(typeof m.name === "string" ? m.name : "").catch(() => {});
    }
    return;
  }
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
    // Close a tab from the browser. Prefer closing the real DESKTOP tab via
    // ctx.ssh.closeConnection (TEDI >= 0.3.54): that tears down the SSH session
    // AND removes the tab on the desktop, so closing on the web closes both
    // sides. Fall back to ssh_close (session only) on an older core.
    const id = parseInt(m.id.slice(4), 10);
    if (!Number.isNaN(id) && sshAttached.has(id)) {
      let closedTab = false;
      if (ctx.ssh && typeof ctx.ssh.closeConnection === "function") {
        try {
          closedTab = ctx.ssh.closeConnection(id);
        } catch {
          closedTab = false;
        }
      }
      if (!closedTab) ctx.invoke("ssh_close", { id }).catch(() => {});
      sshAttached.delete(id);
      disposeSshChannel(id);
      // Tell the browser the tab is dead now (the next pollSsh authoritatively
      // drops it from the published list).
      sshSend({ t: "exit", id: m.id, code: 0 });
    }
  } else if (m.t === "resize" && typeof m.id === "string" && m.id.startsWith("ssh:")) {
    // "Fit host to my screen": resize the SSH PTY to the browser so its output
    // fills the remote view at normal text. This reflows the same SSH terminal in
    // the desktop app -- the deliberate trade-off of fit-host mode (mirrors the
    // native agent's daemon resize). Gated to sessions we mirror, dims bounded.
    const id = parseInt(m.id.slice(4), 10);
    const cols = m.cols | 0;
    const rows = m.rows | 0;
    if (
      !Number.isNaN(id) &&
      sshAttached.has(id) &&
      cols > 0 &&
      cols <= 1000 &&
      rows > 0 &&
      rows <= 1000
    ) {
      ctx.invoke("ssh_resize", { id, cols, rows }).catch(() => {});
    }
  } else if (m.t === "client_join") {
    // Re-publish the session list (no re-attach: that would add a duplicate
    // sink). SSH late-joiners get live output, not replayed scrollback.
    pollSsh(ctx);
    sendTabMeta(); // give the new browser the desktop tab numbers
    sendSshConns(ctx); // and the saved SSH hosts it may open
  } else if (m.t === "open-ssh") {
    // Open a SAVED SSH connection from the browser. The relay only forwards this
    // AFTER verifying the user's LOGIN password (POST /api/open-ssh) and drops
    // any browser-sent open-ssh, so reaching here means the action was
    // re-authenticated. We open the connection BY ID via the host; the SSH
    // password / key are read host-side from the keychain and never seen here.
    const id = typeof m.connectionId === "string" ? m.connectionId : "";
    if (id && ctx.ssh && typeof ctx.ssh.openConnection === "function") {
      // Switch to the requested workspace FIRST (if any) so the SSH tab opens
      // there, then open it. The relay forwards m.wsId from POST /api/open-ssh.
      maybeSwitchWorkspace(ctx, m.wsId).then(() => {
        ctx.ssh
          .openConnection(id)
          .then((r) => {
            if (!r || !r.ok) {
              ctx.logger.warn("open-ssh refused", r && r.error);
              ctx.ui.toast("Remote SSH: " + ((r && r.error) || "could not open"), {
                variant: "error",
              });
            }
            // On success the new SSH tab streams in via the next pollSsh.
          })
          .catch((e) => ctx.logger.warn("open-ssh error", e));
      });
    }
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
        const s = JSON.stringify(tabMeta);
        if (s === lastTabMetaStr) return; // terminals unchanged: skip the broadcast
        lastTabMetaStr = s;
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
