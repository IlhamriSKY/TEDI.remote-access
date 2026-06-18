# SSH tab mirroring

Local terminals mirror with no host changes: the native agent attaches to the
PTY daemon (a multi-subscriber broker). **SSH tabs are different** — TEDI's
`ssh/` module keeps each russh session in the GUI process with a single event
channel, so neither the agent nor the daemon can see them. Mirroring SSH needs a
small TEDI-core capability to tee an SSH session to a second consumer, plus a
host API for an extension to receive a streaming `Channel`.

## What the extension does (this repo, v0.2.0)

`extension.js` runs an **SSH bridge** in the webview:

1. `ctx.invoke("ssh_list_sessions")` to enumerate open SSH tabs (no-ops if the
   command is absent — older TEDI builds simply mirror local terminals only).
2. For each session, `ctx.invokeChannel("ssh_attach", { id }, onEvent)` to
   receive its output (replayed ring + live).
3. Forwards each session to the relay as a **second source** (`kind: "ssh"`,
   id `ssh:<n>`), authenticating the header-less webview WebSocket with a
   short-lived ticket (`POST /api/agent-ticket`).
4. Browser input for an `ssh:*` id routes back through `ctx.invoke("ssh_write")`
   / `ssh_resize`.

The relay merges PTY + SSH sources and broadcasts browser input to all sources;
each handles only ids it owns (so there is no PTY regression).

## What TEDI core must expose (apply + ship in the main TEDI repo)

These changes live in the **TEDI app**, not this extension. They are already
written in the working tree; build + release a TEDI that includes them (e.g.
`0.3.43`), then install it — this extension v0.2.0 mirrors SSH automatically.

| File | Change |
| --- | --- |
| `src-tauri/src/modules/ssh/session.rs` | `SshSession` gains mirror sinks + a replay ring + live dims; the read pump fans `Data`/`Exit` to every sink and appends to the ring. `add_mirror_sink()` (replays the ring, returns alive) + `mirror_info()`. |
| `src-tauri/src/modules/ssh/mod.rs` | `ssh_list_sessions` -> `Vec<SshSessionInfo>` and `ssh_attach(id, on_event)` commands. |
| `src-tauri/src/lib.rs` | Register `ssh::ssh_list_sessions`, `ssh::ssh_attach`. |
| `src/modules/extensions/host.ts` | `ctx.invokeChannel(command, args, onEvent)` — lets a permission-gated extension invoke a command that streams through a Tauri `Channel`. |

The extension declares `invoke:ssh_list_sessions`, `invoke:ssh_attach`,
`invoke:ssh_write`, `invoke:ssh_resize`. All are install-time consented and
marked HIGH-risk in the review dialog.

## Limitations (v0.2.0)

- SSH late-joiners get live output, not replayed scrollback (the ring replays
  once per attach; re-attaching would duplicate the sink).
- The webview bridge is subject to browser background-throttling when the TEDI
  window is minimized (the native PTY agent is not). Acceptable for SSH, which
  is less frequent than local terminals.
- No `ssh_detach` yet: a bridge restart leaves the old sink attached until the
  SSH session closes (it sends to a closed socket, harmless).
