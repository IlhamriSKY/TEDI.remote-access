# Changelog

All notable changes to the TEDI Remote Access extension are documented here.

## [0.5.0] - 2026-06-19

- **New terminal from the browser.** A "+" in the tab strip opens a fresh
  terminal on the host: the agent asks TEDI's PTY daemon to spawn one and it
  streams in as a new tab (sized to your current view, then auto-focused).
  Requires this version's agent, so reinstall the extension to update it.
- **Tab style matches the TEDI app.** The active tab now shows a left accent
  stripe (colored per kind: terminal or ssh) instead of a top stripe, so the
  browser and the desktop app look consistent.

## [0.4.0] - 2026-06-19

- **All three OSes TEDI supports.** The agent now builds and ships for Windows
  (x64), macOS (x64 + arm64), and Linux (x64). It connects to TEDI's daemon the
  same way TEDI binds it on each OS: a kernel-namespaced pipe on Windows, a
  filesystem socket (`$XDG_RUNTIME_DIR/tedi-ptyd.sock`, else
  `$TMPDIR/tedi-ptyd-<USER>.sock`) on macOS/Linux. The agent uses the OS-native
  TLS stack (SChannel / Secure Transport / OpenSSL); Linux statically vendors
  OpenSSL so the binary needs no system `libssl`.
- **Website ships as source, not a build.** The release bundle now carries the
  browser UI source (`client/`) and the relay (`server/`); you build the UI on
  deploy. CI verifies the website still compiles but no longer ships a pre-built
  `public/`.
- **Docs consolidated into the README.** Removed the `docs/` folder and the
  separate `server/README.md`; everything (setup, build-from-source, SSH,
  security) now lives in one clear README.

## [0.3.1] - 2026-06-19

- **Fix install from GitHub.** The release shipped two `.zip` assets and TEDI's
  installer picks the first `.zip`, so it could grab the relay bundle (no
  manifest at root) and fail. The relay bundle now ships as `.tar.gz`, leaving
  the extension `.zip` as the only zip.
- **No default relay.** The hardcoded default relay URL was removed; each user
  must set their own relay in Settings, so a fresh install never connects to
  anyone else's host. The deploy nginx templates are genericized too.
- Relay: prune + cap the one-time WS ticket store.

## [0.3.0] - 2026-06-19

- **Browser UI refresh.** Light + dark themes (system-aware, persisted, no
  flash of the wrong palette) with a one-click toggle that re-themes every live
  terminal. A minimal header shows the signed-in user (avatar + name) with a
  dropdown for text size and sign-out.
- **CLI-running indicator.** Each tab's icon shows whether a command is running
  in that terminal (amber + gentle breathe, driven by OSC 133 shell-integration
  command markers) and goes idle otherwise.
- Responsive polish across login, header, tab bar, terminal, and the mobile
  helper-key bar; all components adapt to both themes.

## [0.2.0] - 2026-06-19

- **SSH tab mirroring.** SSH tabs you open in TEDI now mirror to the browser
  (sky stripe + `ssh` badge). Because SSH sessions live in the GUI process (not
  the PTY daemon), a webview bridge attaches to each via the host `ssh_attach`
  command and forwards it to the relay as a SECOND source; input routes back
  through `ssh_write` / `ssh_resize`.
- **Relay multi-source.** The relay now accepts multiple agent sources (native
  PTY agent + SSH bridge), merges their session lists, and broadcasts browser
  input to all sources (each ignores ids it doesn't own — no PTY regression).
  Header-less WS sources authenticate with a short-lived ticket
  (`POST /api/agent-ticket`).
- Requires a TEDI build exposing `ssh_list_sessions` / `ssh_attach` +
  `ctx.invokeChannel` (a TEDI core change). On older builds the SSH bridge
  transparently no-ops and only local terminals mirror.

## [0.1.0] - 2026-06-18

- Initial release.
- **Mirror your open terminals to a browser anywhere.** The native agent attaches
  to TEDI's PTY daemon as a second subscriber (replayed scrollback + live
  output), forwards over an outbound WSS to a self-hosted relay, and a browser
  SPA renders the sessions with xterm.js. Typing drives the same PTY, so input
  shows on the desktop too.
- **Browser client** — React + Tailwind v4 + shadcn using TEDI's design tokens
  (1px borders, no radius, Hugeicons, matching tooltips), clear terminal tab
  navigation, a mobile helper-key bar (Esc / Tab / Ctrl / arrows / symbols),
  responsive layout, login (password + optional TOTP), font controls, and
  auto-reconnect with scrollback replay.
- **Relay** — a small Node `ws` broker that authenticates the host agent
  (bearer token) and browser clients (login cookie), pipes opaque frames, and is
  fronted by nginx for TLS. Rate-limited login with lockout, gzip, immutable
  asset caching, SPA fallback, graceful shutdown.
- **SSH-tab groundwork** — the browser already renders SSH tabs distinctly (sky
  stripe + `ssh` badge). Live SSH mirroring needs a TEDI build that exposes the
  `ssh_attach` host command (TEDI's SSH sessions live in the GUI process, not the
  PTY daemon); until then the extension mirrors local terminals only. Tracked for
  a follow-up release.
- Status-bar connection indicator; toggle with **Ctrl+Alt+R**.
