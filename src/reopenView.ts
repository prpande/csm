// Pure view helpers for the renderer reopen flow (#67, design spec §7). No DOM,
// no I/O — unit-tested in test/main. Keeps the bypass-confirm decision and the
// error-code → user-message mapping out of the React components so both are
// deterministically testable.

import type { ReopenErrorCode } from "./ipcTypes";
import type { PermissionMode } from "./sessionParser";

/** The one permission mode that requires an interposed confirmation before we
 * reopen (spec §7): bypassPermissions auto-approves every tool call, so an
 * accidental double-click must not silently launch an unsupervised agent. All
 * other modes reopen directly. */
export function needsBypassConfirm(mode: string): boolean {
  return mode === "bypassPermissions";
}

/** The safe one-click downgrade the confirm modal offers instead of an
 * all-or-nothing gate (spec §7): reopen with edits auto-approved but every other
 * tool call still prompted. */
export const DOWNGRADE_MODE: PermissionMode = "acceptEdits";

/** The catch-all reopen-failed message. Exported so a non-error caller (e.g. the
 * "no preload bridge" case, which has no ReopenErrorCode) can surface the same
 * copy without borrowing an unrelated failure code. */
export const GENERIC_REOPEN_MESSAGE = "Couldn't reopen this session.";

/** Map a discriminated reopen failure code to a short, human-facing message.
 * FOLDER_MISSING gets a specific line (the common worktree/Temp-deleted case);
 * everything else collapses to the generic message. `error.message` never
 * crosses IPC (ipcTypes.ts), so these strings never embed an untrusted path. */
export function reopenErrorMessage(code: ReopenErrorCode): string {
  if (code === "FOLDER_MISSING") {
    return "That folder no longer exists.";
  }
  return GENERIC_REOPEN_MESSAGE;
}
