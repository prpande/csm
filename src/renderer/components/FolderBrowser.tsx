import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionScan } from "../hooks/useSessionScan";
import { useReopen } from "../hooks/useReopen";
import { useSidebarWidth } from "../hooks/useSidebarWidth";
import { findFolder, flattenVisible, type FolderNode } from "../../sessionTree";
import type { SessionMetadata } from "../../sessionParser";
import { SIDEBAR_MIN_WIDTH, maxSidebarWidth } from "../../sidebarWidth";
import { pathLabelBudget } from "../pathLabel";
import { TitleBar } from "./TitleBar";
import { FolderTree } from "./FolderTree";
import { FolderPane } from "./FolderPane";
import { BypassConfirmModal } from "./BypassConfirmModal";
import { SettingsModal } from "./SettingsModal";
import { NewSessionModal } from "./NewSessionModal";
import { Toast } from "./Toast";
import styles from "./FolderBrowser.module.css";

const SAVED_MESSAGE = "Claude path saved.";

// A newly launched session's JSONL doesn't exist the instant the terminal
// spawns — claude writes it as it starts up. Rescan after a short delay so the
// new session appears in its folder without the user hitting refresh (#165).
const NEW_SESSION_RESCAN_DELAY_MS = 2500;

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  // New-session modal (#165): null = closed; a string = open, prefilled with
  // that directory ("" from the title bar, the folder path from the pane).
  const [newSessionDir, setNewSessionDir] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  // Keyboard focus (#70) is held as a PATH for the same reason selection is:
  // buildTree rebuilds every node between streaming batches, so a node reference
  // would go stale. treeKeyAction falls back to the first row if the path is gone.
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  // Auto-expand each drive root once, the first time it appears — including a
  // root first seen in a later streaming tier. The ref tracks which roots have
  // already been seeded so a re-streamed root (a refresh, or a root that spans
  // tiers) does not undo the user's manual collapses by re-expanding.
  const seededRoots = useRef<Set<string>>(new Set());
  // Resizable sidebar (#164): all state and handlers live in the hook; this
  // component only wires them onto the separator element below.
  const {
    sidebarWidth,
    windowWidth,
    dragging: draggingSplitter,
    onSplitterPointerDown,
    onSplitterPointerMove,
    endSplitterDrag,
    onSplitterKeyDown,
    resetSplitter,
  } = useSidebarWidth();

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

  // Cross-modal gates (settings spec §3): the bypass-confirm modal now traps Tab
  // (#70), but SettingsModal does not yet, so backdrop coverage still doesn't
  // imply focus containment on that side — rows stay keyboard-reachable behind the
  // settings backdrop. State gates keep the three modals mutually exclusive so
  // their backdrops can't stack.
  const openSettings = useCallback(() => {
    if (!pendingBypass && newSessionDir === null) setSettingsOpen(true);
  }, [pendingBypass, newSessionDir]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // New-session modal (#165), same mutual-exclusion discipline. Both entry
  // points pass a directory: the folder pane its selected path, the title bar
  // an empty string (the user browses/types).
  const openNewSession = useCallback(
    (dir: string) => {
      if (!pendingBypass && !settingsOpen) setNewSessionDir(dir);
    },
    [pendingBypass, settingsOpen],
  );
  const closeNewSession = useCallback(() => setNewSessionDir(null), []);
  // A launched session's file lands a beat later; rescan once after a delay so
  // it appears on its own. The timer is cleared on unmount and re-armed if a
  // second launch happens before the first fires.
  const rescanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (rescanTimer.current) clearTimeout(rescanTimer.current);
    },
    [],
  );
  const handleLaunched = useCallback(() => {
    if (rescanTimer.current) clearTimeout(rescanTimer.current);
    rescanTimer.current = setTimeout(refresh, NEW_SESSION_RESCAN_DELAY_MS);
  }, [refresh]);

  // Newest-message-wins toast slot (settings spec §3): a fresh save
  // confirmation dismisses a live reopen error, and a reopen error arriving
  // later clears the confirmation — superseded messages are dropped, never
  // queued for redisplay.
  const handleSaved = useCallback(() => {
    dismissToast();
    setSavedMessage(SAVED_MESSAGE);
  }, [dismissToast]);
  // Stable identity: Toast's auto-dismiss effect keys on [message, onDismiss],
  // so an inline closure here would restart the 6s timer on every unrelated
  // FolderBrowser re-render (scan batches, tree toggles).
  const dismissSaved = useCallback(() => setSavedMessage(null), []);

  useEffect(() => {
    if (toast) setSavedMessage(null);
  }, [toast]);

  // Stable identity so FolderPane's memo holds through per-frame splitter-drag
  // renders — an inline closure would re-render the pane on every frame.
  const openSession = useCallback(
    (session: SessionMetadata) => {
      if (!settingsOpen && newSessionDir === null) void requestReopen(session);
    },
    [settingsOpen, newSessionDir, requestReopen],
  );

  // "Focus lands on the tree on load" (spec §9), implemented as: the tree's
  // roving tab stop is seeded and ready — NOT as stealing the user's focus.
  // This seeds STATE only; TreeNode pulls real DOM focus solely when the tree
  // already holds it (see the comment there). Stealing was measured to be
  // actively harmful: a scan streams in tiers, so it re-fired on every tier and
  // on every refresh, making other controls impossible to keep focus on.
  const visible = useMemo(
    () => flattenVisible(tree, expanded),
    [tree, expanded],
  );
  useEffect(() => {
    setFocusedPath((prev) => {
      if (visible.length === 0) return prev;
      // Keep the user's row unless it has disappeared (aged out between batches,
      // hidden by the declutter toggle, or not yet re-streamed after a refresh).
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
  // Memoized like `visible` above: a splitter drag re-renders this component
  // per pointermove, and an inline findFolder would re-walk the whole tree on
  // every frame for an unchanged selection.
  const resolved = useMemo(
    () => (selectedPath ? findFolder(tree, selectedPath) : null),
    [tree, selectedPath],
  );
  const selected = resolved && resolved.ownCount > 0 ? resolved : null;

  return (
    <div className={styles.layout}>
      <TitleBar
        onRefresh={refresh}
        refreshing={scanning}
        onOpenSettings={openSettings}
        onNewSession={() => openNewSession("")}
      />
      <div
        className={styles.body}
        style={
          { "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties
        }
      >
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
          labelBudget={pathLabelBudget(sidebarWidth)}
        />
        {/* APG window-splitter (#164): a real value-bearing separator, in the
            Tab order, arrows/Home/End on the keyboard, drag on the pointer.
            It IS the visual divider (the sidebar's old border-right), with a
            widened invisible hit area in CSS. */}
        <div
          className={styles.splitter}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the folder sidebar"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={maxSidebarWidth(windowWidth)}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          data-dragging={draggingSplitter || undefined}
          onPointerDown={onSplitterPointerDown}
          onPointerMove={onSplitterPointerMove}
          onPointerUp={endSplitterDrag}
          onLostPointerCapture={endSplitterDrag}
          onDoubleClick={resetSplitter}
          onKeyDown={onSplitterKeyDown}
        />
        <FolderPane
          selected={selected}
          onRefreshFolder={refresh}
          refreshDisabled={scanning}
          onOpen={openSession}
          onNewSession={openNewSession}
        />
      </div>
      {pendingBypass && (
        <BypassConfirmModal
          session={pendingBypass}
          onConfirm={(mode) => void confirmReopen(mode)}
          onCancel={cancelReopen}
        />
      )}
      {settingsOpen && (
        <SettingsModal onClose={closeSettings} onSaved={handleSaved} />
      )}
      {newSessionDir !== null && (
        <NewSessionModal
          initialDir={newSessionDir}
          onClose={closeNewSession}
          onLaunched={handleLaunched}
        />
      )}
      {toast ? (
        <Toast message={toast.message} onDismiss={dismissToast} />
      ) : savedMessage ? (
        <Toast message={savedMessage} onDismiss={dismissSaved} />
      ) : null}
    </div>
  );
}
