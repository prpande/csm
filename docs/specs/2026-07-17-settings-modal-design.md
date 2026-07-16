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
  (parent spec §8) — explicitly out of scope in #68; follow-up issue to be
  filed at PR time.
- Focus trap / full keyboard traversal — #70 owns modal keyboard polish, same
  as `BypassConfirmModal`.
- Additional settings keys: theme has its own title-bar control (#86),
  `indexEnabled` UI is #134, terminal preference / labels / filters are
  phase C. The modal's layout (labeled rows inside a form) must not preclude
  adding rows later, but no extensibility machinery is built now.

## 3. UX and behavior

- **Open:** the title-bar gear (currently a disabled placeholder) becomes an
  enabled icon button, `aria-label="Settings"`. When the preload bridge is
  absent (plain browser, unit test without the stub) it stays a disabled
  placeholder, `aria-label="Settings (unavailable)"` — the `ThemeToggle`
  self-gating pattern.
- **Modal:** blocking dialog over a fixed backdrop, visually and structurally
  matching `BypassConfirmModal` (backdrop → dialog card, same tokens). Title
  "Settings". One form row: a `<label>` "Claude executable path" tied to a text
  input via `htmlFor`/`id`.
- **Prefill:** on mount the input is disabled while `getClaudePath()` resolves;
  on resolve it is enabled, prefilled, and receives focus. A guarded effect
  (`active` flag, as in `ThemeToggle`) prevents a late resolve from acting on
  an unmounted component. If the read rejects (IPC transport failure — the
  store itself is fail-soft), prefill falls back to the default `"claude"`.
- **Save:** the row lives in a `<form>`; Enter in the input and the Save button
  both submit. Submit trims the value and calls `setClaudePath(trimmed)`
  verbatim — including `""`, which the store resolves back to the default on
  read. While the save promise is pending, Save is disabled (double-submit
  guard, mirroring `useReopen`'s in-flight guard). On resolve: `onSaved()` then
  close. On reject: the modal stays open and shows a fixed inline error
  ("Couldn't save settings. Try again.") — never the raw error text, which can
  embed host paths (the no-message-leak IPC convention).
- **Cancel:** Cancel button, Escape (keydown on the dialog), and backdrop click
  all close without calling `setClaudePath`. Clicks inside the dialog don't
  propagate to the backdrop. Identical to `BypassConfirmModal`.
- **Save toast:** after a successful save `FolderBrowser` shows the existing
  `Toast` ("Claude path saved."). The reopen-error toast and the settings
  toast share one rendered `Toast` slot; the reopen error wins if both are
  live (error > confirmation, and the two can't collide in practice — the
  settings backdrop covers the session rows).
- **Modal exclusivity:** both modals render full-viewport backdrops
  (`z-index: 100`), so the gear is unreachable while the bypass confirm is
  open and vice versa; no explicit mutual-exclusion state is needed.

## 4. Component and state design

Decision: **component-local modal, `FolderBrowser`-owned visibility** — not a
`useReopen`-style hook. The reopen hook exists because its logic is shared by
every session row; settings has exactly one call site and no shared logic, so
a self-loading component plus one boolean is the least machinery.

- `FolderBrowser`: `settingsOpen` boolean state; renders
  `<SettingsModal onClose={…} onSaved={…} />` beside the existing modal/toast
  block; `savedMessage: string | null` state feeds the shared `Toast` slot.
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
- `claudePath` reaches `spawn` only as the discrete `file` argument via
  `reopenSession` — this slice never touches the launch path.

## 6. Security invariants (CLAUDE.md)

- The stored path is rendered only as a controlled input's `value` and the
  toast/error strings are fixed literals — no `innerHTML`, no interpolation of
  stored or error text.
- No new IPC surface; no renderer-side spawning; the value flows to `spawn`
  only through the existing argv-array path.
- Raw IPC rejection messages are never displayed (may embed host paths).

## 7. Test plan (TDD order)

`test/renderer/SettingsModal.test.tsx` (new):

1. Renders `role="dialog"`, `aria-modal="true"`, labelled by the title; the
   input is labelled "Claude executable path".
2. Prefills the input from `getClaudePath()` and focuses it once loaded.
3. Save submits the trimmed value via `setClaudePath`, then calls `onSaved`
   and `onClose` (in that order-insensitive sense; both called once).
4. Whitespace-only input saves as `""`.
5. Enter in the input submits the form (same assertions as 3).
6. Cancel button closes without calling `setClaudePath`.
7. Escape closes without saving; backdrop click closes without saving; a click
   inside the dialog does not close.
8. A rejecting `setClaudePath` keeps the modal open, shows the fixed inline
   error text, and does not call `onSaved`/`onClose`.
9. While the save promise is pending, the Save button is disabled (assert with
   a deferred promise).
10. A rejecting `getClaudePath` prefills the default `"claude"`.

`test/renderer/TitleBar.test.tsx` (extend):

11. With the bridge present and `onOpenSettings` passed, the gear is enabled
    and clicking it fires the callback.
12. Without the bridge, the gear renders the disabled placeholder.

`test/renderer/FolderBrowser.settings.test.tsx` (new, mirrors the
`.reopen` integration file):

13. Gear click opens the settings dialog.
14. Save closes the dialog and shows the confirmation toast.
15. Cancel closes the dialog; `setClaudePath` never called; no toast.

## 8. File manifest

- `src/renderer/components/SettingsModal.tsx` — new
- `src/renderer/components/SettingsModal.module.css` — new
- `src/renderer/components/TitleBar.tsx` — enable + wire the gear
- `src/renderer/components/FolderBrowser.tsx` — open-state, modal, saved toast
- `test/renderer/SettingsModal.test.tsx` — new
- `test/renderer/TitleBar.test.tsx` — extend
- `test/renderer/FolderBrowser.settings.test.tsx` — new
- `docs/specs/2026-07-17-settings-modal-design.md` — this spec

8 files — within the PR size cap.

## 9. Acceptance criteria (from #68)

- [ ] Gear opens a blocking modal; the field is prefilled from
      `getClaudePath()`.
- [ ] Save calls `setClaudePath` with the entered value and closes; cancel
      does not persist.
- [ ] The modal is a custom accessible dialog (design-system control, not a
      browser prompt).
