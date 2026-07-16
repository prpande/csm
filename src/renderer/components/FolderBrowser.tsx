import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionScan } from "../hooks/useSessionScan";
import { useReopen } from "../hooks/useReopen";
import { findFolder, flattenVisible, type FolderNode } from "../../sessionTree";
import { TitleBar } from "./TitleBar";
import { FolderTree } from "./FolderTree";
import { FolderPane } from "./FolderPane";
import { BypassConfirmModal } from "./BypassConfirmModal";
import { Toast } from "./Toast";
import styles from "./FolderBrowser.module.css";

// Slice-2 shell (decision A): the single owner of the tree's expansion and
// selection state, wrapping the #64 data layer. Children are presentational.
// Selection is held as a PATH (not a node reference) so it survives a buildTree
// rebuild between batches/refreshes; the live node is looked up per render and
// the selection self-clears if that folder disappears.
export function FolderBrowser() {
  const { tree, status, refresh, declutter, toggleDeclutter } =
    useSessionScan();
  const {
    pendingBypass,
    toast,
    requestReopen,
    confirmReopen,
    cancelReopen,
    dismissToast,
  } = useReopen();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Keyboard focus (#70) is held as a PATH for the same reason selection is:
  // buildTree rebuilds every node between streaming batches, so a node reference
  // would go stale. treeKeyAction falls back to the first row if the path is gone.
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
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

  // "Focus lands on the tree on load" (spec §9): seed the focused row the first
  // time the tree has one. Only the roving-tabindex STATE is seeded — no
  // .focus() call fires until the user actually enters the tree, so this never
  // steals focus from the page on mount.
  const visible = useMemo(
    () => flattenVisible(tree, expanded),
    [tree, expanded],
  );
  useEffect(() => {
    setFocusedPath((prev) => {
      if (visible.length === 0) return prev;
      // Keep the user's focus unless the row it names has disappeared (a folder
      // aged out between batches, or the declutter toggle hid it).
      if (prev !== null && visible.some((f) => f.node.path === prev))
        return prev;
      return visible[0].node.path;
    });
  }, [visible]);

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
          declutter={declutter}
          onToggleDeclutter={toggleDeclutter}
          focusedPath={focusedPath}
          onFocusNode={setFocusedPath}
        />
        <FolderPane
          selected={selected}
          onRefreshFolder={refresh}
          refreshDisabled={scanning}
          onOpen={(session) => void requestReopen(session)}
        />
      </div>
      {pendingBypass && (
        <BypassConfirmModal
          session={pendingBypass}
          onConfirm={(mode) => void confirmReopen(mode)}
          onCancel={cancelReopen}
        />
      )}
      {toast && <Toast message={toast.message} onDismiss={dismissToast} />}
    </div>
  );
}
