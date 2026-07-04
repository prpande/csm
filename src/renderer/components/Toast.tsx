import { useEffect } from "react";
import styles from "./Toast.module.css";

interface ToastProps {
  /** The user-facing message (already mapped from an error code — never a raw
   * error string or path). */
  message: string;
  onDismiss: () => void;
}

/** Default visible duration before the toast auto-dismisses (ms). */
const TOAST_DURATION_MS = 6000;

// A transient, non-blocking status pill (spec §7 error surface; snackbar over a
// screen-wide banner). Auto-dismisses after TOAST_DURATION_MS and offers a manual
// close. role="status" (polite) so a screen reader announces it without stealing
// focus. The message is a JSX text child — never innerHTML.
export function Toast({ message, onDismiss }: ToastProps) {
  useEffect(() => {
    const id = setTimeout(onDismiss, TOAST_DURATION_MS);
    return () => clearTimeout(id);
  }, [message, onDismiss]);

  return (
    <div className={styles.toast} role="status">
      <span className={styles.message}>{message}</span>
      <button
        type="button"
        className={styles.close}
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ✕
      </button>
    </div>
  );
}
