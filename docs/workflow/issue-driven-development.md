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

## 2. Sizing gate (enforced, not optional)

Classify every issue into one tier **before** coding and follow that tier's
track. When unsure between two tiers, pick the heavier one. The point of the gate
is that the plan/spec and review steps don't get silently skipped — only the
genuinely trivial tier is exempt.

- **Trivial** — hygiene / config, ≈≤3 files, no logic or design choice
  (e.g. `.gitattributes`, a doc tweak). Implement → open the PR (§4). **No
  plan/spec.**
- **Standard** — real logic, multiple files, or a new module
  (most feature work). Write a **short plan in `docs/plans/`** first (what/why,
  the approach, the test list), then TDD → open the PR (§4). Use
  `superpowers:writing-plans` (or `compound-engineering:ce-plan`) for larger ones.
- **High-risk** — `area:launcher` (terminal spawning), session-file deletion,
  anything `priority:p1`, or any change touching the security invariants in
  `CLAUDE.md`. Write a **spec in `docs/specs/`**, run
  `compound-engineering:ce-doc-review` on it and apply what holds up, then
  TDD → open the PR (§4). The maintainer should also run `/code-review ultra` on
  the PR before merge.

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

## 4. Opening the PR — via pr-autopilot (default)

Open and drive the PR with the **`pr-autopilot`** skill — this is the default, not
an optional extra. It runs the quality + review steps so they don't get skipped:

1. a `/simplify` quality pass over the diff,
2. preflight **self-review** and **spec/plan-alignment** check (against the
   `docs/plans/` or `docs/specs/` artifact from §2, when the tier required one),
3. opens the PR from the template with `Closes #<issue>` in the body,
4. loops on **reviewer-bot** comments, running build + test before each push,
   until quiescent → final CI gate.

**Trigger the Claude review manually.** The Claude bot is the mention-responder
only — there is **no** automatic on-open review (the auto-review was unreliable).
After the PR is open, post a comment containing **`@claude review`** to kick off
the review. With `pr-autopilot`, post that comment **right after it opens the PR**,
so the bot's review lands inside the loop's wait window (otherwise the loop goes
quiescent before any review appears). Use `pr-followup` to fold in review comments
that arrive later.

> Beware: **any `@claude` substring re-triggers the bot** — even "thanks @claude".
> Say "claude[bot]" when referring to it in dispositions unless you want a
> re-review.

Before invoking pr-autopilot, make sure local pre-push checks pass
(lint → build → test) and the **Proof** checklist in the PR template
(`.github/pull_request_template.md`) is fillable (acceptance criteria, tests,
lint/build, secrets scan; screenshots for UI).

Manual `gh pr create` is a fallback only when `pr-autopilot` is unavailable; if you
fall back, still fill the template, include `Closes #<issue>`, and run the pre-push
checks by hand.

## 5. Closing the loop

Merging a PR with `Closes #N` closes the issue, and the
`unclaim-on-close.yml` Action removes the `in-progress` label automatically. No
manual cleanup needed.

## Commands

- `/new-issue <description>` — create a well-formed, labelled issue.
- `/work-issue <number>` — claim, branch, implement, and open a closing PR.
- `/groom-backlog` — list and triage open issues.
