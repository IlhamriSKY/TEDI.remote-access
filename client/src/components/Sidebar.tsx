import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import {
  IconAdd,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconMore,
  IconPin,
  IconRename,
  IconSsh,
  IconTerminal,
  IconUnpin,
} from "@/lib/icons";
import { ConfirmModal } from "@/components/ConfirmModal";
import { NewSshModal } from "@/components/NewSshModal";
import { NewTerminalModal } from "@/components/NewTerminalModal";
import { NewWorkspaceModal } from "@/components/NewWorkspaceModal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { SessionMeta } from "@/lib/protocol";
import type { Remote } from "@/hooks/useRemote";

// Left sidebar: workspaces, each with its list of terminal/SSH tabs — mirroring
// the desktop TEDI Workspaces panel. Each tab reads "folder · title" (folder =
// the terminal's cwd basename, title = the program's OSC window title, e.g. a
// running agent's task), exactly like the desktop panel's terminal list. On
// desktop it is an in-flow column (toggle to collapse); on mobile it is an
// overlay drawer (toggle from the header; tapping a tab closes it).

/** Trailing path segment, Windows + POSIX. */
function basename(p?: string | null): string {
  if (!p) return "";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** The folder part of a tab's label (SSH tabs show "user@host" as their name). */
function folderName(s: SessionMeta): string {
  if (s.kind === "ssh") return s.title || "ssh";
  return basename(s.cwd) || s.title || "terminal";
}

const WS_OTHER = "__other__";

// Sidebar width is drag-resizable on desktop (persisted); the mobile drawer keeps
// a fixed width.
const SIDEBAR_W_KEY = "tedi-remote-sidebar-w";
const DEFAULT_SIDEBAR_W = 240;
const clampSidebarWidth = (n: number) => Math.min(480, Math.max(180, n || DEFAULT_SIDEBAR_W));

type Group = { id: string; name: string; tabs: SessionMeta[] };

export function Sidebar({
  remote,
  open,
  onClose,
}: {
  remote: Remote;
  open: boolean;
  onClose: () => void;
}) {
  const { sessions, workspaces, wsById, activeId } = remote;
  const [pendingClose, setPendingClose] = useState<SessionMeta | null>(null);
  const [sshOpen, setSshOpen] = useState(false);
  const [newTermOpen, setNewTermOpen] = useState(false);
  const [newWsOpen, setNewWsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Which row is being renamed inline, or null. Owned here so switching tabs or
  // renaming another row cancels the one in flight.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Same, for a workspace header. Separate from `renamingId` so a tab and a
  // workspace can never both be in edit mode.
  const [renamingWsId, setRenamingWsId] = useState<string | null>(null);
  const [width, setWidth] = useState(() => {
    try {
      return clampSidebarWidth(Number(localStorage.getItem(SIDEBAR_W_KEY)));
    } catch {
      return DEFAULT_SIDEBAR_W;
    }
  });
  const widthRef = useRef(width);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);
  // Drag the right edge to resize (desktop). Tracked on window so the drag keeps
  // working past the 1px handle; persisted on release.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const onMove = (ev: PointerEvent) =>
      setWidth(clampSidebarWidth(startW + (ev.clientX - startX)));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(SIDEBAR_W_KEY, String(widthRef.current));
      } catch {
        /* ignore */
      }
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Group sessions by workspace: workspaces in their host order, tabs in the
  // browser's (drag-preserved) session order. Sessions without workspace
  // metadata land in a trailing "Other" group; with no workspaces at all (an
  // older host that sends no tabmeta) we render one flat, header-less list.
  const hasWs = workspaces.length > 0;
  const groups: Group[] = [];
  if (hasWs) {
    for (const w of workspaces) groups.push({ id: w.id, name: w.name, tabs: [] });
    const other: SessionMeta[] = [];
    for (const s of sessions) {
      const g = wsById[s.id] ? groups.find((x) => x.id === wsById[s.id]) : undefined;
      if (g) g.tabs.push(s);
      else other.push(s);
    }
    if (other.length) groups.push({ id: WS_OTHER, name: "Other", tabs: other });
  } else {
    groups.push({ id: WS_OTHER, name: "", tabs: sessions });
  }

  // Pinned tabs float to the top of their workspace, the same rule the desktop
  // applies to its tab strip (sortPinnedFirst). Done here rather than by
  // reordering `sessions`, because the host owns the desktop's order and the
  // browser owns its own: this is a render-time view of the pin state that
  // arrives over tabmeta. A stable partition, so pinning one tab does not
  // shuffle the rest.
  for (const g of groups) {
    const pinnedRows = g.tabs.filter((t) => remote.pinnedIds[t.id]);
    if (pinnedRows.length && pinnedRows.length < g.tabs.length) {
      g.tabs = [...pinnedRows, ...g.tabs.filter((t) => !remote.pinnedIds[t.id])];
    }
  }

  const selectTab = (id: string) => {
    remote.setActiveId(id);
    // Dismiss the overlay drawer on a phone; leave the desktop sidebar open.
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) onClose();
  };

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={onClose} aria-hidden />
      )}
      <aside
        aria-label="Workspaces and terminals"
        style={{ width }}
        className={cn(
          "bg-sidebar border-border relative z-40 shrink-0 flex-col border-r",
          // Mobile drawer: fixed width (!w-72 beats the inline style), overlaid.
          // It is position:fixed so it escapes #root's safe-area padding — pad it
          // itself so the header + tab rows clear the notch / side cutout / home
          // indicator on notched phones (no-op on desktop; insets resolve to 0).
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:!w-72 max-md:max-w-[85%] max-md:shadow-xl",
          "max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] max-md:pl-[env(safe-area-inset-left)]",
          open ? "flex" : "hidden",
        )}
      >
        <div
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize"
          className="hover:bg-primary/40 absolute inset-y-0 right-0 z-20 hidden w-1 cursor-col-resize transition-colors md:block"
        />
        <div className="border-border flex h-9 shrink-0 items-center gap-1 border-b px-2">
          <span className="text-muted-foreground flex-1 truncate pl-1 text-[11px] font-semibold tracking-wide uppercase">
            Workspaces
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="New tab"
                className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:border-ring flex size-6 items-center justify-center border border-transparent transition-colors focus-visible:outline-none"
              >
                <IconAdd size={15} strokeWidth={1.8} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem
                onSelect={() =>
                  remote.workspaces.length > 1 ? setNewTermOpen(true) : remote.newTerminal()
                }
              >
                <IconTerminal size={14} strokeWidth={1.8} />
                New terminal
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSshOpen(true)}>
                <IconSsh size={14} strokeWidth={1.8} />
                New SSH
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setNewWsOpen(true)}>
                <IconFolder size={14} strokeWidth={1.8} />
                New workspace
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {sessions.length === 0 ? (
            <p className="text-muted-foreground px-3 py-4 text-center text-xs">
              No terminals open.
            </p>
          ) : (
            groups.map((g) => (
              <WorkspaceGroup
                key={g.id}
                group={g}
                showHeader={hasWs}
                active={g.tabs.some((t) => t.id === activeId)}
                collapsed={collapsed.has(g.id)}
                onToggle={() => toggle(g.id)}
                onSelectWorkspace={() => g.id !== WS_OTHER && remote.selectWorkspace(g.id)}
                remote={remote}
                activeId={activeId}
                onSelectTab={selectTab}
                onCloseTab={setPendingClose}
                renamingId={renamingId}
                onSetRenaming={(id) => {
                  setRenamingWsId(null);
                  setRenamingId(id);
                }}
                renamingWs={renamingWsId === g.id}
                onSetRenamingWs={(id) => {
                  setRenamingId(null);
                  setRenamingWsId(id);
                }}
              />
            ))
          )}
        </div>
      </aside>

      {sshOpen && <NewSshModal remote={remote} onClose={() => setSshOpen(false)} />}
      {newTermOpen && <NewTerminalModal remote={remote} onClose={() => setNewTermOpen(false)} />}
      {newWsOpen && <NewWorkspaceModal remote={remote} onClose={() => setNewWsOpen(false)} />}
      {pendingClose && (
        <ConfirmModal
          title="Close terminal"
          danger
          confirmLabel="Close terminal"
          message={
            <>
              Close <span className="text-foreground font-medium">{folderName(pendingClose)}</span>?
              This ends the process and closes the tab in TEDI on your computer too.
            </>
          }
          onConfirm={() => remote.closeTerminal(pendingClose.id)}
          onClose={() => setPendingClose(null)}
        />
      )}
    </>
  );
}

