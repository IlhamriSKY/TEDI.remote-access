import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import type { Remote } from "@/hooks/useRemote";

// Self-contained change-password modal (overlay + centered card). Escape or an
// overlay click closes it; the first field is focused on open. Responsive:
// max-w-sm with page padding so it fits a phone. Submits to /api/change-password
// via remote.changePassword (verifies the current password server-side).
export function ChangePasswordModal({ remote, onClose }: { remote: Remote; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (next.length < 8) return setErr("New password must be at least 8 characters.");
    if (next !== confirm) return setErr("New passwords do not match.");
    setBusy(true);
    const r = await remote.changePassword(current, next);
    setBusy(false);
    if (r.ok) {
      setDone(true);
      window.setTimeout(onClose, 1100);
    } else {
      setErr(r.error || "Could not change password.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Change password"
        className="w-full max-w-sm border border-border bg-card shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3 text-sm font-medium text-foreground">Change password</div>
        <form onSubmit={submit} className="flex flex-col gap-3 p-4">
          <Field label="Current password" value={current} onChange={setCurrent} inputRef={firstRef} autoComplete="current-password" />
          <Field label="New password" value={next} onChange={setNext} autoComplete="new-password" />
          <Field label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          {err && <p className="text-xs text-destructive">{err}</p>}
          {done && <p className="text-xs text-success">Password changed.</p>}
          <div className="mt-1 flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || done}>
              {busy ? "Saving…" : "Change"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  inputRef,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoComplete: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        ref={inputRef}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="h-8 border border-border bg-background px-2 text-xs text-foreground outline-none transition-colors focus:border-ring"
      />
    </label>
  );
}
