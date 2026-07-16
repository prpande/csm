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

### The rule: DOM focus moves only from a user gesture, never from a render

`FolderTree` focuses the roving row **inside its own `onKeyDown`**, and `TreeNode`
focuses its row **inside its own `onClick`**. There is no focus effect anywhere.
`flushSync` commits the state change first, so the row we reach for already
exists (Right may have just expanded its parent).

This is the third design. The two before it failed in opposite directions, and
the reason **no middle ground exists** is worth recording so nobody re-derives it:

1. **Focus whenever a row becomes "the focused one" → STEALS.** A scan streams in
   tiers, so the seed re-runs per batch, and `compactTree` can change a node's
   path mid-scan (remounting the component, re-firing the effect). Measured: the
   tree grabbed focus on populate, on every tier, and on every refresh.
2. **Gate on `tree.contains(document.activeElement)` → STRANDS.** When the focused
   `<li>` is removed the browser has *already* blurred to `<body>`, synchronously
   during the DOM mutation. The check sees `<body>`, declines, and focus never
   returns — the row still reads as the tab stop while the arrows do nothing.
3. **Track ownership from focus/blur → IMPOSSIBLE.** Verified directly in
   Chromium: a removal and a click on a non-focusable area **both** fire
   `focusout` with `relatedTarget === null`, and `target.isConnected` is `true`
   in both. The two are indistinguishable at blur time, so any branch on that
   event reintroduces (1) or (2). (This is also why the unit suite cannot settle
   it: jsdom fires **no** blur/focusout on removal at all — it silently repoints
   `activeElement` at `<body>` — so a jsdom test of that branch is vacuous.)

Focusing from the gesture sidesteps the whole problem: inside our own keydown the
tree provably has focus, so focusing cannot steal, and there is no ambiguous event
to misread. It also means **keyboard tests must Tab into the tree before
arrowing** — which is exactly what a real user does.

The key map's shape does real work here too: Left collapses the focused node **in
place** and only walks to the parent once already collapsed, so the arrows can
never remove the row they stand on. The mouse can (collapsing an ancestor), and
that is covered because the collapse is itself a gesture — the chevron handler
focuses its own row.

**Accepted limitation.** If a scan tier remounts the focused row *while* the user
is arrow-navigating (compaction changing a node's path mid-stream), focus drops to
`<body>` and is not restored; the next arrow does nothing until the user clicks or
Tabs back in. That is narrow (it needs keyboard navigation during the seconds a
scan is still streaming and restructuring) and transient, and it is the honest
price of never stealing. Tracked as a follow-up rather than papered over with a
heuristic that provably cannot be correct.

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

Focus needs guards on both halves of the rule, since the two faults are mirrors:

- *Must not steal*: seeding the tab stop must not take DOM focus; a later
  streaming tier must not yank focus off another control. (Use the declutter
  switch — the refresh button is `disabled` while scanning, so it cannot hold
  focus and the assertion would pass for the wrong reason.)
- *Must not strand*: a **mouse-collapse** that removes the focused row keeps focus
  in the tree; a **keyboard collapse** keeps focus on the node it collapsed.

None of these existed at first, which is why the bug shipped into the PR: every
keyboard test used a single batch and only asserted what focus *was* doing, never
what it wasn't.

**What the unit suite cannot prove.** jsdom fires no blur/focusout on element
removal, so any test of removal-blur handling is vacuous there. The gesture model
is deliberately built to not depend on that event at all — but the behaviour was
still verified in real Electron, which is the only place it is decidable.

## Out of scope

- New reopen behavior — PR B reuses slice 4 unchanged.
- `aria-activedescendant` as an alternative to roving tabindex: both are valid APG
  patterns; roving tabindex is chosen because real DOM focus is what the existing
  `:focus-visible` styling and the e2e can observe.
