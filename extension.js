// tedi.remote-access — spawns the native agent (sidecar) that mirrors every
// live PTY daemon session to your self-hosted relay over an outbound WSS, so a
// browser anywhere can attach to the terminals you have open in TEDI.
//
// The heavy lifting (daemon attach, multiplexing, reconnect) lives in the Rust
// agent under sidecar/<platform>/. This module only: reads config from the
// extension settings, spawns the agent, reads its READY handshake, and exposes
// a status-bar indicator + a Ctrl+Alt+R toggle.

const DEFAULT_RELAY = "wss://remote.ilhamriski.com/agent";

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
  const relayUrl = (await ctx.settings.get("relayUrl")) || DEFAULT_RELAY;
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
