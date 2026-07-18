export type SessionKind = "pty" | "ssh";

/** Per-terminal AI-CLI run state, mirrored from the desktop app so the web shows
 *  the same working indicator on EVERY tab (not just the focused one). The
 *  browser can't derive this itself — PowerShell emits no OSC 133 C, and only
 *  the host sees commands started from the desktop. */
export type AiCliState = "idle" | "working" | "blocking";

/** A workspace the browser can switch between, derived from the tabmeta the host
 *  sends. Only workspaces with at least one live (mirrored) terminal appear — a
 *  workspace the desktop never opened this run has no live PTY to mirror. */
export type RemoteWorkspace = { id: string; name: string; active: boolean };

export type SessionMeta = {
  id: string;
  title?: string;
  cwd?: string | null;
  cols: number;
  rows: number;
  alive: boolean;
  /** "pty" (local terminal, default) or "ssh" (remote SSH tab). */
  kind?: SessionKind;
  /** Host creation time (ms). Drives stable tab order. */
  createdAt?: number;
};

/** A saved SSH host the browser may OPEN (never create). Secret-free metadata;
 *  the SSH password/key stay in the host's keychain. Only PINNED hosts (already
 *  verified on the desktop) are sent, since a first connect needs human host-key
 *  verification a web user can't do. */
export type SavedSshConn = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  pinned: boolean;
};

export type ServerFrame =
  | { t: "host"; status: "online" | "offline"; name?: string }
  | { t: "sessions"; items: SessionMeta[] }
  | { t: "attached"; id: string; scrollback: string; cols: number; rows: number; alive: boolean }
  | { t: "data"; id: string; b64: string }
  | { t: "exit"; id: string; code: number }
  | { t: "pong" }
  // Sent by the host extension (via the relay): the desktop app's tab numbers
  // keyed by daemon ptyId, so the browser labels tabs the same as the app. Each
  // item also carries the tab's AI-CLI state (idle/working/blocking) so the
  // browser shows the working indicator on every tab, the host's OSC 0/2 window
  // `title` (the running agent's task) so the tab reads the same as the desktop
  // instead of a stale/blank local capture, and the owning workspace
  // (wsId/wsName/wsActive) so the browser groups tabs into the same workspaces.
  | {
      t: "tabmeta";
      items: {
        ptyId: string;
        ordinal: number;
        state?: AiCliState;
        title?: string;
        wsId?: string;
        wsName?: string;
        wsActive?: boolean;
      }[];
    }
  // Saved SSH hosts the browser may open (secret-free, pinned-only).
  | { t: "ssh-conns"; items: SavedSshConn[] };

// Frames the browser SENDS to the relay (forwarded to the host agent + SSH
// bridge), built inline via `send` in useRemote:
//   { t:"hello" } | { t:"ping" } | { t:"input"; id; b64 }
//   | { t:"open"; cols; rows } | { t:"close"; id }
//   | { t:"resize"; id; cols; rows }
// "resize" is sent ONLY in "Fit host to my screen" mode (fit ON), for the active
// terminal, to size the host PTY to the browser so the view is full-size at
// normal text. This DOES reflow the shared desktop pane - the deliberate trade-
// off of that mode. In mirror mode (fit OFF) the browser adopts the host's real
// cols/rows and scales DOWN to fit client-side, never touching the host.
//
// Opening a SAVED SSH connection is deliberately NOT a WS frame: the browser
// POSTs /api/open-ssh with the user's LOGIN password (re-auth), the relay
// verifies it and emits the open-ssh frame to the host itself. So the action is
// gated server-side and a browser can't trigger SSH by sending a raw WS frame.

// xterm themes mirroring TEDI's dark + light ANSI palettes (globals.css).
export const TERMINAL_THEME_DARK = {
  background: "#1e1e1e",
  foreground: "#cccccc",
  cursor: "#cccccc",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#18181b",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#fafafa",
} as const;

export const TERMINAL_THEME_LIGHT = {
  background: "#ffffff",
  foreground: "#1e2227",
  cursor: "#1e2227",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  black: "#3f3f46",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#b08800",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#a1a1aa",
  brightBlack: "#71717a",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#ca8a04",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#52525b",
} as const;

export type ThemeName = "light" | "dark";

export const TERMINAL_FONT =
  '"JetBrains Mono", ui-monospace, Menlo, Consolas, "Courier New", monospace';

// User-selectable terminal fonts (Settings). "JetBrains Mono" is bundled; the
// rest fall back to whatever monospace the OS provides.
export type FontFamilyId = "jetbrains" | "system" | "menlo" | "consolas" | "courier";

export const FONT_FAMILIES: { id: FontFamilyId; label: string; stack: string }[] = [
  { id: "jetbrains", label: "JetBrains Mono", stack: TERMINAL_FONT },
  {
    id: "system",
    label: "System monospace",
    stack: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  {
    id: "menlo",
    label: "Menlo / Monaco",
    stack: 'Menlo, Monaco, ui-monospace, "Courier New", monospace',
  },
  { id: "consolas", label: "Consolas", stack: 'Consolas, "Courier New", ui-monospace, monospace' },
  { id: "courier", label: "Courier New", stack: '"Courier New", monospace' },
];

export const DEFAULT_FONT_FAMILY: FontFamilyId = "jetbrains";

export function fontStack(id: FontFamilyId): string {
  return (FONT_FAMILIES.find((f) => f.id === id) ?? FONT_FAMILIES[0]).stack;
}

// Line-spacing presets (xterm `lineHeight` multiplier).
export const LINE_SPACINGS: { label: string; value: number }[] = [
  { label: "Compact", value: 1.0 },
  { label: "Normal", value: 1.2 },
  { label: "Relaxed", value: 1.4 },
];
export const DEFAULT_LINE_HEIGHT = 1.0;
