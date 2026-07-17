# Plan — shared type guards (#61) + dead pathAdapter predicates (#114)

Two tech-debt issues, one PR. They are **forced together**: #61 makes
`pathAdapter` import a shared guard, #114 deletes two `pathAdapter` functions.
Landing them separately guarantees a conflict in that file for no reviewer
benefit.

## #61 — extract the shared guards

### The duplicate set is larger than the issue says

#61 was filed during #58 and names three sites. #116 (session index) landed
afterwards and added a fourth copy of `isRecord`. Current state:

| predicate | site | form |
| --- | --- | --- |
| `isRecord` | `src/sessionParser.ts:75` | `v is Record_` (local alias) |
| `isRecord` | `src/sessionIndex.ts:63` | `v is Record<string, unknown>` |
| `isRecord` | `src/settingsStore.ts:32` | `v is Record<string, unknown>` |
| non-empty string | `src/sessionParser.ts:79` | `asNonEmptyString`, returns **untrimmed** |
| non-empty string | `src/settingsStore.ts:57` | inline, returns **trimmed** |
| non-empty string | `src/pathAdapter.ts:98` | inline, in a `.filter()` |

All three `isRecord` bodies are byte-identical
(`typeof v === "object" && v !== null && !Array.isArray(v)`). `sessionIndex`'s
comment already says "mirrors settingsStore.isRecord" — the drift is documented
in-tree and still unfixed. That copy arriving *after* the issue was filed is the
argument for doing the extraction now rather than deferring again.

### The non-empty-string predicate is shared; the value handling is NOT

This is the one real trap. The three sites agree on the *test*
(`typeof v === "string" && v.trim() !== ""`) but deliberately disagree on what
they return:

- `settingsStore.getClaudePath` returns the **trimmed** value — the string flows
  to `spawn` as the `file` argument, so surrounding whitespace from a
  hand-edited `settings.json` must not survive.
- `sessionParser.asNonEmptyString` returns the value **untrimmed** — it is
  session metadata rendered as-is.

So only the predicate is extracted. Each caller keeps its own value handling.
Collapsing them to one "return the trimmed string" helper would silently change
parser output; collapsing to "return raw" would reintroduce the spawn bug #58
fixed. Neither is done.

`asString` stays local to `sessionParser` — one copy, no rule-of-three case.

### Shape

New `src/typeGuards.ts` (pure, no imports, no I/O):

- `isRecord(v): v is Record<string, unknown>`
- `isNonEmptyString(v): v is string`

`isNonEmptyString` is a **type guard**, not a boolean helper, so
`raw.filter(isNonEmptyString)` narrows `(string | undefined)[]` to `string[]`
and `pathAdapter` drops its hand-written `(r): r is string =>` annotation.

### Equivalence being claimed (each rewrite is behavior-preserving)

| site | before | after |
| --- | --- | --- |
| `pathAdapter.tempRoots` | `raw.filter((r): r is string => typeof r === "string" && r.trim() !== "")` | `raw.filter(isNonEmptyString)` |
| `settingsStore.getClaudePath` | `const t = typeof v === "string" ? v.trim() : ""; return t !== "" ? t : DEFAULT` | `return isNonEmptyString(v) ? v.trim() : DEFAULT` |
| `sessionParser.asNonEmptyString` | `const s = asString(v); return s && s.trim() ? s : undefined` | `isNonEmptyString(v) ? v : undefined` |

The `s && s.trim()` → `v.trim() !== ""` step is the only non-obvious one. It
holds for every input: `""` is falsy at `s &&`; `"  "` passes `s &&` then fails
`s.trim()`. Both map to `false` under `isNonEmptyString`. Non-strings fail
`asString` before and `typeof` after.

## #114 — the two dead predicates

