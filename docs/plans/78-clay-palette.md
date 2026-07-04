# Plan — #78 Adopt the Clay palette

## What / why

Swap CSM's placeholder neutral/blue design tokens for the **Clay** palette — a
warm, burnt-terracotta direction chosen by the maintainer (over Amber/Apricot)
from rendered mockups, then refined by eye against the app icon. Goal: CSM reads
as *related to Claude* (warm orange lean) without copying Claude's coral.

Because every color already routes through the semantic tokens in
`src/renderer/styles/global.css` (component CSS modules held zero hardcoded hex
except one `#ffffff`), this is a **token-value swap plus one modal line**, not a
component rewrite.

## Approach

1. Replace the light + dark token values in `global.css` with the Clay set.
2. Add an `--on-accent` token (text/icon on the accent fill) and use it in
   `BypassConfirmModal.module.css`, removing the last hardcoded `#ffffff`.
3. Commit the app icon source set under `assets/icons/` (packaging wiring is a
   separate concern, tracked in #36).

Token **names/roles** are unchanged, so every existing and future slice inherits
the palette automatically.

### Accent decision (post visual sign-off)

- Light accent brightened `#c0562b → #d9622b`; dark selected-row `#4c2e1d → #7a4524`
  after the originals read too dark on the real UI.
- **Scoped AA relaxation:** white-on-`#d9622b` is ~3.6:1 — under AA-normal (4.5:1)
  but above the 3:1 large-text bar. Accepted **only** for the single primary
  accent button (standard brand-button treatment; matches Claude's own). Dark
  button (`#e27a48` + `#241610`) is ~6:1. Every other pair stays strict AA ≥ 4.5.

## Tests

- `test/main/designTokens.test.ts` (new, node-context, pure fs read):
  - `global.css` defines `--on-accent` in both the light and dark blocks.
  - No component CSS module hardcodes a color literal (guards the centralization
    invariant so future palette swaps stay one-file edits).
- Existing chip/component tests assert `data-variant`, not color, so no changes
  expected.

## Verification

- WCAG AA computed for all load-bearing pairs (body/muted text on bg, each chip
  text on its chip bg, selection-text on selection-bg) — all ≥ 4.5:1; tightest
  are muted 4.69 and chip-info 4.97. Only the accent button is the scoped
  exception above.
- Both themes screenshotted on the real renderer (Vite dev server with a stubbed
  bridge), light + dark.
- `bypassPermissions` chip stays clearly distinct from the accent at real size.

## Out of scope

- Packaging the icon into installers (`build/icon.*`, electron-builder) — #36.
- A shared text-button primitive (noted in #67 review) — the modal buttons remain
  the only text buttons for now.
