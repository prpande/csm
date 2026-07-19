import { memo } from "react";
import type { SessionMetadata } from "../../sessionParser";
import type { FolderNode } from "../../sessionTree";
import { currentBridge } from "../bridge";
import { SessionList } from "./SessionList";
import styles from "./FolderPane.module.css";

interface FolderPaneProps {
  /** The selected folder, or null when nothing is selected. */
  selected: FolderNode | null;
  /** Refresh this folder (wired to the global re-scan for now — see plan/#65). */
  onRefreshFolder: () => void;
  /** Disabled while a scan is in flight. */
  refreshDisabled: boolean;
  /** Row open gesture (double-click → reopen, #67). */
  onOpen?: (session: SessionMetadata) => void;
  /** Start a new session in this folder (#165) — passes the folder path up to
   *  open the launcher modal prefilled. Absent without the launch bridge. */
  onNewSession?: (dir: string) => void;
}

// Right pane shell. With no selection it shows a centered prompt and NO folder
// header (spec §9). With a folder selected it shows the header (path + count +
// per-folder refresh) and the virtualized session list (#66) filling the body.
// Memoized (#164): same reason as FolderTree — skip the pane subtree during
// per-frame splitter-drag renders (all props, incl. onOpen, are stable).
export const FolderPane = memo(function FolderPane({
  selected,
  onRefreshFolder,
  refreshDisabled,
  onOpen,
  onNewSession,
}: FolderPaneProps) {
  // The launch bridge is optional (absent in a plain browser / older preload),
  // so the button only appears when a new session can actually be started.
  const newSessionReady =
    onNewSession !== undefined && !!currentBridge()?.newSession;
  if (!selected) {
    return (
      <section className={styles.pane}>
        <div className={styles.empty}>Select a folder to view its sessions</div>
      </section>
    );
  }

  const count = selected.ownCount;
  return (
    <section className={styles.pane}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.eyebrow}>Folder</div>
          <div className={styles.path}>{selected.path}</div>
          <div className={styles.meta}>
            {count} {count === 1 ? "session" : "sessions"} · most recent first
          </div>
        </div>
        <div className={styles.headerActions}>
          {newSessionReady && (
            <button
              type="button"
              className={styles.newSession}
              onClick={() => onNewSession?.(selected.path)}
              aria-label="Start a new session in this folder"
              title="Start a new session in this folder"
            >
              + New session
            </button>
          )}
          <button
            type="button"
            className={styles.refresh}
            onClick={onRefreshFolder}
            disabled={refreshDisabled}
            aria-label="Refresh this folder"
            title="Refresh this folder"
          >
            ⟳
          </button>
        </div>
      </header>
      {/* key by folder path so a new selection mounts a fresh list — the
          previous folder's scroll position never carries over (spec §9:
          newest-first). */}
      <SessionList
        key={selected.path}
        sessions={selected.sessions}
        onOpen={onOpen}
        worktreeBranches={selected.worktreeBranches}
      />
    </section>
  );
});
