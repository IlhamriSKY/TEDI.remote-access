import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import type { Remote } from "@/hooks/useRemote";

// "New SSH" dialog. You pick a SAVED host (only ones already verified/pinned on
// the desktop are offered) and re-authenticate with your LOGIN password - NOT
// the SSH password, which never leaves the host. On submit the relay verifies
// the login password and tells the host to open the connection by id; the SSH
// credentials are read from the host's keychain and never touch the browser.
export function NewSshModal({ remote, onClose }: { remote: Remote; onClose: () => void }) {
  const conns = remote.sshConns;
  const [id, setId] = useState(conns[0]?.id ?? "");
  const [pass, setPass] = useState("");
  const [otp, setOtp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passRef.current?.focus();
  }, []);
  // Keep a valid selection if the saved-host list changes while open.
  useEffect(() => {
    if (conns.length && !conns.some((c) => c.id === id)) setId(conns[0].id);
  }, [conns, id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!id) return setErr("Pick a saved host.");
    if (!pass) return setErr("Enter your login password.");
    setBusy(true);
    const r = await remote.openSshConnection(id, pass, otp || undefined);
    setBusy(false);
    if (r.ok) onClose();
    else setErr(r.error || "Could not open SSH.");
  };

  return (
    <Modal title="New SSH connection" onClose={onClose}>
      <form onSubmit={submit}>
        <ModalBody>
          {conns.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No saved SSH hosts available. Add one and connect to it once in the TEDI desktop app
              (so its host key is verified) before you can open it from here.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">Host</span>
                <Select
                  aria-label="Saved SSH host"
                  searchable
                  value={id}
                  onChange={setId}
                  placeholder="Select a saved host…"
                  options={conns.map((c) => ({
                    value: c.id,
                    label: c.name,
                    hint: `${c.user}@${c.host}:${c.port}`,
                  }))}
                />
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  Your login password
                  <span className="text-muted-foreground/70 ml-1">(not the SSH password)</span>
                </span>
                <input
                  ref={passRef}
                  type="password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  autoComplete="current-password"
                  className="border-input bg-background text-foreground focus:border-ring h-9 border px-3 text-sm transition-colors outline-none"
                />
              </label>
              {remote.totpRequired && (
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-xs">Authenticator code</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    autoComplete="one-time-code"
                    className="border-input bg-background text-foreground focus:border-ring h-9 border px-3 text-sm transition-colors outline-none"
                  />
                </label>
              )}
              {err && <p className="text-destructive text-xs">{err}</p>}
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || conns.length === 0}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
