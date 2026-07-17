import type { SessionMetadata } from "../../sessionParser";
import {
  chipVariant,
  formatRelativeTime,
  shortSessionId,
  factSegments,
  shouldShowGitBranch,
} from "../../sessionRowView";
import type { FactEntry } from "../hooks/useSessionFacts";
import { GitBranchIcon } from "./GitBranchIcon";
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
  // One branch chip per row, at most (#110). A worktree row's provenance chip
  // already IS this session's gitBranch (sessionTree sets it to
  // `sess.gitBranch ?? worktree.name`), so computing an own-branch chip too
  // would print the same string twice — hence the `worktreeBranch === undefined`
  // guard rather than two independent chips.
  const isProvenance = worktreeBranch !== undefined;
  const ownBranch = shouldShowGitBranch(session.gitBranch)
    ? session.gitBranch
    : undefined;
  const branchLabel = worktreeBranch ?? ownBranch;
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
          {/* A neutral, informational chip — held visually apart from the
              risk-coded permission chip. The branch is user/repo-derived text,
              so it goes in as a text node, never innerHTML.

              Two jobs, one look. As PROVENANCE (#101) it means "this row was
              folded in from a worktree elsewhere" and always shows — including
              on `main`, since suppressing it would erase that signal. As
              INFORMATION (#110) it means "this session ran on that branch" and
              is suppressed for the repo default (shouldShowGitBranch), which is
              why only the latter passes through the noise rule. */}
          {branchLabel !== undefined && (
            <span
              className={styles.branch}
              data-testid={isProvenance ? "worktree-branch" : "git-branch"}
              title={`${isProvenance ? "Worktree branch" : "Branch"}: ${branchLabel}`}
              aria-label={`${isProvenance ? "Worktree branch" : "Branch"}: ${branchLabel}`}
            >
              <GitBranchIcon className={styles.branchIcon} />
              <span className={styles.branchName}>{branchLabel}</span>
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
