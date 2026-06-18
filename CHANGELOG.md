# Changelog

All notable changes to the TEDI Remote Access extension are documented here.

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
