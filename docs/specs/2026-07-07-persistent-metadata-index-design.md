# Persistent Session-Metadata Index — Design Spec

- **Issue:** [#116](https://github.com/prpande/csm/issues/116) — Persistent
  session-metadata index in `userData` (rebuildable cache) + engine decision.
- **Epic:** [#88](https://github.com/prpande/csm/issues/88) — unified session
  metadata index. This is the keystone first child.
- **Depends on:** the enriched-rows slice (#115, merged `1a251e9`) for the
  extraction shape (`extractSessionFacts`) and the windowed lazy fetch it reads
  from.
- **Status:** design — pending `ce-doc-review`, then implementation plan.

## 1. Goal

Promote CSM's per-session cache from an in-memory Map (lost on every restart)
into a **persistent, rebuildable JSON index in Electron `userData`**, built
incrementally during the existing tiered scan. The index is the substrate the
rest of Epic #88 reads from, and its immediate payoff is that **a restart
re-reads only files that changed since last run** instead of re-parsing the
whole ~1.7 GB corpus.

The index is always a **rebuildable cache over strictly read-only source
files** — never authoritative, never synced off-machine.

## 2. Context and measured ground truth

The engine decision was made against the real corpus, not guessed. Measured on
the author's machine (2026-07-07):

| Metric | Value |
| --- | --- |
| Project dirs | 148 |
| Session files | 2,715 |
| Total JSONL | 1.7 GB |
| Median file | 194 KB |
| p95 file | 1.7 MB |
| Largest file | 60.5 MB |
| `stat` every file | ~100 ms |

The decisive observation: the **compact index** (a handful of small fields per
session × 2,715 rows) is **under ~2 MB** — trivial. The 1.7 GB lives in
conversation *content*, which this index does not store. Content-scale problems
(full-text search) belong to a different feature (#117) and a different engine
decision.

## 3. Engine decision: flat JSON

**Chosen: a single flat JSON file.** Rationale:

- The index is ~2 MB. JSON loads in milliseconds and rewrites atomically for
  effectively zero cost at this size.
- **Zero native dependencies.** `better-sqlite3` is a native module needing
  per-platform / per-Electron-version rebuilds — a direct threat to this repo's
  3-OS CI and `electron-builder` packaging, which has repeatedly been burned by
  native-module friction (preload bundling, cross-OS `npm ci`). The built-in
  `node:sqlite` avoids the native dep but is experimental and Electron-Node
  version gated.
- SQLite earns its cost only for **full-text search over content** (FTS5/BM25).
  That is #117's problem, and #117 makes its own engine call there. A JSON
  facts index **forecloses nothing**: search indexes the read-only source
  content independently, in whatever engine wins the #117 spike.

### Rejected alternatives

- **SQLite / SQLite FTS now** — over-engineered for a 2 MB metadata index;
  imports the native-dependency and packaging risk one feature too early.
- **Local vector DB / semantic index** — requires embeddings. Remote embeddings
  send private conversation content off-machine (violates §8). Local embeddings
  mean shipping a model + native inference runtime and CPU-embedding 1.7 GB on
  first run (minutes-to-hours) — heavier than SQLite for a feature (#117) we
  have not scoped. Vectors are also *worse* than lexical for the dominant
  session-recall query (exact identifiers, filenames, error strings). Deferred
  wholesale to #117, and even there only as an optional, fully-local later layer.

## 4. Scope

### In scope

- A persistent JSON index in `userData`, `schemaVersion`-tagged.
- Eager **metadata** persistence during the scan, keyed by `mtime:size` →
  restart-incremental.
- **Facts** served by the existing windowed lazy pull (#115), now backed by the
  index and persisted on compute.
- A **cooperative idle backfill** that fills facts for un-browsed sessions after
  the initial scan, driving the index to completeness without blocking the UI.
- A **global privacy opt-out** (`indexEnabled` setting).

### Explicitly out of scope (with rationale)

- **Full-text search / FTS / vectors** → #117 (separate engine decision).
- **`filesTouched[]` / `toolsUsed[]`** → #118. These were dropped from #115 on
  purpose (the "#114 dead-code precedent": do not persist a large field with no
  reader). #118 extends both the extractor and the schema when reverse-lookup
  actually consumes them.
- **AI-generated summaries** → resolved by #109 as a *derived-heuristic*
  descriptor, not an LLM call. CSM never invokes a model (privacy, cost,
  offline). The `title` field already reads Claude's own `ai-title`/`summary`
  records verbatim when present.
- **Encryption at rest** → rejected by decision, not omission (see §8).
- **Per-path index exclusion** → deferred; the global switch covers the real
  need (see §8).
- **`worker_thread` / `utilityProcess` offload** → deferred behind a seam; built
  only if big-file parse blips prove to jank the UI in practice (see §7.4).
- **Reactive main→renderer push channel** → not built. The renderer already
  *pulls* the visible window and self-heals on a miss, so a push stream would
  add a new event channel, throttling, and reactive-merge edge cases for a UX
  identical to what pull already delivers (see §7.3).

## 5. Data model

One file, `session-index.json`, in `app.getPath('userData')`:

```jsonc
{
  "schemaVersion": 1,
  "entries": {
    "<sessionId>": {
      // Freshness key — identity of the source-file version this entry derives
      // from. Guards the whole entry: a mismatch invalidates metadata AND facts.
      "mtime": 1720000000000,   // ms
      "size": 198734,           // bytes

      // Metadata tier (list/tree) — eager, always present once scanned.
      // Union of SessionMetadata minus the sessionId (that is the map key).
      "cwd": "/home/u/project",
      "title": "Fix the span formatter",
      "permissionMode": "default",
      "lastActivity": "2026-07-06T18:41:00Z",   // null → filled from mtime in store
      "version": "1.0.83",                        // optional; absent if unknown

      // Facts tier (enriched row) — lazy. ABSENT until computed by a lazy pull
      // or the backfill. Presence of `facts` == "this session's facts are warm".
      "facts": {
        "messageCount": 42,                       // genuine turns (#115 semantics)
        "firstActivity": "2026-07-06T15:00:00Z",
        "editedFileCount": 5,
        "firstModel": "claude-opus-4-8",
        "distinctModelCount": 1,
        "outputTokens": 12000
      }
    }
  }
}
```

**Field reconciliation.** `SessionMetadata` and `SessionFacts` overlap on
`sessionId` (→ the map key) and `lastActivity` (→ stored once at entry level).
`messageCount` differs semantically between the two shapes (`SessionMetadata`
carries an optional raw count; `SessionFacts` carries the genuine-turn count) —
the entry stores **only the genuine-turn count**, inside `facts`. The list/tree
row does not need a separate count.

**Tiering by build strategy is the point of the shape.** The eager metadata
tier lives at the entry top level; the lazy facts tier is a nested optional
`facts` object. "Backfill" == "find entries whose `facts` is absent and compute
it." This models *metadata-eager, facts-lazy-persisted* directly in the schema.

## 6. Versioning: rebuild, not migrate

The index is a cache over authoritative source, so there is no precious data to
migrate. On load:

- `schemaVersion` !== current → **discard the file, treat as empty.** The next
  scan repopulates metadata; facts refill lazily + via backfill.
- Corrupt / unparseable / absent / non-object file → **empty** (fail-soft,
  mirroring `settingsStore`'s `{}`-on-garbage behavior). Never throws to the
  caller.

Consequences:

- A schema bump (e.g. #118 adds `filesTouched[]`) is a one-line constant change
  plus the extractor change; no migration code is ever written.
- **Deleting `session-index.json` by hand is a supported "force full rebuild."**

## 7. Build and update model

### 7.1 Startup

`sessionIndex.load()` reads the file once into an in-memory map (or empty per
§6). That map is the single working cache; it **replaces** the two ad-hoc
in-memory Maps in `sessionStore` today (`cache` for metadata, `factCache` for
facts).

### 7.2 Metadata — eager during scan

The tiered scan already `stat`s and reads+parses every file to build the
folder grouping, so metadata is *already* computed for every file on every
scan. The change is only that it is now cached persistently:

- For each file, compute `key = mtime:size`.
- **Hit** (entry exists and `key` matches): reuse the persisted metadata — no
  read, no parse.
- **Miss**: read + `parseSession`, write the metadata tier of the entry, mark
  dirty. A mismatched `key` also drops any stale `facts` on that entry.
- Flush once at scan end (§7.5).

First run reads all 1.7 GB (same as today). **Every subsequent launch reads
only changed files** — the headline win.

### 7.3 Facts — lazy pull, now persisted

The renderer keeps #115's windowed lazy fetch (`useSessionFacts` →
`session:getFacts` IPC) unchanged. Only the main-side handler changes:

- Entry has `facts` and `key` matches → return it (in-memory, instant).
- Otherwise → read that one file, `extractSessionFacts`, write `entry.facts`,
  mark dirty (debounced flush), return.

Opening a folder with thousands of sessions still only ever computes facts for
the ~20 visible rows; the rest fill in as the user scrolls, and every computed
fact survives restart.

**No push channel.** A visible cache-miss row is already in-flight via the pull
and paints when it resolves; a row scrolled-to after the backfill warmed it
hits warm cache on its pull. Pull self-heals, so main→renderer push is not
built.

### 7.4 Cooperative idle backfill (in scope for #116)

After the initial scan and first paint, `sessionStore.startBackfill()` runs a
**cooperative loop on the main event loop**: for each entry lacking `facts`,
compute + persist, then `await`/yield to the loop before the next. This drives
the index to completeness (facts for every session, not just browsed ones)
without a worker thread and without blocking IPC.

- **De-dup with the lazy pull:** an in-flight `Set<sessionId>` guards both the
  backfill and `getFacts` so a session is never computed twice concurrently.
- **Cancelable:** the loop stops on `before-quit` and on index-disable.
- **`worker_thread` seam:** the only thing that would force a real second thread
  is the ~24 files >10 MB (up to 60 MB) causing a per-file parse blip on the
  main loop. If that jank is observed, the *parse* alone is offloaded to a
  worker behind the same seam — not built speculatively.

Completeness matters for faceting and for #118/#119; it does **not** gate #117
(search indexes source content, not these compact facts).

### 7.5 Write model — single atomic file, debounced

- **Atomic:** write `session-index.json.tmp`, then rename over the target, so a
  crash or a concurrent read never sees a half-written file.
- **Debounced:** coalesce dirty state and flush on a short debounce, plus forced
  flushes at scan end, on folder switch, and on `before-quit`. This bounds
  write amplification from per-scroll fact persistence to a handful of ~2 MB
  writes rather than one per row.

### 7.6 Disabled mode (no separate code path)

When `indexEnabled` is `false`, `sessionIndex` operates **in-memory only**:
`load()` returns empty, `flush()` is a no-op. `sessionStore` uses the exact same
code path; behavior degrades precisely to today's ephemeral cache (rebuilt each
launch, facts lazy and non-persistent) with no forked logic.

## 8. Privacy

- **Content exposure is narrow.** The only conversation-derived fields are
  `title` (possibly a truncated user prompt) and `cwd` (a path). No message
  bodies, no tool output. The index is *less* sensitive than the source.
- **Same protection as the source.** The index lives in `userData`,
  OS-user-scoped — the same protection the source `.jsonl` files already have,
  sitting in plaintext in the same profile.
- **Never off-machine — structurally.** CSM has no network code; "never synced"
  is an architectural property. Requirement: the index file must never be added
  to any sync/telemetry/upload path.
- **No encryption at rest — by decision.** Encrypting a derived, less-sensitive
  index while its plaintext source sits in the same directory is security
  theater: it adds key management and changes real exposure by zero. Recorded as
  a rejected option so it is a decision, not an omission.
- **Global opt-out:** `indexEnabled` (default `true`) in `settingsStore`. Off →
  disabled mode (§7.6). This is the coarsest, most defensible "don't index X"
  control and satisfies the AC.
- **Per-path exclusion** (exclude specific project folders) — deferred as a
  possible later refinement; YAGNI until requested. The global switch covers the
  actual privacy need today.

## 9. Module boundaries

Small units, pure core untouched.

- **`src/sessionIndex.ts` (new)** — persistence layer over the JSON file.
  Injectable `dir` (like `settingsStore`) so it is testable against a temp dir
  with no Electron runtime. Owns: `load()` → in-memory map; `get(id)`;
  `upsert(id, entry)`; `flush()` (atomic temp-write + rename, debounced); and
  the `schemaVersion` / corruption → empty-map fail-soft. The only file that
  knows the on-disk format.
- **`src/sessionStore.ts` (modified)** — orchestration. The two in-memory Maps
  are replaced by the loaded index. `scan()` reuses on `mtime:size` hit, parses
  + upserts on miss, flushes at scan end. `getFacts()` serves from the index,
  computes + upserts on miss. New `startBackfill()` runs the cooperative loop
  with the in-flight `Set`.
- **`src/sessionParser.ts` (unchanged)** — `parseSession` / `extractSessionFacts`
  stay pure and independently unit-tested.
- **`src/settingsStore.ts` (extended)** — `indexEnabled` getter/setter, same
  fail-soft, allowlist-style default (`true`).
- **`src/main.ts` (minimal)** — inject `app.getPath('userData')` into the index,
  start the backfill after the initial scan + first paint, flush on
  `before-quit`, and honor `indexEnabled`.
- **IPC** — `session:getFacts` stays; no new channel.

## 10. Read-only invariant

All index writes target the `userData` index file **only**. The source `.jsonl`
files are never written, moved, or deleted — a hard CLAUDE.md constraint,
asserted in tests as it is today for `sessionStore`.

## 11. Error handling (fail-soft, spec §12 lineage)

- Corrupt / mismatched / absent index → empty → rebuild.
- Source file unreadable mid-scan → skip it, keep scanning (as today).
- Facts extraction throws / file vanishes during a lazy compute or backfill →
  the entry's `facts` is **not** written (transient failure retries on the next
  pull/backfill pass — the #115 "errors are never cached" rule).
- Atomic write failure → log, keep the in-memory map; the next flush retries.
  Never crash the app over an index write.

## 12. Testing strategy

Mirrors the repo's seams — pure tests plus `test/main/` node-context tests
(`tsconfig.node.json`); renderer tsconfig stays DOM-only.

- **`sessionIndex`:** load/save round-trip; atomic write leaves no partial file
  on simulated failure; `schemaVersion` mismatch → empty → rebuild; corrupt /
  absent / non-object file → empty (fail-soft); `mtime:size` freshness;
  disabled-mode (`load` empty, `flush` no-op).
- **`sessionStore`:** scan populates the index; a second scan with unchanged
  `mtime` **skips re-parse** (asserted via the existing injectable-parser
  call-count spy in `StoreDeps`); a changed file re-parses and drops stale
  facts; `getFacts` hit vs. miss+persist; backfill drives the index to
  completeness and is idempotent against a concurrent lazy pull (in-flight
  `Set`); the **read-only invariant** — no writes ever touch a source `.jsonl`.
- **`settingsStore`:** `indexEnabled` default `true`, honors a stored boolean,
  fail-soft on garbage.
- **Pure parser tests** unchanged.

## 13. Acceptance-criteria mapping

| Issue AC | Satisfied by |
| --- | --- |
| Engine decision recorded (JSON vs SQLite/FTS) with spike evidence | §2 (measured corpus), §3 (JSON + rejected alternatives) |
| Index persists in `userData`, rebuilds when deleted, updates incrementally via `mtime/size` deltas during scan | §5, §6, §7.2 |
| Schema versioned with rebuild-on-mismatch path | §6 |
| Enriched rows read from the persistent index (in-memory cache retired) | §7.1, §7.3 |
| Source `.jsonl` strictly read-only; index never off-machine | §8, §10 |
| Privacy opt-out specified (implementation may follow) | §8 (`indexEnabled`, shipped this slice) |

## 14. Follow-ups (filed as/against Epic #88 children)

- **#117** — full-text search + engine decision for content; may layer optional,
  fully-local semantic search later.
- **#118** — reverse file→session lookup; extends the extractor + schema
  (`schemaVersion` bump) with `filesTouched[]`.
- **#119** — preview/peek pane; reads the same index.
- **Deferred within this area, filed if/when needed:** `worker_thread` parse
  offload (only if big-file jank is observed); per-path index exclusion;
  a one-time faceting backfill trigger if a "sort/facet across all sessions"
  feature needs guaranteed-complete facts on demand.
