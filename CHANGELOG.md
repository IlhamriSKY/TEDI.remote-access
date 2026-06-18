# Changelog

All notable changes to the TEDI Remote Access extension are documented here.

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
