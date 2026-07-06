import type { SessionMetadata } from "../../sessionParser";
import {
  chipVariant,
  formatRelativeTime,
  shortSessionId,
  factSegments,
} from "../../sessionRowView";
import type { FactEntry } from "../hooks/useSessionFacts";
import styles from "./SessionRow.module.css";

interface SessionRowProps {
  session: SessionMetadata;
  /** Fixed row height (px), supplied by the windowing list. */
  rowHeight: number;
  /** Open gesture (double-click) — reopen this session (#67). Optional so the
   * row stays a pure presentational unit in tests that don't wire reopen. */
  onOpen?: (session: SessionMetadata) => void;
  /** Set when this session was folded in from a git worktree (#101): the branch
   * label (its gitBranch, or the worktree folder name). Renders a provenance
   * chip. Undefined for the folder's own (non-worktree) sessions. */
  worktreeBranch?: string;
  /** Lazily-loaded facts (#115). Undefined = still loading (renders a skeleton). */
  factState?: FactEntry;
}

// One presentational session row (spec §9): a text block (title over a
// risk-coded permission-mode chip, relative time, and the short session id) and
// a trailing "Open" button (#102) — the discoverable way to reopen, alongside
// the double-click shortcut. All fields are user-prompt-derived, so every value
// is inserted as a text node (JSX text children ≡ textContent) — never innerHTML.
export function SessionRow({
  session,
  rowHeight,
  onOpen,
  worktreeBranch,
  factState,
}: SessionRowProps) {
  const variant = chipVariant(session.permissionMode);
  // Non-empty only in the loaded state; the skeleton/error arms don't read it.
  const factSegs =
    factState?.status === "loaded" ? factSegments(factState.facts) : [];
  return (
    <div
      className={styles.row}
      style={{ height: rowHeight }}
      role="listitem"
      onDoubleClick={onOpen ? () => onOpen(session) : undefined}
    >
      <div className={styles.text}>
        <div className={styles.title} title={session.title}>
          {session.title}
        </div>
        <div className={styles.meta}>
          <span className={styles.chip} data-variant={variant}>
            {session.permissionMode}
          </span>
          {/* Worktree provenance (#101): a neutral, informational chip — held
              visually apart from the risk-coded permission chip. The branch is
              user/repo-derived text, so it goes in as a text node. */}
          {worktreeBranch !== undefined && (
            <span
              className={styles.branch}
              data-testid="worktree-branch"
              title={`Worktree branch: ${worktreeBranch}`}
              aria-label={`Worktree branch: ${worktreeBranch}`}
            >
              <svg
                className={styles.branchIcon}
                viewBox="0 0 16 16"
                width="11"
                height="11"
                aria-hidden="true"
              >
                <path
                  fill="currentColor"
                  d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
                />
              </svg>
              <span className={styles.branchName}>{worktreeBranch}</span>
            </span>
          )}
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
        {factState === undefined ? (
          <div className={styles.facts} aria-busy="true">
            <span className={styles.skeleton} />
          </div>
        ) : factState.status === "error" ? (
          <div className={styles.facts}>—</div>
        ) : (
          <div className={styles.facts} aria-label={factSegs.join(", ")}>
            <span className={styles.factsText}>
              {factSegs.map((seg, i) => (
                <span key={i}>
                  {i > 0 && (
                    <span className={styles.sep} aria-hidden="true">
                      {" · "}
                    </span>
                  )}
                  {seg}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>
      {/* Rendered only when a reopen handler is wired (always, in the app). The
          accessible name is per-row; stopPropagation keeps a click from also
          firing the row's double-click reopen. */}
      {onOpen && (
        <button
          type="button"
          className={styles.open}
          aria-label={`Open session: ${session.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(session);
          }}
          // Swallow a double-click on the button so it can't also bubble to the
          // row's double-click reopen — the button owns its own gesture,
          // independent of the reopen consumer being idempotent.
          onDoubleClick={(e) => e.stopPropagation()}
        >
          Open
        </button>
      )}
    </div>
  );
}