`isTempPath` and `isWorktreePath` have **zero production callers** (verified:
only their own definitions, their own tests, and a #49 plan-doc mention). Both
are deleted. The decision the issue asks for, per predicate:

**`isTempPath` → delete.** Superseded by design, not by accident: #113 moved the
§10 temp filter renderer-side. Main discovers the roots (`tempRoots`, which needs
`os`) and ships them over `paths:getTempRoots`; `sessionFilter.ts` does pure
prefix-matching in the renderer. `tempRoots` stays — it is a live IPC dependency.

**`isWorktreePath` → delete.** The issue offers "keep it and have #56/#91 build
on it". Rejected on two independent grounds:

1. **Its only plausible caller cannot import it.** The convention is re-encoded
   in `sessionTree.rollUpWorktrees`, and `sessionTree`'s header contract is "no
   DOM and no node runtime deps … so it is safe to import from the DOM-only
   renderer". `pathAdapter` imports `node:os`/`node:path`. Importing it into
   `sessionTree` would pull `os` into the renderer bundle and break that
   guarantee. `sessionFilter` already faced exactly this and chose to *mirror*
   `canon` as string-only rather than import it — the boundary is established
   precedent, not a new opinion.
2. **#56/#91 need a different function.** They want *generic* git-worktree
   detection, which requires reading the worktree's `.git` file (I/O).
   `isWorktreePath` is a pure `.claude/worktrees` path-convention matcher — the
   wrong shape for the work it is supposedly being saved for.

`sessionTree` keeps owning the convention as `CLAUDE_DIR`/`WORKTREES_DIR`
constants, where it is actually used.

### Knock-on deletions

`canon()` exists only for `isTempPath` → dead, deleted. `semantics()` returns
`{ P, fold }`; with both predicates gone `fold` has no consumer, so it collapses
to the path-module pick. `PathClassOpts` stays (`tempRoots` takes it).

`sessionFilter.ts:18` comments that it mirrors "pathAdapter's `canon`". Deleting
`canon` makes that a dangling reference — the comment is updated in the same
commit.

## Risk

Low, and the risk is *silent* rather than loud: every change is
behavior-preserving, so a mistake shows up as a wrong-but-green refactor rather
than a failure. Mitigations:

- The existing `sessionParser` / `settingsStore` / `sessionIndex` / `pathAdapter`
  suites are the regression net for the rewrites — they must pass **untouched**.
  Any test I find myself editing to accommodate the refactor is a behavior change
  I did not intend; that is the tripwire.
- Deleting `isTempPath`/`isWorktreePath` deletes their tests too. Mostly that is
  coverage *of code that no longer exists* — but not entirely. See below.

### Correction: the deletion would have silently stripped `tempRoots` of coverage

This plan originally asserted that root-discovery stayed covered by "`test/main/
pathAdapter.test.ts`'s `tempRoots` block". **There was no such block.** Checked
rather than assumed, and the real picture is worse than the claim:

- `tempRoots` had **no direct test at all**.
- Its entire per-OS matrix (`%TEMP%`/`%TMP%`/`%LOCALAPPDATA%\Temp`/
  `C:\Windows\Temp`; `$TMPDIR`//tmp//private/tmp//var/folders/…) was covered only
  **transitively**, through the `isTempPath` tests — because `isTempPath` called
  `tempRoots` internally.
- Every consumer test mocks it (`ipc.test.ts` and `FolderBrowser.test.tsx` both
  inject a `vi.fn()`), so none of them touch the real implementation.

So deleting the dead predicate would have taken the live function's only real
coverage with it, silently and greenly — `tempRoots` is what `main.ts` imports
and ships over `paths:getTempRoots`, and it *is* the §10 filter's input.

This PR therefore adds direct `tempRoots` tests for both OS matrices. That is not
scope creep; it is the cost of the deletion, and #114 explicitly says to keep
`tempRoots` — keeping it untested is not keeping it.

The blank/unset case is the load-bearing one and is now asserted directly: `""`
is a prefix of every path, so a single blank root would hide the entire tree.
Falsified — degrading the filter to `raw.filter(Boolean)` turns both blank-entry
tests red, which is exactly the regression the `isNonEmptyString` swap could have
introduced.

## Steps

1. `test/main/typeGuards.test.ts` — write first, verify red (module absent).
2. `src/typeGuards.ts` — implement, verify green.
3. Rewrite the four `isRecord` sites and the three string sites; suites stay green
   **without edits**.
4. Delete `isTempPath`, `isWorktreePath`, `canon`, their tests; simplify
   `semantics`; fix the `sessionFilter` comment.
5. Full gate: lint · typecheck (3 projects) · build · test.

## Out of scope

- #129 (settingsStore read-mutate-write helper) — also touches `settingsStore`,
  but it refactors the *write* path and deserves its own focused review. Next PR,
  rebased on this one.
- #130 / #131 (sessionIndex entry validation, ENOENT vs transient) — `isRecord`
  is the seam they will build on, so they follow this, not precede it.
