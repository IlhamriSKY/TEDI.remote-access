import { useEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";

import { IconTerminal } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

// Every mirrored session keeps a mounted xterm so switching tabs is instant and
// background terminals stay live. Inactive panes use `invisible
// pointer-events-none` (visibility, not display:none) so xterm can still measure
// glyph metrics correctly. In "Fit host to my screen" mode (the default) the
// active terminal is sized to the browser and the host PTY is resized to match,
// so the view fills the pane at normal text size (it reflows the desktop pane,
// the opt-in trade-off); just clip. Fit off mirrors the host's real size and
// CSS-scales DOWN to fit, so center it and clip.
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
            // real available box (the fit-to-window scale math needs the true size).
            "absolute inset-1.5",
            // fit ON ("Fit host to my screen"): the xterm is sized to fill this
            // box (the host PTY is resized to match), so just clip. fit OFF
            // (mirror): the xterm is at the host size and CSS-scaled down, so
            // center it and clip the overflow.
            fit ? "overflow-hidden" : "flex items-center justify-center overflow-hidden",
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
        <HugeiconsIcon icon={IconTerminal} size={22} strokeWidth={1.6} />
      </span>
      <p className="text-muted-foreground max-w-xs text-xs">{msg}</p>
    </div>
  );
}
