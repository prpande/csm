import { useCallback, useState } from "react";
import type { SessionMetadata } from "../../sessionParser";
import { needsBypassConfirm, reopenErrorMessage } from "../../reopenView";

/** A transient, non-blocking status message (spec §7 error surface). */
export interface ReopenToast {
  message: string;
}

export interface UseReopen {
  /** The bypassPermissions session awaiting confirmation, or null. */
  pendingBypass: SessionMetadata | null;
  /** The active error toast, or null. */
  toast: ReopenToast | null;
  /** Open gesture from a row: confirm-gate bypass sessions, reopen the rest. */
  requestReopen: (session: SessionMetadata) => Promise<void>;
  /** Resolve the confirm modal — reopen the pending session with `mode`
   * (its original bypassPermissions, or the acceptEdits downgrade). */
  confirmReopen: (mode: string) => Promise<void>;
  /** Dismiss the confirm modal without reopening. */
  cancelReopen: () => void;
  /** Dismiss the current toast. */
  dismissToast: () => void;
}

// Orchestrates the renderer reopen flow (#67, spec §7). Owns the confirm-modal
// and toast state; the bypass decision and error-message mapping are the pure
// reopenView helpers. Rendered/owned by FolderBrowser (Approach 1); the modal and
// toast are presentational and driven by this state.
export function useReopen(): UseReopen {
  const [pendingBypass, setPendingBypass] = useState<SessionMetadata | null>(
    null,
  );
  const [toast, setToast] = useState<ReopenToast | null>(null);

  // Reopen `session` with `mode` (passed through unchanged, §4.1). Never throws:
  // the bridge resolves a discriminated result, and an absent bridge (a plain
  // browser without the preload) fails soft to the generic toast.
  const run = useCallback(async (session: SessionMetadata, mode: string) => {
    const bridge = window.csm;
    if (!bridge) {
      setToast({ message: reopenErrorMessage("SPAWN_FAILED") });
      return;
    }
    const result = await bridge.reopenSession({
      cwd: session.cwd,
      sessionId: session.sessionId,
      mode,
    });
    if (!result.ok) {
      setToast({ message: reopenErrorMessage(result.code) });
    }
  }, []);

  const requestReopen = useCallback(
    async (session: SessionMetadata) => {
      if (needsBypassConfirm(session.permissionMode)) {
        setPendingBypass(session);
        return;
      }
      await run(session, session.permissionMode);
    },
    [run],
  );

  const confirmReopen = useCallback(
    async (mode: string) => {
      const session = pendingBypass;
      setPendingBypass(null);
      if (!session) return;
      await run(session, mode);
    },
    [pendingBypass, run],
  );

  const cancelReopen = useCallback(() => setPendingBypass(null), []);
  const dismissToast = useCallback(() => setToast(null), []);

  return {
    pendingBypass,
    toast,
    requestReopen,
    confirmReopen,
    cancelReopen,
    dismissToast,
  };
}
