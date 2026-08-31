import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { b64ToBytes, strToB64 } from "@/lib/b64";
import { cellRatio, fitFontSize, FIT_MAX_FONT, FIT_MIN_FONT } from "@/lib/fit";
import { stripLeadingStatusGlyph } from "@/lib/termTitle";
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_LINE_HEIGHT,
  FONT_FAMILIES,
  fontStack,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
  type AiCliState,
  type FontFamilyId,
  type RemoteWorkspace,
  type SavedSshConn,
  type ServerFrame,
  type SessionMeta,
  type ThemeName,
} from "@/lib/protocol";

export type ConnState = "connecting" | "open" | "closed";

type TermEntry = { term: Terminal; el: HTMLElement };

const FONT_KEY = "tedi-remote-fontsize";
const FONTAUTO_KEY = "tedi-remote-fontauto";
const FONTFAMILY_KEY = "tedi-remote-fontfamily";
const LINEHEIGHT_KEY = "tedi-remote-lineheight";
const THEME_KEY = "tedi-remote-theme";
const DEFAULT_FONT = 13;
const clampFont = (n: number) => Math.min(28, Math.max(8, n || DEFAULT_FONT));
const clampLineHeight = (n: number) => Math.min(1.6, Math.max(1.0, n || DEFAULT_LINE_HEIGHT));

function getInitialFontFamily(): FontFamilyId {
  try {
    const v = localStorage.getItem(FONTFAMILY_KEY);
    if (v && FONT_FAMILIES.some((f) => f.id === v)) return v as FontFamilyId;
  } catch {
    /* ignore */
  }
  return DEFAULT_FONT_FAMILY;
}

function getInitialLineHeight(): number {
  try {
    return clampLineHeight(Number(localStorage.getItem(LINEHEIGHT_KEY)));
  } catch {
    return DEFAULT_LINE_HEIGHT;
  }
}

function getInitialTheme(): ThemeName {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    /* ignore */
  }
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

const termTheme = (t: ThemeName) => (t === "dark" ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT);

