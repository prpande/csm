import type { SessionMetadata } from "../../sessionParser";
import {
  chipVariant,
  formatRelativeTime,
  shortSessionId,
} from "../../sessionRowView";
import styles from "./SessionRow.module.css";

interface SessionRowProps {
  session: SessionMetadata;
  /** Fixed row height (px), supplied by the windowing list. */
  rowHeight: number;
  /** Open gesture (double-click) — reopen this session (#67). Optional so the
   * row stays a pure presentational unit in tests that don't wire reopen. */
  onOpen?: (session: SessionMetadata) => void;
}

// One presentational session row (spec §9): description (title), then a
// risk-coded permission-mode chip, relative time, and the short session id.
// All fields are user-prompt-derived, so every value is inserted as a text node
// (JSX text children ≡ textContent) — never innerHTML.
export function SessionRow({ session, rowHeight, onOpen }: SessionRowProps) {
  const variant = chipVariant(session.permissionMode);
  return (
    <div
      className={styles.row}
      style={{ height: rowHeight }}
      role="listitem"
      onDoubleClick={onOpen ? () => onOpen(session) : undefined}
    >
      <div className={styles.title} title={session.title}>
        {session.title}
      </div>
      <div className={styles.meta}>
        <span className={styles.chip} data-variant={variant}>
          {session.permissionMode}
        </span>
        <span className={styles.sep} aria-hidden="true">
          ·
        </span>
        <span className={styles.time}>
          {formatRelativeTime(session.lastActivity, Date.now())}
        </span>
        <span className={styles.sep} aria-hidden="true">
          ·
        </span>
        <span className={styles.id}>{shortSessionId(session.sessionId)}</span>
      </div>
    </div>
  );
}
