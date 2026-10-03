# PR Button and Popover Implementation Plan

**Goal:** Replace the PR chip on session rows with a state-coloured PR button under Open, and a popover that lists every PR linked to the session.

**Spec:** `docs/specs/2026-10-02-session-search-and-pr-links-design.md` §8.4 (binding). Approved mockup: light and dark Clay themes, tree chevron, external-link icon (option 1).

**Builds on:** `docs/plans/206-search-engine-pr-chip.md`. Its Global Constraints still apply, except "No new design tokens", which this plan replaces with the `--pr-*` tokens below.

## Global Constraints

- Commit subjects end with `(#206)`; no `Co-Authored-By` or `Claude-Session` trailers.
- Git runs as `git -C D:\src\CSM\.claude\worktrees\206-search-engine-pr-chip ...`; never bare `git stash`.
- One build or test command at a time, in the foreground. Run vitest through `node_modules/.bin/vitest`, never `npx vitest`.
- Render titles, repos and labels as text nodes only (CLAUDE.md).
- Code comments: default none. Keep only a non-obvious why, at most one line. No issue numbers.
- Colours live only in `src/renderer/styles/global.css`; `test/main/designTokens.test.ts` fails on a hex value anywhere else.
- The pure units stay pure and are tested in `test/main/` (node context). Component tests go in `test/renderer/`.

## Token values

| token | light | dark |
|---|---|---|
| `--pr-open-bg` / `--pr-open-text` | `#dcecd8` / `#2b6a34` | `#1b3a22` / `#93d39d` |
| `--pr-draft-bg` / `--pr-draft-text` | `#eae0d2` / `#675d52` | `#383029` / `#c4b8aa` |
| `--pr-merged-bg` / `--pr-merged-text` | `#eedcf2` / `#7a2d8e` | `#3b2045` / `#dcaaea` |
| `--pr-closed-bg` / `--pr-closed-text` | `#f9dcdb` / `#a0262f` | `#4a1e21` / `#f3a5a9` |

Measured: text on fill is 4.93:1 at worst (light draft). The text colour, used as the border, is 3.98:1 at worst against `--selection-bg` (dark closed).

## Task 1: State tokens and shared icons

**Files:** `src/renderer/styles/global.css`, `src/renderer/components/ChevronIcon.tsx` (new), `src/renderer/components/ExternalLinkIcon.tsx` (new), `src/renderer/components/TreeNode.tsx`, `test/main/designTokens.test.ts`, a new `test/main/prStateContrast.test.ts`.

- Add the eight tokens per theme, from the table above.
- `prStateContrast.test.ts` parses both theme blocks of `global.css`, computes WCAG contrast, and asserts for each state and theme:
  - text on fill ≥ 4.5;
  - text colour against `--bg`, `--hover-bg` and `--selection-bg` ≥ 3.
- It also asserts that a deliberately failing pair is caught, so the test can't pass vacuously.
- `ChevronIcon` takes the SVG exactly from `TreeNode` (viewBox `0 0 16 16`, path `M6 4l4 4-4 4`, stroke 1.75, round caps and joins, 15px, `aria-hidden`), with `className` and `size` props as in `GitBranchIcon`. `TreeNode` uses it, with no visual change, and its tests stay green.
- `ExternalLinkIcon` uses the same props and the same stroke style, with the path `M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3`.

## Task 2: Pure helpers

**Files:** `src/prChip.ts`, `test/main/prChip.test.ts`.

- `popoverPlacement(anchor: {top: number; bottom: number}, popoverHeight: number, viewportHeight: number, gap: number): "below" | "above"`. It returns `below` when `anchor.bottom + gap + popoverHeight <= viewportHeight`. Otherwise it returns `above` when there is more room above than below, and `below` if not.
- `prPopoverKey(key: string, index: number, count: number): { type: "move"; index: number } | { type: "open"; index: number } | { type: "close" } | null`. ArrowUp and ArrowDown are clamped; Home and End jump to the ends; Enter opens; Escape closes; any other key returns null.
- `prButtonLabel(links)` returns `{ number, state, more, multiple }` for the primary PR, built from `orderedPrs` and `prStateLabel`.
- Each helper gets boundary tests: empty, one and many links; the first and last index; a popover that fits exactly; one too tall for either side.

