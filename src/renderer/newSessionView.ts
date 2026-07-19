// Pure view helpers for the new-session launcher (#165, spec
// docs/specs/2026-07-18-new-session-launcher.md). No DOM, no I/O — unit-tested
// in test/main. Keeps the permission-mode list, the bypass-warning decision,
// and the failure-code → user-message mapping out of the React modal so all
// three are deterministically testable.

import type { NewSessionResult } from "../ipcTypes";
import { KNOWN_PERMISSION_MODES, type PermissionMode } from "../sessionParser";

/** The permission-mode dropdown options, in the order the modal presents them:
 * the everyday default first, the unsupervised bypass last. Derived from the
 * parser's canonical allowlist so a new CLI mode can't drift out of the picker
 * (the assertion below fails the build if the two ever disagree). */
export const PERMISSION_MODE_OPTIONS: readonly {
  value: PermissionMode;
  label: string;
}[] = [
  { value: "default", label: "default — prompt for each action" },
  { value: "acceptEdits", label: "acceptEdits — auto-approve edits" },
  { value: "plan", label: "plan — plan only, no changes" },
  { value: "auto", label: "auto" },
  { value: "dontAsk", label: "dontAsk" },
  {
    value: "bypassPermissions",
    label: "bypassPermissions — auto-approve everything",
  },
];

// Build-time guard: the picker must offer exactly the parser's known modes. A
// mismatch (a mode added to the allowlist but not here, or vice versa) is a
// programming error, surfaced at module load rather than as a silently missing
// option.
if (PERMISSION_MODE_OPTIONS.length !== KNOWN_PERMISSION_MODES.size) {
  throw new Error(
    "PERMISSION_MODE_OPTIONS is out of sync with KNOWN_PERMISSION_MODES",
  );
}

/** The default the modal opens on. */
export const DEFAULT_NEW_SESSION_MODE: PermissionMode = "default";

/** bypassPermissions auto-approves every tool call, so the modal shows an inline
 * warning when it is the chosen launch mode (spec: the warning is part of the
 * form, not a second stacked modal). */
export function isBypassMode(mode: string): boolean {
  return mode === "bypassPermissions";
}

/** The catch-all launch-failed message (also the no-preload-bridge case). */
export const GENERIC_NEW_SESSION_MESSAGE = "Couldn't start a new session.";

/** Map a failed launch result to a short, human-facing message. INVALID_ARGS
 * carries a display-safe `detail` (the offending token, validated main-side) —
 * shown so the user can fix the argument; every other code maps to a fixed
 * string, since a raw `error.message` never crosses IPC. */
export function newSessionErrorMessage(
  result: Extract<NewSessionResult, { ok: false }>,
): string {
  switch (result.code) {
    case "INVALID_ARGS":
      return result.detail
        ? `Invalid arguments: ${result.detail}`
        : "Those arguments aren't valid.";
    case "FOLDER_MISSING":
      return "That folder no longer exists.";
    case "UNSUPPORTED_OS":
      return "Launching sessions isn't supported on this OS.";
    default:
      return GENERIC_NEW_SESSION_MESSAGE;
  }
}
