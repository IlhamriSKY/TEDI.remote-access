import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import type { Remote } from "@/hooks/useRemote";

// Pick which workspace a new terminal opens into (defaults to the topmost). Only
// shown when there is more than one workspace; with a single workspace the "+"
// opens a terminal directly. The host switches to the chosen workspace so the
// new terminal is adopted there.
export function NewTerminalModal({ remote, onClose }: { remote: Remote; onClose: () => void }) {
  const wss = remote.workspaces;
  const [wsId, setWsId] = useState(wss[0]?.id ?? "");
  useEffect(() => {
    if (wss.length && !wss.some((w) => w.id === wsId)) setWsId(wss[0].id);
  }, [wss, wsId]);

  const submit = () => {
    remote.newTerminal(wsId || undefined);
    onClose();
  };

  return (
    <Modal title="New terminal" onClose={onClose}>
      <ModalBody>
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">Workspace</span>
          <Select
            aria-label="Workspace"
            value={wsId}
            onChange={setWsId}
            options={wss.map((w) => ({ value: w.id, label: w.name || "Workspace" }))}
          />
        </div>
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          Opens a terminal in the chosen workspace on your desktop.
        </p>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={submit}>
          Open terminal
        </Button>
      </ModalFooter>
    </Modal>
  );
}
