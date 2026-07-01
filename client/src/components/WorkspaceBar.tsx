import { cn } from "@/lib/utils";
import type { Remote } from "@/hooks/useRemote";

// Workspace switcher: mirrors the desktop's workspaces so the browser can view
// one workspace's tabs at a time instead of one flat list of every terminal.
// Hidden when there's a single workspace (nothing to switch). Sits above the tab
// strip; selecting a workspace focuses its first tab (see `selectWorkspace`).
export function WorkspaceBar({ remote }: { remote: Remote }) {
  const { workspaces, activeWs, selectWorkspace } = remote;
  if (workspaces.length <= 1) return null;
  return (
    <div
      role="tablist"
      aria-label="Workspaces"
      className="no-scrollbar border-border bg-muted/50 flex h-8 shrink-0 items-stretch gap-1 overflow-x-auto border-b px-1.5 py-1"
    >
      {workspaces.map((w) => {
        const active = w.id === activeWs;
        return (
          <button
            key={w.id}
            role="tab"
            aria-selected={active}
            title={w.name}
            onClick={() => selectWorkspace(w.id)}
            className={cn(
              "flex shrink-0 items-center rounded px-2.5 text-xs whitespace-nowrap transition-colors",
              active
                ? "bg-background text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-background/60",
            )}
          >
            {w.name}
          </button>
        );
      })}
    </div>
  );
}
