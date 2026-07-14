import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { b64ToBytes, strToB64 } from "@/lib/b64";
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
const FONTFAMILY_KEY = "tedi-remote-fontfamily";
const LINEHEIGHT_KEY = "tedi-remote-lineheight";
const THEME_KEY = "tedi-remote-theme";
// Bumped from "tedi-remote-fit" so every existing browser resets to the new
// safe default (mirror / OFF). The old key persisted "1" for everyone, because
// the previous default was ON and the persist effect wrote it on mount — so
// reusing the key would keep host-resize on and keep garbling the desktop.
const FIT_KEY = "tedi-remote-fit2";
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

// How many cols/rows fit in `host` at the terminal's current cell size. This is
// exactly what xterm's FitAddon computes (container px / cell px); we inline it
// to avoid an addon whose published versions don't peer-match xterm 6. Reads the
// renderer's measured cell size (no public API for it), so it's guarded.
function proposeDims(term: Terminal, host: HTMLElement): { cols: number; rows: number } | null {
  const core = (
    term as unknown as {
      _core?: {
        _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } };
      };
    }
  )._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  const cw = cell?.width;
  const ch = cell?.height;
  if (!cw || !ch) return null;
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (w < 2 || h < 2) return null;
  return { cols: Math.max(2, Math.floor(w / cw)), rows: Math.max(1, Math.floor(h / ch)) };
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
  // Default OFF: the browser is a PURE MIRROR that never resizes the shared host
  // PTY, so opening the remote can't reflow/garble the desktop terminal (a
  // full-screen TUI like Claude especially). Host-fill is an explicit opt-in
  // ("Fit host to my screen"), which persists "1"; anything else is mirror mode.
  const [fit, setFit] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FIT_KEY) === "1";
    } catch {
      return false;
    }
  });

  const wsRef = useRef<WebSocket | null>(null);
  const terms = useRef<Map<string, TermEntry>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  const ctrlRef = useRef(false);
  const themeRef = useRef<ThemeName>(theme);
  const fontFamilyRef = useRef<FontFamilyId>(fontFamily);
  const lineHeightRef = useRef<number>(lineHeight);
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
  const fitRef = useRef(fit);
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
      entry.term.focus();
      entry.term.scrollToBottom();
    }
  }, []);

  // Two sizing modes, controlled by `fit`:
  //  - fit ON ("Fit host to my screen", default): measure how many cols/rows fit
  //    the browser at the current font, resize THIS xterm to that, and push the
  //    size to the host PTY (a {t:resize} frame). The host produces output at the
  //    browser's width, so the terminal is FULL-SIZE with normal, readable text
  //    even when the desktop pane is tiny. Rendered 1:1 (no scaling). This does
  //    reflow the shared desktop pane - the deliberate trade-off you opt into by
  //    turning this on; only the ACTIVE terminal drives the host.
  //  - fit OFF: never touch the host PTY. Mirror its real size and CSS-scale the
  //    render DOWN to fit (never enlarge), so the desktop is never reflowed; a
  //    small host stays at its native size rather than being blown up huge.
  const fitTerminal = useCallback(
    (id: string | null) => {
      if (!id) return;
      const entry = terms.current.get(id);
      const node = entry?.term.element;
      const host = entry?.el;
      if (!entry || !node || !host) return;
      if (fitRef.current) {
        node.style.transform = "";
        node.style.transformOrigin = "";
        if (id !== activeIdRef.current) return; // only the visible terminal sizes the host
        requestAnimationFrame(() => {
          const live = terms.current.get(id);
          if (!live || live.el !== host || !fitRef.current || id !== activeIdRef.current) return;
          const dims = proposeDims(live.term, host);
          if (!dims) return;
          if (live.term.cols !== dims.cols || live.term.rows !== dims.rows) {
            try {
              live.term.resize(dims.cols, dims.rows);
            } catch {
              /* ignore */
            }
          }
          send({ t: "resize", id, cols: dims.cols, rows: dims.rows });
        });
        return;
      }
      requestAnimationFrame(() => {
        const live = terms.current.get(id);
        if (!live || live.el !== host || fitRef.current) return;
        const el = live.term.element;
        if (!el) return;
        el.style.transformOrigin = "center center";
        el.style.transform = "none"; // measure natural size at 1:1
        const tw = el.offsetWidth;
        const th = el.offsetHeight;
        const cw = host.clientWidth;
        const ch = host.clientHeight;
        if (tw < 2 || th < 2 || cw < 2 || ch < 2) {
          el.style.transform = "";
          return;
        }
        // Downscale-only: shrink a too-big terminal to fit, never enlarge a small
        // one (that made the text huge and blurry).
        el.style.transform = `scale(${Math.min(1, cw / tw, ch / th)})`;
      });
    },
    [send],
  );

  // --- frame handling -----------------------------------------------------
  const writeScrollback = useCallback(
    (id: string, b64: string, cols: number, rows: number) => {
      const bytes = b64 ? b64ToBytes(b64) : new Uint8Array(0);
      const entry = terms.current.get(id);
      if (entry) {
        // In mirror mode (fit OFF) adopt the host PTY's real size. In fit-host
        // mode the browser owns the size (fitTerminal drives it), so don't snap
        // back to the host's size.
        if (!fitRef.current && (entry.term.cols !== cols || entry.term.rows !== rows)) {
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
          // In mirror mode (fit OFF) adopt each host PTY's real size; in fit-host
          // mode the browser owns the size (fitTerminal drives the active one).
          if (!fitRef.current) {
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
          const nextWsById: Record<string, string> = {};
          // Preserve first-seen order + de-dup workspaces by id.
          const wsMap = new Map<string, RemoteWorkspace>();
          for (const it of f.items) {
            nextOrd[it.ptyId] = it.ordinal;
            if (it.state) nextStatus[it.ptyId] = it.state;
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
          setWsById(nextWsById);
          setWorkspaces([...wsMap.values()]);
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

  // font size -> all terminals + persist
  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
    for (const { term } of terms.current.values()) term.options.fontSize = fontSize;
    // Font change alters cell size, so re-scale every terminal in fit mode.
    for (const id of terms.current.keys()) fitTerminal(id);
  }, [fontSize, fitTerminal]);

  const bumpFont = useCallback((delta: number) => setFontSize((f) => clampFont(f + delta)), []);
  const resetFont = useCallback(() => setFontSize(DEFAULT_FONT), []);

  // Font family -> all terminals + persist. Changing the family alters cell
  // width, so re-scale every terminal in fit mode.
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

  // Line spacing -> all terminals + persist (changes row height -> re-fit).
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

  // Fit mode: persist, mirror to the ref, and re-scale every live terminal
  // (turning fit off clears their transforms; turning it on re-fits them).
  useEffect(() => {
    fitRef.current = fit;
    try {
      localStorage.setItem(FIT_KEY, fit ? "1" : "0");
    } catch {
      /* ignore */
    }
    for (const id of terms.current.keys()) fitTerminal(id);
  }, [fit, fitTerminal]);
  const toggleFit = useCallback(() => setFit((v) => !v), []);

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
    bumpFont,
    resetFont,
    fontFamily,
    setFontFamily,
    lineHeight,
    setLineHeight,
    fit,
    toggleFit,
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
    wsById,
    workspaces,
    selectWorkspace,
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
