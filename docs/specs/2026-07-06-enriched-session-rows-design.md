# Enriched session rows — design

- **Issue:** #115 (child of Epic #88; resolves the descriptor direction from #109)
- **Status:** Design — pending review
- **Date:** 2026-07-06
- **Phase:** Epic #88, slice 1 (extraction + row subtitles)

## 1. Context and goal

Today a session row shows a two-line summary: a title (a truncated first prompt in
practice — a 60-session sample had **0** `ai-title` and **0** `summary` records, so
100% fall through to the raw prompt, per #109) and a meta line
(`permission-chip · relative-time · short-id`). Telling sessions apart in a busy
folder is guesswork.

This slice adds a **third line of extracted facts to every row of the currently
listed folder**:

```
212 msgs · 3h 41m · 5 edited · Opus 4.8 · 1.2M tok
```

- `0 edited` renders as `read-only`.
- Facts load **windowed and lazily** (only the visible rows, most-recent-first),
  cached in-memory, and **refresh on an interval** so live (still-being-written)
  sessions stay current.

The facts must be computed without freezing the UI on a folder that holds
thousands of sessions, and without re-parsing on every scroll tick (which would
fight the virtualized list).

## 2. Non-goals (deferred — each tracked as a #88 child)

| Deferred | Issue |
|---|---|
| Persistent `userData` index + JSON-vs-SQLite engine decision | #116 |
| Full-text content search + facets | #117 |
| Reverse file→sessions lookup (`filesTouched[]` is seeded here) | #118 |
| Preview / peek pane (single-session deep view) | #119 |
| First-class live-session UX (live badge, live-tail, reopen semantics) | #120 |

This slice uses an **in-memory cache only**. Promoting it to a persistent index
is #116's job, made against measured behavior from this slice rather than guessed.

## 3. Architecture

Three units, each independently testable, matching the existing scan → list
separation:

```
sessionParser.extractSessionFacts   (pure; no fs/Electron)   <- new
        ▲ raw JSONL text
        │
main:  session:getFacts IPC + in-memory fact cache            <- new
        ▲ sessionId[]                    ▲ mtime/size re-stat
        │ (visible window)               │ (interval poll)
        │                                │
renderer: SessionRow third line + windowed request + poller   <- extend
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
  messageCount: number;        // real count of user+assistant message records
  firstActivity: string | null;
  lastActivity: string | null; // duration = last - first (both from record timestamps)
  editedFileCount: number;     // distinct paths mutated (0 -> row shows "read-only")
  firstModel: string | null;   // first real model id the session ran on (raw id)
  outputTokens: number;        // summed message.usage.output_tokens (cache-read excluded)
  filesTouched: string[];      // distinct read+write paths (seeds #118; not shown on the row)
}

export function extractSessionFacts(sessionId: string, content: string): SessionFacts;
```

Field-by-field extraction rules (validated against a real session — first model
`claude-opus-4-8`, 10 edited files, 351 431 output tokens):

- **messageCount** — count records whose `type` is `user` or `assistant`. (This is
  the true message count, distinct from the optional in-file `messageCount` field
  that `parseSession` opportunistically reads.)
- **firstActivity / lastActivity** — first and last record with a string
  `timestamp`. Duration is derived in the renderer from the pair; a single
  timestamp yields a zero/na duration, not an error.
- **firstModel** — the **first** assistant record with a *real* `message.model`
  string. Skip placeholder ids (`<synthetic>` and any value starting with `<`) and
  empty strings, so an injected/synthetic record can't win. Stored as the raw id;
  friendly-naming happens at render (§7). `null` when none present.
- **outputTokens** — sum of `message.usage.output_tokens` (integer) across records.
  `cache_read_input_tokens`, `cache_creation_input_tokens`, and `input_tokens` are
  **excluded** — output is the weight that reflects work produced.
- **editedFileCount** — size of the distinct set of file paths from **mutating**
  tool_use blocks: tool `name` in `{Write, Edit, MultiEdit, NotebookEdit}`, path
  from `input.file_path` (or `input.notebook_path` for `NotebookEdit`). A block
  with no path is ignored.
- **filesTouched** — distinct set over **all** tool_use blocks that carry a
  `file_path` / `notebook_path` (read tools included). Captured now to seed #118;
  the row does not display it. Kept as a sorted array for determinism.

**Error handling / fail-soft (spec §12):** malformed lines are skipped by the
shared `parseRecords`. Missing fields degrade to `0` / `null` / empty — a
junk file yields a well-formed `SessionFacts`, never a throw.

## 5. Unit 2 — delivery: `session:getFacts` IPC + fact cache (main)

**IPC — batch, window-shaped.** One handler:

```
session:getFacts(sessionIds: string[]) -> Record<sessionId, SessionFacts | { error: true }>
```

The renderer sends **only the visible window** of session ids (§6), not the whole
folder. Batch (not per-row) so one scroll settle is one IPC round-trip.

**Cache.** An in-memory `Map<sessionId, { key: string; facts: SessionFacts }>` in
main. The cache key is `` `${mtime}:${size}` `` for the session's `.jsonl`. On a
`getFacts` request, for each id: `stat` the file; if the key matches the cached
entry, return it; otherwise read + `extractSessionFacts` + store. A file that
grew (a live session) has a new size → new key → automatic re-parse. Files are
read **read-only**; the source `.jsonl` is never written/moved/deleted.

**Cost control.** The cache bounds repeated work to changed files only. Bounded
I/O concurrency inside the batch is a known follow-up (#45) and out of scope here;
the window is small (§6) so a naive sequential read is acceptable for this slice.
Path resolution reuses `sessionStore`'s existing `sessionId → file path` logic
(no new path derivation in the renderer).

## 6. Unit 3 — renderer: third line, windowing, refresh

**Row (`SessionRow`).** A third line below the existing meta line. It occupies a
**reserved fixed height** at all times: before facts arrive it renders a skeleton
bar; when facts arrive the text swaps in place. Because the height never changes,
lazy fill causes **no reflow** in the virtualized list. All values are inserted as
JSX text children (≡ `textContent`) — never `innerHTML` — since model ids and
counts are derived but the invariant is uniform.

**Windowed request.** The list already knows the visible range (it is virtualized)
and each row's `lastActivity` (from the light scan), so recency ordering is free.
On folder select and on scroll-settle, the renderer collects the session ids in
the visible range (plus a small overscan), drops those already cached client-side,
and issues one `session:getFacts` for the rest. Results fill a renderer-side
`Map<sessionId, SessionFacts>` that the rows read.

**Interval refresh (live sessions).** A single timer (~3–5 s) while a folder is
open re-issues `getFacts` for the **currently visible** ids only. Main re-stats
those files; unchanged mtime/size is a cache hit (no re-parse, cheap `stat`);
a grown file re-parses and returns fresh facts, which swap into the row in place.
The timer is scoped to the visible window — it never walks the whole folder.

**Sort stability.** Rows are **not** re-sorted while a folder is open (a live
session climbing to the top mid-read is jarring). Re-sort happens only on folder
re-entry. (First-class live reordering/badging is #120.)

## 7. Render formatting (renderer-side, pure helpers)

Extend `sessionRowView` with pure, unit-tested formatters:

- **Model friendly name.** Lookup table for known ids
  (`claude-opus-4-8`→`Opus 4.8`, `claude-sonnet-4-6`→`Sonnet 4.6`,
  `claude-haiku-4-5`→`Haiku 4.5`, `claude-fable-5`→`Fable 5`). Unknown id →
  strip a leading `claude-` and show the remainder, so a future model still renders
  legibly. `null` → the model segment is omitted.
- **Token humanization.** `>= 1e6` → one decimal + `M` (`1.2M`); `>= 1e3` →
  integer + `k` (`351k`); else the raw integer. Always suffixed ` tok`.
- **Duration.** From `firstActivity`..`lastActivity`: `>= 1h` → `Xh Ym`;
  `>= 1m` → `Ym`; else `<1m`. A missing/single timestamp → the duration segment is
  omitted rather than shown as `0m`.
- **Edited.** `editedFileCount === 0` → `read-only`; else `N edited`.
- **Messages.** `N msgs`.

Segments are joined by ` · `; any omitted segment (null model, na duration)
collapses cleanly without leaving a dangling separator.

## 8. Data flow (folder select → steady state)

1. User selects a folder → the light session list renders immediately (titles +
   meta), each row showing a skeleton third line.
2. The list reports its visible range → renderer sends `session:getFacts(idsInWindow)`.
3. Main returns facts (cache miss → parse; hit → cached) → rows swap skeleton→text.
4. User scrolls → new window → step 2 for the newly-visible, uncached ids.
5. Every ~3–5 s → renderer re-requests the visible ids → grown files refresh in
   place; unchanged ids are cheap stat-only hits.
6. User leaves the folder → timer stops; renderer-side fact map may be retained or
   dropped (retain for snappy re-entry; bounded by folder switches).

## 9. Security / invariants (CLAUDE.md)

- Source `.jsonl` files are read **read-only**; no writes, moves, or deletes. The
  fact cache lives only in main-process memory this slice (no `userData` yet).
- All row text via `textContent` / JSX text children; never `innerHTML`.
- Electron hardening unchanged: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`; the renderer reaches main only through the preload bridge, which
  gains the single `getFacts` method (narrow, id-array in / facts-map out).
- No new terminal launching, so the argv/AppleScript constraints are untouched.

## 10. Testing

**`extractSessionFacts` (fixtures, pure):**
- multi-model session → `firstModel` is the first *real* model; a leading
  `<synthetic>` assistant record is skipped.
- read-only session (no mutating tools) → `editedFileCount === 0`.
- edited-file dedup → same path edited N times counts once; `NotebookEdit` uses
  `notebook_path`.
- token summing → sums `output_tokens`; a record with only `cache_read_input_tokens`
  contributes 0.
- duration → first/last timestamp captured; single-timestamp and no-timestamp cases.
- malformed/junk file → well-formed all-fallback `SessionFacts`, no throw.
- `filesTouched` → distinct read+write paths, sorted.

**Cache (main, `test/main`):** key = `mtime:size`; unchanged file → no re-parse
(spy on the parser); grown file → re-parse; missing file → `{ error: true }` entry,
not a crash.

**Formatters (`sessionRowView`):** model map + unknown fallback; token buckets at
999 / 1 000 / 999 999 / 1 000 000; duration buckets; `0 edited` → `read-only`;
omitted segments leave no dangling ` · `.

**Row (renderer):** third line reserves height with a skeleton before facts; text
swaps in on arrival; values present as text nodes (no `innerHTML`).

## 11. Open questions (resolve during planning, not blocking)

- Overscan size for the window (rows fetched beyond the viewport) — start small
  (e.g. one screen), tune if scroll feels laggy.
- Whether to retain or drop the renderer-side fact map on folder switch — lean
  retain, revisit if memory grows on huge histories.
- Refresh interval exact value (3 vs 5 s) — pick during implementation; make it a
  single constant.
