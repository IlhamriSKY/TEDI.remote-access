import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter } from "@/components/ui/modal";

// Generic confirm dialog on the shared <Modal> shell, so every confirmation in
// the app looks identical. `danger` flips the primary action to the destructive
// style (used for closing a terminal, which kills the process on the host).
export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <ModalBody>
        <p className="text-xs leading-relaxed text-muted-foreground">{message}</p>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={danger ? "destructive" : "default"}
          size="sm"
          autoFocus
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
