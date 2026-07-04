import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionScan } from "../hooks/useSessionScan";
import { findFolder, type FolderNode } from "../../sessionTree";
import { TitleBar } from "./TitleBar";
import { FolderTree } from "./FolderTree";
import { FolderPane } from "./FolderPane";
import styles from "./FolderBrowser.module.css";

// Slice-2 shell (decision A): the single owner of the tree's expansion and
// selection state, wrapping the #64 data layer. Children are presentational.
// Selection is held as a PATH (not a node reference) so it survives a buildTree
// rebuild between batches/refreshes; the live node is looked up per render and
// the selection self-clears if that folder disappears.
export function FolderBrowser() {
  const { tree, status, refresh } = useSessionScan();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Auto-expand each drive root once, the first time it appears — including a
  // root first seen in a later streaming tier. The ref tracks which roots have
  // already been seeded so a re-streamed root (a refresh, or a root that spans
  // tiers) does not undo the user's manual collapses by re-expanding.
  const seededRoots = useRef<Set<string>>(new Set());

  useEffect(() => {
    const fresh = tree.roots
      .map((r) => r.path)
      .filter((p) => !seededRoots.current.has(p));
    if (fresh.length === 0) return;
    fresh.forEach((p) => seededRoots.current.add(p));
    setExpanded((prev) => {
      const next = new Set(prev);
      fresh.forEach((p) => next.add(p));
      return next;
    });
  }, [tree.roots]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const select = useCallback((node: FolderNode) => {
    setSelectedPath(node.path);
  }, []);

  const scanning = status === "scanning";
  // Resolve the selection against the live tree. Null it out when the folder is
  // gone OR is no longer selectable (its own sessions aged out, leaving a
  // 0-session intermediate) — only ownCount>0 folders are selectable, matching
  // TreeNode — so the pane self-clears to the empty state instead of showing a
  // stale "0 sessions" header the tree can't highlight or clear.
  const resolved = selectedPath ? findFolder(tree, selectedPath) : null;
  const selected = resolved && resolved.ownCount > 0 ? resolved : null;

  return (
    <div className={styles.layout}>
      <TitleBar onRefresh={refresh} refreshing={scanning} />
      <div className={styles.body}>
        <FolderTree
          tree={tree}
          status={status}
          expandedPaths={expanded}
          selectedPath={selectedPath}
          onToggle={toggle}
          onSelect={select}
        />
        <FolderPane
          selected={selected}
          onRefreshFolder={refresh}
          refreshDisabled={scanning}
        />
      </div>
    </div>
  );
}
