import { useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";

import { IconTerminal } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

// Every mirrored session keeps a mounted xterm so switching tabs is instant and
// background terminals stay live. Inactive panes use `invisible
// pointer-events-none` (visibility, not display:none) so xterm can still
// measure glyph metrics correctly. Size-follows the host, so wider-than-screen
// terminals scroll horizontally (use the font controls to shrink on mobile).
export function TerminalHost({ remote }: { remote: Remote }) {
  const { sessions, activeId, attachTerminal, focusActive } = remote;

  useEffect(() => {
    focusActive();
  }, [activeId, focusActive]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-background" onPointerDown={focusActive}>
      {sessions.map((s) => (
        <div
          key={s.id}
          ref={(el) => {
            if (el) attachTerminal(s.id, el, s);
          }}
          className={cn(
            "absolute inset-0 overflow-auto p-1.5",
            s.id === activeId ? "visible z-10" : "invisible pointer-events-none",
          )}
        />
      ))}
      {sessions.length === 0 && <EmptyState hostOnline={remote.hostOnline} connecting={remote.conn !== "open"} />}
    </div>
  );
}

function EmptyState({ hostOnline, connecting }: { hostOnline: boolean; connecting: boolean }) {
  const msg = connecting
    ? "Connecting to the relay..."
    : hostOnline
      ? "No terminals open on the host yet. Open a terminal (or SSH tab) in TEDI."
      : "Host is offline. Open TEDI on your PC to connect.";
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex size-12 items-center justify-center border border-border bg-card text-muted-foreground">
        <HugeiconsIcon icon={IconTerminal} size={22} strokeWidth={1.6} />
      </span>
      <p className="max-w-xs text-xs text-muted-foreground">{msg}</p>
    </div>
  );
}
