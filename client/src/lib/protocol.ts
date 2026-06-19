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
  /** Host creation time (ms). Drives stable tab order. */
  createdAt?: number;
};

export type ServerFrame =
  | { t: "host"; status: "online" | "offline"; name?: string }
  | { t: "sessions"; items: SessionMeta[] }
  | { t: "attached"; id: string; scrollback: string; cols: number; rows: number; alive: boolean }
  | { t: "data"; id: string; b64: string }
  | { t: "exit"; id: string; code: number }
  | { t: "pong" }
  // Sent by the host extension (via the relay): the desktop app's tab numbers
  // keyed by daemon ptyId, so the browser labels tabs the same as the app.
  | { t: "tabmeta"; items: { ptyId: string; ordinal: number }[] };

// Frames the browser SENDS to the relay (forwarded to the host agent + SSH
// bridge), built inline via `send` in useRemote:
//   { t:"hello" } | { t:"ping" } | { t:"input"; id; b64 }
//   | { t:"open"; cols; rows } | { t:"close"; id }
// ("resize" is no longer sent: the browser scales to fit client-side.)

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

// User-selectable terminal fonts (Settings). "JetBrains Mono" is bundled; the
// rest fall back to whatever monospace the OS provides.
export type FontFamilyId = "jetbrains" | "system" | "menlo" | "consolas" | "courier";

export const FONT_FAMILIES: { id: FontFamilyId; label: string; stack: string }[] = [
  { id: "jetbrains", label: "JetBrains Mono", stack: TERMINAL_FONT },
  { id: "system", label: "System monospace", stack: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  { id: "menlo", label: "Menlo / Monaco", stack: 'Menlo, Monaco, ui-monospace, "Courier New", monospace' },
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
