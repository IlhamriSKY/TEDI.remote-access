import { useEffect, useRef } from "react";

// Cloudflare Turnstile widget (explicit render). The site key comes from the
// relay (/api/me); the token it emits is sent with login / change-password and
// verified server-side. Needs the CSP to allow challenges.cloudflare.com, which
// the relay adds when Turnstile is enabled. Remount (change the `key`) to force a
// fresh token after a failed submit — Turnstile tokens are single-use.

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      theme?: "light" | "dark" | "auto";
      size?: "normal" | "flexible" | "compact";
      callback?: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
      "timeout-callback"?: () => void;
    },
  ) => string;
  remove: (id: string) => void;
  reset: (id?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loader: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window !== "undefined" && window.turnstile) return Promise.resolve();
  if (loader) return loader;
  loader = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loader = null; // let a later mount retry
      reject(new Error("turnstile script failed to load"));
    };
    document.head.appendChild(s);
  });
  return loader;
}

export function Turnstile({
  siteKey,
  onToken,
  theme,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  theme?: "light" | "dark";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          theme: theme ?? "auto",
          size: "flexible",
          callback: (token) => onTokenRef.current(token),
          "error-callback": () => onTokenRef.current(null),
          "expired-callback": () => onTokenRef.current(null),
          "timeout-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => onTokenRef.current(null));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetId.current);
        } catch {
          /* ignore */
        }
      }
      widgetId.current = null;
    };
  }, [siteKey, theme]);

  return <div ref={ref} className="flex min-h-[65px] w-full justify-center" />;
}
