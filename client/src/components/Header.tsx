import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";

import { IconLock, IconLogout, IconMoon, IconSettings, IconSpin, IconSun } from "@/lib/icons";
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

export function Header({ remote }: { remote: Remote }) {
  const connecting = remote.conn !== "open";
  const online = remote.hostOnline && !connecting;
  const dark = remote.theme === "dark";
  const [pwOpen, setPwOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-3">
        <StatusDot online={online} connecting={connecting} />
        <span className="truncate text-xs font-semibold text-foreground">{remote.hostName || "TEDI Remote"}</span>
        <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
          · {connecting ? "connecting…" : online ? "host online" : "host offline"}
        </span>

        <div className="ml-auto flex items-center gap-0.5">
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

function StatusDot({ online, connecting }: { online: boolean; connecting: boolean }) {
  const title = connecting ? "Connecting…" : online ? "Host online" : "Host offline";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center justify-center px-0.5" aria-label={title}>
          {connecting ? (
            <HugeiconsIcon icon={IconSpin} size={13} className="animate-spin text-warning" strokeWidth={2} />
          ) : (
            <span
              className={cn(
                "inline-block size-2.5 ring-2",
                online ? "bg-success ring-success/25" : "bg-destructive ring-destructive/20",
              )}
            />
          )}
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
