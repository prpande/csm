import { useEffect, useRef } from "react";
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
  /** The one keyboard-focused node in the whole tree (#70), or null before the
   *  tree has any rows. Drives the roving tabindex. */
  focusedPath?: string | null;
  /** Report a click so the keyboard's focus follows the mouse — otherwise an
   *  arrow key after a click would resume from a stale row. */
  onFocusNode?: (path: string) => void;
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
  focusedPath,
  onFocusNode,
}: TreeNodeProps) {
  const hasChildren = node.children.length > 0;
  const isExpanded = hasChildren && expandedPaths.has(node.path);
  const isSelectable = node.ownCount > 0;
  const isSelected = isSelectable && selectedPath === node.path;
  // Derived with zero I/O from the sessions already in the tree (#111), so it
  // still marks a repo whose folder has since been deleted.
  const isRepo = isGitRepo(node);
  const isFocused = focusedPath === node.path;
  const itemRef = useRef<HTMLLIElement>(null);

  // Pull real DOM focus to the focused row (#70) — real focus, not just
  // aria-activedescendant, so :focus-visible and the e2e can both observe it.
  //
  // ONLY when the tree already holds focus, i.e. the user is navigating inside
  // it. The roving tabindex is re-seeded every time a scan tier lands or a
  // refresh re-streams, and compactTree can change a node's path mid-scan, which
  // remounts this component and re-fires the effect. Focusing unconditionally
  // therefore stole focus on populate, again on every tier, and again on every
  // refresh — measured in real Electron, not theorised: it made other controls
  // impossible to keep focus on while sessions loaded.
  useEffect(() => {
    if (!isFocused) return;
    const el = itemRef.current;
    if (!el) return;
    const tree = el.closest('[role="tree"]');
    if (tree?.contains(document.activeElement)) el.focus();
  }, [isFocused]);

  const onRowClick = () => {
    // Keep keyboard focus in step with the mouse, or the next arrow key would
    // resume from wherever the keyboard last was, not from what was clicked.
    onFocusNode?.(node.path);
    if (isSelectable) onSelect(node);
    else if (hasChildren) onToggle(node.path);
  };

  return (
    <li
      ref={itemRef}
      className={styles.item}
      role="treeitem"
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={isSelectable ? isSelected : undefined}
      // Roving tabindex: the tree is ONE tab stop. tabIndex/focus must sit on the
      // same element as aria-expanded/aria-selected — putting them on the inner
      // row div would give a tree that navigates but announces wrong.
      tabIndex={isFocused ? 0 : -1}
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
            // Out of the natural Tab order (#70): the tree is a composite widget
            // with ONE tab stop, so Tab must reach the tree — not every visible
            // node's chevron in turn. Still mouse-clickable, and keyboard users
            // expand/collapse via the row's own Right/Left/Space (ARIA APG).
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onFocusNode?.(node.path);
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
              focusedPath={focusedPath}
              onFocusNode={onFocusNode}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
