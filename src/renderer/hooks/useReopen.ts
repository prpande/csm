import { useCallback, useRef, useState } from "react";
import type { SessionMetadata } from "../../sessionParser";
import type { CsmBridge } from "../types/csm";
import { currentBridge } from "../bridge";
import {
  needsBypassConfirm,
  reopenErrorMessage,
  GENERIC_REOPEN_MESSAGE,
} from "../../reopenView";

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
export function useReopen(
  bridge: CsmBridge | undefined = currentBridge(),
): UseReopen {
  const [pendingBypass, setPendingBypass] = useState<SessionMetadata | null>(
    null,
  );
  const [toast, setToast] = useState<ReopenToast | null>(null);
  // Guards against overlapping launches: a reopen is an async round-trip to the
  // bridge, so a fast repeat gesture (double double-click, or a modal button
  // activated twice before it unmounts) could otherwise fire reopenSession twice
  // and spawn two terminals. A ref (not state) so the check is synchronous and
  // doesn't depend on a re-render landing first.
  const inFlight = useRef(false);

  // Reopen `session` with `mode` (passed through unchanged, §4.1). Never throws:
  // the bridge resolves a discriminated result, and an absent bridge (a plain
  // browser without the preload) fails soft to the generic toast.
  const run = useCallback(
    async (session: SessionMetadata, mode: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        if (!bridge) {
          setToast({ message: GENERIC_REOPEN_MESSAGE });
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
      } finally {
        inFlight.current = false;
      }
    },
    [bridge],
  );

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