// Merge an incoming session list into the current one while PRESERVING the
// current (possibly user-dragged) tab order: keep existing tabs in place with
// refreshed metadata, drop tabs that are gone, and append newcomers ordered by
// host creation time (so a fresh connection lists them oldest-first, matching
// the order they were opened in the desktop app).
function reconcileOrder(prev: SessionMeta[], incoming: SessionMeta[]): SessionMeta[] {
  const byId = new Map(incoming.map((s) => [s.id, s]));
  const out: SessionMeta[] = [];
  for (const p of prev) {
    const cur = byId.get(p.id);
    if (cur) {
      out.push(cur);
      byId.delete(p.id);
    }
  }
  const newcomers = [...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return [...out, ...newcomers];
}

export type Remote = ReturnType<typeof useRemote>;

export function useRemote() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = checking
  const [totpRequired, setTotpRequired] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [hostOnline, setHostOnline] = useState(false);
  const [hostName, setHostName] = useState("");
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  // Map daemon ptyId -> the desktop app's tab number (terminalOrdinal), pushed
  // by the host via the `tabmeta` frame. Kept separate from `sessions` so it
  // survives session-list updates; the tab strip reads it by session id.
  const [ordinals, setOrdinals] = useState<Record<string, number>>({});
  // Saved SSH hosts the user may open from the web (secret-free, pinned-only),
  // pushed by the host via the `ssh-conns` frame.
  const [sshConns, setSshConns] = useState<SavedSshConn[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(() => clampFont(Number(localStorage.getItem(FONT_KEY))));
  // Auto: the client picks the text size that makes the host's fixed grid fill
  // the pane (default). Off: `fontSize` is used verbatim and the pane scrolls to
  // whatever does not fit. Either way the host's cols/rows are never touched.
  const [fontAuto, setFontAutoState] = useState(() => localStorage.getItem(FONTAUTO_KEY) !== "0");
  const [fontFamily, setFontFamily] = useState<FontFamilyId>(getInitialFontFamily);
  const [lineHeight, setLineHeightState] = useState<number>(getInitialLineHeight);
  const [ctrlSticky, setCtrlSticky] = useState(false);
  const [user, setUser] = useState("");
  // Cloudflare Turnstile site key from the relay (/api/me). Empty = disabled; when
  // set, the Login + Change-password forms render the widget and send its token.
  const [turnstileSiteKey, setTurnstileSiteKey] = useState("");
  const [theme, setThemeState] = useState<ThemeName>(getInitialTheme);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Per-tab program-set window title (OSC 0/2), e.g. a running agent's task, keyed
  // by session id. The sidebar shows it next to the folder name ("folder · title")
  // to match the desktop Workspaces panel. Captured via xterm `onTitleChange` from
  // the mirrored stream, so no host change is needed.
  const [titles, setTitles] = useState<Record<string, string>>({});
  // Host-authoritative window title from the desktop, keyed by session id (via the
  // `tabmeta` frame). Preferred over the local `titles` capture above: the desktop
  // captured the OSC 0/2 title live, so this is never stale after a scrollback
  // reset and is present even for a browser that late-joins a running alt-screen
  // agent (whose title already scrolled off the mirrored stream). Falls back to
  // the local capture for hosts too old to send it.
  const [hostTitles, setHostTitles] = useState<Record<string, string>>({});
  // Per-tab AI-CLI state mirrored from the desktop (keyed by session id). This is
  // the authoritative working indicator: it covers EVERY tab (not just the one
  // in view) and works on Windows, where the shell emits no OSC 133 C for the
  // client-side `busy` heuristic to latch onto.
  const [status, setStatus] = useState<Record<string, AiCliState>>({});
  // Which workspace each session belongs to (session id -> workspace id), and the
  // list of workspaces to switch between — both mirrored from the desktop via
  // tabmeta. Only workspaces with a live (mirrored) terminal appear.
  const [wsById, setWsById] = useState<Record<string, string>>({});
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([]);
  // Pin state + the user's own tab name, both mirrored from the desktop, which
  // owns them: it decides tab ORDER, and it re-publishes the title on every
  // context change, so a browser-local edit would be overwritten on the next
  // frame. The browser asks the host and reads the answer back here.
  const [pinnedIds, setPinnedIds] = useState<Record<string, boolean>>({});
  const [customTitles, setCustomTitles] = useState<Record<string, string>>({});
  // Whether the desktop is new enough to accept the tab/workspace control
  // surface (pin, rename tab, rename workspace — they all landed in one core
  // build). Probed rather than version-gated: the extension feature-detects the
  // host API, so the only honest signal is whether a `pinned` boolean arrives.
  const [hostControl, setHostControl] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const terms = useRef<Map<string, TermEntry>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  const ctrlRef = useRef(false);
  const themeRef = useRef<ThemeName>(theme);
  const fontFamilyRef = useRef<FontFamilyId>(fontFamily);
  const lineHeightRef = useRef<number>(lineHeight);
  const fontSizeRef = useRef<number>(fontSize);
  const fontAutoRef = useRef<boolean>(fontAuto);
  const busyRef = useRef<Map<string, boolean>>(new Map());
  const idleTimers = useRef<Map<string, number>>(new Map());
  const pending = useRef<Map<string, Uint8Array[]>>(new Map());
  const reconnectMs = useRef(1000);
  const hbTimer = useRef<number | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const mounted = useRef(true);
  const sessionsRef = useRef<SessionMeta[]>([]);
  const pendingNewIds = useRef<Set<string> | null>(null);
  const pendingNewTimer = useRef<number | null>(null);
  // Reset the reconnect backoff only after a connection has proven stable (armed
  // in onopen, cleared in onclose); a socket that opens-then-instantly-drops
  // keeps backing off instead of hammering the relay ~1x/second.
  const stableTimer = useRef<number | null>(null);
  // Server-liveness: timestamp of the last inbound frame (incl. pong). If the
  // host is online but nothing arrives for a while, the socket is half-open —
  // force a reconnect instead of silently swallowing keystrokes.
  const lastRecv = useRef(0);
  const hostOnlineRef = useRef(false);
  // Session ids whose initial scrollback has already been painted. A re-`attached`
  // (on reconnect / client_join) for a live alt-screen TUI must NOT reset+replay
  // the ring — that garbles a running full-screen program (Claude) into corrupt
  // output; the live `data` stream already keeps it current.
  const attachedOnce = useRef<Set<string>>(new Set());

  const send = useCallback((obj: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  const sendInput = useCallback(
    (id: string, data: string) => send({ t: "input", id, b64: strToB64(data) }),
    [send],
  );

  // --- terminal lifecycle -------------------------------------------------
  const flushPending = useCallback((id: string, term: Terminal) => {
    const chunks = pending.current.get(id);
    if (chunks) {
      for (const c of chunks) term.write(c);
      pending.current.delete(id);
    }
  }, []);

  // Per-tab "CLI running" state. Going busy is immediate; going idle is
  // debounced so a fast run of commands doesn't flicker the indicator.
  const setBusyVal = useCallback((id: string, val: boolean) => {
    const timers = idleTimers.current;
    if (val) {
      const t = timers.get(id);
      if (t) {
        window.clearTimeout(t);
        timers.delete(id);
      }
      if (busyRef.current.get(id) !== true) {
        busyRef.current.set(id, true);
        setBusy((prev) => ({ ...prev, [id]: true }));
      }
    } else {
      const t = timers.get(id);
      if (t) window.clearTimeout(t);
      timers.set(
        id,
        window.setTimeout(() => {
          timers.delete(id);
          if (busyRef.current.get(id) !== false) {
            busyRef.current.set(id, false);
            setBusy((prev) => ({ ...prev, [id]: false }));
          }
        }, 350),
      );
    }
  }, []);

  const attachTerminal = useCallback(
    (id: string, el: HTMLElement, meta?: SessionMeta) => {
      const entry = terms.current.get(id);
      if (entry) {
        if (entry.el !== el) {
          entry.el = el;
          term_open(entry.term, el);
        }
        return;
      }
      const term = new Terminal({
        cols: meta?.cols ?? 80,
        rows: meta?.rows ?? 24,
        fontSize,
        fontFamily: fontStack(fontFamilyRef.current),
        lineHeight: lineHeightRef.current,
        theme: termTheme(themeRef.current),
        cursorBlink: true,
        scrollback: 8000,
        convertEol: false,
        allowProposedApi: true,
      });
      try {
        term.loadAddon(new WebLinksAddon());
      } catch {
        /* non-fatal */
      }
      // OSC 133 (shell integration) marks command boundaries: C = output start
      // (a command is running), A/B/D = prompt / typed / done (idle). Drives the
      // per-tab "CLI running" indicator. Returns false so xterm keeps parsing.
      try {
        term.parser.registerOscHandler(133, (data) => {
          const k = data.charAt(0);
          if (k === "C") setBusyVal(id, true);
          else if (k === "A" || k === "B" || k === "D") setBusyVal(id, false);
          return false;
        });
      } catch {
        /* OSC handler unsupported -> no running indicator for this term */
      }
      // Program-set window title (OSC 0/2). A running agent (Claude Code, …) or a
      // TUI sets it; mirror it into `titles` (strip the leading spinner glyph) so
      // the sidebar reads "folder · title" like the desktop Workspaces panel.
      try {
        term.onTitleChange((raw) => {
          const t = stripLeadingStatusGlyph((raw || "").trim());
          setTitles((prev) => {
            if (!t) {
              if (!(id in prev)) return prev;
              const next = { ...prev };
              delete next[id];
              return next;
            }
            return prev[id] === t ? prev : { ...prev, [id]: t };
          });
        });
      } catch {
        /* onTitleChange unsupported -> no title for this term */
      }
      // Clipboard, so a mirrored session (an SSH one included) can take a token
      // pasted from this device and hand a URL back to it.
      //
      // Paste is deliberately NOT `navigator.clipboard.readText()`: returning
      // false from the handler makes xterm skip the key WITHOUT calling
      // preventDefault, so the browser runs its own paste command, fires the
      // `paste` event on xterm's textarea, and xterm's built-in handler brackets
      // and sends it. That needs no clipboard-read permission and no async hop -
      // whereas letting xterm handle the key maps Ctrl+V to ^V and cancels the
      // event, which is why pasting did nothing here at all.
      //
      // Copy has no such native path (the browser would copy the empty textarea,
      // not the buffer), so it writes the selection explicitly. Ctrl+C is left
      // alone: it is SIGINT on a remote shell, and this client has no reliable
      // way to offer a second press.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown" || e.altKey) return true;
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return true;
        const key = e.key.toLowerCase();
        if (key === "v") return false; // hand it to the browser's paste
        if (key === "c" && e.shiftKey) {
          // Cancel this one: Ctrl+Shift+C / Cmd+Shift+C is Chrome's
          // inspect-element, which would open DevTools over the session if the
          // key reached the browser the way the paste chord deliberately does.
          e.preventDefault();
          const sel = term.getSelection();
          if (sel) void navigator.clipboard?.writeText(sel).catch(() => {});
          return false;
        }
        return true;
      });
      // Select-to-copy, the PuTTY convention the desktop panes also implement:
      // releasing a left-drag puts the selection on this device's clipboard.
      el.addEventListener("mouseup", (ev) => {
        if ((ev as MouseEvent).button !== 0) return;
        const sel = term.getSelection();
        if (sel) void navigator.clipboard?.writeText(sel).catch(() => {});
      });

      term_open(term, el);
      term.onData((data) => {
        let out = data;
        // Sticky Ctrl from the mobile helper bar: fold the next single letter
        // into its control char (a->^A ... z->^Z), then release.
        if (ctrlRef.current && data.length === 1) {
          const code = data.toUpperCase().charCodeAt(0);
          if (code >= 64 && code <= 95) out = String.fromCharCode(code - 64);
          setCtrlSticky(false);
        }
        sendInput(id, out);
      });
      terms.current.set(id, { term, el });
      flushPending(id, term);
    },
    [fontSize, sendInput, flushPending],
  );

  const disposeTerminal = useCallback((id: string) => {
    const entry = terms.current.get(id);
    if (entry) {
      try {
        entry.term.dispose();
      } catch {
        /* ignore */
      }
      terms.current.delete(id);
    }
    pending.current.delete(id);
    attachedOnce.current.delete(id);
    const t = idleTimers.current.get(id);
    if (t) {
      window.clearTimeout(t);
      idleTimers.current.delete(id);
    }
    if (busyRef.current.delete(id)) {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
    setTitles((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const focusActive = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    const entry = terms.current.get(id);
    if (entry) {
      // Focus only — do NOT force scrollToBottom here. This runs on every
      // pointerdown (TerminalHost's container onPointerDown), and on touch the
      // start of a scroll-drag fires pointerdown first, so snapping to the
      // bottom made scrolling up impossible on phones. xterm already scrolls to
      // the bottom on user input (scrollOnUserInput) and follows new output when
      // you're already at the bottom, so the forced scroll gave nothing but cost
      // the ability to scroll back through history.
      entry.term.focus();
    }
  }, []);

  // The browser is a PURE MIRROR. It adopts each host PTY's real cols/rows and
  // never sends a size back, so resizing the browser window or rotating a phone
  // cannot reflow the shared terminal inside the TEDI desktop app.
  //
  // There used to be a "Fit host to my screen" mode here that resized the host
  // PTY to the browser. It filled a phone screen nicely and shredded whatever
  // full-screen CLI was running on the PC, so it is gone; the host now drops
  // browser resize frames outright (see the agent + SSH bridge).
  //
  // What is left to choose is how big the host's fixed cells are DRAWN, and this
  // picks a real font size for that instead of the CSS `transform: scale()` it
  // used to apply -- see lib/fit.ts for why (fuzzy glyphs, a misplaced cursor,
  // 5.7px text on a phone, and a small host marooned in the middle of a big
  // pane). With Auto off the user's own size wins and TerminalHost scrolls.
  const fitTerminal = useCallback((id: string | null) => {
    if (!id) return;
    const entry = terms.current.get(id);
    if (!entry?.term.element || !entry.el) return;
    requestAnimationFrame(() => {
      const live = terms.current.get(id);
      if (!live || live.el !== entry.el) return;
      const el = live.term.element;
      const host = live.el;
      if (!el || !host) return;
      const at = live.term.options.fontSize ?? DEFAULT_FONT;
      if (!fontAutoRef.current) {
        if (at !== fontSizeRef.current) live.term.options.fontSize = fontSizeRef.current;
        return;
      }
      const { cols, rows } = live.term;
      const ratio = cellRatio(el.offsetWidth, el.offsetHeight, cols, rows, at);
      if (!ratio) return; // pane not laid out yet; a later refit will catch it
      const apply = (f: number) => {
        if (live.term.options.fontSize !== f) live.term.options.fontSize = f;
      };
      const overflows = () =>
        el.offsetWidth > host.clientWidth || el.offsetHeight > host.clientHeight;

      // Start from the estimate so the walk below is a step or two, then VERIFY
      // against the real render. xterm rounds its cell box to whole pixels and
      // updates the element synchronously on an options change, so the honest
      // answer is to look rather than to trust the arithmetic -- a ratio sampled
      // before the web font loaded describes the fallback face and overshot far
      // enough to push the prompt row out of the pane.
      let size = fitFontSize(ratio, cols, rows, host.clientWidth, host.clientHeight);
      apply(size);
      while (size > FIT_MIN_FONT && overflows()) apply(--size);
      while (size < FIT_MAX_FONT) {
        apply(size + 1);
        if (overflows()) {
          apply(size);
          break;
        }
        size += 1;
      }
    });
  }, []);

  // --- frame handling -----------------------------------------------------
  const writeScrollback = useCallback(
    (id: string, b64: string, cols: number, rows: number) => {
      const bytes = b64 ? b64ToBytes(b64) : new Uint8Array(0);
      const entry = terms.current.get(id);
      if (entry) {
        // Adopt the host PTY's real size: the desktop is the only size authority.
        if (entry.term.cols !== cols || entry.term.rows !== rows) {
          try {
            entry.term.resize(cols, rows);
          } catch {
            /* ignore */
          }
        }
        // The agent re-sends `attached` for a live session on every relay
        // (re)connect and every client_join. Repainting from the ring is only
        // safe on the FIRST attach, or a normal-screen re-attach that actually
        // CARRIES scrollback to repaint. Two cases must NOT reset:
        //   - a live full-screen TUI (alt-screen, e.g. Claude): a reset+replay
        //     nukes the running program into corrupt output.
        //   - an empty-scrollback re-attach: every SSH `attached` sends
        //     scrollback:"" (the bridge has no ring), so a re-attach after a
        //     source/webview reconnect would reset() a live SSH terminal to
        //     BLANK. Keep what's on screen — the live `data` stream stays current.
        const first = !attachedOnce.current.has(id);
        const inAltScreen = entry.term.buffer.active.type === "alternate";
        if (first || (!inAltScreen && bytes.length)) {
          entry.term.reset();
          entry.term.write(bytes);
        }
        attachedOnce.current.add(id);
        fitTerminal(id);
      } else {
        pending.current.set(id, bytes.length ? [bytes] : []);
        attachedOnce.current.add(id); // the pending write IS this id's first paint
      }
    },
    [fitTerminal],
  );

  const handleFrame = useCallback(
    (f: ServerFrame) => {
      switch (f.t) {
        case "host":
          setHostOnline(f.status === "online");
          if (f.name) setHostName(f.name);
          break;
        case "sessions": {
          const items = f.items;
          // Adopt each host PTY's real size: the desktop is the size authority.
          for (const it of items) {
            const e = terms.current.get(it.id);
            if (e && (e.term.cols !== it.cols || e.term.rows !== it.rows)) {
              try {
                e.term.resize(it.cols, it.rows);
              } catch {
                /* ignore */
              }
            }
          }
          for (const it of items) fitTerminal(it.id);
          const live = new Set(items.map((i) => i.id));
          for (const id of [...terms.current.keys()]) if (!live.has(id)) disposeTerminal(id);
          setSessions((prev) => reconcileOrder(prev, items));
          // If the user just hit "+", focus the session that wasn't there before.
          const fresh =
            pendingNewIds.current && items.find((i) => !pendingNewIds.current!.has(i.id));
          if (fresh) {
            pendingNewIds.current = null;
            if (pendingNewTimer.current) window.clearTimeout(pendingNewTimer.current);
            setActiveId(fresh.id);
          } else {
            setActiveId((cur) => (cur && live.has(cur) ? cur : (items[0]?.id ?? null)));
          }
          break;
        }
        case "attached": {
          writeScrollback(f.id, f.scrollback, f.cols, f.rows);
          setSessions((prev) =>
            prev.some((s) => s.id === f.id)
              ? prev.map((s) =>
                  s.id === f.id ? { ...s, cols: f.cols, rows: f.rows, alive: f.alive } : s,
                )
              : [
                  ...prev,
                  { id: f.id, cols: f.cols, rows: f.rows, alive: f.alive, title: "terminal" },
                ],
          );
          setActiveId((cur) => cur ?? f.id);
          break;
        }
        case "data": {
          const bytes = b64ToBytes(f.b64);
          const entry = terms.current.get(f.id);
          if (entry) entry.term.write(bytes);
          else {
            const arr = pending.current.get(f.id) ?? [];
            arr.push(bytes);
            pending.current.set(f.id, arr);
          }
          break;
        }
        case "exit": {
          const entry = terms.current.get(f.id);
          if (entry) {
            entry.term.write(
              new TextEncoder().encode(`\r\n\x1b[90m[process exited ${f.code}]\x1b[0m\r\n`),
            );
          }
          setSessions((prev) => prev.map((s) => (s.id === f.id ? { ...s, alive: false } : s)));
          break;
        }
        case "tabmeta": {
          const nextOrd: Record<string, number> = {};
          const nextStatus: Record<string, AiCliState> = {};
          const nextTitles: Record<string, string> = {};
          const nextWsById: Record<string, string> = {};
          const nextPinned: Record<string, boolean> = {};
          const nextCustom: Record<string, string> = {};
          let canControl = false;
          // Preserve first-seen order + de-dup workspaces by id.
          const wsMap = new Map<string, RemoteWorkspace>();
          for (const it of f.items) {
            nextOrd[it.ptyId] = it.ordinal;
            if (it.state) nextStatus[it.ptyId] = it.state;
            if (it.title) nextTitles[it.ptyId] = it.title;
            if (typeof it.pinned === "boolean") {
              canControl = true;
              if (it.pinned) nextPinned[it.ptyId] = true;
            }
            if (it.customTitle) nextCustom[it.ptyId] = it.customTitle;
            if (it.wsId) {
              nextWsById[it.ptyId] = it.wsId;
              if (!wsMap.has(it.wsId)) {
                wsMap.set(it.wsId, {
                  id: it.wsId,
                  name: it.wsName || "Workspace",
                  active: !!it.wsActive,
                });
              }
            }
          }
          setOrdinals(nextOrd);
          setStatus(nextStatus);
          setHostTitles(nextTitles);
          setWsById(nextWsById);
          setWorkspaces([...wsMap.values()]);
          setPinnedIds(nextPinned);
          setCustomTitles(nextCustom);
          // Latches on: an empty tabmeta (every terminal closed) carries no
          // evidence either way and must not retract a capability the host has
          // already demonstrated.
          if (canControl) setHostControl(true);
          break;
        }
        case "ssh-conns":
          setSshConns(Array.isArray(f.items) ? f.items : []);
          break;
        case "pong":
          break;
      }
    },
    [disposeTerminal, writeScrollback, fitTerminal],
  );

  // --- websocket lifecycle ------------------------------------------------
  const connect = useCallback(() => {
    if (!mounted.current) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/client`);
    wsRef.current = ws;
    setConn("connecting");

    ws.onopen = () => {
      if (!mounted.current) return;
      setConn("open");
      lastRecv.current = Date.now();
      // Reset the backoff only once this connection has stayed up for a while, so
      // an open-then-instant-drop (proxy idle-kill, LB drain) keeps backing off
      // rather than reconnecting ~1x/second forever.
      if (stableTimer.current) window.clearTimeout(stableTimer.current);
      stableTimer.current = window.setTimeout(() => {
        reconnectMs.current = 1000;
      }, 5000);
      send({ t: "hello" });
      if (hbTimer.current) window.clearInterval(hbTimer.current);
      // Ping every 10s; force-close after ~28s of total silence. On a healthy
      // idle link a pong (or data) refreshes lastRecv every 10s, so 28s (~3
      // missed pings) never false-closes it — but a half-open link (send dir
      // dead, ping never lands) is caught in ~28-38s instead of the old 40-65s,
      // which is what made a live-looking tab silently swallow keystrokes,
      // especially on mobile Wi-Fi/cellular handoff. ponytail: threshold must
      // stay > interval + RTT margin; tune the pair together if the link is slow.
      hbTimer.current = window.setInterval(() => {
        const sock = wsRef.current;
        if (!sock || sock.readyState !== WebSocket.OPEN) return;
        if (hostOnlineRef.current && Date.now() - lastRecv.current > 28000) {
          try {
            sock.close();
          } catch {
            /* ignore */
          }
          return;
        }
        send({ t: "ping" });
      }, 10000);
    };
    ws.onmessage = (ev) => {
      lastRecv.current = Date.now();
      let f: ServerFrame;
      try {
        f = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      handleFrame(f);
    };
    ws.onclose = (ev) => {
      if (hbTimer.current) window.clearInterval(hbTimer.current);
      if (stableTimer.current) {
        window.clearTimeout(stableTimer.current);
        stableTimer.current = null;
      }
      if (!mounted.current) return;
      setConn("closed");
      setHostOnline(false);
      if (ev.code === 1008 || ev.code === 4401) {
        setAuthed(false);
        return;
      }
      reconnectTimer.current = window.setTimeout(connect, reconnectMs.current);
      reconnectMs.current = Math.min(reconnectMs.current * 2, 15000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }, [send, handleFrame]);

  // --- auth ---------------------------------------------------------------
  const login = useCallback(
    async (
      user: string,
      pass: string,
      otp: string,
      turnstile?: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const r = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ user, pass, otp, turnstile }),
        });
        if (r.ok) {
          setUser(user);
          setAuthed(true);
          connect();
          return { ok: true };
        }
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return {
          ok: false,
          error: j.error || (r.status === 429 ? "Too many attempts" : "Sign in failed"),
        };
      } catch {
        return { ok: false, error: "Network error" };
      }
    },
    [connect],
  );

  const logout = useCallback(async () => {
    try {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      /* ignore */
    }
    location.reload();
  }, []);

  const changePassword = useCallback(
    async (
      current: string,
      next: string,
      turnstile?: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const r = await fetch("/api/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ current, new: next, turnstile }),
        });
        if (r.ok) return { ok: true };
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return {
          ok: false,
          error: j.error || (r.status === 429 ? "Too many attempts" : "Could not change password"),
        };
      } catch {
        return { ok: false, error: "Network error" };
      }
    },
    [],
  );

  // Snapshot the current session ids so the newcomer (a new terminal / SSH tab /
  // workspace's default terminal) auto-focuses when it streams in. Cleared after
  // 8s so a no-op request never mis-selects a later, unrelated session.
  const markPendingNew = useCallback(() => {
    pendingNewIds.current = new Set(sessionsRef.current.map((s) => s.id));
    if (pendingNewTimer.current) window.clearTimeout(pendingNewTimer.current);
    pendingNewTimer.current = window.setTimeout(() => {
      pendingNewIds.current = null;
    }, 8000);
  }, []);

  // Open a SAVED SSH connection. The user re-authenticates with their LOGIN
  // password (NOT the SSH password) over POST /api/open-ssh; the relay verifies
  // it and tells the host to open the connection by id (keychain creds stay on
  // the host). The new SSH tab then streams in via the next sessions frame.
  const openSshConnection = useCallback(
    async (
      connectionId: string,
      pass: string,
      otp?: string,
      wsId?: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      // Snapshot existing ids so the new SSH tab auto-focuses when it appears.
      markPendingNew();
      try {
        const r = await fetch("/api/open-ssh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          // `wsId` (optional): the relay forwards it so the host switches to that
          // workspace before opening, placing the SSH tab there.
          body: JSON.stringify({ connectionId, pass, otp, ...(wsId ? { wsId } : {}) }),
        });
        if (r.ok) return { ok: true };
        pendingNewIds.current = null;
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return {
          ok: false,
          error:
            j.error ||
            (r.status === 429
              ? "Too many attempts"
              : r.status === 401
                ? "Wrong password"
                : r.status === 503
                  ? "Host is offline"
                  : "Could not open SSH"),
        };
      } catch {
        pendingNewIds.current = null;
        return { ok: false, error: "Network error" };
      }
    },
    [markPendingNew],
  );

  // boot: check session, then connect
  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const r = await fetch("/api/me", { credentials: "same-origin" });
        // Public login config (totp + turnstile site key) comes back on 200 AND
        // 401, so the Login screen can render the widget / OTP field pre-auth.
        const j = (await r.json().catch(() => ({}))) as {
          totp?: boolean;
          user?: string;
          turnstile?: string;
        };
        setTotpRequired(!!j.totp);
        if (j.turnstile) setTurnstileSiteKey(j.turnstile);
        if (r.ok) {
          if (j.user) setUser(j.user);
          setAuthed(true);
          connect();
        } else {
          setAuthed(false);
        }
      } catch {
        setAuthed(false);
      }
    })();
    return () => {
      mounted.current = false;
      if (hbTimer.current) window.clearInterval(hbTimer.current);
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Text size -> persist + re-fit. Under Auto the fitter owns the rendered size,
  // so this only records what turning Auto off falls back to.
  useEffect(() => {
    fontSizeRef.current = fontSize;
    localStorage.setItem(FONT_KEY, String(fontSize));
    for (const id of terms.current.keys()) fitTerminal(id);
  }, [fontSize, fitTerminal]);

  useEffect(() => {
    fontAutoRef.current = fontAuto;
    try {
      localStorage.setItem(FONTAUTO_KEY, fontAuto ? "1" : "0");
    } catch {
      /* ignore */
    }
    for (const id of terms.current.keys()) fitTerminal(id);
  }, [fontAuto, fitTerminal]);

  // A-/A+ are an explicit size choice, so they leave Auto — starting from the
  // size actually on screen. Under Auto that is the fitted size, and snapping
  // back to the stored preference on the first press would jump.
  const bumpFont = useCallback((delta: number) => {
    const shown = activeIdRef.current
      ? terms.current.get(activeIdRef.current)?.term.options.fontSize
      : undefined;
    setFontAutoState(false);
    setFontSize(clampFont((shown ?? fontSizeRef.current) + delta));
  }, []);
  const resetFont = useCallback(() => setFontSize(DEFAULT_FONT), []);

  // Font family -> all terminals + persist. Changing the family alters cell
  // width, so re-scale every terminal.
  useEffect(() => {
    fontFamilyRef.current = fontFamily;
    try {
      localStorage.setItem(FONTFAMILY_KEY, fontFamily);
    } catch {
      /* ignore */
    }
    const stack = fontStack(fontFamily);
    for (const { term } of terms.current.values()) term.options.fontFamily = stack;
    for (const id of terms.current.keys()) fitTerminal(id);
  }, [fontFamily, fitTerminal]);

  // Line spacing -> all terminals + persist (changes row height -> re-scale).
  const setLineHeight = useCallback((n: number) => setLineHeightState(clampLineHeight(n)), []);
  useEffect(() => {
    lineHeightRef.current = lineHeight;
    try {
      localStorage.setItem(LINEHEIGHT_KEY, String(lineHeight));
    } catch {
      /* ignore */
    }
    for (const { term } of terms.current.values()) term.options.lineHeight = lineHeight;
    for (const id of terms.current.keys()) fitTerminal(id);
  }, [lineHeight, fitTerminal]);

  // Theme: persist, toggle the <html class="dark">, and re-theme every live term.
  const setTheme = useCallback((t: ThemeName) => {
    setThemeState(t);
    themeRef.current = t;
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* ignore */
    }
    document.documentElement.classList.toggle("dark", t === "dark");
    const th = termTheme(t);
    for (const { term } of terms.current.values()) term.options.theme = th;
  }, []);
  const toggleTheme = useCallback(
    () => setTheme(themeRef.current === "dark" ? "light" : "dark"),
    [setTheme],
  );
  // Ensure the class matches state on mount (the index.html inline script sets
  // it pre-paint to avoid a flash; this is belt-and-braces).
  useEffect(() => {
    document.documentElement.classList.toggle("dark", themeRef.current === "dark");
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    ctrlRef.current = ctrlSticky;
  }, [ctrlSticky]);
  useEffect(() => {
    hostOnlineRef.current = hostOnline;
  }, [hostOnline]);

  // Send a literal sequence (helper keys) to whichever terminal is focused.
  const sendToActive = useCallback(
    (data: string) => {
      const id = activeIdRef.current;
      if (id) sendInput(id, data);
    },
    [sendInput],
  );

  // Ask the host to open a NEW terminal (the "+" in the tab strip). Sizes it to
  // the active terminal so it fills the view; the host spawns a fresh PTY and
  // the new tab streams in within ~2s. Snapshot current ids so we can focus the
  // newcomer when it appears (cleared after 5s so a no-op never mis-selects).
  const newTerminal = useCallback(
    (wsId?: string) => {
      const id = activeIdRef.current;
      const e = id ? terms.current.get(id) : null;
      const cols = e?.term.cols ?? 80;
      const rows = e?.term.rows ?? 24;
      markPendingNew();
      // `wsId` (optional) asks the host extension to switch the desktop to that
      // workspace first, so the new terminal is adopted into it. The native agent
      // ignores the field and just spawns.
      send({ t: "open", cols, rows, ...(wsId ? { wsId } : {}) });
    },
    [send, markPendingNew],
  );

  // Ask the host to create a NEW workspace (it switches to it on the desktop,
  // which auto-opens a default terminal). The new workspace + its terminal stream
  // in via the next tabmeta/sessions frames; snapshot ids so it auto-focuses.
  const createRemoteWorkspace = useCallback(
    (name: string) => {
      markPendingNew();
      send({ t: "ws-create", name });
    },
    [send, markPendingNew],
  );

  // Permanently close (kill) a tab. The host kills the daemon PTY (or the SSH
  // bridge runs ssh_close), which closes it in the desktop app too; the
  // authoritative "exit"/"sessions" frames then drop the tab. Optimistically
  // Pin / rename a mirrored tab on the DESKTOP. Fire-and-forget: the host does
  // the work and republishes tabmeta, which is what actually moves this UI. No
  // optimistic local write, deliberately — the desktop can refuse (a terminal in
  // a background workspace is not resolvable there), and a local guess would
  // then show a state the desktop is not in.
  const setTabPinned = useCallback(
    (id: string, pinned: boolean) => send({ t: "tab-pin", id, pinned }),
    [send],
  );
  const renameTab = useCallback(
    (id: string, title: string | null) => {
      const t = (title ?? "").trim().slice(0, 60);
      send({ t: "tab-rename", id, title: t || null });
    },
    [send],
  );
  // A workspace has no derived name to fall back to (a tab does — its cwd), so
  // an empty rename is dropped here rather than sent and refused by the host.
  const renameWorkspace = useCallback(
    (id: string, name: string) => {
      const n = name.trim().slice(0, 60);
      if (n) send({ t: "ws-rename", id, name: n });
    },
    [send],
  );

  // mark it dead so the UI reacts immediately (a later sessions frame corrects
  // it if the close didn't take).
  const closeTerminal = useCallback(
    (id: string) => {
      // Parity with the desktop's per-workspace last-tab gate (useTabs.closeTab:
      // `if (curr.length <= 1) return curr`): a workspace always keeps >=1 tab, so
      // refuse to close a session that is the ONLY one in its workspace. Ungrouped
      // sessions (no wsId — older host, or before tabmeta arrives) are treated as
      // one group, matching the sidebar's "Other" bucket. The sidebar also hides
      // the X in that case (canClose), so this is the belt to that suspenders.
      const ws = wsById[id];
      const siblings = sessionsRef.current.filter((s) => wsById[s.id] === ws);
      if (siblings.length <= 1) return;
      send({ t: "close", id });
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, alive: false } : s)));
    },
    [send, wsById],
  );

  // Drag-to-reorder: move `draggedId` to where `targetId` currently sits. The
  // order is local to this browser (the host order is untouched) and survives
  // incoming session frames via reconcileOrder.
  const reorderTabs = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    setSessions((prev) => {
      const from = prev.findIndex((s) => s.id === draggedId);
      if (from < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      const to = next.findIndex((s) => s.id === targetId);
      if (to < 0) return prev;
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // Switch the viewed workspace by focusing its first tab. The sidebar then
  // highlights whichever group owns the active tab, so no separate "active
  // workspace" state is needed. No-op if the workspace has no live tab.
  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      const first = sessionsRef.current.find((s) => wsById[s.id] === workspaceId);
      if (first) setActiveId(first.id);
    },
    [wsById],
  );

  return {
    authed,
    totpRequired,
    conn,
    hostOnline,
    hostName,
    sessions,
    ordinals,
    activeId,
    setActiveId,
    fontSize,
    fontAuto,
    setFontAuto: setFontAutoState,
    bumpFont,
    resetFont,
    fontFamily,
    setFontFamily,
    lineHeight,
    setLineHeight,
    fitTerminal,
    attachTerminal,
    focusActive,
    sendInput,
    sendToActive,
    newTerminal,
    createRemoteWorkspace,
    closeTerminal,
    reorderTabs,
    ctrlSticky,
    setCtrlSticky,
    user,
    turnstileSiteKey,
    theme,
    setTheme,
    toggleTheme,
    busy,
    status,
    titles,
    hostTitles,
    wsById,
    workspaces,
    selectWorkspace,
    pinnedIds,
    customTitles,
    hostControl,
    setTabPinned,
    renameTab,
    renameWorkspace,
    login,
    logout,
    changePassword,
    sshConns,
    openSshConnection,
  };
}

// Open the terminal on an element, tolerating repeated calls (StrictMode / tab
// remounts). xterm throws if open() runs twice on the same element, so guard.
function term_open(term: Terminal, el: HTMLElement) {
  if ((term as unknown as { element?: HTMLElement }).element) return;
  term.open(el);
}
