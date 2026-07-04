import { useEffect, useRef } from "react";
import type { SessionMetadata } from "../../sessionParser";
import { DOWNGRADE_MODE } from "../../reopenView";
import styles from "./BypassConfirmModal.module.css";

interface BypassConfirmModalProps {
  /** The bypassPermissions session awaiting confirmation. */
  session: SessionMetadata;
  /** Reopen with the chosen mode — the original `bypassPermissions` or the
   * `acceptEdits` downgrade. */
  onConfirm: (mode: string) => void;
  /** Dismiss without reopening. */
  onCancel: () => void;
}

// The bypassPermissions safeguard (spec §7): a blocking, three-way confirm that
// names the consequence (every tool call auto-approved) and offers a one-click
// downgrade to acceptEdits instead of an all-or-nothing gate. Custom controls,
// not a native confirm(). Full focus-trap / keyboard traversal is slice #70; this
// ships the dialog roles, Escape-to-cancel, and initial focus on the safe option.
export function BypassConfirmModal({
  session,
  onConfirm,
  onCancel,
}: BypassConfirmModalProps) {
  const downgradeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    downgradeRef.current?.focus();
  }, []);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={onCancel}
      data-testid="modal-backdrop"
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bypass-modal-title"
        aria-describedby="bypass-modal-desc"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      >
        <h2 id="bypass-modal-title" className={styles.title}>
          Reopen with permissions bypassed?
        </h2>
        <p id="bypass-modal-desc" className={styles.desc}>
          This session runs in <strong>bypassPermissions</strong> mode — every
          tool call is auto-approved with no prompt, so an agent can edit files
          and run commands unsupervised.
        </p>
        <p className={styles.session} title={session.title}>
          {session.title}
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            ref={downgradeRef}
            className={styles.primary}
            data-testid="confirm-downgrade"
            onClick={() => onConfirm(DOWNGRADE_MODE)}
          >
            Reopen with edits auto-approved
          </button>
          <button
            type="button"
            className={styles.danger}
            data-testid="confirm-bypass"
            onClick={() => onConfirm(session.permissionMode)}
          >
            Reopen with bypass
          </button>
          <button
            type="button"
            className={styles.cancel}
            data-testid="confirm-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
