# Worktree roll-up + temp/worktree hide filter

**Issues:** #101 (worktree roll-up), #69 (default-on hide temp/worktree filter +
toggle). Co-designed as one slice.
**Updates:** main design `docs/specs/2026-06-30-csm-design.md` sections 4.1, 9, 10.
**Status:** design settled (`needs-design` dropped on #101). Phase A.

## Problem

Selecting a folder shows only its own sessions. Projects spawn git worktrees in
nested folders (`<repo>/.claude/worktrees/<name>`), each a separate tree node, so
reaching a worktree session means drilling into that subfolder. Separately, the
tree is dominated by temp/worktree noise (the OS temp root alone holds 2,500+
sessions). These are two halves of one behavior: **hide the worktree/temp nodes
and surface the worktree sessions under their owning project.**

## Key data finding: the branch is in the session file

Claude session JSONL records carry a per-record `gitBranch` field (present on
~59% of records across `user`/`assistant`/`attachment`/`system` types; the last
value is reliably resolvable per file). This is the branch the session actually
ran on, captured **historically** and available **even when the worktree
directory has since been deleted**.

Consequence: we do **not** need live git I/O to label a worktree session's
branch. Reading live `git HEAD` would be strictly worse (it fails for removed
worktrees, which are the majority for closed sessions, and reports "now" rather
than "then"). The branch label comes free from data `sessionParser` already
reads.

## Scope of this slice (pure, no git subprocess, no fs probing)

1. `sessionParser` extracts `gitBranch` (last-wins, `null` when absent).
2. Worktree roll-up for the unambiguous `.../<repo>/.claude/worktrees/<name>/...`
   convention: re-home those sessions onto the owning-project node
   (`<repo>` = the path up to and excluding `.claude`), tagged with the session's
   `gitBranch` (or the `<name>` folder when the branch is null).
3. Default-on filter that hides temp-rooted folders and `.claude/worktrees`
   nodes from the tree, with a single global toggle to reveal the raw structure.

### Explicitly out of scope (deferred, tracked)

- **Generic (non-`.claude`) worktree detection + roll-up** (e.g.
  `<repo>/worktrees/<name>` or a sibling `<repo>-hotfix`). Requires a live
  `git rev-parse --git-common-dir` / `.git`-file probe (I/O). Tracked under
  **#91**'s "worktree roll-up via git-common-dir" child; **#56** consumes that
  probe. Generic *removed* worktrees leave no on-disk trace and are undetectable
  by any means.
- **Branch on all session rows** (#110) and **git-repo marker in the tree**
  (#111) — derived-metadata display consuming the `gitBranch` parsed here; filed
  under Epic 2 (#88).

## Detection: two tiers, but only tier 2 ships here

| Case | Signal | This slice |
|---|---|---|
| Worktree still on disk | git `.git`-file I/O (true branch, owning repo, generic layouts) | deferred to #91/#56 |
| `.claude/worktrees/<name>` (any state, incl. removed) | path convention (pure) | **yes** |
| Generic removed worktree | none | undetectable |

The `.claude/worktrees` convention is what the user's own `EnterWorktree`
produces and is unambiguous (`.claude` disambiguates from a real `worktrees/`
source dir), so tier 2 covers the dominant case purely.

## Unified UI model: declutter vs raw

One global toggle in the tree pane, default **declutter** (filter on):

| | Declutter (default) | Raw structure |
|---|---|---|
| Temp-rooted folders | hidden | shown as nodes |
| `.claude/worktrees/<name>` | node hidden; sessions rolled up into owning project, tagged with branch | shown as own nodes; roll-up suppressed (no double-render) |

This single control replaces both #69's filter toggle and #101's originally
proposed per-folder "This folder only" toggle (redundant — raw mode already
exposes the worktree node for own-only viewing).

### Folder pane

Selecting a project surfaces own + rolled-up worktree sessions in one
recency-sorted list (spec section 9, newest-first). Each rolled-up row carries a
small branch/name chip, rendered via `textContent` (branch names are untrusted)
using palette tokens (the designTokens test forbids hardcoded hex). Own rows
carry no chip. The header count reflects the aggregate.

## Data shapes

- `SessionMetadata.gitBranch: string | null` — legitimate parsed session data,
  resolved last-wins like `permissionMode`. Not a derived classification, so it
  belongs on the DTO.
- `FolderNode` gains `worktreeBranches: ReadonlyMap<string, string>` (session id →
  branch label). Rolled-up sessions are merged **into** the owning node's `sessions`
  (newest-first, sorted inside the `rollUpWorktrees` transform) and the drained
  worktree subtree is removed, so `ownCount`/`totalCount` and the `ownCount > 0`
  selection rule stay consistent with a normal node. Consumers do no merging or
  re-sorting: `SessionList`/`SessionRow` render the list as-is and look up
  `worktreeBranches.get(id)` to decide the chip. (Rationale: keeps sorting a
  `sessionTree` concern and leaves every downstream count/selection consumer
  unchanged, rather than pushing a parallel `rolledUp` array and render-time
  re-sort up into `FolderPane`.)
- Temp classification input: main injects the **resolved temp-roots list** once
  (renderer lacks `os`); the renderer does pure prefix-matching. No per-session
  wire field.

## Placement

- Worktree roll-up + `.claude/worktrees` detection: **renderer**, pure, in the
  `sessionTree` layer as a transform (`rollUpWorktrees`) composed in
  `useSessionScan` alongside `compactTree`. Must run before `compactTree` (it
  changes which nodes exist).
- Temp classification: **renderer** prefix-match against the main-injected roots.
- The only main-side change is exposing the temp-roots list over the existing
  IPC surface.

## Testing

- `sessionParser`: `gitBranch` present / absent / changes-within-file (last
  wins). Fixtures.
- `rollUpWorktrees`: `.claude/worktrees` session re-homed to owning project;
  branch label from `gitBranch`, fallback to `<name>`; owning node synthesized
  when it has no own sessions; non-worktree tree untouched; interaction with
  `compactTree`.
- Filter: temp prefix-match per-OS (inject roots), `.claude/worktrees` node
  hidden in declutter mode and present in raw mode.
- Renderer: `FolderPane` shows merged list + chip; toggle flips modes without
  losing scan state.

## Security / invariants

- Read-only over Claude's files (no mutation); no git subprocess, no shell
  interpolation; all metadata rendered via `textContent`.
