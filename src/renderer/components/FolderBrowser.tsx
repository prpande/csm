import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionScan } from "../hooks/useSessionScan";
import { useReopen } from "../hooks/useReopen";
import { findFolder, flattenVisible, type FolderNode } from "../../sessionTree";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  maxSidebarWidth,
  restoreSidebarWidth,
  splitterKeyWidth,
} from "../../sidebarWidth";
import { TitleBar } from "./TitleBar";
import { FolderTree } from "./FolderTree";
import { FolderPane } from "./FolderPane";
import { BypassConfirmModal } from "./BypassConfirmModal";
import { SettingsModal } from "./SettingsModal";
import { Toast } from "./Toast";
import styles from "./FolderBrowser.module.css";

const SAVED_MESSAGE = "Claude path saved.";

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
  // Resizable sidebar (#164). All the math is the pure sidebarWidth module;
  // this owns the wiring only. Width is renderer view state (per-machine
  // chrome), so it persists in localStorage — deliberately NOT settingsStore,
  // which would cost an IPC round-trip per drag frame for a non-setting.
  // windowWidth is state (not read ad hoc) so the separator's aria-valuemax
  // re-announces when the window resizes.
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    restoreSidebarWidth(
      window.localStorage.getItem(SIDEBAR_WIDTH_KEY),
      window.innerWidth,
    ),
  );
  const [draggingSplitter, setDraggingSplitter] = useState(false);
  // The drag origin — deltas are computed against pointer-DOWN, not the
  // previous move, so a jittery pointer cannot accumulate rounding drift.
  const splitterDragStart = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const onResize = () => {
      setWindowWidth(window.innerWidth);
      setSidebarWidth((w) => clampSidebarWidth(w, window.innerWidth));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const onSplitterPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    splitterDragStart.current = { x: e.clientX, width: sidebarWidth };
    setDraggingSplitter(true);
    // Capture routes every move to the splitter even when the cursor outruns
    // the thin strip mid-drag. Guarded: jsdom has no pointer capture.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onSplitterPointerMove = (e: React.PointerEvent) => {
    const start = splitterDragStart.current;
    if (!start) return;
    setSidebarWidth(
      clampSidebarWidth(start.width + (e.clientX - start.x), windowWidth),
    );
  };
  // Shared by pointerup AND lostpointercapture: if the capture is torn away
  // (alt-tab, context menu), the drag must not keep tracking a phantom pointer.
  const endSplitterDrag = () => {
    splitterDragStart.current = null;
    setDraggingSplitter(false);
  };
  const onSplitterKeyDown = (e: React.KeyboardEvent) => {
    const next = splitterKeyWidth(e.key, sidebarWidth, windowWidth);
    if (next === null) return; // not ours — let Tab and friends through
    e.preventDefault();
    setSidebarWidth(next);
  };

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
  // settings backdrop. Two state gates keep the modals mutually exclusive so the
  // two backdrops can't stack.
  const openSettings = useCallback(() => {
    if (!pendingBypass) setSettingsOpen(true);
  }, [pendingBypass]);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

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
  const resolved = selectedPath ? findFolder(tree, selectedPath) : null;
  const selected = resolved && resolved.ownCount > 0 ? resolved : null;

  return (
    <div className={styles.layout}>
      <TitleBar
        onRefresh={refresh}
        refreshing={scanning}
        onOpenSettings={openSettings}
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
          onDoubleClick={() =>
            setSidebarWidth(
              clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, windowWidth),
            )
          }
          onKeyDown={onSplitterKeyDown}
        />
        <FolderPane
          selected={selected}
          onRefreshFolder={refresh}
          refreshDisabled={scanning}
          onOpen={(session) => {
            if (!settingsOpen) void requestReopen(session);
          }}
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
      {toast ? (
        <Toast message={toast.message} onDismiss={dismissToast} />
      ) : savedMessage ? (
        <Toast message={savedMessage} onDismiss={dismissSaved} />
      ) : null}
    </div>
  );
}
