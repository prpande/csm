import { isGitRepo, type FolderNode } from "../../sessionTree";
import { truncatePathLabel } from "../pathLabel";
import { GitBranchIcon } from "./GitBranchIcon";
import styles from "./FolderTree.module.css";

interface TreeNodeProps {
  node: FolderNode;
  /** Nesting depth (0 = root), drives the indent. */
  depth: number;
  expandedPaths: ReadonlySet<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: FolderNode) => void;
}

// One tree row plus (when expanded) its children. A collapsed node does NOT
// render its child <ul>, so collapsed subtrees stay out of the DOM entirely
// (spec §6 perf). A folder with its own sessions (ownCount > 0) is selectable
// and shows a count; a pure navigation folder (ownCount === 0) only expands.
export function TreeNode({
  node,
  depth,
  expandedPaths,
  selectedPath,
  onToggle,
  onSelect,
}: TreeNodeProps) {
  const hasChildren = node.children.length > 0;
  const isExpanded = hasChildren && expandedPaths.has(node.path);
  const isSelectable = node.ownCount > 0;
  const isSelected = isSelectable && selectedPath === node.path;
  // Derived with zero I/O from the sessions already in the tree (#111), so it
  // still marks a repo whose folder has since been deleted.
  const isRepo = isGitRepo(node);

  const onRowClick = () => {
    if (isSelectable) onSelect(node);
    else if (hasChildren) onToggle(node.path);
  };

  return (
    <li
      className={styles.item}
      role="treeitem"
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={isSelectable ? isSelected : undefined}
    >
      <div
        className={isSelected ? `${styles.row} ${styles.selected}` : styles.row}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={onRowClick}
      >
        {hasChildren ? (
          <button
            type="button"
            className={styles.chevron}
            aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.path);
            }}
          >
            {/* A single right-pointing chevron that rotates 90° when open (matches
                PRism's file tree). Presentational — the button's aria-label
                carries the state. */}
            <svg
              className={
                isExpanded
                  ? `${styles.chevronIcon} ${styles.chevronIconOpen}`
                  : styles.chevronIcon
              }
              viewBox="0 0 16 16"
              width="15"
              height="15"
              aria-hidden="true"
            >
              <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : (
          <span className={styles.chevronSpacer} aria-hidden="true" />
        )}
        {/* A #77-compacted chain label can be a long path. Middle-truncate it so
            the drive head and the leaf both stay visible; the tooltip carries the
            full absolute path (`node.path` — always absolute, unlike a sub-chain's
            relative `name`), and the CSS end-ellipsis backstops the rare overflow. */}
        <span className={styles.name} title={node.path}>
          {truncatePathLabel(node.name)}
        </span>
        {/* Repo marker (#111). Decorative: the wrapper's title carries the
            meaning on hover, and the row's accessible name stays the folder
            name — a screen reader should not read a glyph per row. */}
        {isRepo && (
          <span
            className={styles.repoMarker}
            data-testid="git-repo-marker"
            title="Git repository"
          >
            <GitBranchIcon className={styles.repoMarkerIcon} size={12} />
          </span>
        )}
        {isSelectable && <span className={styles.count}>{node.ownCount}</span>}
      </div>
      {isExpanded && (
        <ul className={styles.group} role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
