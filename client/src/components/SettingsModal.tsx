import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { FONT_FAMILIES, LINE_SPACINGS, type FontFamilyId } from "@/lib/protocol";
import { SESSION_SHORTCUTS } from "@/hooks/useSessionShortcuts";
import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

// App + terminal settings on the shared <Modal> shell. Everything applies live
// and persists to localStorage via the hook, so there is no Save step (the
// footer just closes). Covers the terminal font, text size, and line spacing.
// Nothing here can change the host: the browser only ever restyles its own view.
export function SettingsModal({ remote, onClose }: { remote: Remote; onClose: () => void }) {
  return (
    <Modal title="Settings" onClose={onClose} className="max-w-md">
      <ModalBody className="gap-0 p-0">
        <Section title="Terminal">
          <Row label="Font">
            <Select
              aria-label="Terminal font"
              size="sm"
              className="w-44"
              value={remote.fontFamily}
              onChange={(v) => remote.setFontFamily(v as FontFamilyId)}
              options={FONT_FAMILIES.map((f) => ({ value: f.id, label: f.label }))}
            />
          </Row>

          <Row
            label="Text size"
            hint="Auto fills the pane with your PC's terminal. Set a size to zoom in and pan."
          >
            <span className="flex items-center gap-1">
              <Button
                variant={remote.fontAuto ? "default" : "outline"}
                size="xs"
                aria-pressed={remote.fontAuto}
                onClick={() => remote.setFontAuto(true)}
              >
                Auto
              </Button>
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="Smaller text"
                onClick={() => remote.bumpFont(-1)}
              >
                A-
              </Button>
              <button
                type="button"
                onClick={remote.resetFont}
                title="Reset to default"
                className={cn(
                  "hover:text-foreground w-12 text-center text-[11px] tabular-nums transition-colors",
                  // Under Auto the stored number is not what is on screen, so it
                  // reads as the fallback it is rather than the current size.
                  remote.fontAuto ? "text-muted-foreground/50" : "text-muted-foreground",
                )}
              >
                {remote.fontSize}px
              </button>
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="Larger text"
                onClick={() => remote.bumpFont(1)}
              >
                A+
              </Button>
            </span>
          </Row>

          <Row label="Line spacing">
            <Segmented
              options={LINE_SPACINGS.map((l) => ({ label: l.label, value: l.value }))}
              isActive={(v) => Math.abs(remote.lineHeight - (v as number)) < 0.001}
              onSelect={(v) => remote.setLineHeight(v as number)}
            />
          </Row>
        </Section>

        <Section title="Shortcuts" last>
          <p className="text-muted-foreground mb-1.5 text-[10px] leading-snug">
            Everything else goes straight to the terminal, so a TUI keeps its own keys.
          </p>
          <dl className="flex flex-col gap-1">
            {SESSION_SHORTCUTS.map((k) => (
              <div key={k.keys} className="flex items-baseline justify-between gap-4">
                <dt className="text-foreground text-xs">{k.label}</dt>
                <dd className="border-border text-muted-foreground shrink-0 border px-1.5 py-0.5 font-mono text-[10px]">
                  {k.keys}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      </ModalBody>
      <ModalFooter>
        <Button type="button" size="sm" onClick={onClose}>
          Done
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function Section({
  title,
  children,
  last,
}: {
  title: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <div className={cn("px-4 py-3", !last && "border-border border-b")}>
      <div className="text-muted-foreground mb-2 text-[10px] font-medium tracking-wide uppercase">
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="min-w-0">
        <span className="text-foreground block text-xs">{label}</span>
        {hint && (
          <span className="text-muted-foreground block text-[10px] leading-snug">{hint}</span>
        )}
      </span>
      <span className="shrink-0">{children}</span>
    </div>
  );
}

function Segmented({
  options,
  isActive,
  onSelect,
}: {
  options: { label: string; value: string | number }[];
  isActive: (v: string | number) => boolean;
  onSelect: (v: string | number) => void;
}) {
  return (
    <span className="border-border flex items-stretch border">
      {options.map((o, i) => {
        const active = isActive(o.value);
        return (
          <button
            key={o.label}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(o.value)}
            className={cn(
              "px-2.5 py-1 text-[11px] transition-colors",
              i > 0 && "border-border border-l",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}
