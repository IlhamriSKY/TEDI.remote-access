import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { Turnstile } from "@/components/Turnstile";
import type { Remote } from "@/hooks/useRemote";

// Change-password dialog on the shared <Modal> shell (so its chrome matches the
// confirm dialog). The first field is focused on open; submit goes to
// /api/change-password via remote.changePassword (the server verifies the
// current password). Responsive: the shell is max-w-sm with page padding.
export function ChangePasswordModal({ remote, onClose }: { remote: Remote; onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (next.length < 8) return setErr("New password must be at least 8 characters.");
    if (next !== confirm) return setErr("New passwords do not match.");
    if (remote.turnstileSiteKey && !token) return setErr("Please complete the verification.");
    setBusy(true);
    const r = await remote.changePassword(current, next, token ?? undefined);
    setBusy(false);
    if (r.ok) {
      setDone(true);
      window.setTimeout(onClose, 1100);
    } else {
      setErr(r.error || "Could not change password.");
      // Turnstile tokens are single-use: reset for the next attempt.
      setToken(null);
      setResetKey((k) => k + 1);
    }
  };

  return (
    <Modal title="Change password" onClose={onClose}>
      <form onSubmit={submit}>
        <ModalBody>
          <Field
            label="Current password"
            value={current}
            onChange={setCurrent}
            inputRef={firstRef}
            autoComplete="current-password"
          />
          <Field label="New password" value={next} onChange={setNext} autoComplete="new-password" />
          <Field label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          {remote.turnstileSiteKey && (
            <Turnstile
              key={resetKey}
              siteKey={remote.turnstileSiteKey}
              theme={remote.theme}
              onToken={setToken}
            />
          )}
          {err && <p className="text-xs text-destructive">{err}</p>}
          {done && <p className="text-xs text-success">Password changed.</p>}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || done}>
            {busy ? "Saving…" : "Change"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
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
        className="h-9 border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-ring"
      />
    </label>
  );
}
