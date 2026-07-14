import { IconDown, IconLeft, IconRight, IconUp, type LucideIcon } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import type { Remote } from "@/hooks/useRemote";

const ESC = String.fromCharCode(27);
const ETX = String.fromCharCode(3); // ^C
const TAB = String.fromCharCode(9);

type Key =
  | { kind: "ctrl" }
  | { kind: "icon"; id: string; icon: LucideIcon; seq: string; label: string }
  | { kind: "text"; id: string; label: string; seq: string };

const KEYS: Key[] = [
  { kind: "text", id: "esc", label: "Esc", seq: ESC },
  { kind: "text", id: "tab", label: "Tab", seq: TAB },
  { kind: "ctrl" },
  { kind: "icon", id: "up", icon: IconUp, seq: ESC + "[A", label: "Up" },
  { kind: "icon", id: "down", icon: IconDown, seq: ESC + "[B", label: "Down" },
  { kind: "icon", id: "left", icon: IconLeft, seq: ESC + "[D", label: "Left" },
  { kind: "icon", id: "right", icon: IconRight, seq: ESC + "[C", label: "Right" },
  { kind: "text", id: "ctrlc", label: "^C", seq: ETX },
  { kind: "text", id: "pipe", label: "|", seq: "|" },
  { kind: "text", id: "tilde", label: "~", seq: "~" },
  { kind: "text", id: "slash", label: "/", seq: "/" },
  { kind: "text", id: "dash", label: "-", seq: "-" },
];

// Helper-key row for touch devices (soft keyboards lack Esc/Tab/Ctrl/arrows).
// Gated by POINTER TYPE, not width: shown on every touch-primary device
// (phones AND tablets/iPads, which sit >=768px and were wrongly hidden by the
// old `md:hidden`), hidden only where the primary pointer is a mouse (desktops,
// which have a real keyboard).
export function MobileKeys({ remote }: { remote: Remote }) {
  return (
    <div className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-card px-1.5 py-1.5 pointer-fine:hidden">
      {KEYS.map((k, i) => {
        if (k.kind === "ctrl") {
          return (
            <Button
              key={`ctrl-${i}`}
              variant={remote.ctrlSticky ? "default" : "outline"}
              size="default"
              className="min-w-[46px]"
              onClick={() => remote.setCtrlSticky(!remote.ctrlSticky)}
            >
              Ctrl
            </Button>
          );
        }
        if (k.kind === "icon") {
          const Icon = k.icon;
          return (
            <Button
              key={k.id}
              variant="outline"
              size="icon"
              aria-label={k.label}
              onClick={() => remote.sendToActive(k.seq)}
            >
              <Icon size={15} strokeWidth={1.8} />
            </Button>
          );
        }
        return (
          <Button
            key={k.id}
            variant="outline"
            size="default"
            className="min-w-[42px] font-mono"
            onClick={() => remote.sendToActive(k.seq)}
          >
            {k.label}
          </Button>
        );
      })}
    </div>
  );
}
