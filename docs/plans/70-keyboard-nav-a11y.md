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

### Focus on load — seed the tab stop, never steal focus

A `useEffect` in `FolderBrowser` (alongside the existing `seededRoots`
auto-expand) sets `focusedPath` to the first visible node once the tree is
non-empty, and re-seeds if that row later disappears.

**"Focus lands on the tree on load" (AC) is implemented as "the tree's roving tab
stop is seeded and ready", not as taking DOM focus.** That is a deliberate
reading, and it was forced by measurement rather than taste. An earlier draft had
`TreeNode` call `.focus()` whenever a row became focused; probing the built app in
real Electron showed:

```
activeElement BEFORE any tree row exists: body
activeElement AFTER the tree populates:   li[role=treeitem] "C:"        <- stolen
activeElement after focusing Refresh:     li[role=treeitem] "C:"        <- .focus() wouldn't stick
activeElement AFTER refresh re-streams:   li[role=treeitem] "AppData…"  <- yanked again, to an arbitrary row
```

Three separate faults, one cause. A scan arrives in **tiers**, so the seed re-runs
per batch; `compactTree` can change a node's `path` mid-scan, which changes
`TreeNode`'s `key`, **remounts** it and re-fires the mount effect. The result was
a tree that grabbed focus on populate, kept grabbing it while sessions streamed,
and grabbed it again after every refresh — so other controls could not hold focus
during a scan at all. That is a WCAG 3.2.x unexpected-context-change, not a nicety.

So `TreeNode` pulls real DOM focus only when **the tree owns focus**.

**How ownership is decided — and why the obvious way is wrong.** The first
attempt gated on a live `tree.contains(document.activeElement)`. That stops the
steal but introduces its mirror image: it **strands** focus. When the focused
`<li>` is *removed* — an ancestor collapsed, or a mid-scan re-compaction remounts
it under a different parent — the browser blurs to `<body>` **synchronously
during the DOM mutation**, strictly before any passive effect runs. The check
then sees `<body>`, concludes "not ours", and declines. Focus never comes back:
the row still reads as the tab stop (`tabIndex=0`) while the arrows silently do
nothing, because the keydown now fires on `<body>` and never reaches the tree's
handler. The user has to click or Tab away and back to recover, with no clue why.

`document.activeElement` simply cannot describe that moment. So ownership is
tracked from **focus/blur events** on the tree instead:

- `onFocus` → the tree owns focus.
- `onBlur` → give it up **only if `relatedTarget` is a real node outside the
  tree**. A null `relatedTarget` means the focused element was removed (or the
  window blurred) — that is the tree's own row vanishing, not the user leaving,
  and the imminent re-render is about to restore focus to its replacement.

That one distinction is the whole fix: it remembers the tree had focus *across*
the instant its element disappears.

This also means keyboard tests must Tab into the tree before arrowing, since
arrows do nothing to DOM focus until the tree owns it — which is exactly how a
real user behaves.

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
collapses then moves to parent; the tab stop seeds to the first row; a click
moves keyboard focus; Tab isn't swallowed.

Focus needs guards in **both** directions — the two faults above are mirrors, and
fixing one is exactly how the other appears:

- *Must not steal*: seeding the tab stop must not take DOM focus; a later
  streaming tier must not yank focus off another control. (Use the declutter
  switch — the refresh button is `disabled` while scanning, so it cannot hold
  focus and the assertion would pass for the wrong reason.)
- *Must not strand*: focus must survive a later tier **remounting** the focused
  row (tier 1 compacts `D:\src\csm` to a root; tier 2 gives `src` a sibling, so
  it demotes to a nested child — a different React parent, hence a real
  unmount+remount), and must survive **collapsing an ancestor** of the focused
  row.
- *Must give up*: blurring to a control outside the tree really does release
  ownership — otherwise the flag goes sticky and re-grabs on the next tier,
  reintroducing the steal.

None of these existed at first, which is why the bug shipped into the PR: every
keyboard test used a single batch and only asserted what focus *was* doing, never
what it wasn't.

## Out of scope

- New reopen behavior — PR B reuses slice 4 unchanged.
- `aria-activedescendant` as an alternative to roving tabindex: both are valid APG
  patterns; roving tabindex is chosen because real DOM focus is what the existing
  `:focus-visible` styling and the e2e can observe.
