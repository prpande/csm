# Plan — #77 Compact single-child folder chains

Start the sidebar tree at the largest common parent per cluster instead of the
drive root, by collapsing pure single-child pass-through folders.

## Approach

A pure `compactTree(tree: SessionTree): SessionTree` transform in
`src/sessionTree.ts`, applied **over** `buildTree` output — not inside
`buildTree`, not in the render layer. Grouping and compaction stay separate,
independently DOM-free-unit-testable concerns (matching the `sessionTree`
convention). `useSessionScan` composes them as the outermost transform
(`compactTree(buildTree(sessions))`), so compaction runs post-any-future
`#69` filter automatically.

### Rule (from the issue)

Collapse a folder into its single child iff `ownCount === 0 && children.length === 1`.
Stop at the first folder that owns sessions (`ownCount > 0`) or branches
(`> 1` child).

### Algorithm — bottom-up

`compact(node)`:
1. Recurse: `children = node.children.map(compact)`.
2. If `node.ownCount === 0 && children.length === 1`, merge: return the single
   (already-compacted) child, but with `name` = the parent's label joined to the
   child's label via the path separator. The survivor keeps the child's `path`,
   `sessions`, `children`, `ownCount`, `totalCount` (the deepest node's
   identity).
3. Otherwise return the node with its compacted children.

`compactTree` maps `compact` over `roots` and the `unknown` group.

Key details:
- **Separator** is inferred from `child.path` (always contains a separator),
  never `node.path` — a drive root `"D:"` has no separator in its own path.
- Label building reuses the existing `joinPath` helper, so the POSIX `/` root
  (`joinPath("/", "/", "Users")` → `/Users`) and drive roots both join cleanly.
- **Counts/selection are preserved:** the survivor takes the child's counts,
  which already equal the absorbed parent's `totalCount`; only `ownCount>0`
  nodes are selectable and their leaf `path`s survive compaction, so
  `findFolder`/selection/auto-expand keep resolving.

### Renderer

`compactTree` emits the **full joined path** as `name` (lossless — the data
layer bakes in no pixel-width truncation). `TreeNode` already truncates long
names with CSS end-ellipsis; add `title={node.name}` so the full path is
discoverable on hover. Selection/expansion semantics are unchanged.
Middle-truncation, if wanted, is a cosmetic follow-up (not in these criteria).

## Tests (`test/main/sessionTree.test.ts`)

- Unbroken chain `C:\…\worktrees\42-hotfix` → one node, `name` = full path,
  selectable iff it owns sessions.
- Branch point (`D:\src` → `csm`, `prism`) preserved and expandable; `D:\src`
  kept as top node.
- A folder that owns sessions AND has children is never absorbed.
- Cross-drive / disjoint roots → multiple compact roots (no forced single root).
- POSIX `/` root chain collapses with `/`-joined label.
- `ownCount`/`totalCount`/selectability correct post-compaction; existing tree
  tests unchanged (compaction is a separate function).
- `unknown` group passes through unchanged.
