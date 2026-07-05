import { WindowControls } from "./WindowControls";
import brandIcon from "../../../assets/icons/png/icon_32.png";
import styles from "./TitleBar.module.css";

interface TitleBarProps {
  /** Full re-scan (data layer refresh()). */
  onRefresh: () => void;
  /** True while a scan is in flight — the refresh control disables to avoid
   *  stacking scans. */
  refreshing: boolean;
}

// Full-width app title bar (spec §9): brand + global controls. Only refresh is
// wired in this slice; search (phase C), settings (#68), and the theme toggle are
// greyed disabled placeholders that establish the layout.
export function TitleBar({ onRefresh, refreshing }: TitleBarProps) {
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
        <span className={styles.brandText}>CSM · Claude Session Manager</span>
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
          disabled
          aria-label="Settings (coming soon)"
          title="Settings (coming soon)"
        >
          ⚙
        </button>
        <button
          type="button"
          className={styles.iconButton}
          disabled
          aria-label="Toggle theme (coming soon)"
          title="Toggle theme (coming soon)"
        >
          ◐
        </button>
        <WindowControls />
      </div>
    </header>
  );
}
