import { HugeiconsIcon } from "@hugeicons/react";

import { IconFontDown, IconFontUp, IconLogout, IconSpin } from "@/lib/icons";
import { IconButton } from "@/components/IconButton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

export function Header({ remote }: { remote: Remote }) {
  const connecting = remote.conn !== "open";
  const online = remote.hostOnline && !connecting;

  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2">
      <StatusDot online={online} connecting={connecting} />
      <span className="truncate text-xs font-medium text-foreground">{remote.hostName || "TEDI Remote"}</span>
      <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
        {connecting ? "connecting..." : online ? "host online" : "host offline"}
      </span>

      <div className="ml-auto flex items-center gap-0.5">
        <IconButton icon={IconFontDown} label="Smaller text" onClick={() => remote.bumpFont(-1)} />
        <IconButton icon={IconFontUp} label="Larger text" onClick={() => remote.bumpFont(1)} />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <IconButton icon={IconLogout} label="Sign out" onClick={() => void remote.logout()} />
      </div>
    </header>
  );
}

function StatusDot({ online, connecting }: { online: boolean; connecting: boolean }) {
  const title = connecting ? "Connecting..." : online ? "Host online" : "Host offline";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center justify-center px-1" aria-label={title}>
          {connecting ? (
            <HugeiconsIcon icon={IconSpin} size={13} className="animate-spin text-warning" strokeWidth={2} />
          ) : (
            <span className={cn("inline-block size-2.5", online ? "bg-success" : "bg-destructive")} />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  );
}
