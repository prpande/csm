# Issue-driven development

All work on CSM flows through **GitHub issues**. If it's worth doing, it's worth
an issue — features, bugs, refactors, tests, docs, CI. This keeps a single
visible backlog and a clean issue→branch→PR trail. (Adapted from the PRism
workflow, right-sized for a solo project — "medium" ceremony.)

## 1. Every work item is an issue

Before starting work, there is an issue for it. When you discover follow-up work
mid-task, **file a new issue** rather than expanding the current PR's scope or
leaving a TODO.

Create issues with the templates (`.github/ISSUE_TEMPLATE/`): **Bug**,
**Feature / enhancement**, **Task / chore**. Or use the `/new-issue` command.

Label every issue with:
- **Type** — `bug`, `enhancement`, `tech-debt`, `test`, or `documentation`.
- **Priority** — `priority:p1` (broken core / correctness), `priority:p2`
  (meaningful UX / medium), `priority:p3` (polish / lower impact).
- **Area** — `area:scanner`, `area:tree-ui`, `area:launcher`, `area:settings`,
  `area:packaging`, `area:ci` (add others as the app grows).
- **`needs-design`** if it requires a design pass before implementation.

## 2. Sizing: small vs needs-spec

Two tracks, pick by judgement (when unsure, escalate to needs-spec):

- **Small** (≈1–3 files, no real design choice): write a failing test, implement,
  open the PR. No spec.
- **Needs-spec** (multiple files, a design decision, new module, or a
  security-sensitive surface): write a short spec in `docs/specs/` first, run
  `compound-engineering:ce-doc-review` on it, apply what holds up, then implement.
  Larger efforts use `superpowers:writing-plans` → `docs/plans/`.

## 3. Picking up an issue

1. **Claim it:** self-assign and add the `in-progress` label. These two actions
   are the claim. Don't pick up an issue already assigned or labelled
   `in-progress` by someone else.
2. **Branch in an isolated worktree** (never work in the launch checkout):
   `git worktree add <path> -b <issue#>-<short-slug>` off the latest `main`.
3. **TDD:** write the test first (red), implement (green), refactor. Bug fixes
   start with a regression test that fails on `main`.
4. **Respect the security invariants** in `CLAUDE.md` — especially anything in
   `area:launcher` (terminal spawning) and session-file deletion (phase B).
   Security-sensitive changes get a human review before merge.

## 4. Opening the PR

- Use the PR template; fill the **Proof** checklist (acceptance criteria, tests,
  lint/build, secrets scan; screenshots for UI).
- The PR body **must** contain `Closes #<issue>` so merging auto-closes the issue.
- Run the pre-push checks (lint → build → test) — mirror CI. Optionally drive the
  reviewer/CI loop with `pr-autopilot`.

## 5. Closing the loop

Merging a PR with `Closes #N` closes the issue, and the
`unclaim-on-close.yml` Action removes the `in-progress` label automatically. No
manual cleanup needed.

## Commands

- `/new-issue <description>` — create a well-formed, labelled issue.
- `/work-issue <number>` — claim, branch, implement, and open a closing PR.
- `/groom-backlog` — list and triage open issues.
