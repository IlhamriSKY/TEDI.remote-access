import { useEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";

import { IconTerminal } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

// Every mirrored session keeps a mounted xterm so switching tabs is instant and
// background terminals stay live. Inactive panes use `invisible
// pointer-events-none` (visibility, not display:none) so xterm can still
// measure glyph metrics correctly. The browser always mirrors each terminal at
// the host's real cols/rows. In "fit to window" mode the active terminal is
// CSS-scaled (transform) to fill this container -- the host PTY is never resized,
// so the desktop terminal is never reflowed; otherwise it renders 1:1 and the
// pane scrolls when the terminal is larger than the screen.
export function TerminalHost({ remote }: { remote: Remote }) {
  const { sessions, activeId, fit, attachTerminal, focusActive, fitTerminal } = remote;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    focusActive();
    fitTerminal(activeId);
  }, [activeId, focusActive, fitTerminal]);

  // Re-fit the active terminal when the viewport/container resizes (fit mode).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let t: number | undefined;
    const ro = new ResizeObserver(() => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => fitTerminal(activeId), 150);
    });
    ro.observe(el);
    return () => {
      if (t) window.clearTimeout(t);
      ro.disconnect();
    };
  }, [activeId, fitTerminal]);

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 overflow-hidden bg-background"
      onPointerDown={focusActive}
    >
      {sessions.map((s) => (
        <div
          key={s.id}
          ref={(el) => {
            if (el) attachTerminal(s.id, el, s);
          }}
          className={cn(
            // inset-x-3 gives a tidy left/right gutter; measuring the inset pane
            // (not a padded one) keeps the fit-mode scale math correct.
            "absolute inset-y-0 inset-x-3",
            // Fit mode centers the CSS-scaled terminal and clips the overflow;
            // otherwise render 1:1 and let the pane scroll.
            fit ? "flex items-center justify-center overflow-hidden" : "overflow-auto",
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
