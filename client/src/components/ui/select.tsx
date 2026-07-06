import * as React from "react";
import { Popover } from "radix-ui";

import { IconCheck, IconChevronDown, IconSearch, type LucideIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";

// One styled dropdown used everywhere a native <select> was, so every picker in
// the app reads the same as the DropdownMenu / Tooltip popovers (bordered
// bg-popover card, 1px, zoom+fade). Optionally searchable (type to filter),
// which native <select> can't do. Keyboard: ArrowUp/Down move the highlight,
// Enter picks it (preventDefault so it never submits an enclosing form), Escape
// closes (Radix). Values are plain strings.

export type SelectOption = {
  value: string;
  label: string;
  /** Secondary muted text after the label (e.g. "user@host:22"). */
  hint?: string;
  /** Optional leading glyph. */
  icon?: LucideIcon;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchable?: boolean;
  size?: "sm" | "default";
  /** Trigger classes (e.g. a fixed width). Overrides the default w-full. */
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  "aria-label"?: string;
};

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchable = false,
  size = "default",
  className,
  contentClassName,
  disabled,
  "aria-label": ariaLabel,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);

  const selected = options.find((o) => o.value === value) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q),
      )
    : options;

  // Reset transient state when the popover opens; highlight the current value.
  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    const i = options.findIndex((o) => o.value === value);
    setActive(i < 0 ? 0 : i);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the highlight in range as the filtered list shrinks.
  React.useEffect(() => {
    setActive((a) => Math.min(Math.max(0, a), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const commit = (o?: SelectOption) => {
    if (o) onChange(o.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault(); // never submit an enclosing <form>
      commit(filtered[active]);
    }
  };

  const h = size === "sm" ? "h-8 px-2 text-xs" : "h-9 px-3 text-sm";

  return (
    <Popover.Root open={open} onOpenChange={disabled ? undefined : setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            "border-input bg-background text-foreground focus-visible:border-ring flex w-full items-center justify-between gap-2 border outline-none transition-colors disabled:pointer-events-none disabled:opacity-50",
            h,
            className,
          )}
        >
          <span
            className={cn("min-w-0 flex-1 truncate text-left", !selected && "text-muted-foreground")}
          >
            {selected ? selected.label : placeholder}
          </span>
          <IconChevronDown
            size={size === "sm" ? 13 : 14}
            strokeWidth={2}
            className={cn(
              "text-muted-foreground shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onKeyDown={onKeyDown}
          className={cn(
            "bg-popover text-popover-foreground border-border z-50 w-[max(var(--radix-popover-trigger-width),12rem)] max-w-[min(24rem,92vw)] overflow-hidden border p-0 shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            contentClassName,
          )}
        >
          {searchable && (
            <div className="border-border flex items-center gap-1.5 border-b px-2.5">
              <IconSearch
                size={13}
                strokeWidth={1.8}
                className="text-muted-foreground shrink-0"
              />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                aria-label="Search options"
                className="text-foreground placeholder:text-muted-foreground h-8 w-full bg-transparent text-xs outline-none"
              />
            </div>
          )}
          <div className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="text-muted-foreground px-2.5 py-3 text-center text-xs">
                No matches
              </div>
            ) : (
              filtered.map((o, i) => {
                const isSel = o.value === value;
                const isActive = i === active;
                const Icon = o.icon;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => commit(o)}
                    className={cn(
                      "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors",
                      isActive ? "bg-muted" : "hover:bg-muted",
                    )}
                  >
                    {Icon && (
                      <Icon
                        size={14}
                        strokeWidth={1.8}
                        className="text-muted-foreground shrink-0"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-foreground">{o.label}</span>
                      {o.hint && <span className="text-muted-foreground ml-1.5">{o.hint}</span>}
                    </span>
                    {isSel && (
                      <IconCheck
                        size={14}
                        strokeWidth={2}
                        className="text-primary shrink-0"
                      />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