## Task 3: PR button, popover and list wiring

**Files:**
- `src/renderer/components/SessionRow.tsx` and `SessionRow.module.css`
- `src/renderer/components/PrPopover.tsx` and `PrPopover.module.css` (new)
- `src/renderer/components/SessionList.tsx`
- `test/renderer/SessionRow.test.tsx`, `test/renderer/SessionList.test.tsx`, a new `test/renderer/PrPopover.test.tsx`

**Row**
- Remove the PR chip from the meta line.
- Wrap Open and the new PR button in an action column: `flex: 0 0 7.6rem`, a vertical stack, `gap: 9px`, centred. Both buttons are `24px` tall and full width.
- The PR button follows spec §8.4:
  - label: number, state, `+N`, and the external-link icon for one PR or the chevron for several (`is-open` rotation while expanded);
  - colours from `--pr-<state>-*`; an unfetched PR uses a transparent fill and `--text-muted`;
  - the hover swap;
  - `tabIndex=-1`, with the accessible name and tooltip listing every PR, plus `aria-haspopup="dialog"` and `aria-expanded` when there are several;
  - `e.detail > 1` ignored, and `onDoubleClick` stopped, as the chip did.
- `SessionRow` gets an `onPrButton(session, anchorEl)` prop. The row still decides nothing: SessionList owns what happens.

**List**
- `SessionList` owns `picker: { sessionId: string; anchor: HTMLElement } | null`.
- The PR button calls a handler that opens the one PR directly, or toggles the picker when there are several.
- Shift+Enter does the same. It finds the anchor by a stable DOM id derived from the row id, and ignores `e.repeat`.
- Close the picker on list scroll and on window resize, and when its session leaves `sessions`.
- On a keyboard close, return focus to the list container.

**Popover**
- `PrPopover` renders through `createPortal(…, document.body)`, at a fixed position computed from `anchor.getBoundingClientRect()` and `popoverPlacement`, right-aligned to the anchor.
- Contents and roles follow spec §8.4:
  - the header and hint;
  - items with a pill, number, title or "Title unavailable", the icon, repo, and `opened here`;
  - `role="dialog"` with the `aria-label`;
  - the primary item focused on open; keys handled through `prPopoverKey`; Tab kept inside.
- Opening an item calls `openPr(link)` and keeps the popover open.
- Close on an outside `pointerdown`.

**Tests**
- Row:
  - one PR opens it directly;
  - several open the popover;
  - the meta line has no PR element;
  - the colours come from the state attribute;
  - the label shows the unfetched case.
- Popover:
  - order;
  - Enter and click both open and keep it open;
  - Up/Down/Home/End;
  - Esc closes and returns focus;
  - an outside click closes it;
  - it renders in `document.body`.
- List:
  - Shift+Enter with one PR opens it, and with several opens the popover;
  - a held repeat is ignored;
  - a list scroll closes the popover;
  - after a `search:changed` refetch, an open popover shows the new links.
- Remove the chip tests this replaces.

## Review Focus

1. **A popover opened on the last visible row near the bottom of the window.** Expected: it flips above and stays fully on screen. Test: Task 2 placement boundaries, and Task 3 list test with a mocked anchor rect.
2. **The anchor row scrolled out of the mounted window while the popover is open.** Expected: the popover closes, with no orphaned portal and no error. Test: Task 3 list scroll test.
3. **A session whose PR links change while the popover is open** (a `search:changed` refetch). Expected: the items update, focus stays on a valid item, and nothing throws if the list shrinks. Test: Task 3.
4. **A double-click on the PR button.** Expected: one open, or one toggle, and no row reopen. Test: Task 3 row test with `detail: 2`.
5. **A selected row in the dark theme.** Expected: the button border stays at least 3:1 against `--selection-bg`. Test: Task 1 contrast test.
