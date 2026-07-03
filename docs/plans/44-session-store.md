# Plan — #44 sessionStore (tiered scan + parse + group + mtime cache)

**Issue:** prpande/csm#44 · **Area:** scanner · **Tier:** Standard (plan only)

## Sizing-tier note

`priority:p1` would normally route to the high-risk tier (spec + `ce-doc-review`).
Deviating to **Standard** for the same reason as #42: the contract is already
fixed in the merged design spec (§5 module table, §6 tiered scan), and there is
no security-invariant *change* here — the one invariant that applies
(read-only on Claude's session files) is an existing constraint we honour and
assert directly with a test, not a new decision needing a design pass. No
launcher, no deletion, no shell/AppleScript surface. Flagged for the maintainer.

## Goal

Turn a directory of Claude Code session JSONL files into grouped, tiered
session metadata by driving the pure `sessionParser` (#42). First real consumer
of the parser; foundation for tree / list / reopen.

## API (streaming option A — locked with the user)

```ts
createSessionStore(rootDir, deps?) => { scan(opts) => Promise<GroupedSessions> }
```

- **Factory, not free function.** `rootDir` and the mtime cache live on the store
  instance so a *refresh* is just another `scan()` on the same instance and the
  cache survives between calls. (Minor shape shift from the issue's literal
  `scan(rootDir, …)` sketch; the streaming/onBatch contract is unchanged.)
- `scan({ now, onBatch })`:
  - `now: number` — epoch ms, **injected** so tier boundaries are deterministic
    under test.
  - `onBatch?: (sessions: SessionMetadata[]) => void` — called once per non-empty
    tier, newest tier first, before the next tier is parsed. The IPC bridge (a
    later issue) maps `onBatch`→`sessions:batch`, resolve→`sessions:done`.
  - resolves to `GroupedSessions` — all folders, each sorted most-recent-first.
- `deps.parse?` — inject the parser (defaults to the real `parseSession`) so the
  cache test can spy call counts without ESM module-mocking.

Types:

```ts
interface SessionFolder { cwd: string; sessions: SessionMetadata[] }
interface GroupedSessions { folders: SessionFolder[] }
```

## Algorithm

1. **Collect** `*.jsonl` under `rootDir/*/` (one subdir level: the encoded-cwd
   folders). Missing root -> empty result, no batches (fail-soft).
2. **Stat pass:** `stat` each file for `mtimeMs` only. Bucket by age
   (`now - mtimeMs`) into 6 tiers.
3. **Parse pass, newest tier first:** within a tier, order files by mtime desc;
   for each, cache-lookup by `filepath + mtimeMs`; on miss read + `parse` +
   apply mtime fallback; cache the result. Emit the tier via `onBatch`.
4. **Group** every session by authoritative in-file `cwd` (NOT the encoded folder
   name); after all tiers, sort each folder most-recent-first by `lastActivity`.

**Tiers (by mtime age):** `<=1d, <=3d, <=7d, <=14d, <=30d, >30d`. Pure helper
`tierIndex(ageMs)` -> 0..5, unit-tested in isolation.

**lastActivity fallback:** parser `null` -> file mtime as ISO. After the store,
`lastActivity` is always a string, so ISO lexicographic sort == chronological.

## Invariants honoured

- **Read-only:** only `readdir`/`stat`/`readFile`. Asserted by a before/after
  fixture snapshot (names + contents + mtimes byte-identical).
- No Electron / `fs` mocking in the pure parser; the store is integration-tested
  against a real temp fixture dir (`mkdtempSync` under `os.tmpdir()`).

## Test list (TDD, `test/sessionStore.test.ts` + pure helper)

- `tierIndex`: each boundary maps to its tier; >30d -> 5; future mtime -> 0.
- happy path: multi-folder fixture -> folders grouped by in-file cwd, each
  sorted most-recent-first.
- tiering/order: `onBatch` fires once per non-empty tier, newest first, before
  resolve; empty tiers emit no batch.
- lastActivity fallback: a file whose parse yields null lastActivity gets the
  file mtime (ISO).
- grouping: two files with different encoded folders but the same in-file cwd
  land in ONE folder; same encoded folder, different cwd -> two folders.
- cache: second `scan` re-parses only changed files (spy parse call counts);
  bump one file's mtime -> only that file re-parsed.
- skips: non-`.jsonl` files, unreadable/empty files, non-dir entries -> skipped,
  scan still completes.
- read-only: fixture dir byte-identical after a scan.
- empty / missing root -> `{ folders: [] }`, no batches.

## Out of scope (follow-on issues)

IPC event wiring; `pathAdapter` (default-root resolution); renderer
virtualization; live-session guarding.
