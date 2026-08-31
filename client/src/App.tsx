import { useEffect } from "react";

import { IconSpin } from "@/lib/icons";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Login } from "@/components/Login";
import { Workspace } from "@/components/Workspace";
import { useRemote } from "@/hooks/useRemote";

// A phone's soft keyboard does not shrink the LAYOUT viewport, so a `height:100%`
// shell keeps its full height and the bottom of the app — the terminal and the
// helper-key row — slides underneath the keyboard. `visualViewport` is the only
// thing that reports the space actually left, so the shell height is driven off
// it (index.css: `#root { height: var(--app-h, 100%) }`). No-op on desktop, where
// it always equals the window height.
function useViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () =>
      document.documentElement.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);
}

export default function App() {
  const remote = useRemote();
  useViewportHeight();
  return (
    <TooltipProvider delayDuration={200}>
      <div className="bg-background text-foreground flex h-full w-full flex-col">
        {remote.authed === null ? (
          <Splash />
        ) : remote.authed === false ? (
          <Login remote={remote} />
        ) : (
          <Workspace remote={remote} />
        )}
      </div>
    </TooltipProvider>
  );
}

function Splash() {
  return (
    <div className="text-muted-foreground flex h-full w-full items-center justify-center">
      <IconSpin size={22} className="animate-spin" strokeWidth={2} />
    </div>
  );
}
