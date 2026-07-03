import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { FONT_FAMILIES, LINE_SPACINGS, type FontFamilyId } from "@/lib/protocol";
import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

// App + terminal settings on the shared <Modal> shell. Everything applies live
// and persists to localStorage via the hook, so there is no Save step (the
// footer just closes). Covers the terminal font, text size, line spacing,
// fit-to-window, and theme.
export function SettingsModal({ remote, onClose }: { remote: Remote; onClose: () => void }) {
  return (
    <Modal title="Settings" onClose={onClose} className="max-w-md">
      <ModalBody className="gap-0 p-0">
        <Section title="Terminal" last>
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

          <Row label="Text size" hint="Size of the terminal text.">
            <span className="flex items-center gap-1">
              <Button variant="outline" size="icon-xs" aria-label="Smaller text" onClick={() => remote.bumpFont(-1)}>
                A-
              </Button>
              <button
                type="button"
                onClick={remote.resetFont}
                title="Reset to default"
                className="w-12 text-center text-[11px] tabular-nums text-muted-foreground transition-colors hover:text-foreground"
              >
                {remote.fontSize}px
              </button>
              <Button variant="outline" size="icon-xs" aria-label="Larger text" onClick={() => remote.bumpFont(1)}>
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

          <Row
            label="Fit host to my screen"
            hint="Off (recommended): mirror the desktop at its real size and scale to fit — never touches the app. On: resize the shared host terminal to fill this screen, which also reshapes it in the TEDI desktop app and can garble a full-screen TUI like Claude."
          >
            <Button
              variant="outline"
              size="xs"
              aria-pressed={remote.fit}
              onClick={remote.toggleFit}
              className={cn("w-12", remote.fit && "border-primary/60 text-foreground")}
            >
              {remote.fit ? "On" : "Off"}
            </Button>
          </Row>
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

function Section({ title, children, last }: { title: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cn("px-4 py-3", !last && "border-b border-border")}>
      <div className="mb-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{title}</div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="min-w-0">
        <span className="block text-xs text-foreground">{label}</span>
        {hint && <span className="block text-[10px] leading-snug text-muted-foreground">{hint}</span>}
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
    <span className="flex items-stretch border border-border">
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
              i > 0 && "border-l border-border",
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}
