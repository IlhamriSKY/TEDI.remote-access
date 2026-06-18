import { useState, type FormEvent, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";

import { IconLock } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import type { Remote } from "@/hooks/useRemote";

const FIELD =
  "h-9 w-full border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-ring placeholder:text-muted-foreground";

export function Login({ remote }: { remote: Remote }) {
  const [user, setUser] = useState("admin");
  const [pass, setPass] = useState("");
  const [otp, setOtp] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    const r = await remote.login(user.trim(), pass, otp.trim());
    setBusy(false);
    if (!r.ok) setErr(r.error || "Sign in failed");
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-4">
      <form onSubmit={submit} className="w-full max-w-[360px] border border-border bg-card p-6 shadow-lg">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center border border-border bg-secondary text-primary">
            <HugeiconsIcon icon={IconLock} size={18} strokeWidth={1.8} />
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold text-foreground">TEDI Remote</span>
            <span className="block text-xs text-muted-foreground">Sign in to reach your terminals</span>
          </span>
        </div>

        <div className="space-y-3">
          <Field label="User">
            <input className={FIELD} autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>
          <Field label="Password">
            <input
              className={FIELD}
              type="password"
              autoComplete="current-password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoFocus
            />
          </Field>
          {remote.totpRequired && (
            <Field label="2FA code">
              <input
                className={FIELD}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
              />
            </Field>
          )}
        </div>

        {err && <p className="mt-3 text-xs text-destructive">{err}</p>}

        <Button type="submit" disabled={busy} className="mt-5 w-full">
          {busy ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] tracking-wide text-muted-foreground uppercase">{label}</span>
      {children}
    </label>
  );
}
