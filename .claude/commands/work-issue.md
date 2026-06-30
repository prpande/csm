---
description: Pick up a GitHub issue and drive it to a PR that closes it
argument-hint: <issue number>
---

Work GitHub issue #$ARGUMENTS (repo `prpande/csm`) end-to-end, following
`docs/workflow/issue-driven-development.md`.

1. Read it: `gh issue view $ARGUMENTS --repo prpande/csm`. Confirm it isn't already
   assigned or labelled `in-progress` by someone else.
2. **Claim:** `gh issue edit $ARGUMENTS --repo prpande/csm --add-assignee @me --add-label in-progress`.
3. **Size it** (small vs needs-spec). If needs-spec: write a spec in `docs/specs/`,
   run `compound-engineering:ce-doc-review`, apply what holds up before coding.
4. **Worktree + branch** off latest `main`:
   `git worktree add <path> -b $ARGUMENTS-<short-slug>` (never work in the launch
   checkout). Use the `EnterWorktree` tool if available.
5. **TDD:** failing test first, then implement, then refactor. Honour the security
   invariants in `CLAUDE.md` (argv-array spawning, `textContent` rendering,
   read-only on Claude session files).
6. Run pre-push checks (lint → build → test).
7. Open the PR with the template, fill the **Proof** checklist, and include
   `Closes #$ARGUMENTS` in the body. Optionally use `pr-autopilot`.
8. Report the PR URL. Merging it will auto-close the issue and drop `in-progress`.
