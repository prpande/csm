# Settings modal (configurable `claude` path) — design

Issue: #68 · Parent design: `2026-06-30-csm-design.md` §8 (Settings), §9 (title
bar) · Tier: high-risk (`priority:p1`) per
`docs/workflow/issue-driven-development.md` §2.

## 1. Goal

Ship the MVP settings surface: a modal dialog opened by the title-bar gear with
one labeled text input for the `claude` executable path, **Save** / **Cancel**,
backed by the existing `csm.getClaudePath()` / `csm.setClaudePath()` preload
bridge (#59). Everything below the renderer already exists — `settingsStore`
(#58), the `settingsGet`/`settingsSet` IPC handlers with sender guards, and the
bridge typing in `src/renderer/types/csm.d.ts`. This slice is renderer-only.

## 2. Scope

**In**

- Enable the existing disabled gear placeholder in `TitleBar` and wire it to
  open the modal.
- New `SettingsModal` component: labeled `claudePath` text input prefilled from
  `getClaudePath()`, Save persists via `setClaudePath()` and closes, Cancel /
  Escape / backdrop-click close without persisting.
- Empty (or whitespace-only) input saves as `""` — `settingsStore` read-side
  normalization already resolves that to the default `"claude"` on the next
  read, per the store's documented semantics.
- A brief toast confirms a successful save (parent spec §8; the existing
  `Toast` component is reused).
- Inline, generic error message on a failed save (modal stays open).

**Out (deferred, tracked)**

- `claudePath` resolvability validation and echoing the resolved absolute path
  (parent spec §8) — explicitly out of scope in #68; tracked in #145.
- Focus trap / full keyboard traversal — #70 owns modal keyboard polish, same
  as `BypassConfirmModal`. (The cheap cross-modal state gates below are NOT
  deferred — they close a hole this slice itself would open.)
- Additional settings keys: theme has its own title-bar control (#86),
  `indexEnabled` UI is #134, terminal preference / labels / filters are
  phase C. The modal's layout (labeled rows inside a form) must not preclude
  adding rows later, but no extensibility machinery is built now.

## 3. UX and behavior

- **Open:** the title-bar gear (currently a disabled placeholder) becomes an
  enabled icon button, `aria-label="Settings"`. When the preload bridge is
  absent (plain browser, unit test without the stub) it stays a disabled
  placeholder, `aria-label="Settings (unavailable)"` — rendered like
  `ThemeToggle`'s disabled placeholder, but gated on whole-bridge presence
  (`getClaudePath`/`setClaudePath` are non-optional bridge members, unlike the
  optional `theme`/`windowControls` sub-objects).
- **Modal:** blocking dialog over a fixed backdrop, visually and structurally
  matching `BypassConfirmModal` (backdrop → dialog card, same tokens). Title
  "Settings". One form row: a `<label>` "Claude executable path" tied to a text
  input via `htmlFor`/`id`.
- **Prefill:** on mount the input and Save are disabled (and form submission is
  a no-op) while `getClaudePath()` resolves; on resolve the input is enabled,
  prefilled, and focused, and Save is enabled. A guarded effect (`active`
  flag, as in `ThemeToggle`) prevents a late resolve from acting on an
  unmounted component. If the read rejects (IPC transport failure — the store
  itself is fail-soft), the same enable-and-focus happens with the default
  `"claude"` in the input, plus an inline notice ("Couldn't load the current
  setting — saving will overwrite it.") so the user knows Save replaces a
  value that failed to display, rather than silently confirming it.
- **Save:** the row lives in a `<form>`; Enter in the input and the Save button
  both submit. The submit handler checks a synchronous in-flight ref
  (`useReopen`'s `inFlight.current` pattern — a disabled button alone doesn't
  stop HTML implicit submission) and no-ops while a save is pending or the
  prefill hasn't settled. Submit trims the value and calls
  `setClaudePath(trimmed)` verbatim — including `""`, which the store resolves
  back to the default on read. On resolve, `onSaved()` then close — both gated
  by the unmount guard so a resolve landing after unmount does nothing. On
  reject: the modal stays open and shows a fixed inline error ("Couldn't save
  settings. Try again.") — never the raw error text, which can embed host
  paths (the no-message-leak IPC convention). The error node is
  `role="alert"`, and its text is cleared at each submit so a repeat of the
  identical failure re-announces to assistive tech.
- **Cancel:** Cancel button, Escape (keydown on the dialog), and backdrop click
  all close without calling `setClaudePath`; clicks inside the dialog don't
  propagate to the backdrop. **While a save is in flight all three dismissal
  paths are inert** — otherwise "close without persisting" would be a lie (the
  in-flight IPC write can't be cancelled and would persist after the modal
  closed, then fire a "saved" toast for an action the user believed
  abandoned). The write settles in one local round-trip; on success the modal
  closes itself, on failure the error shows and dismissal re-enables.
- **Save toast:** after a successful save `FolderBrowser` shows the existing
  `Toast` ("Claude path saved."). The reopen-error toast and the settings
  confirmation share one rendered `Toast` slot with **newest-message-wins**
  semantics: a successful save dismisses any live reopen-error toast and shows
  the confirmation; a reopen error arriving later replaces the confirmation.
  The superseded message is cleared, never queued for redisplay. (A fixed
  "error wins" priority was considered and rejected: a reopen started before
  the modal opened can resolve to an error while settings is open, and letting
  that stale error starve the fresh save confirmation reads as "the save
  silently failed".)
- **Cross-modal state gates:** backdrop coverage does not imply focus
  containment — there is no focus trap yet (#70), and this slice makes the
  gear focusable for the first time, so Shift+Tab from the bypass-confirm
  dialog could otherwise reach the gear and stack Settings on top of the
  safety modal. Two one-line gates close both directions now, independent of
  #70: activating the gear is a no-op while a bypass confirmation is pending
  (`pendingBypass` non-null), and row open gestures are no-ops while the
  settings modal is open.

## 4. Component and state design

Decision: **component-local modal, `FolderBrowser`-owned visibility** — not a
`useReopen`-style hook. The reopen hook exists because its logic is shared by
every session row; settings has exactly one call site and no shared logic, so
a self-loading component plus one boolean is the least machinery.

- `FolderBrowser`: `settingsOpen` boolean state; passes `onOpenSettings` to
  `TitleBar` (guarded on `pendingBypass`, per the cross-modal gates) and
  wraps the row `onOpen` callback with the `settingsOpen` guard; renders
  `<SettingsModal onClose={…} onSaved={…} />` beside the existing modal/toast
  block. `savedMessage: string | null` state feeds the shared `Toast` slot:
  the render shows the reopen-error toast when present, else the saved
  message; `onSaved` calls `dismissToast()` before setting `savedMessage`,
  and a new reopen toast clears `savedMessage` — together this yields
  newest-message-wins with no queue.
- `TitleBar`: new optional prop `onOpenSettings?: () => void`. The gear is
  enabled iff the prop is present **and** the bridge exists
  (`currentBridge()`); otherwise it renders today's disabled placeholder.
- `SettingsModal` props: `onClose(): void`, `onSaved(): void`, and an optional
  `bridge?: CsmBridge` defaulting to `currentBridge()` — the same injection
  seam the hooks use, so tests can pass a controllable bridge without touching
  `window.csm`.
- New CSS module `SettingsModal.module.css` following the
  `BypassConfirmModal.module.css` structure (backdrop/dialog/title/actions,
  semantic tokens, `:focus-visible` ring, reduced-motion guard). Two modals do
  not yet justify extracting a shared modal stylesheet (rule of three); a
  shared extraction is a candidate refactor when a third modal appears.

## 5. Contracts relied on (existing, unchanged)

- `settingsStore.getClaudePath()` → trimmed stored value, or `"claude"` when
  absent/blank/non-string; never throws (fail-soft read).
- `settingsStore.setClaudePath(value)` → stores the string verbatim,
  spread-merging so unknown keys survive.
- IPC `settingsSet` ignores non-string payloads and is sender-guarded; a
  storage failure rejects the renderer's promise with an Electron-wrapped
  error whose text must not be rendered.
- `claudePath` reaches `spawn` only through the existing argv-array path — as
  a validated (`assertNoCmdMetachars`) argv element to `cmd.exe`/`wt.exe` on
  Windows, or as a two-layer-escaped AppleScript script argument to
  `osascript` on macOS — never interpolated into a shell command string. Those
  escaping/metachar guards are the load-bearing injection barrier and run at
  reopen time; this slice never touches the launch path.

## 6. Security invariants (CLAUDE.md)

- The stored path is rendered only as a controlled input's `value` and the
  toast/error strings are fixed literals — no `innerHTML`, no interpolation of
  stored or error text.
- No new IPC surface; no renderer-side spawning; the value flows to `spawn`
  only through the existing argv-array path (§5).
- Raw IPC rejection messages are never displayed (may embed host paths).
- The gear gate while `pendingBypass` is live preserves the CLAUDE.md-mandated
  bypass confirmation: without it, this slice's newly-focusable gear would let
  a keyboard user stack Settings over the warning dialog.

## 7. Test plan (TDD order)

Timing-sensitive cases (9, 11, 12) use deferred promises — a fake that
resolves instantly cannot exercise the in-flight windows.

`test/renderer/SettingsModal.test.tsx` (new):

1. Renders `role="dialog"`, `aria-modal="true"`, labelled by the title; the
   input is labelled "Claude executable path".
2. Prefills the input from `getClaudePath()` and focuses it once loaded.
3. Save submits the trimmed value via `setClaudePath`, then calls `onSaved`
   and `onClose` (both exactly once).
4. Whitespace-only input saves as `""`.
5. Enter in the input submits the form (same assertions as 3).
6. Cancel button closes without calling `setClaudePath`.
7. Escape closes without saving; backdrop click closes without saving; a click
   inside the dialog does not close.
8. A rejecting `setClaudePath` keeps the modal open, shows the fixed inline
   error text in a `role="alert"` node, and does not call `onSaved`/`onClose`.
9. While the save promise is pending (deferred), the Save button is disabled
   AND Cancel/Escape/backdrop do not close the modal; after the deferred
   promise resolves, the modal closes normally.
10. A rejecting `getClaudePath` prefills the default `"claude"`, still enables
    and focuses the input, and shows the load-failure notice.
11. While the prefill promise is pending (deferred), submitting the form does
    not call `setClaudePath`.
12. Submitting twice before the first save settles calls `setClaudePath`
    exactly once (synchronous in-flight ref).

`test/renderer/TitleBar.test.tsx` (extend):

13. With the bridge present and `onOpenSettings` passed, the gear is enabled
    with `aria-label="Settings"` and clicking it fires the callback.
14. Without the bridge, the gear renders the disabled placeholder with
    `aria-label="Settings (unavailable)"`.

`test/renderer/FolderBrowser.settings.test.tsx` (new, mirrors the
`.reopen` integration file):

15. Gear click opens the settings dialog.
16. Save closes the dialog and shows the confirmation toast.
17. Cancel closes the dialog; `setClaudePath` never called; no toast.
18. A live reopen-error toast is replaced by the save confirmation
    (newest wins).
19. While the bypass-confirm modal is open, activating the gear does not open
    settings; while settings is open, a row open gesture does not call
    `reopenSession`.

## 8. File manifest

- `src/renderer/components/SettingsModal.tsx` — new
- `src/renderer/components/SettingsModal.module.css` — new
- `src/renderer/components/TitleBar.tsx` — enable + wire the gear
- `src/renderer/components/FolderBrowser.tsx` — open-state, modal, saved toast,
  cross-modal gates
- `test/renderer/SettingsModal.test.tsx` — new
- `test/renderer/TitleBar.test.tsx` — extend
- `test/renderer/FolderBrowser.settings.test.tsx` — new
- `docs/specs/2026-07-17-settings-modal-design.md` — this spec

8 files — within the PR size cap.

## 9. Acceptance criteria (from #68)

- [ ] Gear opens a blocking modal; the field is prefilled from
      `getClaudePath()`.
- [ ] Save calls `setClaudePath` with the trimmed input value and closes;
      cancel does not persist.
- [ ] The modal is a custom accessible dialog (design-system control, not a
      browser prompt).
