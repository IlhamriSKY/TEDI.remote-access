import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";

import { IconTerminal, IconAdd, IconClose } from "@/lib/icons";
import { ConfirmModal } from "@/components/ConfirmModal";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SessionMeta } from "@/lib/protocol";
import type { Remote } from "@/hooks/useRemote";

const tabLabel = (s: SessionMeta) => s.title || (s.kind === "ssh" ? "ssh" : "terminal");

// Terminal/SSH tab strip. The active tab carries a short LEFT accent stripe just
// left of the tab icon (matching the TEDI desktop app) plus the terminal
// background, so it reads as current and "joins" the terminal below. SSH tabs
// get a sky accent + badge. Closing a tab asks for confirmation first (it kills
// the process on the host). The trailing "+" opens a fresh terminal on the host.
export function TabBar({ remote }: { remote: Remote }) {
  const { sessions, activeId, setActiveId } = remote;
  const [pendingClose, setPendingClose] = useState<SessionMeta | null>(null);
  if (sessions.length === 0) return null;

  return (
    <>
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
            // Wrapper holds the select button + a sibling close button (a button
            // can't nest inside a button). The close (x) shows on hover on desktop
            // and is always visible on touch (max-md).
            <div
              key={s.id}
              className={cn(
                "group relative flex w-40 shrink-0 items-stretch border-r border-border",
                active ? "bg-background" : "bg-card hover:bg-muted",
              )}
            >
              {active && (
                <span
                  className={cn(
                    "pointer-events-none absolute top-1/2 left-1 z-10 h-4 w-[3px] -translate-y-1/2",
                    ssh ? "bg-[#38bdf8]" : "bg-terminal",
                  )}
                  aria-hidden
                />
              )}
              <button
                role="tab"
                aria-selected={active}
                title={s.cwd || tabLabel(s)}
                onClick={() => setActiveId(s.id)}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 pr-1 pl-3.5 text-xs whitespace-nowrap transition-colors",
                  active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={IconTerminal}
                  size={13}
                  strokeWidth={1.8}
                  className={cn(
                    "shrink-0",
                    running ? "animate-breathe text-warning" : active ? accent : "text-muted-foreground",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-left">{tabLabel(s)}</span>
                {ssh && (
                  <span className="shrink-0 border border-[#38bdf8]/40 px-1 text-[9px] leading-[1.4] tracking-wide text-[#38bdf8] uppercase">
                    ssh
                  </span>
                )}
                {!s.alive && <span className="shrink-0 text-[10px] text-muted-foreground">exited</span>}
              </button>
              <button
                type="button"
                aria-label={`Close ${tabLabel(s)}`}
                title="Close terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingClose(s);
                }}
                className="flex w-6 shrink-0 items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 max-md:w-9 max-md:opacity-100"
              >
                <HugeiconsIcon icon={IconClose} size={12} strokeWidth={2} />
              </button>
            </div>
          );
        })}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="New terminal"
              onClick={() => remote.newTerminal()}
              className="flex w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <HugeiconsIcon icon={IconAdd} size={15} strokeWidth={1.8} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">New terminal</TooltipContent>
        </Tooltip>
      </div>

      {pendingClose && (
        <ConfirmModal
          title="Close terminal"
          danger
          confirmLabel="Close terminal"
          message={
            <>
              Close <span className="font-medium text-foreground">{tabLabel(pendingClose)}</span>? This ends the
              process and closes the tab in TEDI on your computer too.
            </>
          }
          onConfirm={() => remote.closeTerminal(pendingClose.id)}
          onClose={() => setPendingClose(null)}
        />
      )}
    </>
  );
}
