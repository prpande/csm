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
// not a native confirm(). Ships the dialog roles, Escape-to-cancel, initial focus
// on the safe option, and a Tab focus-trap (#70) so keyboard focus cannot leave
// the modal onto the gated-away controls behind the backdrop.
export function BypassConfirmModal({
  session,
  onConfirm,
  onCancel,
}: BypassConfirmModalProps) {
  const downgradeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    downgradeRef.current?.focus();
  }, []);

  // Escape cancels; Tab is trapped inside the dialog. Every Tab transition is
  // computed and applied here (not delegated to native focus order) so the trap
  // is deterministic and cycles: Tab past the last action wraps to the first,
  // Shift+Tab before the first wraps to the last. Focus can never reach the
  // controls the backdrop only visually covers.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled])",
    );
    if (!focusable || focusable.length === 0) return;
    const items = Array.from(focusable);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const dir = e.shiftKey ? -1 : 1;
    // From outside the set (current === -1), Tab lands on the first item and
    // Shift+Tab on the last; otherwise step with wraparound.
    const next =
      current === -1
        ? e.shiftKey
          ? items.length - 1
          : 0
        : (current + dir + items.length) % items.length;
    e.preventDefault();
    items[next].focus();
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={onCancel}
      data-testid="modal-backdrop"
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bypass-modal-title"
        aria-describedby="bypass-modal-desc"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
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
        {/* #98: the safe downgrade is the dominant full-width primary (and keeps
            initial focus); the risky bypass and Cancel share a compact second row
            so the modal no longer stacks three full-height buttons. Bypass uses a
            red outline that only fills on hover — deliberate, not the default. */}
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
          <div className={styles.secondaryRow}>
            <button
              type="button"
              className={styles.cancel}
              data-testid="confirm-cancel"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.danger}
              data-testid="confirm-bypass"
              onClick={() => onConfirm(session.permissionMode)}
            >
              Reopen with bypass
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
