import { useEffect, useRef } from "react";

import { IconTerminal } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

// Every mirrored session keeps a mounted xterm so switching tabs is instant and
// background terminals stay live. Inactive panes use `invisible
// pointer-events-none` (visibility, not display:none) so xterm can still measure
// glyph metrics correctly. Each terminal is drawn at the HOST's real cols/rows in
// the largest whole font size that fits the pane (see lib/fit.ts); resizing here
// only ever changes that font size, the host PTY is never touched.
export function TerminalHost({ remote }: { remote: Remote }) {
  const { sessions, activeId, attachTerminal, focusActive, fitTerminal } = remote;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    focusActive();
    fitTerminal(activeId);
  }, [activeId, focusActive, fitTerminal]);

  // Re-scale the active terminal when the viewport/container resizes, including
  // on a real window resize / orientation change so rotating a phone re-fills
  // the screen immediately. CSS scale only; the host PTY keeps its own size.
  useEffect(() => {
    const el = containerRef.current;
    let t: number | undefined;
    const refit = () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => fitTerminal(activeId), 120);
    };
    const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(refit) : null;
    ro?.observe(el!);
    window.addEventListener("resize", refit);
    window.addEventListener("orientationchange", refit);
    return () => {
      if (t) window.clearTimeout(t);
      ro?.disconnect();
      window.removeEventListener("resize", refit);
      window.removeEventListener("orientationchange", refit);
    };
  }, [activeId, fitTerminal]);

  return (
    <div
      ref={containerRef}
      className="bg-background relative min-h-0 flex-1 overflow-hidden"
      onPointerDown={focusActive}
    >
      {sessions.map((s) => (
        <div
          key={s.id}
          ref={(el) => {
            if (el) attachTerminal(s.id, el, s);
          }}
          className={cn(
            // Near-full-bleed (a 6px inset for breathing room). The inset is set
            // via positioning, not padding, so clientWidth/Height measure the
            // real available box (the fit math needs the true size).
            "absolute inset-1.5",
            // Top-left, never centred: a terminal reads from its first cell, and
            // the fit leaves any slack at the bottom-right where the pane and the
            // xterm background are the same colour, so it does not show. Centring
            // would also make the overflow below unreachable — flex splits it
            // across both edges and you cannot scroll past the start.
            "flex items-start justify-start",
            // Pans when the grid cannot fit: with Auto off the user picked a size
            // bigger than the pane, and even with it on a very wide host bottoms
            // out at the readable floor. Scrollbars are hidden rather than shown
            // so their appearing cannot shrink the box the fit just measured.
            "no-scrollbar overflow-auto overscroll-contain",
            s.id === activeId ? "visible z-10" : "pointer-events-none invisible",
          )}
        />
      ))}
      {sessions.length === 0 && (
        <EmptyState hostOnline={remote.hostOnline} connecting={remote.conn !== "open"} />
      )}
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
      <span className="border-border bg-card text-muted-foreground flex size-12 items-center justify-center border">
        <IconTerminal size={22} strokeWidth={1.6} />
      </span>
      <p className="text-muted-foreground max-w-xs text-xs">{msg}</p>
    </div>
  );
}
