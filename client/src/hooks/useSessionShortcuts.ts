import { useEffect } from "react";

import type { Remote } from "@/hooks/useRemote";

/**
 * Keyboard navigation between mirrored terminals.
 *
 * The chords are constrained from BOTH sides, which rules out most of the
 * obvious ones:
 *
 * - The terminal must keep every key a TUI needs. Claude Code binds bare
 *   Shift+Tab (cycle modes), Esc and Ctrl+C; readline owns bare Ctrl+<letter>
 *   and bare Alt+<letter/digit>. Stealing any of those would break the thing
 *   this client exists to drive.
 * - The BROWSER reserves Ctrl+Tab and Alt+Arrow for its own tab/history
 *   navigation and will not let a page preventDefault them, so the desktop
 *   app's Ctrl+Tab / Ctrl+Shift+Tab pair cannot be reused here.
 *
 * Ctrl+Shift+Arrow and Ctrl+Alt+Digit are free on both sides. Ctrl+Shift+* is
 * also the family this client already uses for copy, and the family TEDI itself
 * reserves for terminal-UI actions.
 *
 * Listening in the CAPTURE phase on window is what makes this work at all: xterm
 * reads keys off its own textarea, so a bubble-phase listener would fire after
 * the terminal had already encoded Ctrl+Shift+Arrow as a CSI sequence and sent
 * it to the host.
 */
export function useSessionShortcuts(remote: Remote) {
  const { sessions, activeId, setActiveId } = remote;
  useEffect(() => {
    if (sessions.length < 2) return; // nothing to navigate between
    const step = (delta: number) => {
      const i = sessions.findIndex((s) => s.id === activeId);
      const from = i < 0 ? 0 : i;
      // Wraps, like the desktop's tab.next/tab.prev.
      setActiveId(sessions[(from + delta + sessions.length) % sessions.length].id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      // "A text field has focus" cannot be the test: xterm delivers every
      // terminal keystroke through its OWN hidden textarea, so that check would
      // disable these shortcuts exactly where they are meant to work. Skip only
      // fields OUTSIDE a terminal — today that is the inline tab-rename box,
      // which cannot defend itself: it sees keys in the bubble phase, and this
      // listener has already run by then.
      const el = e.target as HTMLElement | null;
      if (
        el &&
        typeof el.closest === "function" &&
        !el.closest(".xterm") &&
        (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA")
      ) {
        return;
      }
      let hit = false;
      if (e.shiftKey && !e.altKey) {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") ((hit = true), step(1));
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") ((hit = true), step(-1));
      } else if (e.altKey && !e.shiftKey) {
        // `code`, not `key`: with Alt held the produced character is
        // layout-dependent (and on some layouts not a digit at all).
        const m = /^Digit([1-9])$/.exec(e.code);
        if (m) {
          const target = sessions[Number(m[1]) - 1];
          if (target) {
            hit = true;
            setActiveId(target.id);
          } else {
            hit = true; // swallow it anyway; a stray Alt+8 must not reach the PTY
          }
        }
      }
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sessions, activeId, setActiveId]);
}

/** Rendered in Settings so the chords are discoverable rather than folklore. */
export const SESSION_SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "Ctrl+Shift+→", label: "Next terminal" },
  { keys: "Ctrl+Shift+←", label: "Previous terminal" },
  { keys: "Ctrl+Alt+1…9", label: "Jump to terminal" },
  { keys: "Ctrl+Shift+C", label: "Copy selection" },
  { keys: "Ctrl+V", label: "Paste" },
];
