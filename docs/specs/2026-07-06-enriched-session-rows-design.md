# Enriched session rows — design

- **Issue:** #115 (child of Epic #88; first concrete output of the #109 descriptor investigation)
- **Status:** Design — pending review (revised after multi-persona doc review, 2026-07-06)
- **Date:** 2026-07-06
- **Phase:** Epic #88, slice 1 (extraction + row subtitles)

## 1. Context and goal

A session row today shows two lines: a title and a meta line
(`permission-chip · relative-time · short-id`). The title is a fallback chain
(`ai-title → summary → truncated first prompt → "(untitled)"`). On a recent
100-session sample ~30% carried an `ai-title` and the rest fell through to the
raw first prompt, which is often a poor descriptor. So the title alone is a weak
basis for telling same-folder sessions apart.

This slice adds a **third line of scannable quantitative facts to every row of the
currently listed folder**:

```
42 msgs · span 3h 41m · 5 edited · Opus 4.8 · 1.2M tok
```

- `0 edited` renders as `read-only`.
- Facts load **windowed and lazily** — only the visible rows, most-recent-first —
  cached in-memory and refreshed on folder re-entry.

**What this slice is and is not.** These facts are *complementary metadata*
(size, recency, effort, model) that help a user distinguish and triage sessions.
They are **not** a topic/"what-was-it-about" descriptor — that remains the open
question of #109 and is not solved here. The slice must not be described as
resolving #109; it is the first, quantitative output of that investigation.

The facts must be computed without freezing the UI on a folder that holds
thousands of sessions, and without re-parsing on every scroll tick (which would
fight the virtualized list).

## 2. Non-goals (deferred — each tracked as a #88 child)

| Deferred | Issue |
|---|---|
| Persistent `userData` index + JSON-vs-SQLite engine decision | #116 |
| Full-text content search + facets | #117 |
| Reverse file→sessions lookup | #118 |
| Preview / peek pane (single-session deep view) | #119 |
| First-class live-session UX **and live/interval refresh** (badge, live-tail, reopen semantics) | #120 |

