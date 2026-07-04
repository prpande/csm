import { useCallback, useEffect, useMemo, useState } from "react";
import { buildTree, type SessionTree } from "../../sessionTree";
import type { SessionMetadata } from "../../sessionParser";
import type { CsmBridge } from "../types/csm";
import { currentBridge } from "../bridge";

// Thin React adapter over the #59 streaming bridge: it drives `csm.listSessions`,
// accumulates the per-tier `SessionMetadata[]` batches, and (re)derives the
// folder-tree view-model via the pure `buildTree` (Approach A — recompute per
// batch; see docs/plans/64-renderer-data-layer.md). All tree/sort/group logic
// lives in sessionTree.ts so this stays a small, mostly-plumbing hook.

export type ScanStatus = "scanning" | "done" | "error";

export interface SessionScan {
  tree: SessionTree;
  status: ScanStatus;
  /** Restart the scan from scratch (title-bar refresh). */
  refresh: () => void;
}

export function useSessionScan(
  bridge: CsmBridge | undefined = currentBridge(),
): SessionScan {
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [status, setStatus] = useState<ScanStatus>("scanning");
  // Bumped by refresh() to re-run the scan effect without changing `bridge`.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // Non-desktop / plain browser (no preload): fail soft, don't throw.
    if (!bridge?.listSessions) {
      setSessions([]);
      setStatus("error");
      return;
    }
    // Fresh scan: clear prior results and show progress.
    setSessions([]);
    setStatus("scanning");
    // Guard against a late callback landing after this effect was torn down
    // (unmount / refresh) — belt-and-suspenders with the preload's own `settled`.
    let active = true;
    const unsubscribe = bridge.listSessions({
      onBatch: (batch) => {
        if (active) setSessions((prev) => prev.concat(batch));
      },
      onDone: () => {
        if (active) setStatus("done");
      },
      onError: () => {
        // Keep any batches already shown (fail soft, spec §12).
        if (active) setStatus("error");
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const tree = useMemo(() => buildTree(sessions), [sessions]);

  return { tree, status, refresh };
}
