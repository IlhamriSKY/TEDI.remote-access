import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";

import { IconLock, IconLogout, IconMoon, IconSettings, IconSun } from "@/lib/icons";
import { IconButton } from "@/components/IconButton";
import { ChangePasswordModal } from "@/components/ChangePasswordModal";
import { SettingsModal } from "@/components/SettingsModal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

const LOGO = `${import.meta.env.BASE_URL}icon.png`;

export function Header({ remote }: { remote: Remote }) {
  const connecting = remote.conn !== "open";
  const online = remote.hostOnline && !connecting;
  const dark = remote.theme === "dark";
  const [pwOpen, setPwOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border bg-sidebar px-3">
        <img src={LOGO} alt="TEDI" className="size-5 shrink-0 select-none" draggable={false} />
        <span className="truncate text-xs font-semibold text-foreground">{remote.hostName || "TEDI Remote"}</span>

        <div className="ml-auto flex items-center gap-1.5">
          <OnlineIndicator online={online} connecting={connecting} />
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          <IconButton
            icon={dark ? IconSun : IconMoon}
            label={dark ? "Light mode" : "Dark mode"}
            onClick={remote.toggleTheme}
          />
          <IconButton icon={IconSettings} label="Settings" onClick={() => setSettingsOpen(true)} />
          <UserMenu
            remote={remote}
            onChangePassword={() => setPwOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>
      </header>
      {settingsOpen && <SettingsModal remote={remote} onClose={() => setSettingsOpen(false)} />}
      {pwOpen && <ChangePasswordModal remote={remote} onClose={() => setPwOpen(false)} />}
    </>
  );
}

// Round, pulsing connection light (green online / amber connecting / red offline).
function OnlineIndicator({ online, connecting }: { online: boolean; connecting: boolean }) {
  const title = connecting ? "Connecting…" : online ? "Host online" : "Host offline";
  const label = connecting ? "Connecting" : online ? "Online" : "Offline";
  const tone = online ? "bg-success" : connecting ? "bg-warning" : "bg-destructive";
  const textTone = online ? "text-success" : connecting ? "text-warning" : "text-muted-foreground";
  const pulse = online || connecting;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1.5" aria-label={title}>
          <span className="relative flex size-2.5">
            {pulse && <span className={cn("status-circle status-ping absolute inset-0 opacity-70", tone)} aria-hidden />}
            <span className={cn("status-circle relative size-2.5", tone)} />
          </span>
          <span className={cn("hidden text-[11px] font-medium sm:inline", textTone)}>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  );
}

function UserMenu({
  remote,
  onChangePassword,
  onOpenSettings,
}: {
  remote: Remote;
  onChangePassword: () => void;
  onOpenSettings: () => void;
}) {
  const user = remote.user || "user";
  const initial = (user[0] || "?").toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-8 items-center gap-1.5 border border-transparent px-1 text-xs text-foreground transition-colors hover:bg-muted focus-visible:border-ring focus-visible:outline-none"
          aria-label="Account menu"
        >
          <span className="flex size-6 items-center justify-center bg-accent text-[11px] font-semibold text-accent-foreground uppercase">
            {initial}
          </span>
          <span className="hidden max-w-[120px] truncate sm:inline">{user}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
        <div className="truncate px-2.5 pb-1.5 text-xs font-medium text-foreground">{user}</div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onOpenSettings()}>
          <HugeiconsIcon icon={IconSettings} size={14} strokeWidth={1.8} />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChangePassword()}>
          <HugeiconsIcon icon={IconLock} size={14} strokeWidth={1.8} />
          Change password
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          onSelect={() => void remote.logout()}
        >
          <HugeiconsIcon icon={IconLogout} size={14} strokeWidth={1.8} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
