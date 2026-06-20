# Changelog

All notable changes to the TEDI Remote Access extension are documented here.

## [0.8.6] - 2026-06-20

Terminal sizing is now fully isolated between the web and the desktop app, in
both directions.

- **Resizing the web view never reflows your desktop terminal.** The browser is
  now a pure mirror: it always renders each terminal at the host PTY's real
  cols/rows and only scales its OWN view with CSS, so it never resizes the shared
  PTY. The old default ("fit host to my screen") used to resize the host PTY,
  which reflowed the matching terminal in the desktop app; that no longer happens.
- **Belt-and-suspenders on the host side.** The native agent and the SSH bridge
  now ignore every browser-initiated resize, so even a stale/cached old web client
  can't reflow your desktop terminal.
- **Resizing the desktop app no longer disturbs the web.** When you resize a pane
  on the PC, the agent picks up the new size and the web mirrors it and re-scales
  to fill, so the browser view stays full and stable (the content just reflows to
  the host's new size, as a mirror should).
- The "Fit to window" toggle now means: ON (default) = CSS-scale the mirror to
  fill the browser; OFF = show it at the host's natural 1:1 size (the pane
  scrolls if it's bigger than the view). Neither setting ever touches the host.

## [0.8.5] - 2026-06-20

Security-hardening pass (pre-production audit; 3 adversarial reviews of the
relay, agent, and web client). Treat the relay login as shell-equivalent: use a
strong password and, ideally, enable TOTP. Apply the relay fixes by redeploying
the relay bundle to your VPS.

- **SSH bridge now enforces session ownership.** Browser `input`/`close`/`resize`
  frames for SSH tabs were dispatched to `ssh_write`/`ssh_close`/`ssh_resize` by
  id WITHOUT checking the id was actually mirrored, so a hostile relay could drive
  keystrokes into SSH sessions the bridge never attached. The bridge now gates on
  `sshAttached` (matching the native agent's ownership check).
- **Agent validates untrusted PTY dimensions.** A browser `cols`/`rows` was cast
  `as u16`, which silently wraps (65536 -> 0); a 0-width PTY wedges the shell and
  reflows the desktop terminal. Dimensions are now clamped (reject 0 / > 1000) on
  both resize and open.
- **Agent rejects UNC working directories.** A browser-supplied `cwd` like
  `\\\\attacker\\share` would open a shell at a UNC path, triggering an outbound
  SMB auth that leaks Windows NTLM credentials. UNC cwds are now dropped.
- **Hard session cap.** The browser-open cap now counts in-flight opens (not just
  already-mirrored sessions), so a burst can't outrun the 2s discovery poll and
  exceed the limit. The agent also fails closed unless the relay URL is `wss://`.
- **Relay: optional Origin enforcement.** Set `ALLOWED_ORIGIN` (install.sh now
  does) to reject browser WebSocket handshakes whose Origin isn't the relay,
  defense-in-depth against cross-site WS hijacking on top of the SameSite=Strict
  cookie.
- **Relay: TOTP no longer blocks concurrent logins.** Replay protection tracked a
  single high-water counter that rejected the current code on a second device in
  the same window; it now tracks consumed counters with expiry.
- **Relay: boot warning** when `TRUST_PROXY` is unset behind a localhost bind (the
  login limiter would otherwise bucket every client as 127.0.0.1).

## [0.8.4] - 2026-06-20

- **Browser-opened tabs reliably appear in the desktop app and show the
  desktop's tab number.** Now requires TEDI v0.3.52, which re-enables the desktop
  adoption of daemon sessions created from the browser "+" and republishes each
  terminal's real tab number. The agent already forwarded these over the relay;
  this pairs the extension with the matching host fix (both were withdrawn in
  TEDI 0.3.49 on a misdiagnosis, restored after the real launch-hang cause, sync
  git on the UI thread, was fixed in 0.3.50).
- **Safety: the agent caps browser-initiated terminal creation.** A browser can
  no longer spawn unbounded shells via "+": at most 24 mirrored sessions, and at
  most one new terminal per 300 ms across all connected browsers.
- **Mobile: safe-area insets.** The web UI pads itself off the notch and the home
  indicator (viewport-fit=cover) so the header, tab bar, and on-screen key row
  are never clipped on phones with rounded corners or a home bar.
- Docs: corrected the protocol note that wrongly claimed "resize is never sent"
  (it is sent in fit-host mode for the active terminal).

## [0.8.3] - 2026-06-19

- **Web terminals stay full-size even when the app pane is tiny.** New "Fit host
  to my screen" (on by default): the browser measures its viewport and resizes
  the host terminal to fill it, so a terminal is big in the browser even when
  it's a small split pane on the desktop. Turn it off to mirror the desktop's
  size and scale instead (the old behavior, never touches the app).
- **Tabs match the desktop app.** Each tab shows the app's real tab number
  (`terminalOrdinal`, pushed from the host) instead of its position; the icon
  matches the tab type (computer-terminal for local, cloud for SSH); the layout
  is icon -> number -> title.
- **Simpler header + dialogs.** Dropped the duplicate "Settings" entry from the
  account menu (the gear already opens it) and the light/dark control from
  Settings (still on the header). Modal buttons are now full-width.
- (Requires TEDI app >= 0.3.48 for the exact tab numbering; older apps fall back
  to position numbers.)

## [0.8.2] - 2026-06-19

- **Numbered, reorderable tabs.** Each browser tab now shows its position number
  (matching the desktop app's left-to-right order) and can be dragged to reorder.
  The agent now reports terminals in stable creation order (oldest first) instead
  of an arbitrary order, so the numbering is consistent.
- **Connection light is now an actual circle.** The pulsing online indicator was
  still rendering square because the rounding override sat outside `@layer base`
  (for `!important` rules, layered styles beat unlayered ones); moved it into the
  layer so it wins.
- **Pointer cursor** on dropdowns (`<select>`) and other controls.

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
