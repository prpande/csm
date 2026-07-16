# Plan — #111 Mark git repositories in the folder tree

**Tier:** Standard (a pure `sessionTree` predicate + a tree-row marker).
Touches `src/sessionTree.ts`, `src/renderer/components/TreeNode.tsx`,
`src/renderer/components/FolderTree.module.css`, plus
`test/main/sessionTree.test.ts` and `test/renderer/FolderBrowser.test.tsx`.

## Goal

The folder tree gives no signal about which folders are git repositories. Repos
are the meaningful project roots; temp/scratch folders are not. A subtle marker
helps orient.

## Approach

### "Is a git repo" is derivable with zero I/O

A folder whose sessions carry a `gitBranch` **was** a git working tree at session
time. `SessionMetadata.gitBranch` is already parsed and already in the tree, so
this needs no `fs` call, no `.git` probe, and no git subprocess — which is what
makes it work even for folders that have since been **deleted** (the removed-
worktree case), where an on-disk check is impossible by definition.

A live `.git` probe (Epic 5, #91) could later enrich this, but is not required
and is explicitly not attempted here.

### A derived predicate, not a stored field

`isGitRepo` is **derived on read**, as a pure exported function:

```ts
export function isGitRepo(node: FolderNode): boolean {
  return node.sessions.some((s) => s.gitBranch !== null);
}
```

This follows `findFolder`'s precedent — the file's existing pure per-node helper
over the built tree, rather than a stored field.

**Why not a `FolderNode.isGitRepo` field.** Three separate transforms build and
rewrite nodes — `buildTree`, `compactTree` (#77 chain collapsing), and
`rollUpWorktrees` (#101 folding). A stored field must be recomputed correctly in
all three, which is three chances for the flag to drift out of sync with
`sessions`. A derived predicate cannot drift: it reads the same array every
consumer already trusts for `ownCount`. It is also strictly cheaper here —
`.some()` short-circuits on the first branch-carrying session, and only
**expanded** nodes render (a collapsed subtree isn't in the DOM at all).

### The semantics fall out correctly

Checking `node.sessions` — the node's **own** sessions, per the issue — gives the
right answer at every node kind, which is worth stating because each is a case a
stored field would have had to reproduce by hand:

| node | `sessions` | marker | correct? |
| --- | --- | --- | --- |
| repo leaf | its own sessions, some with a branch | yes | yes |
| intermediate nav folder (`D:\src`, `ownCount === 0`) | `[]` | no | yes — it isn't a repo, its children are |
| #77-compacted chain | the merged leaf's sessions | follows the leaf | yes |
| #101 roll-up owner | own + folded-in worktree sessions | yes | yes — it *is* the repo the worktrees belong to |

### False negatives are the safe direction

A repo whose sessions all predate the `gitBranch` field (older JSONL) shows no
marker. That is the issue's own accepted trade: absence of evidence, not evidence
of absence. Erring this way matters — a missing marker is a non-event, whereas
marking a non-repo folder would be an outright lie.

### Rendering

The marker goes in `TreeNode`'s row, after the name, as an `aria-hidden` inline
SVG with a `title` so the meaning is discoverable on hover. Reuses the git-branch
glyph already shipped in `SessionRow` — the same visual language for the same
concept, so no new design call (the deliberate non-design-call option, same
reasoning as #110).

**Icon duplication.** That glyph would now exist in two components. Rather than
copy the path data (where drift means two different-looking git icons), extract a
tiny shared `GitBranchIcon` and have both render it. The repo's rule-of-three
convention (#61) governs *logic* duplication; asset data that must stay visually
identical is a different case, and the extraction is ~15 lines.

Colors come from palette tokens only — no hardcoded values, so the `designTokens`
test stays green.

## Test list

**`test/main/sessionTree.test.ts`** (pure, no fs, no git)

- a folder whose sessions all have `gitBranch: null` → `false`.
- a folder with at least one branch-carrying session → `true`.
- a folder with a **mix** → `true` (it's `some`, not `every`).
- an intermediate node with no own sessions → `false` (even when a *descendant*
  is a repo — own sessions only).
- a `rollUpWorktrees` owner whose branch-carrying sessions arrived by folding →
  `true`.
- a `compactTree`-collapsed chain → follows the merged leaf.

**`test/renderer/FolderBrowser.test.tsx`** (integration — there is no
`FolderTree.test.tsx`, so tree-level rendering is asserted here per the existing
convention)

- a folder with branch-carrying sessions renders the marker; a folder without
  does not.

## Finding from running it: the marker may not earn its place

Verified against a real `~/.claude/projects` (Playwright + Electron, declutter
default-on): **14 of 16 tree rows are marked.** The only two unmarked rows are
`C:` and `D:\src` — nav folders, which already read as different because they
carry no count pill. Every single session-owning leaf is a repo.

This undercuts the issue's stated motivation ("repos are the meaningful project
roots, temp/scratch folders are not"). The untested assumption underneath it is
that a meaningful share of *visible* folders are non-repos — but the default-on
declutter filter (#69) already hides the temp folders, so by the time the tree is
rendered, nearly everything left is a repo. A marker present on ~90% of rows is
close to the "wall of identical chips" that #110's noise rule exists to avoid.

The counter-case, honestly: with declutter **off** the temp cluster reappears and
would be unmarked, so the marker does discriminate in raw mode; a developer who
runs Claude in docs/scratch folders would see more contrast; and the
deleted-worktree case still works where no on-disk check could. One machine's
corpus is not every machine's.

Implemented as specified rather than redesigned unilaterally — #111 is the
owner's issue with an explicit proposal, and "invert it / drop it" is a design
call. Evidence and the concern go to the owner (follow-up issue) instead of being
silently shipped or silently dropped.

## Out of scope

- **A live `.git` probe** to detect repos with no branch-carrying sessions —
  Epic 5 (#91). Needs fs/subprocess and cannot work for deleted folders, which is
  the case this approach handles best.
- **Marking a parent as a repo because a descendant is one** — the issue scopes
  this to a node's own sessions, and a nav folder like `D:\src` is not a repo.
