import { useEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";

import { IconTerminal } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

// Every mirrored session keeps a mounted xterm so switching tabs is instant and
// background terminals stay live. Inactive panes use `invisible
// pointer-events-none` (visibility, not display:none) so xterm can still
// measure glyph metrics correctly. The browser always mirrors each terminal at
// the host's real cols/rows -- it never resizes the shared PTY, so the desktop
// terminal is never reflowed even when its pane on the PC is tiny. In "fit to
// window" mode (the default) the active terminal is CSS-scaled (transform) to
// fill the WHOLE pane here, so the web view stays full-screen no matter how
// small the host's pane is. Fit off renders 1:1 and the pane scrolls.
export function TerminalHost({ remote }: { remote: Remote }) {
  const { sessions, activeId, fit, attachTerminal, focusActive, fitTerminal } = remote;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    focusActive();
    fitTerminal(activeId);
  }, [activeId, focusActive, fitTerminal]);

  // Re-fit the active terminal when the viewport/container resizes (fit mode).
  // Also re-fit on a real window resize/orientation change so rotating a phone
  // or resizing the browser re-fills the screen immediately.
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
            // Near-full-bleed (a 6px inset for breathing room). The inset is set
            // via positioning, not padding, so clientWidth/Height measure the
            // real available box (proposeDims / scale math need the true size).
            "absolute inset-1.5",
            // fit ON ("fit host to my screen"): the xterm is sized to fill this
            // box, so just clip. fit OFF (mirror): the xterm is at the host size
            // and CSS-scaled, so center it and clip the overflow.
            fit ? "overflow-hidden" : "flex items-center justify-center overflow-hidden",
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