function WorkspaceGroup({
  group,
  showHeader,
  active,
  collapsed,
  onToggle,
  onSelectWorkspace,
  remote,
  activeId,
  onSelectTab,
  onCloseTab,
  renamingId,
  onSetRenaming,
  renamingWs,
  onSetRenamingWs,
}: {
  group: Group;
  showHeader: boolean;
  active: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onSelectWorkspace: () => void;
  remote: Remote;
  activeId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (s: SessionMeta) => void;
  renamingId: string | null;
  onSetRenaming: (id: string | null) => void;
  renamingWs: boolean;
  onSetRenamingWs: (id: string | null) => void;
}) {
  const Chevron = collapsed ? IconChevronRight : IconChevronDown;
  // The last tab in a workspace is not closable (mirrors the desktop's
  // per-workspace gate: useTabs.closeTab no-ops at length<=1 and hides the X).
  const canClose = group.tabs.length > 1;
  // "Other" is a bucket this client invents for sessions the host sent no
  // workspace for; there is nothing on the desktop to rename.
  const canRenameWs = remote.hostControl && group.id !== WS_OTHER;
  return (
    <div className="mb-0.5">
      {showHeader && renamingWs ? (
        <RenameRow
          initial={group.name}
          onCancel={() => onSetRenamingWs(null)}
          onCommit={(v) => {
            remote.renameWorkspace(group.id, v);
            onSetRenamingWs(null);
          }}
        />
      ) : null}
      {showHeader && !renamingWs && (
        <div
          className={cn(
            "group/ws flex h-7 items-center gap-1 px-1.5 text-xs",
            // Highlight the active workspace like the desktop Workspaces panel.
            active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
          )}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? "Expand workspace" : "Collapse workspace"}
            aria-expanded={!collapsed}
            className="hover:text-foreground flex size-4 shrink-0 items-center justify-center"
          >
            <Chevron size={12} strokeWidth={2.25} />
          </button>
          <IconFolder size={13} strokeWidth={1.75} className="shrink-0" />
          <button
            type="button"
            onClick={onSelectWorkspace}
            onDoubleClick={() => canRenameWs && onSetRenamingWs(group.id)}
            title={group.name}
            className="hover:text-foreground min-w-0 flex-1 truncate text-left font-medium"
          >
            {group.name || "Workspace"}
          </button>
          <span className="bg-muted/60 shrink-0 px-1 text-[10px] tabular-nums">
            {group.tabs.length}
          </span>
          {canRenameWs && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Options for ${group.name || "workspace"}`}
                  title="Workspace options"
                  className="hover:text-foreground flex size-4 shrink-0 items-center justify-center opacity-0 transition-opacity group-hover/ws:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
                >
                  <IconMore size={13} strokeWidth={2} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem onSelect={() => onSetRenamingWs(group.id)}>
                  <IconRename size={14} strokeWidth={1.8} />
                  Rename workspace
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {!collapsed && (
        <div className={cn("flex flex-col", showHeader && "pl-1.5")}>
          {group.tabs.map((s) => (
            <TabRow
              key={s.id}
              s={s}
              active={s.id === activeId}
              canClose={canClose}
              remote={remote}
              onSelect={() => onSelectTab(s.id)}
              onClose={() => onCloseTab(s)}
              renaming={renamingId === s.id}
              onSetRenaming={onSetRenaming}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TabRow({
  s,
  active,
  canClose,
  remote,
  onSelect,
  onClose,
  renaming,
  onSetRenaming,
}: {
  s: SessionMeta;
  active: boolean;
  canClose: boolean;
  remote: Remote;
  onSelect: () => void;
  onClose: () => void;
  renaming: boolean;
  onSetRenaming: (id: string | null) => void;
}) {
  const ssh = s.kind === "ssh";
  const TabIcon = ssh ? IconSsh : IconTerminal;
  const st = remote.status[s.id];
  const running = st === "working" || st === "blocking" || !!remote.busy[s.id];
  const accent = ssh ? "text-[#38bdf8]" : "text-terminal";
  const folder = folderName(s);
  // Prefer the host's authoritative title (desktop's live OSC 0/2 capture, sent
  // over tabmeta) so the tab reads the same as the app; fall back to the local
  // xterm capture only for hosts too old to send it.
  const title = remote.hostTitles[s.id] ?? remote.titles[s.id];
  // A rename beats every derived label AND the program's window title: the user
  // named this tab, and a TUI that keeps rewriting its OSC 0/2 title must not
  // scribble over that. Same precedence the desktop's `leafLabel` applies.
  const custom = remote.customTitles[s.id];
  const label = custom || folder;
  const showTitle = !custom && title && title !== folder && title !== s.cwd;
  const pinned = !!remote.pinnedIds[s.id];
  const iconColor = running
    ? st === "blocking"
      ? "text-destructive animate-breathe"
      : "text-warning animate-breathe"
    : active
      ? accent
      : "text-muted-foreground";

  if (renaming) {
    return (
      <RenameRow
        initial={custom || folder}
        onCancel={() => onSetRenaming(null)}
        onCommit={(v) => {
          // Empty commits `null`, which drops the tab back to its derived name -
          // the desktop's own "clear the custom title" gesture.
          remote.renameTab(s.id, v.trim() ? v : null);
          onSetRenaming(null);
        }}
      />
    );
  }

  return (
    <div
      className={cn(
        "group/tab relative flex h-7 items-center",
        active ? "bg-background" : "hover:bg-background/50",
      )}
    >
      {active && (
        <span
          className={cn("absolute inset-y-0 left-0 w-0.5", ssh ? "bg-[#38bdf8]" : "bg-terminal")}
          aria-hidden
        />
      )}
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        title={s.cwd || folder}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 pl-2 text-left text-xs transition-colors",
          active ? "text-foreground" : "text-muted-foreground group-hover/tab:text-foreground",
        )}
      >
        <TabIcon size={13} strokeWidth={1.8} className={cn("shrink-0", iconColor)} />
        {remote.ordinals[s.id] != null && (
          <span
            className={cn(
              "shrink-0 text-[10px] tabular-nums",
              active ? accent : "text-muted-foreground/70",
            )}
          >
            {remote.ordinals[s.id]}
          </span>
        )}
        {pinned && (
          <IconPin
            size={10}
            strokeWidth={2}
            aria-label="Pinned"
            className={cn("shrink-0", active ? accent : "text-muted-foreground/70")}
          />
        )}
        <span className="min-w-0 flex-1 truncate">
          {label}
          {showTitle ? <span className="opacity-60"> · {title}</span> : null}
        </span>
        {!s.alive && <span className="text-muted-foreground shrink-0 text-[10px]">exited</span>}
      </button>
      {/* Pin / rename, the desktop's per-tab controls. Hidden entirely when the
          host is too old to accept them (probed from tabmeta) rather than shown
          and silently doing nothing. A menu button, not a right-click: there is
          no right-click on the phone this client is mostly used from. */}
      {remote.hostControl && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Options for ${label}`}
              title="Tab options"
              onClick={(e) => e.stopPropagation()}
              className="text-muted-foreground hover:text-foreground flex w-5 shrink-0 items-center justify-center opacity-0 transition-opacity group-hover/tab:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
            >
              <IconMore size={13} strokeWidth={2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onSelect={() => remote.setTabPinned(s.id, !pinned)}>
              {pinned ? (
                <IconUnpin size={14} strokeWidth={1.8} />
              ) : (
                <IconPin size={14} strokeWidth={1.8} />
              )}
              {pinned ? "Unpin tab" : "Pin tab"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSetRenaming(s.id)}>
              <IconRename size={14} strokeWidth={1.8} />
              Rename
            </DropdownMenuItem>
            {custom && (
              <DropdownMenuItem onSelect={() => remote.renameTab(s.id, null)}>
                <IconClose size={14} strokeWidth={1.8} />
                Reset name
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* The sole tab in a workspace has no close button, like the desktop
          (SortableTabGroup: canClose = totalEntries > 1). pr-1.5 keeps the label
          clear of the scrollbar when the X is gone. */}
      {canClose ? (
        <button
          type="button"
          aria-label={`Close ${folder}`}
          title="Close terminal"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="text-muted-foreground hover:text-foreground flex w-6 shrink-0 items-center justify-center opacity-0 transition-opacity group-hover/tab:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
        >
          <IconClose size={12} strokeWidth={2} />
        </button>
      ) : (
        <span className="w-1.5 shrink-0" aria-hidden />
      )}
    </div>
  );
}

/**
 * Inline rename field. Replaces the whole row while it is up, so there is no way
 * to click the tab underneath and lose what you typed. Committing on blur (not
 * just Enter) is deliberate: on a phone the keyboard's "done" dismisses focus
 * without ever sending Enter.
 */
function RenameRow({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <div className="flex h-7 items-center px-1.5">
      <input
        autoFocus
        value={v}
        maxLength={60}
        onChange={(e) => setV(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => onCommit(v)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(v);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          // Keeps the keystroke off the row behind. The session shortcuts run in
          // the CAPTURE phase and so are already past by now; they skip this
          // field on their own (useSessionShortcuts).
          e.stopPropagation();
        }}
        className="bg-input text-foreground focus-visible:border-ring w-full border border-transparent px-1.5 py-0.5 text-xs outline-none"
      />
    </div>
  );
}
