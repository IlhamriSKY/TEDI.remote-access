import { HugeiconsIcon } from "@hugeicons/react";

import { IconTerminal, IconAdd } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

// Terminal/SSH tab strip. The active tab carries a full-height LEFT accent
// stripe (matching the TEDI desktop app) plus the terminal background, so it
// reads as current and "joins" the terminal below. SSH tabs get a sky accent +
// badge. Tabs are uniform width and the content is left-aligned (icon, title,
// trailing status) so the row stays tidy. Horizontally scrollable on narrow
// screens. This is the primary navigation surface.
export function TabBar({ remote }: { remote: Remote }) {
  const { sessions, activeId, setActiveId } = remote;
  if (sessions.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Terminals"
      className="no-scrollbar flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-card"
    >
      {sessions.map((s) => {
        const active = s.id === activeId;
        const ssh = s.kind === "ssh";
        const running = !!remote.busy[s.id];
        const accent = ssh ? "text-[#38bdf8]" : "text-terminal";
        return (
          <button
            key={s.id}
            role="tab"
            aria-selected={active}
            title={s.cwd || s.title || (ssh ? "ssh" : "terminal")}
            onClick={() => setActiveId(s.id)}
            className={cn(
              "group relative flex w-40 shrink-0 items-center gap-2 border-r border-border pl-3.5 pr-2.5 text-xs whitespace-nowrap transition-colors",
              active
                ? "bg-background text-foreground"
                : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {active && (
              <span
                className={cn(
                  "pointer-events-none absolute inset-y-0 left-0 w-0.5",
                  ssh ? "bg-[#38bdf8]" : "bg-terminal",
                )}
                aria-hidden
              />
            )}
            <HugeiconsIcon
              icon={IconTerminal}
              size={13}
              strokeWidth={1.8}
              className={cn(
                "shrink-0",
                running ? "animate-breathe text-warning" : active ? accent : "text-muted-foreground",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-left">{s.title || (ssh ? "ssh" : "terminal")}</span>
            {ssh && (
              <span className="shrink-0 border border-[#38bdf8]/40 px-1 text-[9px] leading-[1.4] tracking-wide text-[#38bdf8] uppercase">
                ssh
              </span>
            )}
            {!s.alive && <span className="shrink-0 text-[10px] text-muted-foreground">exited</span>}
          </button>
        );
      })}
      <button
        type="button"
        title="New terminal"
        aria-label="New terminal"
        onClick={() => remote.newTerminal()}
        className="flex w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <HugeiconsIcon icon={IconAdd} size={15} strokeWidth={1.8} />
      </button>
    </div>
  );
}
