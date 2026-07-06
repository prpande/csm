import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildTree,
  compactTree,
  rollUpWorktrees,
  type SessionTree,
} from "../../sessionTree";
import { filterOutTemp } from "../../sessionFilter";
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
  /** Declutter view (#69): default on — hides temp folders and rolls
   *  `.claude/worktrees` sessions up into their owning project. Off shows the
   *  raw folder structure. Purely a view transform over the SAME scanned
   *  sessions, so toggling never triggers a re-scan. */
  declutter: boolean;
  toggleDeclutter: () => void;
}

export function useSessionScan(
  bridge: CsmBridge | undefined = currentBridge(),
): SessionScan {
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [status, setStatus] = useState<ScanStatus>("scanning");
  const [declutter, setDeclutter] = useState(true);
  // System temp roots for the hide filter (#69). Resolved by main (renderer lacks
  // `os`); empty until they arrive and on non-desktop — filterOutTemp treats []
  // as "hide nothing", so the tree degrades to showing everything.
  const [tempRoots, setTempRoots] = useState<string[]>([]);
  // Bumped by refresh() to re-run the scan effect without changing `bridge`.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    void bridge
      ?.getTempRoots?.()
      .then((roots) => {
        if (active) setTempRoots(roots);
      })
      .catch(() => {
        /* fail soft: no roots -> nothing hidden */
      });
    return () => {
      active = false;
    };
  }, [bridge]);

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
  const toggleDeclutter = useCallback(() => setDeclutter((d) => !d), []);
  // Transform pipeline (innermost first). In declutter mode: drop temp sessions,
  // build the tree, fold .claude/worktrees sessions into their owning project
  // (#101/#69), then compact single-child chains (#77). Raw mode skips the filter
  // and the roll-up, showing the folder structure as-is; compaction always runs.
  const tree = useMemo(() => {
    if (!declutter) return compactTree(buildTree(sessions));
    const visible = filterOutTemp(sessions, tempRoots);
    return compactTree(rollUpWorktrees(buildTree(visible)));
  }, [sessions, declutter, tempRoots]);

  return { tree, status, refresh, declutter, toggleDeclutter };
}
