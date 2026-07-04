import type { FolderNode } from "../../sessionTree";
import styles from "./FolderPane.module.css";

interface FolderPaneProps {
  /** The selected folder, or null when nothing is selected. */
  selected: FolderNode | null;
  /** Refresh this folder (wired to the global re-scan for now — see plan/#65). */
  onRefreshFolder: () => void;
  /** Disabled while a scan is in flight. */
  refreshDisabled: boolean;
}

// Right pane shell. With no selection it shows a centered prompt and NO folder
// header (spec §9). With a folder selected it shows the header (path + count +
// per-folder refresh); the virtualized session list that fills the body is a
// later slice (#66).
export function FolderPane({
  selected,
  onRefreshFolder,
  refreshDisabled,
}: FolderPaneProps) {
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
          <div className={styles.path}>{selected.path}</div>
          <div className={styles.meta}>
            {count} {count === 1 ? "session" : "sessions"} · most recent first
          </div>
        </div>
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
      </header>
      <div className={styles.listPlaceholder} aria-hidden="true" />
    </section>
  );
}
