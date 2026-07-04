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
  // Auto-expand the drive roots once, the first time a scan yields any. A ref
  // gates it so a later refresh (which re-streams the same roots) does not undo
  // the user's manual collapses by re-seeding.
  const seededRoots = useRef(false);

  useEffect(() => {
    if (!seededRoots.current && tree.roots.length > 0) {
      seededRoots.current = true;
      setExpanded(new Set(tree.roots.map((r) => r.path)));
    }
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
  const selected = selectedPath ? findFolder(tree, selectedPath) : null;

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
