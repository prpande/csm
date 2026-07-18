import { memo, useRef } from "react";
import { flushSync } from "react-dom";
import {
  flattenVisible,
  treeKeyAction,
  type FolderNode,
  type SessionTree,
} from "../../sessionTree";
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
  /** The keyboard-focused node (#70). Owned by FolderBrowser alongside
   *  expansion/selection, so it survives a buildTree rebuild between batches. */
  focusedPath: string | null;
  onFocusNode: (path: string) => void;
  /** Char budget for compacted chain labels, derived from the resizable
   *  sidebar width (#164) so widening the sidebar reveals longer labels.
   *  Quantized upstream, so it changes rarely mid-drag and the memo holds. */
  labelBudget?: number;
}

// Left sidebar: the expandable folder tree over the #64 view-model. Renders the
// named roots, then the pinned "(unknown)" group last (spec §9). Shows a
// streaming indicator while lower tiers load, and a friendly empty state once a
// completed scan turns up nothing (spec §12).
// Memoized (#164): FolderBrowser re-renders on every pointermove of a splitter
// drag; all props here are referentially stable across those renders, so memo
// skips re-walking the visible tree per frame.
export const FolderTree = memo(function FolderTree({
  tree,
  status,
  expandedPaths,
  selectedPath,
  onToggle,
  onSelect,
  declutter,
  onToggleDeclutter,
  focusedPath,
  onFocusNode,
  labelBudget,
}: FolderTreeProps) {
  const isEmpty = tree.roots.length === 0 && tree.unknown === null;

  const treeRef = useRef<HTMLUListElement>(null);

  // Move DOM focus ONLY from a user gesture the tree itself handled — a keydown
  // it received, or a click on one of its rows. Never from data arriving.
  //
  // That rule is the design, and it is the third attempt; the first two failed in
  // opposite directions, and the reason no middle ground exists is worth stating
  // so nobody re-derives it:
  //   1. Focusing whenever a row became "the focused one" STEALS. A scan streams
  //      in tiers and compactTree can change a node's path mid-scan, so that
  //      fires on populate, on every tier, and on every refresh.
  //   2. Gating on `tree.contains(document.activeElement)` STRANDS: when the
  //      focused <li> is removed the browser has already blurred to <body>.
  //   3. Tracking ownership from focus/blur CANNOT WORK. Verified in Chromium:
  //      a removal and a click on a non-focusable area BOTH fire focusout with
  //      relatedTarget === null, and `target.isConnected` is true in both. The
  //      two are indistinguishable at blur time, so any branch on that event
  //      reintroduces (1) or (2).
  //
  // Focusing from the gesture sidesteps all of it: inside our own keydown the
  // tree provably has focus, so focusing cannot steal, and there is no ambiguous
  // event to misread. flushSync commits the state change first, so the row we
  // reach for exists (Right may have just expanded its parent).
  const focusRovingItem = () => {
    treeRef.current
      ?.querySelector<HTMLElement>(':scope [tabindex="0"]')
      ?.focus();
  };

  // One handler on the <ul role="tree">, not one per row: the tree is a
  // composite widget with a single tab stop, and key events bubble up from the
  // focused <li>. All the semantics live in the pure treeKeyAction; this only
  // dispatches, so the key map stays testable without a DOM.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const flat = flattenVisible(tree, expandedPaths);
    const action = treeKeyAction(e.key, flat, focusedPath, expandedPaths);
    if (!action) return; // not ours — let the event through (e.g. Tab)
    e.preventDefault();
    // flushSync so the DOM reflects the action before we reach for the row:
    // ArrowRight may have just expanded a parent, and the child it should land
    // on does not exist until that render commits.
    flushSync(() => {
      if (action.type === "focus") onFocusNode(action.path);
      else if (action.type === "toggle") onToggle(action.path);
      else onSelect(action.node);
    });
    focusRovingItem();
  };

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
      {/* The handler sits here, not per row: role="tree" is a composite widget
          with one tab stop, and keys bubble up from the focused <li>. */}
      <ul
        className={styles.tree}
        role="tree"
        aria-label="Session folders"
        ref={treeRef}
        onKeyDown={onKeyDown}
      >
        {tree.roots.map((root) => (
          <TreeNode
            key={root.path}
            node={root}
            depth={0}
            expandedPaths={expandedPaths}
            selectedPath={selectedPath}
            onToggle={onToggle}
            onSelect={onSelect}
            focusedPath={focusedPath}
            onFocusNode={onFocusNode}
            labelBudget={labelBudget}
          />
        ))}
        {/* Pinned last (spec §9) — flattenVisible mirrors this, so Down from the
            last root lands here and not somewhere the user isn't looking. */}
        {tree.unknown && (
          <TreeNode
            key={tree.unknown.path}
            node={tree.unknown}
            depth={0}
            expandedPaths={expandedPaths}
            selectedPath={selectedPath}
            onToggle={onToggle}
            onSelect={onSelect}
            focusedPath={focusedPath}
            onFocusNode={onFocusNode}
            labelBudget={labelBudget}
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
      {/* The isEmpty asymmetry below is deliberate, not an oversight. On "error"
          it is load-bearing: a scan can throw AFTER streaming batches, and
          useSessionScan keeps those on purpose (fail soft, spec §12) — so this
          notice must yield to a partial result. On "unavailable" the hook clears
          sessions and returns before subscribing, so no batch can ever exist and
          the guard would be dead code. */}
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
});
