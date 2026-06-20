import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { b64ToBytes, strToB64 } from "@/lib/b64";
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_LINE_HEIGHT,
  FONT_FAMILIES,
  fontStack,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
  type FontFamilyId,
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
const FIT_KEY = "tedi-remote-fit";
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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(() => clampFont(Number(localStorage.getItem(FONT_KEY))));
  const [fontFamily, setFontFamily] = useState<FontFamilyId>(getInitialFontFamily);
  const [lineHeight, setLineHeightState] = useState<number>(getInitialLineHeight);
  const [ctrlSticky, setCtrlSticky] = useState(false);
  const [user, setUser] = useState("");
  const [theme, setThemeState] = useState<ThemeName>(getInitialTheme);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [fit, setFit] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FIT_KEY) !== "0";
    } catch {
      return true;
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

  // The browser is a PURE MIRROR: it ALWAYS renders each terminal at the host
  // PTY's real cols/rows and NEVER sends a resize, so nothing the user does in the
  // web can reflow the shared desktop terminal. The `fit` toggle only changes how
  // THIS browser scales its own rendering:
  //  - fit ON ("Fit to window", default): CSS-scale the mirrored terminal to fill
  //    the pane, so it's full-size in the browser even when the desktop pane is
  //    tiny (e.g. a 4-way split). Only a local transform - the host is untouched.
  //  - fit OFF: render at the host's natural 1:1 size (no scaling); the pane clips.
  const fitTerminal = useCallback((id: string | null) => {
    if (!id) return;
    const entry = terms.current.get(id);
    const node = entry?.term.element;
    const host = entry?.el;
    if (!entry || !node || !host) return;
    // Fit OFF: show the mirrored terminal at its natural 1:1 size.
    if (!fitRef.current) {
      node.style.transform = "";
      node.style.transformOrigin = "";
      return;
    }
    // Fit ON: CSS-scale the mirrored terminal to fill the pane. The terminal keeps
    // the HOST's real cols/rows (we never resize the host), so only this browser's
    // rendering scales - the desktop is never reflowed. Measure at 1:1, then fit.
    requestAnimationFrame(() => {
      const live = terms.current.get(id);
      if (!live || live.el !== host || !fitRef.current) return;
      const el = live.term.element;
      if (!el) return;
      el.style.transformOrigin = "center center";
      el.style.transform = "none";
      const tw = el.offsetWidth;
      const th = el.offsetHeight;
      const cw = host.clientWidth;
      const ch = host.clientHeight;
      if (tw < 2 || th < 2 || cw < 2 || ch < 2) {
        el.style.transform = "";
        return;
      }
      el.style.transform = `scale(${Math.min(cw / tw, ch / th)})`;
    });
  }, []);

  // --- frame handling -----------------------------------------------------
  const writeScrollback = useCallback((id: string, b64: string, cols: number, rows: number) => {
    const bytes = b64 ? b64ToBytes(b64) : new Uint8Array(0);
    const entry = terms.current.get(id);
    if (entry) {
      // Always adopt the host PTY's real size - the browser mirrors the host and
      // never drives its own size, so the desktop is never reflowed.
      if (entry.term.cols !== cols || entry.term.rows !== rows) {
        try {
          entry.term.resize(cols, rows);
        } catch {
          /* ignore */
        }
      }
      entry.term.reset();
      if (bytes.length) entry.term.write(bytes);
      fitTerminal(id);
    } else {
      pending.current.set(id, bytes.length ? [bytes] : []);
    }
  }, [fitTerminal]);

  const handleFrame = useCallback(
    (f: ServerFrame) => {
      switch (f.t) {
        case "host":
          setHostOnline(f.status === "online");
          if (f.name) setHostName(f.name);
          break;
        case "sessions": {
          const items = f.items;
          // Always adopt each host PTY's real size - the browser is a pure mirror
          // and never drives its own size, so the desktop is never reflowed.
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
          const fresh = pendingNewIds.current && items.find((i) => !pendingNewIds.current!.has(i.id));
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
              ? prev.map((s) => (s.id === f.id ? { ...s, cols: f.cols, rows: f.rows, alive: f.alive } : s))
              : [...prev, { id: f.id, cols: f.cols, rows: f.rows, alive: f.alive, title: "terminal" }],
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
            entry.term.write(new TextEncoder().encode(`\r\n\x1b[90m[process exited ${f.code}]\x1b[0m\r\n`));
          }
          setSessions((prev) => prev.map((s) => (s.id === f.id ? { ...s, alive: false } : s)));
          break;
        }
        case "tabmeta": {
          const next: Record<string, number> = {};
          for (const it of f.items) next[it.ptyId] = it.ordinal;
          setOrdinals(next);
          break;
        }
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
      reconnectMs.current = 1000;
      send({ t: "hello" });
      if (hbTimer.current) window.clearInterval(hbTimer.current);
      hbTimer.current = window.setInterval(() => send({ t: "ping" }), 25000);
    };
    ws.onmessage = (ev) => {
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
    async (user: string, pass: string, otp: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const r = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ user, pass, otp }),
        });
        if (r.ok) {
          setUser(user);
          setAuthed(true);
          connect();
          return { ok: true };
        }
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: j.error || (r.status === 429 ? "Too many attempts" : "Sign in failed") };
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
    async (current: string, next: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const r = await fetch("/api/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ current, new: next }),
        });
        if (r.ok) return { ok: true };
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: j.error || (r.status === 429 ? "Too many attempts" : "Could not change password") };
      } catch {
        return { ok: false, error: "Network error" };
      }
    },
    [],
  );

  // boot: check session, then connect
  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const r = await fetch("/api/me", { credentials: "same-origin" });
        if (r.ok) {
          const j = (await r.json()) as { totp?: boolean; user?: string };
          setTotpRequired(!!j.totp);
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
  const newTerminal = useCallback(() => {
    const id = activeIdRef.current;
    const e = id ? terms.current.get(id) : null;
    const cols = e?.term.cols ?? 80;
    const rows = e?.term.rows ?? 24;
    pendingNewIds.current = new Set(sessionsRef.current.map((s) => s.id));
    if (pendingNewTimer.current) window.clearTimeout(pendingNewTimer.current);
    pendingNewTimer.current = window.setTimeout(() => {
      pendingNewIds.current = null;
    }, 5000);
    send({ t: "open", cols, rows });
  }, [send]);

  // Permanently close (kill) a tab. The host kills the daemon PTY (or the SSH
  // bridge runs ssh_close), which closes it in the desktop app too; the
  // authoritative "exit"/"sessions" frames then drop the tab. Optimistically
  // mark it dead so the UI reacts immediately (a later sessions frame corrects
  // it if the close didn't take).
  const closeTerminal = useCallback(
    (id: string) => {
      send({ t: "close", id });
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, alive: false } : s)));
    },
    [send],
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
    closeTerminal,
    reorderTabs,
    ctrlSticky,
    setCtrlSticky,
    user,
    theme,
    setTheme,
    toggleTheme,
    busy,
    login,
    logout,
    changePassword,
  };
}

// Open the terminal on an element, tolerating repeated calls (StrictMode / tab
// remounts). xterm throws if open() runs twice on the same element, so guard.
function term_open(term: Terminal, el: HTMLElement) {
  if ((term as unknown as { element?: HTMLElement }).element) return;
  term.open(el);
}
