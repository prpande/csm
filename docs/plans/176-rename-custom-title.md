# Plan — #176 Renamed sessions show the custom name, not the first prompt

**Tier:** Standard (a change to the pure title-derivation in `sessionParser`, plus
an index-schema bump to invalidate stale cached titles). Touches
`src/sessionParser.ts`, `src/sessionIndex.ts`, `test/sessionParser.test.ts`,
`test/main/sessionIndex.test.ts`, and the authoritative design spec (§4.1 title
row + a decision note).

**Doc scope decision.** The `customTitle`-is-Phase-C deferral is recorded in
`docs/plans/42-session-parser.md:107`. That plan is a historical record of what
the #42 slice shipped, and #42 genuinely did not ship custom-title handling —
rewriting it would falsify the record. So the historical plan is left intact and
the *living* design (the spec) is updated instead; this plan supersedes the
deferral.

## Goal

Running `/rename my-label` in a Claude Code session writes a
`{"type":"custom-title","customTitle":"my-label"}` record to the session's JSONL.
CSM's `extractTitle` never reads it — the chain is
`ai-title → summary → first eligible user prompt → "(untitled)"` — so the row keeps
showing a content-derived descriptor (in practice, almost always the raw first
prompt) and the name the user deliberately chose is the one label CSM ignores.
`customTitle` was a deliberate Phase-C deferral
(`docs/plans/42-session-parser.md:107`). This closes it.

## Approach

### Composite title, derived in the pure parser

The custom name **leads**; the existing descriptor becomes a suffix:

```
title = name && descriptor  ? `${name} — ${descriptor}`
      : name ?? descriptor ?? "(untitled)"
```

where `name` is the last non-blank `custom-title.customTitle` and `descriptor` is
the current chain (`ai-title → summary → first eligible prompt`, unchanged).

**Why composite, not "name replaces descriptor".** On a real 3,251-file corpus,
of the 52 sessions carrying a custom title, **23 (44%) share that name with
another session in the same folder** (`bff migration` ×4, `issue filer` ×4, `csm`
×3, …). Names are used as topic tags, not unique keys. If the name simply replaced
the descriptor, ~44% of named rows would become title-identical within their
folder — trading "wrong title" for "four rows all called `bff migration`". Keeping
the descriptor as a suffix preserves the signal that tells same-named sessions
apart.

**Why not name-as-title with the descriptor on a second line (approach B).** That
is the better *eventual* answer, but it edits the row layout that #122 is already
scheduled to redesign (model-first metadata line). Fusing into the existing single
`title` string costs nothing in layout and doesn't collide with that work. The
accepted price: the row can't style name-vs-descriptor differently without later
plumbing a separate `customTitle` field through the index and IPC. When #122 or
#109 wants that, it's an additive field, not a rework.

### `custom-title` is read last-wins; the other tiers stay first-wins

Renames repeat within a session. One corpus session carries **47** `custom-title`
records spanning two distinct names (`#600` then `#634`); the name the session
**ended** on is the one the user means, exactly as `extractPermissionMode` already
takes the last mode. So `custom-title` needs a last-wins read.

`ai-title` and `summary` keep the existing first-wins `firstFieldValue`: across 96
corpus files that carry an `ai-title`, **none has more than one distinct value** —
they don't change in-session, so first vs last is moot and there's no reason to
touch that path.

### The budget applies to the whole composite, name-first

`TITLE_MAX_LENGTH` (120) stays the ceiling for the **rendered** title, still
measured in code points (so an emoji straddling the limit is kept or dropped as a
unit, unchanged). Because the name leads, it survives truncation and the
descriptor absorbs the cut. Three edges, each handled explicitly rather than
falling out of a naive concat:

- **Name alone leaves no room for even one descriptor char** → emit the truncated
  name only, with no dangling ` — `.
- **Name, no descriptor** → the name alone (never `bg migration — (untitled)`).
- **Whitespace-only rename** → ignored (`isNonEmptyString` trims), falls through to
  the descriptor as if no rename happened.

The separator is ` — ` (space–em-dash–space). The metadata line already uses `·`;
reusing it here would blur the title against the metadata beneath it.

### Index schema bump is required, not cosmetic

`readMetadata` (`sessionStore.ts:207`) serves an entry straight from the
`session-index.json` cache whenever `mtime` **and** `size` match. A *closed*
session's file never changes again, so its cached `title` is frozen. Without
invalidation, every session the user has **already** renamed would keep its stale
title forever and the fix would look like it did nothing on exactly the sessions
that motivated it.

Bump `INDEX_SCHEMA_VERSION` 1 → 2. The load path already discards-and-rebuilds on
a version mismatch (`sessionIndex.ts:81`, "rebuild, not migrate"), so this needs no
migration code. Cost is one cold-start-equivalent rescan on first launch after the
update; the scan is tiered newest-first and streams batches, so the list fills
progressively rather than blocking. This is the mechanism #124/#116 already rely on
for any parser-output change, not a new risk.

### Renderer / IPC unchanged

The composite is a plain string in the existing `SessionMetadata.title` /
`IndexEntry.title` field. `sessionRowView` already inserts it via `textContent`,
so the CLAUDE.md "render as text, never innerHTML" invariant holds with no change,
and no wire shape changes.

## Test list

**`test/sessionParser.test.ts`** (pure, fixture-driven)

- custom-title + ai-title → `"<name> — <aiTitle>"`.
- custom-title + no descriptor of any tier → name alone, no trailing separator.
- custom-title + first-prompt descriptor (no ai-title/summary) →
  `"<name> — <prompt>"`.
- **two renames** (`custom-title: "old"` then `"new"`) → composite uses `"new"`
  (last-wins). Fixture must contain both, or it passes for the wrong reason.
- whitespace-only `customTitle` → ignored; title equals the descriptor alone.
- composite over-budget: long name + long descriptor → result is ≤ 120 code points
  + ellipsis, name fully present, descriptor truncated.
- name so long it alone exceeds the budget → truncated name, **no** ` — ` suffix.
- no custom-title at all → every existing chain assertion still holds (regression
  guard: ai-title-wins, summary-fallback, first-prompt-truncation, `(untitled)`).
- code-point truncation of the composite keeps a straddling emoji whole (mirror of
  the existing tier-3 emoji test, applied to the composite path).

**`test/main/sessionIndex.test.ts`**

- a `session-index.json` written at `schemaVersion: 1` loads empty under version 2
  (discard-and-rebuild). If an existing test already pins the version-mismatch
  behaviour, update its literal rather than adding a duplicate.

## Out of scope

- **Styling name vs descriptor differently / a two-line row** — approach B, owned
  by the #122 row redesign; would need a separate `customTitle` field through the
  index and IPC.
- **Smarter descriptor selection** (skip slash-commands / pastes, pick the first
  substantive sentence) — that is #109's investigation, orthogonal to reading the
  name; this change improves the descriptor for *every* session the day #109 lands,
  named or not.
- **`agent-name` records.** They mirror `customTitle` but appear later in the file
  and carry no information the `custom-title` tier doesn't already give; reading
  them would be a redundant second source with its own precedence question.
