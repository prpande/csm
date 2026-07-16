import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { CsmBridge } from "../types/csm";
import { currentBridge } from "../bridge";
import styles from "./SettingsModal.module.css";

// Mirrors settingsStore's DEFAULT_CLAUDE_PATH, which the renderer can't import
// (the store pulls in node:fs). Display-only: the store's read-side
// normalization remains the authority for what an empty save resolves to.
const DEFAULT_CLAUDE_PATH = "claude";

interface SettingsModalProps {
  /** Dismiss without side effects (Cancel/Escape/backdrop) — also called after
   * a successful save, following onSaved. */
  onClose: () => void;
  /** A save was persisted; the parent surfaces the confirmation toast. */
  onSaved: () => void;
  /** Injection seam for tests; defaults to the window.csm preload bridge. */
  bridge?: CsmBridge;
}

// Fixed strings only — a rejected IPC promise may embed host paths in its
// message, which must never be rendered (spec §6).
const SAVE_ERROR = "Couldn't save settings. Try again.";
const LOAD_ERROR =
  "Couldn't load the current setting — saving will overwrite it.";

// The MVP settings surface (spec §8 of the product design; #68): one labeled
// claudePath field over the existing get/setClaudePath bridge. Same dialog
// structure as BypassConfirmModal; the focus trap is #70's slice — this ships
// dialog roles, Escape-to-cancel, and initial focus on the input.
export function SettingsModal({
  onClose,
  onSaved,
  bridge = currentBridge(),
}: SettingsModalProps) {
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // Synchronous in-flight guard: a disabled submit button alone doesn't stop
  // HTML implicit submission (Enter in the lone text field), and dismissal
  // must also be inert mid-save — an in-flight IPC write can't be cancelled,
  // so "close without persisting" would otherwise be false.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!bridge) {
      // Unreachable through the gear (it self-gates on the bridge), but a
      // direct render without a preload must still fail soft, not hang.
      setValue(DEFAULT_CLAUDE_PATH);
      setLoadFailed(true);
      setLoading(false);
      return;
    }
    let alive = true;
    bridge.getClaudePath().then(
      (current) => {
        if (!alive) return;
        setValue(current);
        setLoading(false);
      },
      () => {
        // The store read is fail-soft; only an IPC transport failure lands
        // here. Fall back to the default but say so — a silent default would
        // let Save overwrite a real configured path the user never saw.
        if (!alive) return;
        setValue(DEFAULT_CLAUDE_PATH);
        setLoadFailed(true);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading]);

  const dismiss = (): void => {
    if (!inFlight.current) onClose();
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (inFlight.current || loading || !bridge) return;
    inFlight.current = true;
    setSaving(true);
    // Clearing before each attempt re-mounts the alert on a repeat failure,
    // so identical error text is re-announced to assistive tech.
    setSaveFailed(false);
    bridge.setClaudePath(value.trim()).then(
      () => {
        inFlight.current = false;
        if (!mounted.current) return;
        onSaved();
        onClose();
      },
      () => {
        inFlight.current = false;
        if (!mounted.current) return;
        setSaving(false);
        setSaveFailed(true);
      },
    );
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={dismiss}
      data-testid="settings-backdrop"
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") dismiss();
        }}
      >
        <h2 id="settings-modal-title" className={styles.title}>
          Settings
        </h2>
        <form className={styles.form} onSubmit={submit}>
          <label className={styles.label} htmlFor="settings-claude-path">
            Claude executable path
          </label>
          <input
            id="settings-claude-path"
            ref={inputRef}
            className={styles.input}
            type="text"
            value={value}
            disabled={loading || saving}
            placeholder={DEFAULT_CLAUDE_PATH}
            onChange={(e) => setValue(e.target.value)}
          />
          {loadFailed && (
            <p className={styles.notice} role="status">
              {LOAD_ERROR}
            </p>
          )}
          {saveFailed && (
            <p className={styles.error} role="alert">
              {SAVE_ERROR}
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cancel}
              data-testid="settings-cancel"
              onClick={dismiss}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.primary}
              data-testid="settings-save"
              disabled={loading || saving || !bridge}
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
