import type { FolderNode, SessionTree } from "../../sessionTree";
import type { ScanStatus } from "../hooks/useSessionScan";
import { TreeNode } from "./TreeNode";
import styles from "./FolderTree.module.css";

interface FolderTreeProps {
  tree: SessionTree;
  status: ScanStatus;
  expandedPaths: ReadonlySet<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: FolderNode) => void;
}

// Left sidebar: the expandable folder tree over the #64 view-model. Renders the
// named roots, then the pinned "(unknown)" group last (spec §9). Shows a
// streaming indicator while lower tiers load, and a friendly empty state once a
// completed scan turns up nothing (spec §12).
export function FolderTree({
  tree,
  status,
  expandedPaths,
  selectedPath,
  onToggle,
  onSelect,
}: FolderTreeProps) {
  const isEmpty = tree.roots.length === 0 && tree.unknown === null;

  return (
    <nav className={styles.sidebar} aria-label="Folders">
      <div className={styles.sidebarHeader}>Folders</div>
      <ul className={styles.tree} role="tree" aria-label="Session folders">
        {tree.roots.map((root) => (
          <TreeNode
            key={root.path}
            node={root}
            depth={0}
            expandedPaths={expandedPaths}
            selectedPath={selectedPath}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
        {tree.unknown && (
          <TreeNode
            key={tree.unknown.path}
            node={tree.unknown}
            depth={0}
            expandedPaths={expandedPaths}
            selectedPath={selectedPath}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        )}
      </ul>
      {status === "scanning" && (
        <div className={styles.loading}>⟳ loading older sessions…</div>
      )}
      {status === "done" && isEmpty && (
        <div className={styles.notice}>No Claude sessions found</div>
      )}
      {status === "error" && isEmpty && (
        <div className={styles.notice}>Couldn’t load sessions</div>
      )}
    </nav>
  );
}
