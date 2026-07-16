# Plan — #70 Keyboard navigation + a11y polish (spec §9)

**Tier:** Standard. **Two PRs** — the full scope is ~19 changed files, over the
repo's 10–15 cap, so it is split *before* raising (CLAUDE.md).

- **PR A — tree pane** (`Part of #70`): `src/sessionTree.ts`,
  `src/renderer/components/{FolderTree,TreeNode,FolderBrowser}.tsx`,
  `FolderTree.module.css`, `test/main/sessionTree.test.ts`,
  `test/renderer/{TreeNode,FolderBrowser}.test.tsx`.
- **PR B — list pane + modal** (`Closes #70`): `src/sessionListWindow.ts`,
  `src/renderer/components/{SessionList,SessionRow,BypassConfirmModal}.tsx`,
  `SessionRow.module.css`, and their tests.

## Goal

Spec §9 keyboard access: arrows within a pane, Left/Right/Space expand-collapse
and move-to-parent, Tab between panes, **Enter opens the focused session**
(through the bypass gate), visible focus, focus starts on the tree, correct ARIA
roles.

## Scope is wider than the issue's bullets — by prior deferral, not by drift

Tracing the plan docs shows two pieces were explicitly parked here rather than
dropped, and #70 cannot be honestly closed without them:

- `docs/plans/66-session-list.md` — `SessionList`/`SessionRow`'s `list`/`listitem`
  roles are "the scaffold **#70 upgrades**" to `listbox`/`option`.
- `docs/plans/67-reopen-flow.md` — defers **both** single-click row-selection
  state **and** the modal's full Tab focus-trap to #70.

Today the renderer has **no** selection/focus state at all: grepping
`src/renderer` for `tabIndex` / `onKeyDown` / `aria-activedescendant` returns only
the modal's Escape handler. So this introduces that concept, it doesn't extend it.

## PR A — tree pane

### `flattenVisible` — one pure source of truth for "what's on screen"

Arrow keys need the *visible* row order. That order is a property of the tree +
expansion state, and it already exists implicitly in `TreeNode`'s recursive
render. Deriving it a second time by walking the DOM would let the two drift.

```ts
export interface FlatNode { node: FolderNode; depth: number; parentPath: string | null }
export function flattenVisible(tree: SessionTree, expandedPaths: ReadonlySet<string>): FlatNode[]
```

It must mirror the render **exactly**: `tree.roots` in order, `tree.unknown`
pinned last, recursing into children only when `expandedPaths.has(node.path)` —
matching the "a collapsed node does NOT render its child `<ul>`" invariant
(collapsed subtrees are out of the DOM entirely, spec §6 perf). Pure, so it is
tested in `test/main` with no DOM.

Navigation is then plain index math on that array (`next`/`prev`), and
`parentPath` gives Left-to-parent without a second tree walk.

### Focus lives on the `<li role="treeitem">`

`tabIndex` / `ref` / `.focus()` go on the `<li>`, **not** the inner `.row` div,
because `aria-expanded` / `aria-selected` already live there and ARIA state must
sit on the same element that takes focus. Putting `tabIndex` on the div would
produce a tree that is keyboard-navigable but wrong to a screen reader.

Roving tabindex: `tabIndex={isFocused ? 0 : -1}`, with an effect calling
`.focus()` when a node becomes focused.

### One Tab stop per pane

The chevron `<button>` gets `tabIndex={-1}`. Otherwise Tab stops at every visible
node's chevron and "Tab moves focus between tree and list" is unreachable in
practice. It stays mouse-clickable and keyboard-reachable via the row's own
Right/Left/Space — the standard ARIA APG treeview pattern (a composite widget
exposes one tab stop; item actions run through the composite's key handling, not
nested tab stops).

### Key map

| key | behavior |
| --- | --- |
| Down / Up | next / prev in `flattenVisible` |
| Right | collapsed+children → expand; expanded → first child; leaf → nothing |
| Left | expanded → collapse; else → move to `parentPath` |
| Space / Enter | the row's existing click behavior: select if `ownCount > 0`, else toggle |

**Enter/Space on a tree item is a decision, not an AC.** The AC defines Enter for
*session rows*; tree items aren't sessions. Both keys mirror the existing mouse
behavior — no new concept.

### Focus on load

A `useEffect` in `FolderBrowser` (alongside the existing `seededRoots`
auto-expand) sets `focusedPath` to the first visible node the first time the tree
becomes non-empty. Focus **state** starts on the tree; it does not steal the
browser's focus on mount.

## PR B — list pane + modal (outline)

- `scrollTopToReveal(index, scrollTop, viewportHeight, rowHeight, overscan)` in
  `sessionListWindow.ts`, pure and unit-tested. **The hard part**: moving focus to
  a row outside the mounted `[startIndex, endIndex)` window means recomputing
  scrollTop *before* the row exists in the DOM, then focusing it post-render — and
  updating both React state and the real `scrollRef.current.scrollTop` (state
  alone won't move the scrollbar; the DOM write alone won't recompute the window
  before the focus effect runs).
  **Mounting all rows to sidestep this is not on the table** — spec §11 and
  CLAUDE.md require large lists stay virtualized. Tested with the existing
  2500-row fixture.
- `list`/`listitem` → `listbox`/`option`. **This breaks existing passing
  assertions** in `SessionList.test.tsx` and `FolderPane.test.tsx` — they must be
  updated, and are easy to miss precisely because they pass today.
- Enter calls the existing `onOpen` prop. **No parallel keyboard-reopen path** —
  a second invocation route would silently bypass the reviewed
  `requestReopen` → `needsBypassConfirm` → modal gate.
- `BypassConfirmModal` gains a real Tab trap (it only handles Escape today).

## Test list (PR A)

**`test/main/sessionTree.test.ts`** — `flattenVisible`: collapsed subtree excluded;
expanded children included in render order; `unknown` pinned last; `parentPath`
correct at depth; empty tree → `[]`.

**`test/renderer/TreeNode.test.tsx`** — roving tabindex on the `<li>`; chevron is
`tabIndex={-1}`.

**`test/renderer/FolderBrowser.test.tsx`** (integration; there is no
`FolderTree.test.tsx`) — Down/Up traverse; Right expands then descends; Left
collapses then moves to parent; focus starts on the tree.

## Out of scope

- New reopen behavior — PR B reuses slice 4 unchanged.
- `aria-activedescendant` as an alternative to roving tabindex: both are valid APG
  patterns; roving tabindex is chosen because real DOM focus is what the existing
  `:focus-visible` styling and the e2e can observe.
