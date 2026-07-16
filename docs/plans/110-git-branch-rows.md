# Plan — #110 Show the git branch on session rows

**Tier:** Standard (a new pure helper + row display, no new module).
Touches `src/sessionRowView.ts`, `src/renderer/components/SessionRow.tsx`, plus
`test/main/sessionRowView.test.ts` and `test/renderer/SessionRow.test.tsx`.

## Goal

A session row shows its title but not the branch it ran on, so feature-branch
work and `main` work look identical until you reopen them. `gitBranch` is already
parsed and already reaches the renderer — it is simply never displayed on a
session's own row.

## Starting state (verified, not assumed)

**AC 1 of the issue is already met.** The extraction half shipped with #101/#69
(PR #113), exactly as the issue's "Key finding" predicted:

- `SessionMetadata.gitBranch: string | null` — `src/sessionParser.ts:64-66`,
  populated last-non-empty-wins at `:229-232`.
- Fixture-tested in `test/sessionParser.test.ts` (present / absent / last-wins /
  blank-does-not-clobber).
- Flows untouched through `sessionStore` and `ipcTypes` to the renderer.

So this slice is **display-only**, and adds no per-row I/O — it reads a field the
scan already returns, which is what keeps it virtualization-safe (AC 3).

**What's actually missing.** `SessionRow` already renders a branch chip, but only
for rows folded in from a worktree roll-up (the `worktreeBranch` prop, #101). A
session's own row — the common case — never shows a branch even though
`session.gitBranch` is populated.

## Approach

### The noise rule (the issue's open design call)

The issue leaves this to implementation: *"suppress the marker when the branch is
the repo default (main/master) … Decide default vs always-on."*

**Decision: suppress `main`/`master`.** It is the only option the issue itself
motivates — an all-`main` folder becoming a wall of identical chips is real, and a
chip that is always present carries no information. The branch matters precisely
when it is *not* the default.

**Matched exact and case-sensitive**, via a `Set` lookup mirroring this file's
existing `CHIP_VARIANTS` / `MODEL_NAMES` table style:

```ts
const DEFAULT_BRANCH_NAMES: ReadonlySet<string> = new Set(["main", "master"]);
export function shouldShowGitBranch(branch: string | null): branch is string
```

Case-sensitive is deliberate, not laziness: git branch names *are* case-sensitive,
so `Main` is a genuinely different branch from `main`. Erring toward showing it is
the safe direction — a spurious chip is noise, a suppressed chip is a lie.

Resolving the repo's *actual* configured default branch would be more correct
still, but needs a `git` invocation. CSM shells out to git nowhere today, and
CLAUDE.md's no-shell-interpolation posture makes that a separate feature, not a
line in this slice.

### Precedence: the worktree chip wins

`sessionTree.ts:321` already sets `branches.set(sess.sessionId, sess.gitBranch ??
worktree.name)`. So on a worktree row, `worktreeBranch` **already is**
`session.gitBranch` whenever it's non-null — rendering an own-branch chip too
would print the same string twice on one row. Own-branch chip is therefore
computed only when `worktreeBranch === undefined`.

### The noise rule does NOT apply to the worktree chip

These two chips look alike but do different jobs, so they get different rules:

| chip            | job                                        | suppressed on `main`? |
| --------------- | ------------------------------------------ | --------------------- |
| `worktree-branch` | **provenance** — this row was folded in from elsewhere | **no** |
| `git-branch`      | **information** — which branch this ran on | yes                   |

A worktree session that happens to sit on `main` must still show its chip: the
signal is "this row isn't from this folder", and suppressing it would silently
erase that. Keeping the existing chip's behavior byte-for-byte also means zero
regression risk for the shipped #101 tests.

### Rendering

Reuse the existing `.branch` / `.branchIcon` / `.branchName` CSS and SVG glyph
untouched (already generic per their own comment) — same idea, same visual
language, no new palette decision and no CSS change. Only the labels differ:
`Worktree branch: x` vs `Branch: x`, since an own-row chip reading "Worktree
branch" would be actively wrong. A distinct `data-testid="git-branch"` keeps the
two cases separable in tests.

The branch is repo-derived untrusted text and goes in as a JSX text child
(≡ `textContent`, never `innerHTML`) — the same posture as the existing chip and
required by CLAUDE.md.

## Test list

**`test/main/sessionRowView.test.ts`** (pure, node context)

- `shouldShowGitBranch`: `null` → false; `"main"` → false; `"master"` → false;
  `"feature-x"` → true; `"Main"` → true (documents the case-sensitive decision).

**`test/renderer/SessionRow.test.tsx`**

- own-branch chip renders with `data-testid="git-branch"` for a non-default branch
  when no `worktreeBranch` is passed.
- no chip when `gitBranch` is `"main"` / `"master"`.
- no chip when `gitBranch` is `null`.
- **precedence**: given BOTH a `worktreeBranch` and a non-default `gitBranch`,
  exactly ONE chip renders and it is the `worktree-branch` one.
- **provenance beats noise**: a `worktreeBranch` of `"main"` still renders (the
  suppression rule must not leak onto the provenance chip).
- an XSS-payload `gitBranch` renders as text, no element — mirrors the existing
  worktree-chip test; branch names are untrusted.

## Out of scope

- **Resolving the repo's real default branch** (vs the `main`/`master` literal
  set) — needs a git invocation; see above.
- **#111** (git markers on folder tree nodes) consumes the same `gitBranch` field
  but is a separate issue in the `sessionTree` layer.
