import { useState } from "react";

import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { TerminalHost } from "@/components/TerminalHost";
import { MobileKeys } from "@/components/MobileKeys";
import type { Remote } from "@/hooks/useRemote";

export function Workspace({ remote }: { remote: Remote }) {
  // Sidebar starts open on a desktop-width viewport, closed on a phone (where it
  // is an overlay drawer). Toggled from the header.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 768,
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <Header
        remote={remote}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
      />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar remote={remote} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="flex min-w-0 flex-1 flex-col">
          <TerminalHost remote={remote} />
          <MobileKeys remote={remote} />
        </main>
      </div>
    </div>
  );
}
