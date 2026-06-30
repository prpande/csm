---
description: Turn a work item into a well-formed, labelled GitHub issue
argument-hint: <short description of the work>
---

Create a GitHub issue (repo `prpande/csm`) for the following work item:

$ARGUMENTS

Follow `docs/workflow/issue-driven-development.md`. Steps:

1. Decide the type (bug / feature / task) and draft a clear title and body using
   the matching template's fields (problem/repro, proposed solution or goal, and
   **checkable acceptance criteria** — always include these).
2. Choose labels: one **type** (`bug` / `enhancement` / `tech-debt` / `test` /
   `documentation`), one **priority** (`priority:p1|p2|p3`), and the relevant
   **`area:*`**. Add `needs-design` if it needs a design pass first.
3. Check for duplicates first: `gh issue list --repo prpande/csm --search "<keywords>"`.
4. Create it: `gh issue create --repo prpande/csm --title "..." --body "..." --label "...,..."`.
5. Report the new issue number and URL. Do **not** start implementing — that's
   `/work-issue`.
