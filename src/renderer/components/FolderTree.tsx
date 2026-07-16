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
  /** Declutter view state + toggle (#69): on hides temp folders and rolls
   *  worktree sessions up into their project; off shows the raw structure. */
  declutter: boolean;
  onToggleDeclutter: () => void;
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
  declutter,
  onToggleDeclutter,
}: FolderTreeProps) {
  const isEmpty = tree.roots.length === 0 && tree.unknown === null;

  return (
    <nav className={styles.sidebar} aria-label="Folders">
      <div className={styles.sidebarHeader}>
        <span>Folders</span>
        {/* Declutter switch (#69): a custom role="switch" (not a native
            checkbox) so it inherits the design-system styling and reads its
            on/off state to assistive tech. On = hide temp + roll up worktrees. */}
        <button
          type="button"
          role="switch"
          aria-checked={declutter}
          aria-label="Hide temp folders and roll worktree sessions up into their project"
          className={styles.declutter}
          onClick={onToggleDeclutter}
          title="Hide temp folders and roll worktree sessions into their project"
        >
          <span className={styles.declutterTrack} aria-hidden="true">
            <span className={styles.declutterThumb} />
          </span>
          <span className={styles.declutterLabel}>Declutter</span>
        </button>
      </div>
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
      {/* Two failures, two causes, two remedies (#83). "error" = the scan threw
          (runtime/data — transient, so a refresh may genuinely help).
          "unavailable" = the preload bridge never loaded (a build/packaging bug
          like #81). The preload path is a static __dirname join resolved from the
          installed files on every launch, so restarting re-runs the identical
          broken build — the copy must NOT invite a retry. Per TESTING.md the only
          real remedy is a reinstall (there is no auto-update). */}
      {status === "error" && isEmpty && (
        <div className={styles.notice}>Couldn’t load sessions</div>
      )}
      {status === "unavailable" && (
        <div className={styles.notice}>
          Session bridge unavailable — reinstall CSM
        </div>
      )}
    </nav>
  );
}
