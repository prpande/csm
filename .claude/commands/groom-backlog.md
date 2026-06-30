---
description: List and triage open GitHub issues
---

Triage the open issues for `prpande/csm`.

1. List them: `gh issue list --repo prpande/csm --state open --limit 100 --json number,title,labels,assignees,createdAt`.
2. Flag issues missing a **type**, **priority**, or **area** label, and any that
   look like duplicates or are stale/ambiguous.
3. Suggest a prioritised order (group by `priority:p1|p2|p3`, then by roadmap phase
   A → B → C).
4. Propose concrete label fixes as ready-to-run `gh issue edit` commands, but
   **don't apply them without confirmation**.
5. Output a short summary: counts by priority/area, top suggested next issues, and
   any that need design (`needs-design`).
