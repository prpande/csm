# Plan — #65 Renderer: sidebar file tree + folder-view shell

Slice 2 of the Phase-A renderer UI. Consumes the #64 data layer
(`useSessionScan` → `SessionTree`) and renders the structural skeleton that the
virtualized session list (#66), reopen (#67), and keyboard nav (#70) plug into.

## Decisions (confirmed with maintainer)

- **A — Centralized tree UI state.** A `FolderBrowser` container owns the
  `expanded: Set<path>` and `selectedPath` state; `FolderTree`/`TreeNode`/
  `FolderPane`/`TitleBar` are presentational (props + callbacks), so they unit-test
  without the bridge and slice #70 can drive expansion/selection from outside a
  node. Collapsed subtrees are **not rendered** (spec §6 perf: no mounted DOM for
  collapsed nodes).
- **(a) — Per-folder ⟳ wired to the global `refresh()`** for now (the #59 bridge
  exposes only a full `listSessions` scan; there is no per-folder re-parse API),
  disabled while `status === "scanning"`. True single-folder re-stat/re-parse needs
  a main-process handler — filed as a follow-up.

## Components (`src/renderer/components/`)

- **`FolderBrowser.tsx`** — container: `useSessionScan()`, expansion + selection
  state, auto-expands root (drive) nodes once on first data, derives the selected
  `FolderNode` from `selectedPath` against the current tree (selection survives /
  self-clears across refresh). Lays out title bar + sidebar + pane.
- **`TitleBar.tsx`** — brand, wired global refresh ⟳ (disabled while scanning),
  greyed disabled placeholders for search (phase C) / settings (#68) / theme.
- **`FolderTree.tsx`** — presentational sidebar: renders roots then the pinned
  `(unknown)` node, a "loading older sessions…" line while scanning, a
  "No Claude sessions found" empty state when done + empty, an error line.
- **`TreeNode.tsx`** — one recursive row: chevron (only if it has children;
  toggles, `aria-expanded`), name, count badge **iff `ownCount > 0`**. Row click
  selects when selectable (`ownCount > 0`), else toggles expansion (pure nav node).
  Children `<ul>` mounted only when expanded.
- **`FolderPane.tsx`** — right pane: centered "Select a folder to view its
  sessions" + **no** header when nothing selected; else folder header (path +
  `N sessions` + per-folder ⟳) above a placeholder for the #66 list.

`App.tsx` renders `<FolderBrowser />` (replaces the scaffold).

## Pure helper (tested in `test/main`)

- **`findFolder(tree, path): FolderNode | null`** added to `src/sessionTree.ts`
  (walks roots + unknown). Lets the container resolve `selectedPath` → node and
  keeps that lookup pure + reliably testable (node-context signal).

## Rendering safety

All folder names / paths / counts render as JSX text nodes (≡ `textContent`) —
never `innerHTML` (spec §9). Covered by a test asserting HTML-like text renders
literally with no injected element.

## Tests

- `test/main/sessionTree.test.ts` (+): `findFolder` hit in roots, hit in a nested
  child, hit in `(unknown)`, miss → null.
- `test/renderer/FolderBrowser.test.tsx`: empty-state before selection (no header);
  batch → auto-expanded root shows child; select a `ownCount>0` folder → header w/
  path+count, empty state gone; click intermediate nav node → expands, does NOT
  select; `(unknown)` pinned last + selectable; collapse hides (unmounts) subtree;
  title-bar refresh re-invokes `listSessions` + disabled while scanning; per-folder
  ⟳ present/disabled-while-scanning/calls refresh; loading line while scanning;
  count shown on leaf, absent on intermediate; HTML-like path renders as text.

Renderer tests use plain vitest assertions (no jest-dom matchers) so they pass
locally too (the jest-dom `toBeInTheDocument` artifact fails on this machine; CI
runs the full suite).

## Out of scope

Virtualized list + rows (#66), reopen/bypass (#67), settings modal (#68),
temp/worktree filter (#69), keyboard/a11y nav (#70), per-folder re-parse main API
(new follow-up). Basic `aria-*` labels are included; arrow-key navigation is #70.
