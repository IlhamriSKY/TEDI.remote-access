import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";
import type { Remote } from "@/hooks/useRemote";

// Create a new workspace on the desktop from the browser. The host creates it,
// switches to it (which auto-opens a default terminal), and it streams into the
// sidebar via the next tabmeta/sessions frames. An empty name lets the host pick
// the default "Workspace N".
export function NewWorkspaceModal({ remote, onClose }: { remote: Remote; onClose: () => void }) {
  const [name, setName] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    remote.createRemoteWorkspace(name.trim());
    onClose();
  };

  return (
    <Modal title="New workspace" onClose={onClose}>
      <form onSubmit={submit}>
        <ModalBody>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">
              Name <span className="text-muted-foreground/70">(optional)</span>
            </span>
            <input
              ref={ref}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workspace name"
              maxLength={60}
              className="border-input bg-background text-foreground focus:border-ring h-9 border px-3 text-sm transition-colors outline-none"
            />
          </label>
          <p className="text-muted-foreground text-[11px] leading-relaxed">
            Creates a workspace on your desktop and opens a terminal in it.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm">
            Create
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
