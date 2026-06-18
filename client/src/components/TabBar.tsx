import { HugeiconsIcon } from "@hugeicons/react";

import { IconTerminal } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

// Terminal/SSH tab strip. The active tab carries a top stripe and the terminal
// background colour so it visually "joins" the terminal below, making the
// current tab unmistakable. SSH tabs get a sky stripe + badge so local vs
// remote is obvious. Horizontally scrollable on narrow screens. This is the
// primary navigation surface.
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
        return (
          <button
            key={s.id}
            role="tab"
            aria-selected={active}
            title={s.cwd || s.title || (ssh ? "ssh" : "terminal")}
            onClick={() => setActiveId(s.id)}
            className={cn(
              "relative flex max-w-[220px] min-w-[120px] items-center gap-1.5 border-r border-border px-3 text-xs whitespace-nowrap transition-colors",
              active
                ? "bg-background text-foreground"
                : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {active && (
              <span
                className={cn("absolute inset-x-0 top-0 h-0.5", ssh ? "bg-[#38bdf8]" : "bg-terminal")}
                aria-hidden
              />
            )}
            <HugeiconsIcon
              icon={IconTerminal}
              size={13}
              strokeWidth={1.8}
              className={cn(
                running
                  ? "animate-breathe text-warning"
                  : active
                    ? ssh
                      ? "text-[#38bdf8]"
                      : "text-terminal"
                    : "text-muted-foreground",
              )}
            />
            <span className="truncate">{s.title || (ssh ? "ssh" : "terminal")}</span>
            {ssh && (
              <span className="border border-[#38bdf8]/40 px-1 text-[9px] tracking-wide text-[#38bdf8] uppercase">
                ssh
              </span>
            )}
            {!s.alive && <span className="ml-auto text-[10px] text-muted-foreground">exited</span>}
          </button>
        );
      })}
    </div>
  );
}
