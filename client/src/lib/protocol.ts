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

// xterm theme mirroring TEDI's dark ANSI palette (globals.css --tedi-ansi-*).
export const TERMINAL_THEME = {
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

export const TERMINAL_FONT = '"JetBrains Mono", ui-monospace, Menlo, Consolas, "Courier New", monospace';
