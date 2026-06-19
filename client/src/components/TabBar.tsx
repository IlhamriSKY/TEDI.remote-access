import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";

import { IconTerminal, IconAdd, IconClose } from "@/lib/icons";
import { ConfirmModal } from "@/components/ConfirmModal";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SessionMeta } from "@/lib/protocol";
import type { Remote } from "@/hooks/useRemote";

const tabLabel = (s: SessionMeta) => s.title || (s.kind === "ssh" ? "ssh" : "terminal");

// Terminal/SSH tab strip. Distinct from the terminal area (bg-muted vs
// bg-background) so the chrome reads separately. Each tab shows its position
// number (matching the desktop app's left-to-right order). Tabs are
// drag-to-reorder. Closing a tab confirms first (it kills the process on the
// host, and closes the matching tab in the desktop app too).
export function TabBar({ remote }: { remote: Remote }) {
  const { sessions, activeId, setActiveId } = remote;
  const [pendingClose, setPendingClose] = useState<SessionMeta | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  if (sessions.length === 0) return null;

  return (
    <>
      <div
        role="tablist"
        aria-label="Terminals"
        className="no-scrollbar flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-muted"
      >
        {sessions.map((s, idx) => {
          const active = s.id === activeId;
          const ssh = s.kind === "ssh";
          const running = !!remote.busy[s.id];
          const accent = ssh ? "text-[#38bdf8]" : "text-terminal";
          return (
            <div
              key={s.id}
              draggable
              onDragStart={(e) => {
                setDragId(s.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragId && dragId !== s.id && overId !== s.id) setOverId(s.id);
              }}
              onDragLeave={() => setOverId((o) => (o === s.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) remote.reorderTabs(dragId, s.id);
                setDragId(null);
                setOverId(null);
              }}
              className={cn(
                "group relative flex w-40 shrink-0 items-stretch border-r border-border transition-colors",
                active ? "bg-background" : "hover:bg-background/60",
                dragId === s.id && "opacity-40",
                overId === s.id && "before:absolute before:inset-y-0 before:left-0 before:z-20 before:w-0.5 before:bg-primary",
              )}
            >
              {active && (
                <span
                  className={cn(
                    "pointer-events-none absolute inset-x-0 top-0 z-10 h-[2px]",
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
                  "flex min-w-0 flex-1 items-center gap-1.5 pr-1 pl-2.5 text-xs whitespace-nowrap transition-colors",
                  active ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "shrink-0 text-[10px] tabular-nums",
                    active ? accent : "text-muted-foreground/70",
                  )}
                >
                  {idx + 1}
                </span>
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
              className="flex w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
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
