# Plan — #67 Renderer: reopen flow + bypassPermissions confirm modal + error toast

Slice 4 of the Phase-A renderer UI. Makes the #66 session rows actionable:
double-click reopens a session through the #59 bridge (`csm.reopenSession`), with
the **`bypassPermissions` confirmation modal** (design spec §7) and a fail-soft
**error toast**. Wires the renderer onto the already-hardened main-process
launcher — no new security boundary is introduced here (argv-array spawn, UUID
validation, no shell interpolation all live in the merged `buildLaunchSpec` /
`terminalLauncher` / `ipc.ts`).

## Tiering

**Standard** (plan doc, this file), consistent with #64/#65/#66. Noted tension:
`work-issue` maps `priority:p1` / security-invariant work to High-risk. The
authoritative security behavior is already merged and spec'd in the main process;
this slice is renderer wiring on a hardened bridge whose error codes are already
`as const` and structured-clone-safe. Behavior is fully specified in design spec
§7 with crisp issue acceptance criteria, so a fresh spec would duplicate §7.

## Decisions (confirmed with maintainer)

- **Three-way modal** per spec §7 (spec is authoritative over the issue's
  confirm/cancel-only AC): **Reopen with bypass** / **Reopen downgraded to
  `acceptEdits`** / **Cancel**. The downgrade is the safeguard's actual value —
  a safe path instead of an all-or-nothing gate. Downgrade target: `acceptEdits`.
- **Approach 1** for orchestration: a `useReopen` hook owned by `FolderBrowser`;
  `onOpen(session)` threaded FolderPane → SessionList → SessionRow; the modal and
  toast render at `FolderBrowser` level. Keeps the error-mapping seam DOM-free
  testable; consistent with "FolderBrowser owns state, children presentational".

## Modules

Pure (DOM-free, `src/`, tested in `test/main` like `sessionTree`):

- **`src/reopenView.ts`**
  - `needsBypassConfirm(mode: string): boolean` — `mode === "bypassPermissions"`.
  - `DOWNGRADE_MODE = "acceptEdits"` — the safe downgrade target.
  - `reopenErrorMessage(code: ReopenErrorCode): string` — `FOLDER_MISSING` →
    "That folder no longer exists." ; every other code → a generic
    "Couldn't reopen this session." Never surfaces `error.message` (which may
    embed an untrusted path — it never crosses IPC anyway, per `ipcTypes.ts`).

Renderer (`test/renderer`, plain vitest matchers only — jest-dom fails locally):

- **`src/renderer/hooks/useReopen.ts`** — owns `pendingBypass: SessionMetadata |
  null` and `toast: { message: string } | null`. Exposes:
  - `requestReopen(session)` — if `needsBypassConfirm(session.permissionMode)`,
    set `pendingBypass`; else run immediately with the passthrough mode.
  - `confirmReopen(mode)` — the modal's resolve; runs with the chosen mode
    (original `bypassPermissions` or `DOWNGRADE_MODE`), clears `pendingBypass`.
  - `cancelReopen()` — clears `pendingBypass` without calling the bridge.
  - `dismissToast()`.
  - `run(session, mode)` (internal) — `await csm.reopenSession({ cwd, sessionId,
    mode })`; on `{ ok: false, code }` set toast via `reopenErrorMessage`; on ok,
    silent. Bridge absent (`window.csm` undefined) → fail soft to generic toast.
    `mode` is passed through unchanged (§4.1).
- **`src/renderer/components/BypassConfirmModal.tsx`** (+ css) — blocking
  `role="dialog"` `aria-modal`, labelled + described; names the consequence (all
  tool calls auto-approved). Three custom buttons (not native `confirm`).
  `Escape`/backdrop → cancel. Full focus-trap/keyboard is #70; this ships the
  dialog roles + a sensible initial focus (the safe downgrade button).
- **`src/renderer/components/Toast.tsx`** (+ css) — transient, non-blocking pill
  (`role="status"`), auto-dismiss + manual close. Snackbar over screen-wide
  banner (design taste). Rendered only when a toast is set.

Wiring:

- **`SessionRow`** — add optional `onOpen?: (s: SessionMetadata) => void`;
  `onDoubleClick` calls it. (Single-click selection is a row concern deferred to
  the list; this slice only adds the open gesture.)
- **`SessionList`** — thread `onOpen` to each row.
- **`FolderPane`** — thread `onOpen`.
- **`FolderBrowser`** — call `useReopen()`, pass `onOpen={requestReopen}`, render
  `<BypassConfirmModal>` (when `pendingBypass`) and `<Toast>` (when `toast`).

## Test list

- `test/main/reopenView.test.ts` — `needsBypassConfirm` for every PermissionMode;
  `reopenErrorMessage` for each `REOPEN_ERROR_CODES` entry (FOLDER_MISSING
  specific, others generic); `DOWNGRADE_MODE === "acceptEdits"`.
- `test/renderer/useReopen.test.tsx` — non-bypass runs immediately with
  passthrough mode; bypass sets pending + no call; `confirmReopen("bypass…")`
  calls with bypass; `confirmReopen(DOWNGRADE_MODE)` calls with acceptEdits;
  `cancelReopen` → no call; `{ok:false, FOLDER_MISSING}` → specific toast;
  other code → generic toast; missing bridge → soft toast, no throw.
- `test/renderer/BypassConfirmModal.test.tsx` — renders consequence text + three
  buttons; each button invokes its callback.
- `test/renderer/Toast.test.tsx` — renders the message; close button dismisses.
- `test/renderer/SessionRow.test.tsx` — double-click calls `onOpen` with the
  session (add to the existing file).
- `test/renderer/FolderPane.test.tsx` — integration: double-click a bypass row
  shows the modal; confirm calls `reopenSession` (add to existing file).

## Out of scope (later slices)

- Keyboard `Enter`-to-open + full modal focus-trap/`aria` traversal → #70.
- Bulk / multi-select reopen → Phase B.
- Row single-click selection state → not required by #67.
