import type { FolderNode } from "../../sessionTree";
import { truncatePathLabel } from "../pathLabel";
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
            {isExpanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className={styles.chevronSpacer} aria-hidden="true" />
        )}
        {/* A #77-compacted chain label can be a long path. Middle-truncate it so
            the drive head and the leaf both stay visible; the tooltip carries the
            full label, and the CSS end-ellipsis backstops the rare overflow. */}
        <span className={styles.name} title={node.name}>
          {truncatePathLabel(node.name)}
        </span>
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
