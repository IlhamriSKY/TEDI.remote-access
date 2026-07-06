import { IconSpin } from "@/lib/icons";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Login } from "@/components/Login";
import { Workspace } from "@/components/Workspace";
import { useRemote } from "@/hooks/useRemote";

export default function App() {
  const remote = useRemote();
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full w-full flex-col bg-background text-foreground">
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
    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
      <IconSpin size={22} className="animate-spin" strokeWidth={2} />
    </div>
  );
}
