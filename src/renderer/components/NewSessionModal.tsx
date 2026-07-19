import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { CsmBridge } from "../types/csm";
import { currentBridge } from "../bridge";
import {
  DEFAULT_NEW_SESSION_MODE,
  GENERIC_NEW_SESSION_MESSAGE,
  PERMISSION_MODE_OPTIONS,
  isBypassMode,
  newSessionErrorMessage,
} from "../newSessionView";
import styles from "./NewSessionModal.module.css";

interface NewSessionModalProps {
  /** Prefilled working directory: the selected folder's path (folder-pane entry
   * point) or "" (title-bar entry point — the user browses/types). */
  initialDir: string;
  /** Dismiss without launching (Cancel / Escape / backdrop). Also called after a
   * successful launch or terminal-open, following onLaunched. */
  onClose: () => void;
  /** A session (or terminal) was launched — the parent schedules a delayed
   * rescan so the new session appears once its JSONL exists. */
  onLaunched: () => void;
  /** Injection seam for tests; defaults to the window.csm preload bridge. */
  bridge?: CsmBridge;
}

// The new-session launcher modal (#165, spec docs/specs/2026-07-18-new-session-
// launcher.md). Structured picker (directory + Browse, permission-mode dropdown
// with an inline bypass warning, free-form CLI args) plus an "Open terminal
// here" escape hatch for anything the Windows argument gate rejects. Same dialog
// structure + focus trap (#70) as BypassConfirmModal; all validation of the
// directory and arguments happens main-side, so the modal only surfaces the
// discriminated result (its INVALID_ARGS detail is inserted as text, never HTML).
export function NewSessionModal({
  initialDir,
  onClose,
  onLaunched,
  bridge = currentBridge(),
}: NewSessionModalProps) {
  const [dir, setDir] = useState(initialDir);
  const [mode, setMode] = useState<string>(DEFAULT_NEW_SESSION_MODE);
  const [args, setArgs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous in-flight guard: a disabled button alone doesn't stop HTML
  // implicit submit (Enter), and dismissal must be inert while a launch round-
  // trips — the spawned terminal can't be recalled. This ref (mirroring
  // useReopen) is the sole guard needed: every user close path is inert while
  // it's set, and the only unmount during a round-trip is this component's own
  // success-path onClose (a parent setState, which can't unmount synchronously
  // before the finally runs), so a setState-after-unmount can't be reached.
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    dirRef.current?.focus();
  }, []);

  const dismiss = (): void => {
    if (!inFlight.current) onClose();
  };

  // Run one bridge action (launch / terminal / browse), guarding against
  // overlap and a torn-down modal. `perform` returns whether to close on
  // success (browse stays open; a launch closes).
  const runAction = async (
    perform: () => Promise<{
      ok: boolean;
      message?: string;
      closeOnOk?: boolean;
    }>,
  ): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await perform();
      if (result.ok) {
        if (result.closeOnOk) {
          onLaunched();
          onClose();
        }
      } else {
        setError(result.message ?? GENERIC_NEW_SESSION_MESSAGE);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const launch = (e: FormEvent): void => {
    e.preventDefault();
    if (!bridge?.newSession) {
      setError(GENERIC_NEW_SESSION_MESSAGE);
      return;
    }
    const newSession = bridge.newSession.bind(bridge);
    void runAction(async () => {
      const result = await newSession({ cwd: dir.trim(), mode, rawArgs: args });
      return result.ok
        ? { ok: true, closeOnOk: true }
        : { ok: false, message: newSessionErrorMessage(result) };
    });
  };

  const openTerminal = (): void => {
    if (!bridge?.openTerminalHere) {
      setError(GENERIC_NEW_SESSION_MESSAGE);
      return;
    }
    const openTerminalHere = bridge.openTerminalHere.bind(bridge);
    void runAction(async () => {
      const result = await openTerminalHere(dir.trim());
      // runAction already defaults a missing message to GENERIC_NEW_SESSION_MESSAGE.
      return result.ok ? { ok: true, closeOnOk: true } : { ok: false };
    });
  };

  const browse = (): void => {
    if (!bridge?.pickFolder) return;
    const pickFolder = bridge.pickFolder.bind(bridge);
    void runAction(async () => {
      const picked = await pickFolder();
      if (!picked.canceled) setDir(picked.path);
      return { ok: true }; // browsing never closes the modal
    });
  };

  // Escape dismisses; Tab is trapped inside the dialog and cycles with
  // wraparound, so focus can't reach the controls the backdrop only visually
  // covers. Mirrors BypassConfirmModal's trap, generalized to the form fields.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      dismiss();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])",
    );
    if (!focusable || focusable.length === 0) return;
    const items = Array.from(focusable);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const step = e.shiftKey ? -1 : 1;
    const next =
      current === -1
        ? e.shiftKey
          ? items.length - 1
          : 0
        : (current + step + items.length) % items.length;
    e.preventDefault();
    items[next].focus();
  };

  const canLaunch = dir.trim().length > 0 && !busy && !!bridge?.newSession;
  const canOpenTerminal =
    dir.trim().length > 0 && !busy && !!bridge?.openTerminalHere;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={dismiss}
      data-testid="new-session-backdrop"
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id="new-session-title" className={styles.title}>
          Start a new session
        </h2>
        <form className={styles.form} onSubmit={launch}>
          <label className={styles.label} htmlFor="new-session-dir">
            Directory
          </label>
          <div className={styles.dirRow}>
            <input
              id="new-session-dir"
              ref={dirRef}
              className={styles.input}
              type="text"
              value={dir}
              disabled={busy}
              placeholder="Path to launch the session in"
              onChange={(e) => setDir(e.target.value)}
            />
            {bridge?.pickFolder && (
              <button
                type="button"
                className={styles.browse}
                data-testid="new-session-browse"
                onClick={browse}
                disabled={busy}
              >
                Browse…
              </button>
            )}
          </div>

          <label className={styles.label} htmlFor="new-session-mode">
            Permission mode
          </label>
          {/* A native <select>: a plain enumerated single-select inside a form,
              fully keyboard- and AT-operable with no custom widget to fold into
              the modal's focus trap — the justification the design-system's
              "custom controls over native widgets" rule asks for. */}
          <select
            id="new-session-mode"
            className={styles.select}
            value={mode}
            disabled={busy}
            onChange={(e) => setMode(e.target.value)}
          >
            {PERMISSION_MODE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {isBypassMode(mode) && (
            <p className={styles.bypassWarning} role="status">
              <strong>bypassPermissions</strong> auto-approves every tool call
              with no prompt — an agent can edit files and run commands
              unsupervised.
            </p>
          )}

          <label className={styles.label} htmlFor="new-session-args">
            Additional CLI arguments{" "}
            <span className={styles.optional}>(optional)</span>
          </label>
          <input
            id="new-session-args"
            className={styles.input}
            type="text"
            value={args}
            disabled={busy}
            placeholder="--model opus  --continue"
            onChange={(e) => setArgs(e.target.value)}
          />

          {error && (
            <p
              className={styles.error}
              role="alert"
              data-testid="new-session-error"
            >
              {error}
            </p>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.terminal}
              data-testid="new-session-terminal"
              onClick={openTerminal}
              disabled={!canOpenTerminal}
              title="Open a plain terminal here — type any command yourself"
            >
              Open terminal here
            </button>
            <div className={styles.primaryRow}>
              <button
                type="button"
                className={styles.cancel}
                data-testid="new-session-cancel"
                onClick={dismiss}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={styles.primary}
                data-testid="new-session-launch"
                disabled={!canLaunch}
              >
                Start session
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
