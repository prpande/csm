import { WindowControls } from "./WindowControls";
import { ThemeToggle } from "./ThemeToggle";
import { currentBridge } from "../bridge";
import brandIcon from "../../../assets/icons/png/icon_32.png";
import styles from "./TitleBar.module.css";

interface TitleBarProps {
  /** Full re-scan (data layer refresh()). */
  onRefresh: () => void;
  /** True while a scan is in flight — the refresh control disables to avoid
   *  stacking scans. */
  refreshing: boolean;
  /** Opens the settings modal (#68). The gear renders a disabled placeholder
   *  when absent or when there is no preload bridge to load/save through. */
  onOpenSettings?: () => void;
  /** Opens the new-session modal (#165) with no prefilled directory — the user
   *  browses or types one. Disabled placeholder without the launch bridge. */
  onNewSession?: () => void;
}

// Full-width app title bar (spec §9): brand + global controls. Refresh, the
// theme toggle (#86), settings (#68), and new-session (#165) are wired; search
// (phase C) remains a greyed disabled placeholder that establishes the layout.
export function TitleBar({
  onRefresh,
  refreshing,
  onOpenSettings,
  onNewSession,
}: TitleBarProps) {
  // Whole-bridge gate: get/setClaudePath are non-optional bridge members
  // (unlike the optional theme/windowControls sub-objects), so bridge presence
  // is the availability signal. Without it the modal could neither load nor
  // save, so the gear stays a labelled placeholder.
  const settingsReady = onOpenSettings !== undefined && !!currentBridge();
  const settingsLabel = settingsReady ? "Settings" : "Settings (unavailable)";
  // New-session gate: the launch path is an optional bridge member (absent in a
  // plain browser / older preload), so require it specifically.
  const newSessionReady =
    onNewSession !== undefined && !!currentBridge()?.newSession;
  const newSessionLabel = newSessionReady
    ? "New session"
    : "New session (unavailable)";
  return (
    <header className={styles.titleBar}>
      <div className={styles.brand}>
        {/* Decorative — the adjacent text names the app — so alt="" keeps it out
            of the a11y tree. Rendered as an <img> asset, never innerHTML. */}
        <img
          className={styles.brandIcon}
          src={brandIcon}
          alt=""
          width={18}
          height={18}
        />
        {/* The app's one <h1>: names the page for assistive tech and anchors the
            banner landmark. A plain <span> here left the app with no heading at
            all from #65 until #83. */}
        <h1 className={styles.brandText}>CSM · Claude Session Manager</h1>
      </div>
      <div className={styles.actions}>
        <input
          className={styles.search}
          type="search"
          placeholder="Search"
          disabled
          aria-label="Search sessions (coming soon)"
        />
        <button
          type="button"
          className={styles.iconButton}
          onClick={onNewSession}
          disabled={!newSessionReady}
          aria-label={newSessionLabel}
          title={newSessionLabel}
        >
          +
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh all sessions"
          title="Refresh all sessions"
        >
          ⟳
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onOpenSettings}
          disabled={!settingsReady}
          aria-label={settingsLabel}
          title={settingsLabel}
        >
          ⚙
        </button>
        <ThemeToggle />
        <WindowControls />
      </div>
    </header>
  );
}
