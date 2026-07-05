import { useEffect, useState } from "react";
import styles from "./WindowControls.module.css";

// Custom traffic-light window controls for the frameless shell (#86). Glyphs are
// inline SVG, not Unicode caption dingbats (❐ ↗ ✕), which render inconsistently
// across OS font stacks. The cluster self-gates on `window.csm?.windowControls`:
// in a plain browser or a unit test without the preload it renders nothing, so the
// app degrades to the host chrome instead of showing dead buttons.

const MinimizeGlyph = () => (
  <svg viewBox="0 0 10 10" aria-hidden="true" className={styles.glyph}>
    <line x1="2" y1="5" x2="8" y2="5" />
  </svg>
);
const MaximizeGlyph = () => (
  <svg viewBox="0 0 10 10" aria-hidden="true" className={styles.glyph}>
    <rect x="2" y="2" width="6" height="6" />
  </svg>
);
const RestoreGlyph = () => (
  <svg viewBox="0 0 10 10" aria-hidden="true" className={styles.glyph}>
    <rect x="2" y="3.5" width="4.5" height="4.5" />
    <path d="M3.75 3.5 V2 H8 V6.25 H6.5" />
  </svg>
);
const CloseGlyph = () => (
  <svg viewBox="0 0 10 10" aria-hidden="true" className={styles.glyph}>
    <line x1="2.5" y1="2.5" x2="7.5" y2="7.5" />
    <line x1="7.5" y1="2.5" x2="2.5" y2="7.5" />
  </svg>
);

export function WindowControls() {
  const controls = window.csm?.windowControls;
  const [maximized, setMaximized] = useState(false);

  // Seed the glyph from the current window state, then track OS-driven changes
  // (double-click title bar, snap-maximize, the maximize button itself). Both the
  // async seed and the unsubscribe are guarded so a fast unmount can't setState on
  // a dead component or leak the ipcRenderer listener.
  useEffect(() => {
    if (!controls) return;
    let active = true;
    void controls.isMaximized().then((m) => {
      if (active) setMaximized(m);
    });
    const off = controls.onMaximizedChange((m) => setMaximized(m));
    return () => {
      active = false;
      off();
    };
  }, [controls]);

  if (!controls) return null;

  return (
    <div className={styles.controls} role="group" aria-label="Window controls">
      <button
        type="button"
        className={`${styles.dot} ${styles.minimize}`}
        aria-label="Minimize"
        title="Minimize"
        onClick={() => controls.minimize()}
      >
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        className={`${styles.dot} ${styles.maximize}`}
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => controls.toggleMaximize()}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        className={`${styles.dot} ${styles.close}`}
        aria-label="Close"
        title="Close"
        onClick={() => controls.close()}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}