This slice uses an **in-memory cache only** and does **not** poll or live-refresh.
A topic descriptor (#109) and a persistent index (#116) are explicitly out of
scope; this slice proves the extraction and delivery shape so those decisions are
made against measured behavior rather than guessed.

## 3. Architecture

Three units, each independently testable, matching the existing scan → list
separation:

```
sessionParser.extractSessionFacts   (pure; no fs/Electron)   <- new
        ▲ raw JSONL text
        │
main:  session:getFacts IPC + in-memory fact cache            <- new
        ▲ sessionId[]  (validated; visible window)
        │  + sessionId→path map captured during scan
        │
renderer: SessionRow third line + windowed request            <- extend
```

The light path is untouched: `parseSession` / `SessionMetadata` and the resident
session list stay cheap. Facts are a **separate, heavier, on-demand** computation.

## 4. Unit 1 — `extractSessionFacts` (pure, `src/sessionParser.ts`)

A second entry point in the existing pure module, sharing `parseRecords` (the
record-walk, blank/malformed-line skipping) with `parseSession`. No `fs`,
`child_process`, or Electron — fixture-tested under Vitest.

```ts
export interface SessionFacts {
  sessionId: string;
  messageCount: number;        // genuine conversational turns (see below)
  firstActivity: string | null;
  lastActivity: string | null; // span = last - first (both from record timestamps)
  editedFileCount: number;     // distinct paths mutated (0 -> row shows "read-only")
  firstModel: string | null;   // model the session was launched on (raw id)
  distinctModelCount: number;  // number of distinct real models seen (for the "+N" indicator)
  outputTokens: number;        // summed message.usage.output_tokens (cache-read excluded)
}
```

Field-by-field extraction rules (validated against real sessions):

- **messageCount — genuine turns, not tool plumbing.** Count only records that are
  a visible conversational turn: (a) a `user` record with a real prompt — the same
  eligibility `eligiblePromptText` already applies (`type:"user"`, not `isMeta` /
  `isVisibleInTranscriptOnly`, content is a string or has a text block, not a
  wrapper prefix), and (b) an `assistant` record whose `message.content` contains
  at least one `text` block. `tool_result` user records and tool-use-only assistant
  records are **excluded**. Rationale: counting all `user`+`assistant` records
  inflates the number ~10× (a measured session: 424 records, ~42 real turns).
- **firstActivity / lastActivity** — first and last record with a string
  `timestamp`. The **span** (last − first) is derived at render; a single timestamp
  yields no span, not an error. Span is wall-clock across the file, which for a
  reopened session covers the idle gap — see §7 for how it is labelled/capped.
- **firstModel + distinctModelCount** — `firstModel` is the first assistant record
  with a *real* `message.model` string (skip `<synthetic>` and any `<`-prefixed or
  empty value). `distinctModelCount` is the count of distinct real model ids across
  the session. ~6.5% of sessions run on more than one model; the row labels
  `firstModel` as the launched-on model and appends `+N` when
  `distinctModelCount > 1` (§7), so a mid-session switch is not silently hidden.
- **outputTokens** — sum of `message.usage.output_tokens` (integer) across records.
  `cache_read_input_tokens`, `cache_creation_input_tokens`, and `input_tokens` are
  **excluded**. Note: this is cumulative across the whole file, including
  pre-compaction turns, so a long-lived compacted session can show a large total —
  that is the intended "work produced" meaning.
- **editedFileCount** — size of the distinct set of file paths from **mutating**
  tool_use blocks: tool `name` in `{Write, Edit, MultiEdit, NotebookEdit}`, path
  from `input.file_path` (or `input.notebook_path` for `NotebookEdit`). A block
  with no path is ignored. **Known limitation:** edits performed inside subagents
  live in separate `subagents/*.jsonl` (`isSidechain`) files and are not counted;
  slice-1 counts main-session edits only. Acceptable for a triage signal.

**Error handling / fail-soft (spec §12):** malformed lines are skipped by the
shared `parseRecords`. Missing fields degrade to `0` / `null` — a junk file yields
a well-formed `SessionFacts`, never a throw.

## 5. Unit 2 — delivery: `session:getFacts` IPC + fact cache (main)

**IPC — batch, window-shaped.** One handler:

```
session:getFacts(sessionIds: string[]) -> Record<sessionId, SessionFacts | { error: true }>
```

The renderer sends **only the visible window** of session ids (§6), not the whole
folder. Batch (not per-row) so one scroll settle is one IPC round-trip.

**Input validation.** The handler **rejects any id that is not a well-formed UUID**
(the same UUID validation used before terminal launch, per CLAUDE.md) — it returns
`{ error: true }` for that id and never passes it to path resolution. This closes
the path-traversal surface: a malformed/hostile id from the renderer cannot reach
the filesystem.

**Path resolution — the map does not exist yet and must be built.** `sessionStore`
currently discovers each file's path during a scan and discards it; there is **no**
`sessionId → path` lookup, and because files are grouped on disk by *encoded* cwd
while the app groups by the *authoritative in-file* cwd, the path is **not**
derivable from a session's `cwd`. Therefore: `sessionStore` captures a
`sessionId → absolute path` map during its scan (it already computes both in
`readMetadata`), retains it for the scanned corpus, and exposes it to the main-side
fact handler. `SessionMetadata` must **not** be assumed to carry the path.

**Cache.** An in-memory `Map<sessionId, { key: string; facts: SessionFacts }>` in
main, storing **successful entries only**. The cache key is `` `${mtime}:${size}` ``
for the session's `.jsonl`. On a `getFacts` request, for each validated id: `stat`
the file; on a key match return the cached facts; otherwise read +
`extractSessionFacts` + store. A read/stat failure returns `{ error: true }` for
that id **without caching it**, so a transient failure retries on the next request.
Freshness assumes source files are **append-only** (size strictly grows on change);
an in-place rewrite to an identical size within the same mtime tick is out of scope
(does not occur for Claude's JSONL). Files are read **read-only**; the source
`.jsonl` is never written, moved, or deleted.

**Cost control.** The cache bounds repeated work to changed files only. Bounded
I/O concurrency inside the batch is a known follow-up (#45); the window is small
(§6) so a naive sequential read is acceptable for this slice.

## 6. Unit 3 — renderer: third line + windowing

**Row (`SessionRow`).** A third line below the existing meta line, occupying a
**reserved fixed height** at all times: before facts arrive it renders a skeleton
bar; when facts arrive the text swaps in place. Height never changes, so lazy fill
causes **no reflow** in the virtualized list. All values are inserted as JSX text
children (≡ `textContent`), never `innerHTML`.

**Row height + virtualizer constant.** The third line increases row height. The
single `ROW_HEIGHT` constant in `src/sessionListWindow.ts` (currently 56) drives
`computeWindow`, the list spacer height, and each row's `translateY` — it must be
increased (target ~76 px, final value matched to the rendered line-height) in the
**same change**, or the virtualization math breaks.

**UX states (the third line):**

- **Skeleton:** a single rounded bar at ~60% of the text-column width, height ~0.65em
  (the facts line's cap-height), coloured by a new `--skeleton-bg` token defined for
  both themes in `global.css` (component CSS modules hold zero hardcoded hex —
  enforced by `test/main/designTokens.test.ts`). The container carries
  `aria-busy="true"` while the skeleton shows.
- **Loaded:** facts text in `--text-muted` (same as the meta line). The container
  carries an `aria-label` summarising the facts (e.g. "42 messages, span 3 hours
  41 minutes, 5 files edited, Opus 4.8, 1.2M tokens").
- **Error (`{ error: true }`):** collapse to a muted em-dash `—` (not a permanent
  skeleton), so the row is visibly settled with no data.
- **Overflow:** the facts line is `white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis` (matching `.title`), so a narrow window truncates the
  tail rather than wrapping (which would break the reserved height). The
  unknown-model formatter output is capped (§7).
- **Transition:** skeleton→text is a short opacity fade (~0.15s ease), suppressed to
  an instant swap under `prefers-reduced-motion: reduce` (matching the existing
  `.open` transition pattern). No `aria-live` — the facts are supplementary and
  arrive once, so they are not announced on load.

**Windowed request.** The list is virtualized and already knows its visible range
(`computeWindow` → start/end index in `SessionList`) and each row's `lastActivity`
(from the light scan), so recency ordering is free. On folder select and on
scroll-settle, the renderer collects the session ids in the visible range (plus a
small overscan), drops those already cached client-side, and issues one
`session:getFacts` for the rest into a renderer-side `Map<sessionId, SessionFacts>`
the rows read. The renderer-side map is **dropped on folder switch** (the main
cache makes re-entry cheap — unchanged files are stat-only hits), so it cannot grow
unbounded across a browsing session.

**Freshness / re-entry.** There is no live polling in this slice. On folder
re-entry the window is re-requested; main re-stats the files and re-parses only
those whose `mtime:size` changed. Live in-view refresh, off-screen live surfacing,
and re-sort-on-activity are deferred wholesale to #120.

## 7. Render formatting (renderer-side, pure helpers)

Extend `sessionRowView` with pure, unit-tested formatters:

- **Model.** Friendly-name lookup for known ids (`claude-opus-4-8`→`Opus 4.8`,
  `claude-sonnet-4-6`→`Sonnet 4.6`, `claude-haiku-4-5`→`Haiku 4.5`,
  `claude-fable-5`→`Fable 5`). Unknown id → strip a leading `claude-`, then cap to
  ~20 chars with an ellipsis. `firstModel === null` → the segment is omitted. When
  `distinctModelCount > 1`, append ` +N` (N = `distinctModelCount − 1`), e.g.
  `Opus 4.8 +1`.
- **Tokens.** `>= 1e6` → one decimal + `M` (`1.2M`); `>= 1e3` → integer + `k`
  (`351k`); else the raw integer. Suffixed ` tok`.
- **Span.** From `firstActivity`..`lastActivity`, prefixed `span `: `>= 1h` →
  `span Xh Ym`; `>= 1m` → `span Ym`; else `span <1m`. **Capped:** a span `>= 24h`
  renders `span >24h` (so a reopened-across-days session is not read as effort). A
  missing/single timestamp → the segment is omitted.
- **Edited.** `editedFileCount === 0` → `read-only`; else `N edited`.
- **Messages.** `N msgs`.

Segments are joined by ` · `; any omitted segment (null model, na span) collapses
without leaving a dangling separator.

## 8. Data flow (folder select → steady state)

1. User selects a folder → the light session list renders immediately (titles +
   meta), each row showing a skeleton third line.
2. The list reports its visible range → renderer sends `session:getFacts(idsInWindow)`
   (ids UUID-validated in the handler).
3. Main returns facts (cache miss → parse; hit → cached; bad/unreadable →
   `{ error: true }`) → rows swap skeleton→text (or → em-dash on error).
4. User scrolls → new window → step 2 for the newly-visible, uncached ids.
5. User leaves the folder → renderer-side fact map is dropped. On re-entry, the
   window is re-requested; main re-stats and re-parses only changed files.

## 9. Security / invariants (CLAUDE.md)

- The `getFacts` handler UUID-validates every id before any path resolution;
  non-UUID ids get `{ error: true }` and never touch the filesystem.
- Source `.jsonl` files are read **read-only** (stat + read, no lock/write); no
  writes, moves, or deletes. The fact cache lives only in main-process memory
  (no `userData` this slice).
- All row text via `textContent` / JSX text children; never `innerHTML`.
- Electron hardening unchanged: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`; the renderer reaches main only through the preload bridge, which
  gains the single `getFacts` method (narrow, id-array in / facts-map out).
- No new terminal launching, so the argv/AppleScript constraints are untouched.

## 10. Testing

**`extractSessionFacts` (fixtures, pure):**
- messageCount counts genuine turns only — a session with N `tool_result` user
  records and M tool-use-only assistant records counts neither; real prompts and
  assistant text replies do count.
- multi-model session → `firstModel` is the first *real* model (leading
  `<synthetic>` skipped); `distinctModelCount` reflects the real count.
- read-only session (no mutating tools) → `editedFileCount === 0`.
- edited-file dedup → same path edited N times counts once; `NotebookEdit` uses
  `notebook_path`.
- token summing → sums `output_tokens`; a record with only `cache_read_input_tokens`
  contributes 0.
- span → first/last timestamp captured; single-timestamp and no-timestamp cases.
- malformed/junk file → well-formed all-fallback `SessionFacts`, no throw.

**Cache + handler (main, `test/main`):** key = `mtime:size`; unchanged file → no
re-parse (spy on the parser); grown file → re-parse; unreadable file → `{ error:
true }` **not cached** (a second call re-attempts); a non-UUID id → `{ error: true }`
and the parser/path-resolver is never invoked.

**Formatters (`sessionRowView`):** model map + unknown-id strip-and-cap; `+N` when
`distinctModelCount > 1`; token buckets at 999 / 1 000 / 999 999 / 1 000 000; span
buckets incl. the `>= 24h` cap; `0 edited` → `read-only`; omitted segments leave no
dangling ` · `.

**Row (renderer):** third line reserves height with a skeleton (`aria-busy`) before
facts; text swaps in on arrival with an `aria-label`; `{ error: true }` → em-dash,
not a permanent skeleton; values present as text nodes (no `innerHTML`).

## 11. Open questions (resolve during planning, not blocking)

- Overscan size for the window (rows fetched beyond the viewport) — start small
  (e.g. one screen), tune if scroll feels laggy.
- Exact new `ROW_HEIGHT` value — set to match the rendered three-line height;
  ~76 px is the starting target.
