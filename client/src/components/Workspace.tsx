import { Header } from "@/components/Header";
import { WorkspaceBar } from "@/components/WorkspaceBar";
import { TabBar } from "@/components/TabBar";
import { TerminalHost } from "@/components/TerminalHost";
import { MobileKeys } from "@/components/MobileKeys";
import type { Remote } from "@/hooks/useRemote";

export function Workspace({ remote }: { remote: Remote }) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <Header remote={remote} />
      <WorkspaceBar remote={remote} />
      <TabBar remote={remote} />
      <TerminalHost remote={remote} />
      <MobileKeys remote={remote} />
    </div>
  );
}
