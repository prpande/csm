# Persistent Session-Metadata Index — Design Spec

- **Issue:** [#116](https://github.com/prpande/csm/issues/116) — Persistent
  session-metadata index in `userData` (rebuildable cache) + engine decision.
- **Epic:** [#88](https://github.com/prpande/csm/issues/88) — unified session
  metadata index. This is the keystone first child.
- **Depends on:** the enriched-rows slice (#115, merged `1a251e9`) for the
  extraction shape (`extractSessionFacts`) and the windowed lazy fetch it reads
  from.
- **Status:** design — reviewed via `ce-doc-review` 2026-07-07 (six personas;
  fixes applied inline), then implementation plan.

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
- **Stale-entry pruning** — a session whose source `.jsonl` is gone is removed
  from the index at the end of a *complete* scan (§7.2).
- A **`startBackfill()` seam** — the cooperative facts-completion loop, with its
  in-flight-`Set` de-dup, is *built* but **not auto-started in this slice**. The
  lazy pull already persists every browsed row; the always-on loop is deferred
  to the first consumer that needs guaranteed-complete facts for un-browsed
  sessions (§7.4, §14).
- A **global privacy opt-out** (`indexEnabled` setting).

### Explicitly out of scope (with rationale)

- **Always-on idle backfill loop** → the `startBackfill()` seam ships; *running*
  it unconditionally is deferred. Its only consumers (faceting, #118, #119) are
  all deferred, and the lazy pull already covers every visible row — so the loop
  would spend a first-run background CPU pass over 1.7 GB for no current payoff
  (§7.4).
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
      // The full SessionMetadata shape minus the sessionId (that is the map key).
      "cwd": "/home/u/project",
      "title": "Fix the span formatter",
      "permissionMode": "default",
      "lastActivity": "2026-07-06T18:41:00Z",   // null → filled from mtime in store
      "gitBranch": "main",                        // string | null (null on a non-git cwd)
      "version": "1.0.83",                        // optional; absent if unknown

      // Facts tier (enriched row) — lazy. ABSENT until computed by a lazy pull.
      // Presence of `facts` == "this session's facts are warm".
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

**Field reconciliation.** The metadata tier is the full `SessionMetadata` shape
(`cwd`, `title`, `permissionMode`, `lastActivity`, `gitBranch`, and optional
`version`) minus `sessionId`. `SessionMetadata` and `SessionFacts` overlap on
`sessionId` (→ the map key) and `lastActivity` (→ stored once at entry level).
`messageCount` differs semantically between the two shapes — `SessionMetadata`
carries an optional raw count; `SessionFacts` carries the genuine-turn count —
so the entry stores **only the genuine-turn count**, inside `facts`; the
list/tree row does not need a separate one. `gitBranch` is carried in the
metadata tier because the list already renders it (it is part of the
`SessionMetadata` #115 consumes).

**Tiering by build strategy is the point of the shape.** The eager metadata
tier lives at the entry top level; the lazy facts tier is a nested optional
`facts` object. "Facts completion" == "find entries whose `facts` is absent and
compute it." This models *metadata-eager, facts-lazy-persisted* directly in the
schema.

## 6. Versioning: rebuild, not migrate

The index is a cache over authoritative source, so there is no precious data to
migrate. On load:

- `schemaVersion` !== current → **discard the file, treat as empty**, and log
  the discard (so a user hitting a repeated version-mismatch has a diagnostic
  signal). The next scan repopulates metadata; facts refill lazily.
- Corrupt / unparseable / absent / non-object file → **empty** (fail-soft,
  mirroring `settingsStore`'s `{}`-on-garbage behavior). Never throws to the
  caller.

Consequences:

- A schema bump discards the whole cache and forces a full re-scan on first
  launch after upgrade. That is acceptable for a rebuildable cache, but it is
  wasteful when a bump only *adds* a field. **Design guidance for #118+:** prefer
  additive-tolerant versioning — a reader that finds a known-older `schemaVersion`
  whose only difference is missing new fields should keep the existing entries
  and treat the new fields as absent (recompute lazily), rather than discarding
  the entire index. Reserve the full discard for incompatible shape changes.
- **Deleting `session-index.json` by hand is a supported "force full rebuild."**

## 7. Build and update model

### 7.1 Startup

`sessionIndex.load()` reads the file once into an in-memory map (or empty per
§6). That map is the single working cache; it **replaces** the two ad-hoc
in-memory Maps in `sessionStore` today (`cache` for metadata, `factCache` for
facts).

### 7.2 Metadata — eager during scan, with stale-entry pruning

The tiered scan already `stat`s and reads+parses every file to build the folder
grouping, so metadata is *already* computed for every file on every scan. The
change is only that it is now cached persistently:

- For each file, compute `key = mtime:size`.
- **Hit** (entry exists and `key` matches): reuse the persisted metadata — no
  read, no parse.
- **Miss**: read + `parseSession`, write the metadata tier of the entry, mark
  dirty. A mismatched `key` also drops any stale `facts` on that entry.
- **Prune (only after a *complete* scan):** the scan builds the full set of
  sessionIds present on disk (it already builds `pathById`). After the scan
  reaches completion, remove any persisted entry whose sessionId was **not**
  observed in that set, and mark dirty. This bounds index growth and, together
  with §8, ensures a deleted session's derived content does not linger. The
  invariant: *the persisted entries map is a subset of the sessions present on
  disk at last complete scan.*
- Flush once at scan end (§7.5).

**Crash / partial-scan safety.** Pruning runs **only** after a scan reaches
completion — never on a partial or aborted scan. A crash mid-scan leaves the
previously persisted index fully intact on disk (the atomic write in §7.5
guarantees no partial file reaches disk), so recovery is simply "reuse the
last-good index, re-scan changed files." A half-finished scan that saw only some
folders must never evict the sessions it did not reach.

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
and paints when it resolves; a row scrolled-to later hits warm cache on its
pull. Pull self-heals, so main→renderer push is not built.

### 7.4 Facts-completion seam (`startBackfill()`) — built, not auto-run

Some later features (faceting across all sessions, #118 reverse-lookup, #119
preview) will want facts for sessions the user never browsed. The mechanism for
that is a **cooperative loop on the main event loop**: for each entry lacking
`facts`, compute + persist, then `await`/yield before the next.

This slice **builds the seam but does not start the loop**:

- `sessionStore` exposes `startBackfill()` and the shared in-flight
  `Set<sessionId>` (which de-dups a computing session between the loop and a
  concurrent lazy `getFacts`), but nothing invokes `startBackfill()` in #116.
- The first child issue that needs guaranteed-complete facts calls it on demand
  (§14).

Rationale: the lazy pull already persists every browsed row, so an always-on
loop's *only* delta is warming un-browsed sessions for consumers that are all
deferred — at the cost of a first-run background CPU pass over 1.7 GB. Deferring
the loop keeps the payoff aligned with the consumer that needs it.

- **When the loop is eventually run**, each iteration marks the index dirty and
  arms the debounce (§7.5), so progress persists periodically — not only at
  quit. The in-flight `Set` is in-memory and reconstructs empty on launch, so it
  needs no teardown across restarts.
- **`worker_thread` seam:** the only thing that would force a real second thread
  is the ~24 files >10 MB (up to 60 MB) causing a per-file parse blip on the
  main loop (`extractSessionFacts` parses a file synchronously; a yield between
  files cannot subdivide one file's parse). If that jank is observed, the *parse*
  alone is offloaded to a worker behind the same seam — not built speculatively.

### 7.5 Write model — single-writer, atomic, debounced

- **Atomic:** write to a per-flush unique temp path (e.g.
  `session-index.<n>.tmp`), then rename over the target, so a crash or a
  concurrent read never sees a half-written file.
- **Single-writer:** `flush()` is serialized. The index module holds one debounce
  timer and one in-progress-flush promise; a flush requested while another is
  mid write-then-rename does not start a second concurrent writer — it marks the
  index dirty and re-runs after the in-flight flush resolves. This prevents two
  writers racing on the temp path (and the Windows `rename`-over-open-target
  `EPERM` hazard when antivirus / cloud-sync holds a handle).
- **Debounced:** coalesce dirty state and flush on a short debounce, plus forced
  flushes at scan end, on folder switch, and on quit (§9). This bounds write
  amplification from per-scroll fact persistence to a handful of ~2 MB writes.

### 7.6 Disabled mode (no separate code path)

`sessionIndex` is constructed with the resolved `indexEnabled` value (read from
`settingsStore` by `main.ts` at startup and passed in — `sessionIndex` does not
reach into settings itself). When `indexEnabled` is `false`, `sessionIndex`
operates **in-memory only**: `load()` returns empty, `flush()` is a no-op.
`sessionStore` uses the exact same code path in both modes — it only ever calls
`load`/`get`/`upsert`/`flush`; the enable/disable branch lives entirely inside
`sessionIndex`. Behavior degrades precisely to today's ephemeral cache (rebuilt
each launch, facts lazy and non-persistent) with no forked logic in
`sessionStore`.

## 8. Privacy

- **Content exposure is narrow.** The only conversation-derived fields are
  `title` (possibly a truncated user prompt) and `cwd`/`gitBranch` (a path and a
  branch name). No message bodies, no tool output. The index is *less* sensitive
  than the source.
- **Deletion propagates.** A deleted source session is pruned from the index at
  the next complete scan (§7.2), and Phase B (delete sessions) must remove the
  entry synchronously when it removes the source file. Without this, the index
  would retain a deleted session's `title`/`cwd` indefinitely — a retention
  surface the source never had. Pruning closes it.
- **Location & sync — a caveat, not a guarantee.** CSM has no network code, so
  it never *transmits* the index itself. But "off-machine" is not fully in CSM's
  control: `userData` resolves to `~/Library/Application Support/<App>/` on macOS
  and `%APPDATA%\<App>\` on Windows — locations that a user-configured iCloud
  Drive / Dropbox / OneDrive scope, or an enterprise roaming-profile / folder
  redirection policy, can sweep off-machine. The source `.jsonl` under
  `~/.claude/` is typically below such scopes; the index may not be. **Decision
  for this slice:** accept this as risk equivalent to the source and *document*
  it, rather than assert a false "structurally never off-machine" guarantee. A
  hardening follow-up (e.g. a `.nosync`-style opt-out, or relocating the index)
  is filed against #88, not built here. Requirement: the index must never be
  added to any CSM-owned sync/telemetry/upload path.
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
  Constructed with an injectable `dir` (like `settingsStore`, so it is testable
  against a temp dir with no Electron runtime) plus the resolved `indexEnabled`
  flag. Owns: `load()` → in-memory map; `get(id)`; `upsert(id, entry)`;
  `prune(observedIds)`; `flush()` (single-writer, atomic unique-temp + rename,
  debounced); and the `schemaVersion` / corruption → empty-map fail-soft. The
  only file that knows the on-disk index format.
- **`src/sessionStore.ts` (modified)** — orchestration. The two in-memory Maps
  are replaced by the loaded index. `scan()` reuses on `mtime:size` hit, parses
  + upserts on miss, and calls `prune()` after a complete scan; flushes at scan
  end. `getFacts()` serves from the index, computes + upserts on miss. Exposes
  `startBackfill()` + the in-flight `Set` (seam; not invoked in #116).
- **`src/sessionParser.ts` (unchanged)** — `parseSession` / `extractSessionFacts`
  stay pure and independently unit-tested.
- **`src/settingsStore.ts` (extended)** — `indexEnabled` getter/setter, same
  fail-soft, allowlist-style default (`true`).
- **`src/main.ts` (modified)** — read `indexEnabled` from `settingsStore` and
  construct `sessionIndex` with it + `app.getPath('userData')`. **Quit flush
  handshake:** there is no `before-quit` handler today (`window-all-closed` calls
  `app.quit()` directly). Add a `before-quit` handler that, if the index is
  dirty, calls `event.preventDefault()`, cancels the debounce, `await`s
  `flush()`, then re-invokes `app.quit()` guarded by a `quitting` flag — because
  the atomic temp-write + rename is async and Electron does **not** delay quit
  for a fire-and-forget async task, so without the handshake the last debounce
  window's writes are lost on quit.
- **IPC** — `session:getFacts` stays; no new channel. The existing
  `isValidSessionId` UUID gate at the IPC entry point is preserved unchanged when
  the cache backend is swapped.

## 10. Read-only invariant

All index writes target the `userData` index file **only**. The source `.jsonl`
files are never written, moved, or deleted — a hard CLAUDE.md constraint,
asserted in tests as it is today for `sessionStore`. The new path resolution
still routes through the scan-populated `pathById` map behind the
`isValidSessionId` UUID gate; the raw `sessionId` is only ever a JSON map key,
never concatenated into a filesystem path.

## 11. Error handling (fail-soft, spec §12 lineage)

- Corrupt / mismatched / absent index → empty → rebuild (mismatch is logged, §6).
- Source file unreadable mid-scan → skip it, keep scanning (as today).
- **Crash mid-scan** → the prior persisted index stays intact (atomic write, no
  partial file); pruning never runs on the incomplete scan (§7.2).
- Facts extraction throws / file vanishes during a lazy compute → the entry's
  `facts` is **not** written (transient failure retries on the next pull — the
  #115 "errors are never cached" rule).
- Flush failure (write / rename error) → log, keep the in-memory map; the next
  flush retries. Never crash the app over an index write.

## 12. Testing strategy

Mirrors the repo's seams — pure tests plus `test/main/` node-context tests
(`tsconfig.node.json`); renderer tsconfig stays DOM-only.

- **`sessionIndex`:** load/save round-trip; **single-writer flush** — a forced
  flush fired while a debounced flush is pending yields exactly one well-formed
  file (no temp-path race); atomic write leaves no partial file on simulated
  failure; `schemaVersion` mismatch → empty → rebuild; corrupt / absent /
  non-object file → empty (fail-soft); `mtime:size` freshness; `prune()` drops
  only unobserved ids; disabled-mode (`load` empty, `flush` no-op).
- **`sessionStore`:** scan populates the index; a second scan with unchanged
  `mtime` **skips re-parse** (asserted via the existing injectable-parser
  call-count spy in `StoreDeps`); a changed file re-parses and drops stale facts;
  a **size-only** change with unchanged mtime still invalidates the metadata
  entry (the key is `mtime:size`); `getFacts` hit vs. miss+persist; **prune runs
  only after a complete scan** and a deleted session's entry is removed; a
  partial/aborted scan does **not** evict; `startBackfill()` is invokable and
  idempotent against a concurrent lazy pull (in-flight `Set`); the **read-only
  invariant** — no writes ever touch a source `.jsonl`.
- **`main` quit handshake:** a dirty index triggers a `flush()` that completes
  before quit proceeds (the `preventDefault` + re-quit path).
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
| Privacy opt-out specified (implementation may follow) | §8 — `indexEnabled` **specified and implemented this slice** (the AC permits deferral; shipped anyway because §7.6 makes disabled mode a no-forked-code-path branch) |

## 14. Follow-ups (filed as/against Epic #88 children)

Each item below is either an existing child issue or a to-be-filed tracking
issue; the ones without a number are filed when their trigger condition is hit,
and this spec must not be considered closing any of them.

- **#117** — full-text search + engine decision for content; may layer optional,
  fully-local semantic search later.
- **#118** — reverse file→session lookup; extends the extractor + schema
  (`schemaVersion` bump, additive-tolerant per §6) with `filesTouched[]`; a
  natural first caller of the `startBackfill()` seam.
- **#119** — preview/peek pane; reads the same index.
- **To file against #88 now (untracked otherwise):**
  - *Always-on / on-demand facts backfill trigger* — wire `startBackfill()` to a
    real consumer (faceting or #118) that needs guaranteed-complete facts.
  - *`userData` off-machine hardening* — a `.nosync`-style opt-out or index
    relocation, per §8.
- **File only if the trigger is observed (no issue yet):**
  - *`worker_thread` parse offload* — only if big-file jank appears in QA.
  - *Per-path index exclusion* — only if a user requests folder-level opt-out.
