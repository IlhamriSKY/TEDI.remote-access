import { useEffect, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";

import { IconClose } from "@/lib/icons";
import { cn } from "@/lib/utils";

// One modal shell every dialog in the app shares, so they all read the same:
// a dimmed overlay, a centered sharp-cornered card (1px border, shadow, the
// dropdown/tooltip zoom+fade animation), a header with a title + close (x), and
// composable <ModalBody> / <ModalFooter> slots. Escape or an overlay click
// closes it. Keep new dialogs on this primitive instead of hand-rolling chrome.
export function Modal({
  title,
  onClose,
  children,
  className,
  labelledBy = "modal-title",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 data-[state=open]:animate-in data-[state=open]:fade-in-0"
      data-state="open"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        data-state="open"
        className={cn(
          "w-full max-w-sm border border-border bg-card shadow-lg ring-1 ring-foreground/10 dark:ring-foreground/15",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className,
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <span id={labelledBy} className="truncate text-sm font-medium text-foreground">
            {title}
          </span>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            className="-mr-1 flex size-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:border focus-visible:border-ring focus-visible:outline-none"
          >
            <HugeiconsIcon icon={IconClose} size={13} strokeWidth={2} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Padded content region. Use inside <Modal>. */
export function ModalBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-3 p-4", className)}>{children}</div>;
}

/** Action row with a top divider. Buttons stretch full-width (each an equal
 *  share of the row) rather than sitting small in the corner. Use inside <Modal>. */
export function ModalFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 border-t border-border px-4 py-3 [&>*]:flex-1", className)}>
      {children}
    </div>
  );
}
