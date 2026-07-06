// Single source of truth for the client's icons, aliased to semantic names and
// backed by lucide-react (migrated from Hugeicons to match the desktop app).
// Terminal/SSH glyphs mirror the desktop app's LeafIcon (SquareTerminal for
// local terminals, Server for SSH) so the web tabs match.
export {
  SquareTerminal as IconTerminal,
  Server as IconSsh,
  LogOut as IconLogout,
  Plus as IconFontUp,
  Plus as IconAdd,
  Minus as IconFontDown,
  Keyboard as IconKeyboard,
  ChevronUp as IconUp,
  ChevronDown as IconDown,
  ChevronLeft as IconLeft,
  ChevronRight as IconRight,
  Lock as IconLock,
  LoaderCircle as IconSpin,
  X as IconClose,
  Sun as IconSun,
  Moon as IconMoon,
  Settings as IconSettings,
  // Sidebar (workspaces + tabs) + the unified Select dropdown.
  Folder as IconFolder,
  PanelLeft as IconSidebar,
  ChevronDown as IconChevronDown,
  ChevronRight as IconChevronRight,
  Search as IconSearch,
  Check as IconCheck,
  type LucideIcon,
} from "lucide-react";
