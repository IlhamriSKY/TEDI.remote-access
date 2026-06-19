# Changelog

All notable changes to the TEDI Remote Access extension are documented here.

## [0.8.1] - 2026-06-19

- **New Settings dialog (gear in the header).** Pick the terminal font, text size,
  line spacing, fit-to-window, and theme in one place. Choices persist and apply
  live. Text size and fit moved out of the account menu into Settings.
- **Tabs are now clearly separate from the terminal.** The tab strip uses a
  distinct background from the terminal area (in light mode they were both white
  before, so you couldn't tell them apart). The active tab gets a top accent bar
  and the terminal background so it reads as selected.
- **Header polish.** Status dot with a soft ring, a settings gear, and a tidier
  account menu.

## [0.8.0] - 2026-06-19

- **Status-bar icon lights up when someone is watching.** The relay now tells the
  agent how many browsers are connected; the TEDI status-bar globe turns green
  (and the tooltip shows the count) while a browser is attached, and goes neutral
  when idle. The tooltip always names your relay domain and whether it is online.
- **Closing a tab from the browser now asks first.** A confirmation dialog spells
  out that closing ends the process and closes the tab in the desktop app too, so
  you don't kill a terminal by a stray tap.
- **The browser stays full-screen no matter how small the desktop pane is.** The
  view fills nearly the whole window (decoupled from the host pane's size) and
  re-fits on window resize / phone rotation, without ever resizing the shared host
  PTY.
- **Consistent, tidier dialogs.** All modals (change-password, confirmations) now
  share one shell: same header, close button, footer, border, and animation. Plus
  small UI polish on the tabs and the connection indicator.
- **Fixed: closing an SSH tab from the browser.** The extension calls `ssh_close`,
  but the manifest never requested it (it requested the unused `ssh_resize`
  instead), so closing an SSH tab could be denied. Permissions now match the code.
- **Version numbers realigned.** The relay package, the Rust agent crate, and the
  extension manifest now all report the same version.

## [0.7.5] - 2026-06-19

- **SSH tabs show in the browser again.** The webview SSH bridge fetches its relay
  ticket cross-origin, which needs a CORS preflight the relay never answered, so
  the SSH source could not connect. The relay now allows that preflight on the
  ticket endpoint only, so your open SSH tabs mirror to the browser.
- **New terminals opened in the desktop app now appear in the browser.** The relay
  could skip re-publishing the session list when a source connected or dropped; it
  now always re-publishes on a source change, so a terminal you open in TEDI shows
  up in the web within a couple of seconds.
- **Close terminals from the browser.** Each tab now has a close (x) button that
  ends the session (local or SSH); it closes in the desktop app too. (Closing a
  tab in the app already removed it from the web.)
- **Tidier layout.** Added a left and right gutter so the terminal and header are
  not jammed against the window edges.

## [0.7.4] - 2026-06-19

- **"Fit to window" no longer disturbs your desktop terminal.** Before, fitting
  the browser view resized the shared host PTY, which reflowed the matching
  terminal inside the TEDI desktop app (and any SSH tab it mirrored). Now the
  browser always mirrors each terminal at the host's real size and "fit to
  window" just scales the view with a CSS transform, so the website fills the
  screen while the desktop stays tidy. The agent and SSH bridge also ignore
  browser resize requests now, so nothing on the website can reflow the desktop.

## [0.7.3] - 2026-06-19

- **Change your password from the browser.** The account menu now has a "Change
  password" item that opens a small dialog (current password, new password,
  confirm). The relay verifies the current password, requires the new one to be
  at least 8 characters, and writes the new hash next to `server.js` so it
  survives restarts. The systemd unit now grants `ReadWritePaths` for that one
  file; rerun `server/install.sh` (or add the line manually) so the write
  succeeds under the sandbox.
- **Tab accent matches the desktop app.** The active tab's accent line now sits
  just left of the tab icon (a short, vertically centred stripe) instead of
  running down the edge, so the website and TEDI read the same. SSH tabs keep
  their sky accent.
- **Status-bar icon renders again.** The Remote Access globe in TEDI's status bar
  showed as an empty square; it now draws as a proper HugeIcon. This needs the
  host fix shipped in TEDI 0.3.46, so the extension now requires `tedi >=0.3.46`.
- Responsive and layout tidy-ups across the header, tab strip, and the new modal.

## [0.7.2] - 2026-06-19

- **One-command relay setup.** `server/install.sh` automates the whole VPS setup
  (secrets, `.env`, website build, systemd service, nginx vhost) and prints the
  agent token to paste into the extension. See the README "Self-host" section.
- **Relay hardening (from the security audit):** `SESSION_SECRET` is now required
  (a random per-restart default logged everyone out); the login rate-limit keys
  on nginx's `X-Real-IP` instead of the spoofable `X-Forwarded-For`; browser and
  agent connection caps stop the scrollback-replay amplification; login evaluates
  all factors before combining (no username timing oracle); TOTP codes can't be
  replayed; the SPA is served with a CSP + security headers; large frames skip
  JSON parsing; rate-limit / ticket maps are pruned on the heartbeat; HTTP
  slow-loris timeouts are set; the systemd unit is sandboxed.

## [0.7.1] - 2026-06-19

- **Repo structure now matches the other TEDI extensions.** The extension source
  moved to `src/index.js` and is bundled into `extension.js` by `build.mjs`
  (esbuild); `extension.js` is no longer committed (it is generated and built
  into the release `.zip` by CI). No runtime change.

## [0.7.0] - 2026-06-19

- **Hugeicon status-bar item.** The status bar now uses a host Hugeicon (globe)
  instead of the bundled PNG, matching the other extensions.
- **Security hardening (from a full audit of the agent + extension):**
  - The Relay setting is forced to `wss://`: a plaintext `ws://` / `http://`
    value is upgraded, so the agent token and the terminal stream are never sent
    unencrypted.
  - The agent only writes input/resize to sessions it actually mirrors (the relay
    broadcasts browser input to every source, so foreign ids are now ignored).
  - The daemon frame reader caps frame size, so a bad 4-byte length prefix can no
    longer trigger a multi-GiB allocation.
  - The agent is supervised: if it exits (for example when the PTY daemon
    restarts) it reconnects instead of silently going offline.
  - The host label is trimmed and length-capped.

## [0.6.3] - 2026-06-19

- **One enable/disable.** Removed the separate "Enable remote access" setting and
  the Ctrl+Alt+R toggle command. The extension's own enable toggle (on its card
  in Settings) is now the single on/off: TEDI starts the agent on enable and
  stops it on disable. Settings collapse to just Relay, Agent token, Host label.
- Dropped the now-unused `settings:write` and `secrets:write` permissions.

## [0.6.2] - 2026-06-19

- Shorten the Relay setting description to just the domain example.

## [0.6.1] - 2026-06-19

- **Relay setting accepts a bare domain.** You can now enter just
  `remote.example.com`; the `wss://` scheme and `/agent` path are filled in
  automatically (a full `wss://host/agent` URL still works).

## [0.6.0] - 2026-06-19

- **Fit terminal to the browser.** A new "Fit to window" mode (on by default, in
  the account menu) sizes the active terminal to your browser and resizes the
  host PTY to match, so a terminal that is split tiny across several panes on the
  desktop still fills the screen here. The desktop GUI keeps its own viewport and
  does not fight back while its window is idle; turn the mode off for exact
  host-size mirroring. Requires this version's agent, so reinstall the extension
  to update it.
- **Reset text size.** Click the size value between A- and A+ in the account menu
  to reset the font to the default.

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
