import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { b64ToBytes, strToB64 } from "@/lib/b64";
import { TERMINAL_FONT, TERMINAL_THEME, type ServerFrame, type SessionMeta } from "@/lib/protocol";

export type ConnState = "connecting" | "open" | "closed";

type TermEntry = { term: Terminal; el: HTMLElement };

const FONT_KEY = "tedi-remote-fontsize";
const clampFont = (n: number) => Math.min(28, Math.max(8, n || 13));

export type Remote = ReturnType<typeof useRemote>;

export function useRemote() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = checking
  const [totpRequired, setTotpRequired] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [hostOnline, setHostOnline] = useState(false);
  const [hostName, setHostName] = useState("");
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(() => clampFont(Number(localStorage.getItem(FONT_KEY))));
  const [ctrlSticky, setCtrlSticky] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const terms = useRef<Map<string, TermEntry>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  const ctrlRef = useRef(false);
  const pending = useRef<Map<string, Uint8Array[]>>(new Map());
  const reconnectMs = useRef(1000);
  const hbTimer = useRef<number | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const mounted = useRef(true);

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
        fontFamily: TERMINAL_FONT,
        theme: TERMINAL_THEME,
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

  // --- frame handling -----------------------------------------------------
  const writeScrollback = useCallback((id: string, b64: string, cols: number, rows: number) => {
    const bytes = b64 ? b64ToBytes(b64) : new Uint8Array(0);
    const entry = terms.current.get(id);
    if (entry) {
      if (entry.term.cols !== cols || entry.term.rows !== rows) {
        try {
          entry.term.resize(cols, rows);
        } catch {
          /* ignore */
        }
      }
      entry.term.reset();
      if (bytes.length) entry.term.write(bytes);
    } else {
      pending.current.set(id, bytes.length ? [bytes] : []);
    }
  }, []);

  const handleFrame = useCallback(
    (f: ServerFrame) => {
      switch (f.t) {
        case "host":
          setHostOnline(f.status === "online");
          if (f.name) setHostName(f.name);
          break;
        case "sessions": {
          const items = f.items;
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
          const live = new Set(items.map((i) => i.id));
          for (const id of [...terms.current.keys()]) if (!live.has(id)) disposeTerminal(id);
          setSessions(items);
          setActiveId((cur) => (cur && live.has(cur) ? cur : (items[0]?.id ?? null)));
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
        case "pong":
          break;
      }
    },
    [disposeTerminal, writeScrollback],
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

  // boot: check session, then connect
  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const r = await fetch("/api/me", { credentials: "same-origin" });
        if (r.ok) {
          const j = (await r.json()) as { totp?: boolean };
          setTotpRequired(!!j.totp);
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
  }, [fontSize]);

  const bumpFont = useCallback((delta: number) => setFontSize((f) => clampFont(f + delta)), []);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
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

  return {
    authed,
    totpRequired,
    conn,
    hostOnline,
    hostName,
    sessions,
    activeId,
    setActiveId,
    fontSize,
    bumpFont,
    attachTerminal,
    focusActive,
    sendInput,
    sendToActive,
    ctrlSticky,
    setCtrlSticky,
    login,
    logout,
  };
}

// Open the terminal on an element, tolerating repeated calls (StrictMode / tab
// remounts). xterm throws if open() runs twice on the same element, so guard.
function term_open(term: Terminal, el: HTMLElement) {
  if ((term as unknown as { element?: HTMLElement }).element) return;
  term.open(el);
}
