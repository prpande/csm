---
description: Pick up a GitHub issue and drive it to a PR that closes it
argument-hint: <issue number>
---

Work GitHub issue #$ARGUMENTS (repo `prpande/csm`) end-to-end, following
`docs/workflow/issue-driven-development.md`.

1. Read it: `gh issue view $ARGUMENTS --repo prpande/csm`. Confirm it isn't already
   assigned or labelled `in-progress` by someone else.
2. **Claim:** `gh issue edit $ARGUMENTS --repo prpande/csm --add-assignee @me --add-label in-progress`.
3. **Classify the sizing tier** (workflow §2) and produce its artifact before
   coding:
   - **Trivial** (hygiene/config, ≈≤3 files, no logic): no plan/spec.
   - **Standard** (logic / multiple files / new module): write a short plan in
     `docs/plans/` (what/why, approach, test list). For larger plans use
     `superpowers:writing-plans` or `compound-engineering:ce-plan`.
   - **High-risk** (`area:launcher`, session-file deletion, `priority:p1`, or any
     security-invariant change): write a spec in `docs/specs/`, run
     `compound-engineering:ce-doc-review`, apply what holds up. The maintainer also
     runs `/code-review ultra` on the PR before merge.
4. **Worktree + branch** off latest `main`:
   `git worktree add <path> -b $ARGUMENTS-<short-slug>` (never work in the launch
   checkout). Use the `EnterWorktree` tool if available.
5. **TDD:** failing test first, then implement, then refactor. Honour the security
   invariants in `CLAUDE.md` (argv-array spawning, `textContent` rendering,
   read-only on Claude session files).
6. Run pre-push checks (lint → build → test).
7. **Open the PR via the `pr-autopilot` skill (default).** It runs a `/simplify`
   pass, preflight self-review + spec/plan-alignment, opens the template PR (ensure
   `Closes #$ARGUMENTS` is in the body), then loops on reviewer-bot comments →
   CI gate. Use `pr-followup` for later comments. Manual `gh pr create` is a
   fallback only when `pr-autopilot` is unavailable.
8. Report the PR URL. Merging it will auto-close the issue and drop `in-progress`.
