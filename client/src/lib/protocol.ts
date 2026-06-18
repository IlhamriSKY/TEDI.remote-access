export type SessionKind = "pty" | "ssh";

export type SessionMeta = {
  id: string;
  title?: string;
  cwd?: string | null;
  cols: number;
  rows: number;
  alive: boolean;
  /** "pty" (local terminal, default) or "ssh" (remote SSH tab). */
  kind?: SessionKind;
};

export type ServerFrame =
  | { t: "host"; status: "online" | "offline"; name?: string }
  | { t: "sessions"; items: SessionMeta[] }
  | { t: "attached"; id: string; scrollback: string; cols: number; rows: number; alive: boolean }
  | { t: "data"; id: string; b64: string }
  | { t: "exit"; id: string; code: number }
  | { t: "pong" };

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

export const TERMINAL_FONT = '"JetBrains Mono", ui-monospace, Menlo, Consolas, "Courier New", monospace';
