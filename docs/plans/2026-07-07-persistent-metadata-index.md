# Persistent Session-Metadata Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote CSM's per-session cache from ephemeral in-memory Maps into a persistent, rebuildable JSON index in Electron `userData`, built incrementally during the existing tiered scan so a restart re-reads only changed files.

**Architecture:** A new `sessionIndex` persistence unit owns a single `session-index.json` (`{ schemaVersion, entries: { <sessionId>: IndexEntry } }`) in `userData`, with fail-soft load, rebuild-on-version-mismatch, and single-writer atomic debounced flush. `sessionStore` swaps its two in-memory Maps for this index: metadata is written eagerly during scan (keyed by `mtime:size`), facts fill in lazily on the existing `getFacts` pull and persist, and stale entries are pruned after a complete scan. `main.ts` constructs the index from an `indexEnabled` setting and adds a `before-quit` flush handshake.

**Tech Stack:** TypeScript, Node `fs/promises`, Electron (main process only), Vitest (node-context tests under `test/main/`, `tsconfig.node.json`).

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from the spec (`docs/specs/2026-07-07-persistent-metadata-index-design.md`) and `CLAUDE.md`.

- **Read-only source.** The source `.jsonl` files are never written, moved, or deleted. All index writes target the `userData` index file **only**. Assert this structurally in tests (fixture dir byte-identical after operations).
- **`userData` is the only write location.** `sessionIndex` is constructed with an injectable `dir` and only ever writes `session-index.json` (and its unique `.tmp` siblings) under that dir.
- **Freshness key is `mtime:size`.** A per-entry `mtime` (ms) + `size` (bytes) pair guards the whole entry; a mismatch invalidates metadata AND facts.
- **Rebuild, not migrate.** On load: `schemaVersion` mismatch → discard file, treat as empty, **log the discard**. Corrupt / unparseable / absent / non-object file → empty (fail-soft, never throws to caller), mirroring `settingsStore`'s `{}`-on-garbage.
- **`INDEX_SCHEMA_VERSION` is `1`** for this slice.
- **Single-writer atomic flush.** Write to a per-flush **unique** temp path, then `rename` over the target. `flush()` is serialized: one debounce timer + one in-progress-flush promise; a flush requested mid-write does not start a second concurrent writer.
- **Prune only after a *complete* scan.** Never evict on a partial/aborted scan or when the scan observed zero files. The persisted entries map is a subset of the sessions present on disk at last complete scan.
- **Disabled mode has no forked code path in `sessionStore`.** When `indexEnabled` is `false`, `sessionIndex.load()` returns empty and `flush()` is a no-op; `get`/`upsert`/`prune` still work in-memory. `sessionStore` only ever calls `load`/`get`/`upsert`/`prune`/`flush`.
- **`before-quit` flush handshake.** Electron does not delay quit for a fire-and-forget async task; a dirty index at quit must `event.preventDefault()`, flush, then re-quit under a `quitting` guard.
- **Test seam.** Node-context (`fs`) tests live in `test/main/` (compiled by `tsconfig.node.json`). Do not put these in `test/renderer/` (DOM-only).
- **CSM never invokes an LLM.** No new title/summary generation — `title` continues to read Claude's own records verbatim via the unchanged parser.
- **`sessionParser.ts` stays pure and unchanged.** No `fs`/Electron imports added to it.
- **One build/test command at a time, foreground, timeout ≥ 300000ms.** Never `run_in_background` a build/test.
- **Conventional Commits** (`feat:`, `test:`, `refactor:`, `docs:`), frequent commits, with trailers `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_016WWRREBAL5duQ7SmApYJTJ`.
- **Run vitest via the local binary**, never `npx vitest` (a cached jsdom-ignoring binary). Single-file: `./node_modules/.bin/vitest run <path>`. Full suite: `npm test`.

---

## File Structure

- **Create** `src/sessionIndex.ts` — persistence layer over `session-index.json`. Owns the on-disk format, load, get/upsert/prune, single-writer atomic debounced flush, disabled mode. The only file that knows the index format.
- **Create** `src/quitFlush.ts` — pure factory returning a `before-quit` handler (isDirty → preventDefault → flush → re-quit). Extracted so it is unit-testable without Electron.
- **Modify** `src/sessionStore.ts` — replace the two in-memory Maps (`cache`, `factCache`) with the injected index; add `size` to the collected file entry; prune after a complete scan; serve/persist facts through the index; expose the `startBackfill()` seam + shared in-flight `Set`.
- **Modify** `src/settingsStore.ts` — add `getIndexEnabled` / `setIndexEnabled` (default `true`, boolean allowlist, fail-soft).
- **Modify** `src/main.ts` — read `indexEnabled`, construct `sessionIndex`, pass a bound store factory into `registerIpcHandlers`, wire the `before-quit` handler.
- **Create** `test/main/sessionIndex.test.ts`, `test/main/quitFlush.test.ts` — new unit tests.
- **Modify** `test/main/sessionStore.test.ts`, `test/main/sessionStore.facts.test.ts`, `test/main/settingsStore.test.ts` — extend for index-backed behavior. One existing assertion in `sessionStore.facts.test.ts` changes from object-identity to value-equality (documented in Task 6).

**Interfaces produced by Task 2/3 (`sessionIndex`), consumed by Tasks 5–8:**

```ts
// src/sessionIndex.ts
export const INDEX_FILENAME = "session-index.json";
export const INDEX_SCHEMA_VERSION = 1;

export interface IndexFacts {
  messageCount: number;
  firstActivity: string | null;
  editedFileCount: number;
  firstModel: string | null;
  distinctModelCount: number;
  outputTokens: number;
}
export interface IndexEntry {
  mtime: number;                 // ms
  size: number;                  // bytes
  cwd: string;
  title: string;
  permissionMode: PermissionMode; // imported type from ./sessionParser
  lastActivity: string | null;
  gitBranch: string | null;
  version?: string;
  facts?: IndexFacts;
}
export interface SessionIndexDeps {
  dir: string;
  enabled: boolean;
  debounceMs?: number;           // default 500; injectable for tests
}
export interface SessionIndex {
  load(): Promise<void>;                 // idempotent; reads disk once
  get(id: string): IndexEntry | undefined;
  upsert(id: string, entry: IndexEntry): void;
  prune(observedIds: Set<string>): void;
  flush(): Promise<void>;                // single-writer, atomic, cancels its own debounce
  isDirty(): boolean;                    // unpersisted changes OR a write in flight
}
export function createSessionIndex(deps: SessionIndexDeps): SessionIndex;
```

---

## Task 1: `settingsStore` — `indexEnabled` setting

**Files:**
- Modify: `src/settingsStore.ts`
- Test: `test/main/settingsStore.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createSettingsStore(dir)` return object gains `getIndexEnabled(): Promise<boolean>` and `setIndexEnabled(value: boolean): Promise<void>`; module exports `const DEFAULT_INDEX_ENABLED = true`.

- [ ] **Step 1: Write the failing tests**

Append to `test/main/settingsStore.test.ts`:

```ts
test("getIndexEnabled() defaults to true when settings.json is absent", async () => {
  expect(await createSettingsStore(dir).getIndexEnabled()).toBe(true);
});

test("setIndexEnabled then getIndexEnabled round-trips through disk", async () => {
  const store = createSettingsStore(dir);
  await store.setIndexEnabled(false);
  expect(await store.getIndexEnabled()).toBe(false);
  // A fresh instance reads the same persisted value (no in-memory reliance).
  expect(await createSettingsStore(dir).getIndexEnabled()).toBe(false);
});

test("a non-boolean / garbage stored indexEnabled falls back to true", async () => {
  const store = createSettingsStore(dir);
  for (const contents of [
    JSON.stringify({ indexEnabled: "false" }), // string, not boolean
    JSON.stringify({ indexEnabled: 0 }),
    JSON.stringify({ indexEnabled: null }),
    "{ not json ",
  ]) {
    writeSettings(contents);
    await expect(store.getIndexEnabled()).resolves.toBe(true);
  }
});

test("setIndexEnabled preserves unknown keys and the stored claudePath", async () => {
  writeSettings(JSON.stringify({ claudePath: "keep-me", theme: "dark" }));
  const store = createSettingsStore(dir);
  await store.setIndexEnabled(false);
  const persisted = JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8"));
  expect(persisted.indexEnabled).toBe(false);
  expect(persisted.claudePath).toBe("keep-me");
  expect(persisted.theme).toBe("dark");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run test/main/settingsStore.test.ts`
Expected: FAIL — `store.getIndexEnabled is not a function`.

- [ ] **Step 3: Implement**

In `src/settingsStore.ts`, after `export const DEFAULT_THEME` add:

```ts
// The privacy opt-out default (spec §8): indexing is ON unless explicitly disabled.
export const DEFAULT_INDEX_ENABLED = true;
```

Inside `createSettingsStore`, before the `return`, add:

```ts
  async function getIndexEnabled(): Promise<boolean> {
    const v = (await readSettings()).indexEnabled;
    // Honor only a real boolean; anything else (absent, a hand-edited string,
    // a number, null, a corrupt file) → default true.
    return typeof v === "boolean" ? v : DEFAULT_INDEX_ENABLED;
  }

  async function setIndexEnabled(value: boolean): Promise<void> {
    // Spread-merge so unknown keys (claudePath, theme) are preserved.
    const next = { ...(await readSettings()), indexEnabled: value };
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
  }
```

Add both to the returned object:

```ts
  return {
    getClaudePath,
    setClaudePath,
    getTheme,
    setTheme,
    getIndexEnabled,
    setIndexEnabled,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run test/main/settingsStore.test.ts`
Expected: PASS (all settingsStore tests).

- [ ] **Step 5: Commit**

```bash
git add src/settingsStore.ts test/main/settingsStore.test.ts
git commit -m "feat: add indexEnabled setting to settingsStore (#116)"
```

---

## Task 2: `sessionIndex` — data model, load, get/upsert/prune

**Files:**
- Create: `src/sessionIndex.ts`
- Test: `test/main/sessionIndex.test.ts`

**Interfaces:**
- Consumes: `PermissionMode` type from `./sessionParser`.
- Produces: everything in the "Interfaces produced by Task 2/3" block above **except** the flush machinery (added in Task 3). This task ships `load`, `get`, `upsert`, `prune`, and the constant/types. `flush`/`isDirty` (and the internal `markDirty`/debounce/`cancelDebounce`) are added in Task 3; to keep the module compiling and the interface stable, include no-op stubs for `flush`/`isDirty`/`markDirty` here and replace them in Task 3.

- [ ] **Step 1: Write the failing tests**

Create `test/main/sessionIndex.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionIndex,
  INDEX_FILENAME,
  INDEX_SCHEMA_VERSION,
  type IndexEntry,
} from "../../src/sessionIndex";

// sessionIndex is the persistence layer over session-index.json under the Electron
// userData dir. Tested against a real temp fixture dir (no Electron, no fs mocking):
// the injected dir is the ONLY location it ever touches.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csm-index-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<IndexEntry> = {}): IndexEntry => ({
  mtime: 1000,
  size: 200,
  cwd: "/p",
  title: "t",
  permissionMode: "default",
  lastActivity: "2026-07-06T18:41:00Z",
  gitBranch: "main",
  ...over,
});

const writeRaw = (contents: string): void =>
  writeFileSync(join(dir, INDEX_FILENAME), contents);

test("load() on an absent file yields an empty index", async () => {
  const idx = createSessionIndex({ dir, enabled: true });
  await idx.load();
  expect(idx.get("11111111-1111-4111-8111-111111111111")).toBeUndefined();
});

test("upsert then flush round-trips through disk into a fresh instance", async () => {
  const a = createSessionIndex({ dir, enabled: true, debounceMs: 0 });
  await a.load();
  a.upsert("id-1", entry({ title: "hello" }));
  await a.flush();

  const b = createSessionIndex({ dir, enabled: true });
  await b.load();
  expect(b.get("id-1")).toEqual(entry({ title: "hello" }));
});

test("get is undefined for an unknown id after load", async () => {
  const idx = createSessionIndex({ dir, enabled: true });
  await idx.load();
  expect(idx.get("nope")).toBeUndefined();
});

test("prune drops only unobserved ids", async () => {
  const idx = createSessionIndex({ dir, enabled: true, debounceMs: 0 });
  await idx.load();
  idx.upsert("keep", entry());
  idx.upsert("drop", entry());
  idx.prune(new Set(["keep"]));
  expect(idx.get("keep")).toBeDefined();
  expect(idx.get("drop")).toBeUndefined();
});

test("a schemaVersion mismatch discards the file (rebuild, not migrate)", async () => {
  writeRaw(
    JSON.stringify({
      schemaVersion: INDEX_SCHEMA_VERSION + 1,
      entries: { "id-1": entry() },
    }),
  );
  const idx = createSessionIndex({ dir, enabled: true });
  await idx.load();
  expect(idx.get("id-1")).toBeUndefined();
});

test("a corrupt / non-object file loads as empty (fail-soft, never throws)", async () => {
  for (const contents of ["{ not json ", "[]", '"a string"', "42", "null"]) {
    writeRaw(contents);
    const idx = createSessionIndex({ dir, enabled: true });
    await expect(idx.load()).resolves.toBeUndefined();
    expect(idx.get("id-1")).toBeUndefined();
  }
});

test("load() is idempotent — a second call does not re-read or clobber upserts", async () => {
  writeRaw(
    JSON.stringify({
      schemaVersion: INDEX_SCHEMA_VERSION,
      entries: { "on-disk": entry() },
    }),
  );
  const idx = createSessionIndex({ dir, enabled: true });
  await idx.load();
  idx.upsert("in-memory", entry());
  await idx.load(); // must be a no-op
  expect(idx.get("on-disk")).toBeDefined();
  expect(idx.get("in-memory")).toBeDefined();
});

test("disabled mode: load() ignores an existing file and stays empty", async () => {
  writeRaw(
    JSON.stringify({
      schemaVersion: INDEX_SCHEMA_VERSION,
      entries: { "id-1": entry() },
    }),
  );
  const idx = createSessionIndex({ dir, enabled: false });
  await idx.load();
  expect(idx.get("id-1")).toBeUndefined();
  // get/upsert still function in-memory even when disabled.
  idx.upsert("mem", entry());
  expect(idx.get("mem")).toBeDefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run test/main/sessionIndex.test.ts`
Expected: FAIL — cannot find module `../../src/sessionIndex`.

- [ ] **Step 3: Implement the module core**

Create `src/sessionIndex.ts`:

```ts
// Persistence layer for the session-metadata index (spec 2026-07-07 §5–§7). Owns
// a single session-index.json in a caller-injected dir (main passes Electron
// app.getPath('userData')); the injected dir keeps this unit testable against a
// real temp dir without an Electron runtime. Imports only node fs/path + a type.
//
// The index is a REBUILDABLE CACHE over strictly read-only source .jsonl files:
// never authoritative, so on any version mismatch or corruption it loads empty
// and the next scan repopulates it (§6). Writes are single-writer + atomic
// (unique temp + rename) + debounced (§7.5). Disabled mode (indexEnabled=false)
// keeps the in-memory map live but never touches disk (§7.6).

import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionMode } from "./sessionParser";

export const INDEX_FILENAME = "session-index.json";
export const INDEX_SCHEMA_VERSION = 1;

const DEFAULT_DEBOUNCE_MS = 500;

/** The lazy facts tier (spec §5). Absent on an entry until a getFacts pull
 *  computes it. `lastActivity` lives at entry level, not here (de-duped). */
export interface IndexFacts {
  messageCount: number;
  firstActivity: string | null;
  editedFileCount: number;
  firstModel: string | null;
  distinctModelCount: number;
  outputTokens: number;
}

/** One session's entry. `mtime`+`size` is the freshness key for the WHOLE entry. */
export interface IndexEntry {
  mtime: number;
  size: number;
  cwd: string;
  title: string;
  permissionMode: PermissionMode;
  lastActivity: string | null;
  gitBranch: string | null;
  version?: string;
  facts?: IndexFacts;
}

export interface SessionIndexDeps {
  dir: string;
  enabled: boolean;
  /** Flush debounce (ms). Injectable so tests can force immediate writes. */
  debounceMs?: number;
}

export interface SessionIndex {
  load(): Promise<void>;
  get(id: string): IndexEntry | undefined;
  upsert(id: string, entry: IndexEntry): void;
  prune(observedIds: Set<string>): void;
  flush(): Promise<void>;
  isDirty(): boolean;
}

// Minimal guard: JSON.parse yields any type; null/array/primitive must not be
// treated as the index object (mirrors settingsStore.isRecord).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function createSessionIndex(deps: SessionIndexDeps): SessionIndex {
  const { dir, enabled } = deps;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const file = join(dir, INDEX_FILENAME);

  const entries = new Map<string, IndexEntry>();
  let loaded = false;

  async function load(): Promise<void> {
    if (loaded) return; // idempotent — read disk at most once per instance
    loaded = true;
    if (!enabled) return; // disabled: stay empty, never read disk (§7.6)
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return; // absent / unreadable / unparseable → empty (fail-soft, §6)
    }
    if (!isRecord(parsed)) return; // array / primitive / null → empty
    if (parsed.schemaVersion !== INDEX_SCHEMA_VERSION) {
      // Rebuild, not migrate (§6): discard + log a diagnostic signal.
      console.warn(
        `[CSM] session index schemaVersion ${String(
          parsed.schemaVersion,
        )} != ${INDEX_SCHEMA_VERSION}; discarding and rebuilding`,
      );
      return;
    }
    if (!isRecord(parsed.entries)) return;
    for (const [id, e] of Object.entries(parsed.entries)) {
      // A non-object entry is dropped; the next scan's mtime:size miss refills it.
      if (isRecord(e)) entries.set(id, e as unknown as IndexEntry);
    }
  }

  function get(id: string): IndexEntry | undefined {
    return entries.get(id);
  }

  function upsert(id: string, entry: IndexEntry): void {
    entries.set(id, entry);
    markDirty();
  }

  function prune(observedIds: Set<string>): void {
    let removed = false;
    for (const id of entries.keys()) {
      if (!observedIds.has(id)) {
        entries.delete(id);
        removed = true;
      }
    }
    if (removed) markDirty();
  }

  // --- flush machinery is added in Task 3; these stubs keep the module compiling ---
  function markDirty(): void {
    /* Task 3 */
  }
  async function flush(): Promise<void> {
    /* Task 3 */
  }
  function isDirty(): boolean {
    return false; // Task 3
  }

  return { load, get, upsert, prune, flush, isDirty };
}
```

Note: the round-trip test in Step 1 calls `flush()` — with the Task-2 stub it is a no-op, so that specific test (`upsert then flush round-trips`) will still FAIL after this step. That is expected; it goes green in Task 3. Every other Task-2 test passes now.

- [ ] **Step 4: Run the tests — all pass except the round-trip test**

Run: `./node_modules/.bin/vitest run test/main/sessionIndex.test.ts`
Expected: all PASS except `"upsert then flush round-trips through disk into a fresh instance"`, which FAILS (flush is a stub — no file written). Leave it; Task 3 makes it pass.

- [ ] **Step 5: Commit**

```bash
git add src/sessionIndex.ts test/main/sessionIndex.test.ts
git commit -m "feat: sessionIndex data model, load, get/upsert/prune (#116)"
```

---

## Task 3: `sessionIndex` — single-writer atomic debounced flush

**Files:**
- Modify: `src/sessionIndex.ts`
- Test: `test/main/sessionIndex.test.ts`

**Interfaces:**
- Consumes: the Task-2 module internals (`entries`, `enabled`, `file`, `dir`, `debounceMs`, `markDirty` stub).
- Produces: working `flush()` and `isDirty()`, plus the internal `markDirty()` / debounce / `cancelDebounce()` machinery (`cancelDebounce` stays module-local — `flush()` calls it; it is not on the public interface).

- [ ] **Step 1: Write the failing tests**

First, extend the top-of-file `node:fs` import with the three readers these tests use (`readFileSync`, `readdirSync`, `existsSync`):

```ts
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
```

Then append to `test/main/sessionIndex.test.ts`:

```ts
test("flush() writes a well-formed file with schemaVersion and entries", async () => {
  const idx = createSessionIndex({ dir, enabled: true, debounceMs: 0 });
  await idx.load();
  idx.upsert("id-1", entry());
  await idx.flush();
  const parsed = JSON.parse(readFileSync(join(dir, INDEX_FILENAME), "utf8"));
  expect(parsed.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
  expect(parsed.entries["id-1"]).toEqual(entry());
});

test("single-writer: two overlapping flushes yield exactly one file and no leftover temp", async () => {
  const idx = createSessionIndex({ dir, enabled: true, debounceMs: 0 });
  await idx.load();
  idx.upsert("id-1", entry());
  // Fire two flushes without awaiting the first — exercises the in-flight path.
  await Promise.all([idx.flush(), idx.flush()]);
  expect(readdirSync(dir)).toEqual([INDEX_FILENAME]); // no *.tmp survivors
  const parsed = JSON.parse(readFileSync(join(dir, INDEX_FILENAME), "utf8"));
  expect(parsed.entries["id-1"]).toBeDefined();
});

test("isDirty(): true after an upsert, false after a flush", async () => {
  const idx = createSessionIndex({ dir, enabled: true, debounceMs: 0 });
  await idx.load();
  expect(idx.isDirty()).toBe(false);
  idx.upsert("id-1", entry());
  expect(idx.isDirty()).toBe(true);
  await idx.flush();
  expect(idx.isDirty()).toBe(false);
});

test("disabled mode: flush() is a no-op and never creates a file", async () => {
  const idx = createSessionIndex({ dir, enabled: false, debounceMs: 0 });
  await idx.load();
  idx.upsert("id-1", entry());
  await idx.flush();
  expect(idx.isDirty()).toBe(false);
  expect(existsSync(join(dir, INDEX_FILENAME))).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run test/main/sessionIndex.test.ts`
Expected: the four new tests FAIL (flush is a no-op stub; `isDirty` returns false; no file written), plus the Task-2 round-trip test still FAILS.

- [ ] **Step 3: Implement the flush machinery**

In `src/sessionIndex.ts`, replace the stub block (the `// --- flush machinery ...` comment plus the `markDirty`/`flush`/`isDirty` stubs) with:

```ts
  let dirty = false;
  let flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tmpCounter = 0;

  function markDirty(): void {
    if (!enabled) return; // disabled: nothing to persist (§7.6)
    dirty = true;
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, debounceMs);
    }
  }

  function cancelDebounce(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function serialize(): string {
    // Built synchronously (before any await) so the written bytes are a
    // consistent snapshot even if the map mutates during the async write.
    return (
      JSON.stringify(
        { schemaVersion: INDEX_SCHEMA_VERSION, entries: Object.fromEntries(entries) },
        null,
        2,
      ) + "\n"
    );
  }

  async function writeAtomic(json: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    // Per-flush UNIQUE temp path so two writers can never collide on it, and a
    // crash/concurrent-read never sees a half-written target (§7.5).
    const tmp = join(dir, `${INDEX_FILENAME}.${++tmpCounter}.tmp`);
    try {
      await writeFile(tmp, json, "utf8");
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {}); // best-effort temp cleanup
      throw err;
    }
  }

  async function flush(): Promise<void> {
    if (!enabled) return; // disabled: no-op (§7.6)
    cancelDebounce();
    if (flushing) {
      // A write is mid-flight; do not start a second concurrent writer. Wait for
      // it, then re-flush iff new dirty state accumulated during that write.
      await flushing;
      if (dirty) await flush();
      return;
    }
    if (!dirty) return;
    dirty = false; // claim the current dirty state; new upserts re-set it
    const json = serialize();
    flushing = writeAtomic(json);
    try {
      await flushing;
    } catch (err) {
      dirty = true; // write failed → stay dirty so the next flush retries (§11)
      console.warn(`[CSM] session index flush failed: ${String(err)}`);
    } finally {
      flushing = null;
    }
  }

  function isDirty(): boolean {
    return dirty || flushing !== null;
  }
```

Keep the existing `return { load, get, upsert, prune, flush, isDirty };` (the names now resolve to the real implementations; `cancelDebounce` stays module-local, called only by `flush()`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run test/main/sessionIndex.test.ts`
Expected: PASS — all sessionIndex tests, including the Task-2 round-trip test.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/sessionIndex.ts test/main/sessionIndex.test.ts
git commit -m "feat: sessionIndex single-writer atomic debounced flush (#116)"
```

Expected typecheck: clean (0 errors).

---

## Task 4: `quitFlush` — before-quit flush handler

**Files:**
- Create: `src/quitFlush.ts`
- Test: `test/main/quitFlush.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `createBeforeQuitHandler(deps: { isDirty: () => boolean; flush: () => Promise<void>; quit: () => void }): (event: { preventDefault: () => void }) => void`.

- [ ] **Step 1: Write the failing tests**

Create `test/main/quitFlush.test.ts`:

```ts
import { test, expect, vi } from "vitest";
import { createBeforeQuitHandler } from "../../src/quitFlush";

// A tiny deferred so the test can observe the "quit waits for flush" ordering.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("clean index: handler does nothing, quit proceeds normally", () => {
  const flush = vi.fn(async () => {});
  const quit = vi.fn();
  const preventDefault = vi.fn();
  const handler = createBeforeQuitHandler({ isDirty: () => false, flush, quit });
  handler({ preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
});

test("dirty index: prevents quit, flushes, then re-quits after flush resolves", async () => {
  const d = deferred();
  const flush = vi.fn(() => d.promise);
  const quit = vi.fn();
  const preventDefault = vi.fn();
  const handler = createBeforeQuitHandler({ isDirty: () => true, flush, quit });

  handler({ preventDefault });
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(quit).not.toHaveBeenCalled(); // quit is held until flush resolves

  d.resolve();
  await d.promise;
  await Promise.resolve(); // let the .finally microtask run
  expect(quit).toHaveBeenCalledTimes(1);
});

test("re-quits even if flush rejects (never hangs the app)", async () => {
  const flush = vi.fn(async () => {
    throw new Error("EPERM");
  });
  const quit = vi.fn();
  const handler = createBeforeQuitHandler({ isDirty: () => true, flush, quit });
  handler({ preventDefault: () => {} });
  await Promise.resolve();
  await Promise.resolve();
  expect(quit).toHaveBeenCalledTimes(1);
});

test("idempotent: a second before-quit (the re-quit) does not prevent again", async () => {
  const flush = vi.fn(async () => {});
  const quit = vi.fn();
  const preventDefault = vi.fn();
  const handler = createBeforeQuitHandler({ isDirty: () => true, flush, quit });

  handler({ preventDefault }); // first pass: prevents + flushes
  await Promise.resolve();
  await Promise.resolve();
  // The re-quit fires before-quit a second time; isDirty is still true in this
  // fake, but the `quitting` guard must let it through without preventing.
  handler({ preventDefault });
  expect(preventDefault).toHaveBeenCalledTimes(1); // not called on the 2nd pass
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run test/main/quitFlush.test.ts`
Expected: FAIL — cannot find module `../../src/quitFlush`.

- [ ] **Step 3: Implement**

Create `src/quitFlush.ts`:

```ts
// The before-quit flush handshake (spec §7.5, §9). Electron does NOT delay quit
// for a fire-and-forget async task, so a dirty index must preventDefault, await
// the async atomic flush, then re-invoke quit. The `quitting` guard makes the
// re-quit pass through cleanly. Extracted from main.ts so it is unit-testable
// without an Electron runtime — main.ts only wires the real callbacks in.

export interface QuitFlushDeps {
  /** True when the index has unpersisted changes or a write is in flight. */
  isDirty: () => boolean;
  /** Single-writer atomic flush; cancels its own debounce internally. */
  flush: () => Promise<void>;
  /** Re-invoke the quit that this handler intercepted (e.g. app.quit). */
  quit: () => void;
}

export function createBeforeQuitHandler(
  deps: QuitFlushDeps,
): (event: { preventDefault: () => void }) => void {
  let quitting = false;
  return (event) => {
    // Second pass (our own re-quit) or a clean index → let quit proceed.
    if (quitting || !deps.isDirty()) return;
    event.preventDefault();
    quitting = true;
    // Flush, then quit regardless of flush success — never hang the app on an
    // index-write error (§11). The re-quit fires before-quit again; `quitting`
    // is now true so it falls through to a real quit.
    void deps.flush().finally(deps.quit);
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run test/main/quitFlush.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/quitFlush.ts test/main/quitFlush.test.ts
git commit -m "feat: before-quit flush handshake helper (#116)"
```

---

## Task 5: `sessionStore` — metadata via the persistent index + prune

**Files:**
- Modify: `src/sessionStore.ts`
- Test: `test/main/sessionStore.test.ts`

**Interfaces:**
- Consumes: `createSessionIndex`, `IndexEntry`, `SessionIndex` from `./sessionIndex`.
- Produces: `createSessionStore(rootDir, deps)` — `StoreDeps` gains optional `index?: SessionIndex` (defaults to a disabled in-memory index, so existing callers/tests are unchanged). `FileEntry` gains `size`. `scan()` now loads the index, reuses on `mtime:size` hit, upserts on miss, and prunes after a complete scan.

- [ ] **Step 1: Write the failing tests**

Append to `test/main/sessionStore.test.ts` (the helpers `writeSession`, `scanNow`, `root`, `NOW_MS`, `DAY_MS` already exist in the file):

Add one import at the top of `test/main/sessionStore.test.ts` (the `node:fs` helpers `mkdtempSync`, `statSync`, `readFileSync`, `writeFileSync`, `utimesSync`, `rmSync`, `readdirSync` are already imported there):

```ts
import { createSessionIndex } from "../../src/sessionIndex";
```

Then add the helper and tests:

```ts
// A real enabled index backed by its own temp userData dir, wired into the store.
function enabledIndex() {
  const userData = mkdtempSync(join(tmpdir(), "csm-idx-store-"));
  const index = createSessionIndex({ dir: userData, enabled: true, debounceMs: 0 });
  return { userData, index };
}

test("scan persists metadata; a fresh store over the same index skips re-parse", async () => {
  writeSession(
    "enc-a",
    "11111111-1111-4111-8111-111111111111",
    [{ type: "system", cwd: "/proj", timestamp: "2026-06-30T10:00:00.000Z" }],
    0,
  );
  const { index } = enabledIndex();
  const parse = vi.fn((id: string, c: string) => ({
    sessionId: id,
    cwd: "/proj",
    title: "t",
    permissionMode: "default" as const,
    lastActivity: "2026-06-30T10:00:00.000Z",
    gitBranch: null,
  }));
  const store1 = createSessionStore(root, { index, parse });
  await scanNow(store1);
  expect(parse).toHaveBeenCalledTimes(1);

  // A new store instance over the SAME loaded index re-scans with no re-parse.
  parse.mockClear();
  const store2 = createSessionStore(root, { index, parse });
  await scanNow(store2);
  expect(parse).toHaveBeenCalledTimes(0); // mtime:size hit
});

test("a size-only change (same mtime) still invalidates the metadata entry", async () => {
  const file = writeSession(
    "enc-a",
    "11111111-1111-4111-8111-111111111111",
    [{ type: "system", cwd: "/proj", timestamp: "2026-06-30T10:00:00.000Z" }],
    0,
  );
  const { index } = enabledIndex();
  const parse = vi.fn((id: string) => ({
    sessionId: id,
    cwd: "/proj",
    title: "t",
    permissionMode: "default" as const,
    lastActivity: "2026-06-30T10:00:00.000Z",
    gitBranch: null,
  }));
  const store = createSessionStore(root, { index, parse });
  await scanNow(store);
  expect(parse).toHaveBeenCalledTimes(1);

  // Grow the file but PIN the mtime back to its original value.
  const original = statSync(file).mtime;
  writeFileSync(file, readFileSync(file, "utf8") + "\n{}");
  utimesSync(file, original, original);
  parse.mockClear();
  await scanNow(store);
  expect(parse).toHaveBeenCalledTimes(1); // size changed → miss despite same mtime
});

test("prune removes a deleted session's entry after a complete scan", async () => {
  writeSession("enc-a", "11111111-1111-4111-8111-111111111111", [{ type: "system", cwd: "/p", timestamp: "2026-06-30T10:00:00.000Z" }], 0);
  const gone = writeSession("enc-a", "22222222-2222-4222-8222-222222222222", [{ type: "system", cwd: "/p", timestamp: "2026-06-30T10:00:00.000Z" }], 0);
  const { index } = enabledIndex();
  const store = createSessionStore(root, { index });
  await scanNow(store);
  expect(index.get("22222222-2222-4222-8222-222222222222")).toBeDefined();

  rmSync(gone);
  await scanNow(store);
  expect(index.get("22222222-2222-4222-8222-222222222222")).toBeUndefined();
  expect(index.get("11111111-1111-4111-8111-111111111111")).toBeDefined();
});

test("an empty/unreadable root does NOT prune the existing index", async () => {
  writeSession("enc-a", "11111111-1111-4111-8111-111111111111", [{ type: "system", cwd: "/p", timestamp: "2026-06-30T10:00:00.000Z" }], 0);
  const { index } = enabledIndex();
  await scanNow(createSessionStore(root, { index }));
  expect(index.get("11111111-1111-4111-8111-111111111111")).toBeDefined();

  // Scan a root with zero session files — must not wipe the index (transient
  // failure guard: a scan that observed nothing never evicts).
  const emptyRoot = mkdtempSync(join(tmpdir(), "csm-empty-"));
  await scanNow(createSessionStore(emptyRoot, { index }));
  expect(index.get("11111111-1111-4111-8111-111111111111")).toBeDefined();
  rmSync(emptyRoot, { recursive: true, force: true });
});

test("read-only: fixture dir is byte-identical after an index-backed scan", async () => {
  writeSession("e", "11111111-1111-4111-8111-111111111111", [{ type: "system", cwd: "/p", timestamp: "2026-06-30T10:00:00.000Z" }], 0);
  const { index } = enabledIndex();
  const snapshot = () =>
    readdirSync(root, { recursive: true })
      .map(String)
      .sort()
      .map((rel) => {
        const abs = join(root, rel);
        const st = statSync(abs);
        return st.isDirectory() ? `${rel}/` : `${rel}:${st.mtimeMs}:${readFileSync(abs, "utf8")}`;
      });
  const before = snapshot();
  await scanNow(createSessionStore(root, { index }));
  expect(snapshot()).toEqual(before); // index writes went to userData, not root
});
```

All `node:fs` helpers used above (`mkdtempSync`, `statSync`, `readFileSync`, `writeFileSync`, `utimesSync`, `rmSync`, `readdirSync`) are already imported at the top of `sessionStore.test.ts` (see the file header, lines 2–12). If any is missing, add it to that existing import block.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run test/main/sessionStore.test.ts`
Expected: FAIL — `index` is not an accepted dep / metadata not persisted / prune not applied.

- [ ] **Step 3: Implement the store metadata path**

Edit `src/sessionStore.ts`:

1. Extend imports:

```ts
import {
  createSessionIndex,
  type IndexEntry,
  type SessionIndex,
} from "./sessionIndex";
```

2. Add `size` to `FileEntry`:

```ts
interface FileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}
```

3. In `collectFiles`, capture size from the same `stat`:

```ts
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = await stat(path);
        files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Unreadable between readdir and stat (e.g. removed) — skip.
      }
    }
```

4. Extend `StoreDeps`:

```ts
export interface StoreDeps {
  parse?: (sessionId: string, content: string) => SessionMetadata;
  /** Injectable so tests can spy fact-parse call counts (cache behaviour). */
  extractFacts?: (sessionId: string, content: string) => SessionFacts;
  /** The persistent metadata/facts index (spec 2026-07-07). Defaults to a
   *  disabled in-memory index → today's ephemeral behaviour when none is
   *  injected (used by the many existing tests that construct a bare store). */
  index?: SessionIndex;
}
```

5. In `createSessionStore`, replace the two Map declarations (`const cache = ...` and `const factCache = ...`) with the injected index and helpers, and keep `pathById`:

```ts
export function createSessionStore(rootDir: string, deps: StoreDeps = {}) {
  const parse = deps.parse ?? parseSession;
  const extractFacts = deps.extractFacts ?? extractSessionFacts;
  // Disabled in-memory index when none injected: get/upsert work in memory,
  // load is empty, flush is a no-op — precisely today's ephemeral cache (§7.6).
  const index = deps.index ?? createSessionIndex({ dir: "", enabled: false });
  const pathById = new Map<string, string>();
  // Shared in-flight set for the startBackfill() seam (Task 7). De-dups a
  // session being computed between the (unused-in-#116) loop and a lazy getFacts.
  const inFlight = new Set<string>();

  // Rebuild a SessionMetadata from a persisted entry (the map key is the id, and
  // messageCount is intentionally not persisted — no consumer; the row uses
  // SessionFacts.messageCount, spec §5).
  function metaFromEntry(id: string, e: IndexEntry): SessionMetadata {
    return {
      sessionId: id,
      cwd: e.cwd,
      title: e.title,
      permissionMode: e.permissionMode,
      lastActivity: e.lastActivity,
      gitBranch: e.gitBranch,
      ...(e.version !== undefined ? { version: e.version } : {}),
    };
  }
```

6. Replace `readMetadata` with an index-backed version:

```ts
  async function readMetadata(entry: FileEntry): Promise<SessionMetadata | null> {
    const id = sessionIdOf(entry.path);
    const existing = index.get(id);
    // Hit: mtime AND size match the persisted freshness key → no read, no parse.
    if (existing && existing.mtime === entry.mtimeMs && existing.size === entry.size) {
      return metaFromEntry(id, existing);
    }

    let content: string;
    try {
      content = await readFile(entry.path, "utf8");
    } catch {
      return null; // vanished/unreadable — skip this file, keep scanning.
    }

    const meta = parse(id, content);
    // Parser returns null lastActivity when no record carried a timestamp; fall
    // back to the file's mtime so every session has an orderable time (spec §4.1).
    const lastActivity =
      meta.lastActivity ?? new Date(entry.mtimeMs).toISOString();
    // Miss (new or changed key) → write the metadata tier. A changed key drops
    // any stale facts by replacing the whole entry (spec §7.2).
    index.upsert(id, {
      mtime: entry.mtimeMs,
      size: entry.size,
      cwd: meta.cwd,
      title: meta.title,
      permissionMode: meta.permissionMode,
      lastActivity,
      gitBranch: meta.gitBranch,
      ...(meta.version !== undefined ? { version: meta.version } : {}),
    });
    return metaFromEntry(id, index.get(id)!);
  }
```

7. In `scan`, load the index first, and prune + flush after the complete scan. Change the top of `scan`:

```ts
  async function scan(opts: ScanOptions): Promise<GroupedSessions> {
    const { now, onBatch } = opts;
    await index.load(); // idempotent — reads disk at most once
    const files = await collectFiles(rootDir);
    // Rebuild the id->path map each scan so sessions deleted between scans
    // don't linger as stale entries (the map is exactly one scan's worth).
    pathById.clear();
    for (const f of files) pathById.set(sessionIdOf(f.path), f.path);
```

and, just before `return { folders };` at the end of `scan`, add:

```ts
    // Prune ONLY after a complete scan, and never on a scan that observed no
    // files (a missing/transiently-unreadable root returns []). This keeps the
    // persisted map a subset of sessions present at the last complete scan and
    // avoids wiping the index on a transient failure (spec §7.2, §11).
    if (files.length > 0) {
      index.prune(new Set(pathById.keys()));
    }
    await index.flush();
    return { folders };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run test/main/sessionStore.test.ts`
Expected: PASS — new tests plus all pre-existing sessionStore metadata tests (the unchanged-mtime "0 parses" test still holds: a hit reuses `metaFromEntry`).

- [ ] **Step 5: Commit**

```bash
git add src/sessionStore.ts test/main/sessionStore.test.ts
git commit -m "feat: back sessionStore metadata with the persistent index + prune (#116)"
```

---

## Task 6: `sessionStore` — facts served and persisted through the index

**Files:**
- Modify: `src/sessionStore.ts`
- Test: `test/main/sessionStore.facts.test.ts`

**Interfaces:**
- Consumes: the index + `metaFromEntry` from Task 5; `IndexFacts` from `./sessionIndex`.
- Produces: `getFacts` now serves from `entry.facts` (freshness-checked) and persists a computed fact onto the entry when the scan-time metadata version still matches the file. Adds two pure helpers `factsFromEntry` / `toIndexFacts`.

- [ ] **Step 1: Write / adjust the tests**

In `test/main/sessionStore.facts.test.ts`, make two changes:

(a) Wire an enabled index into the two spy-based tests so persistence is exercised, and change the **object-identity** assertion to **value-equality** (the returned facts are now reconstructed from the persisted entry, so they are equal but not the same reference — the spy-call-count, not identity, proves the cache hit). Replace the test `"returns facts for a scanned session and caches by mtime:size"` body with:

```ts
  test("returns facts for a scanned session and caches by mtime:size", async () => {
    const root = fixtureRoot();
    const userData = mkdtempSync(join(tmpdir(), "csm-facts-idx-"));
    createdRoots.push(userData);
    const index = createSessionIndex({ dir: userData, enabled: true, debounceMs: 0 });
    const spy = vi.fn(
      (id: string, c: string) =>
        ({
          sessionId: id,
          messageCount: 1,
          firstActivity: null,
          lastActivity: null,
          editedFileCount: 0,
          firstModel: null,
          distinctModelCount: 0,
          outputTokens: c.length,
        }) as SessionFacts,
    );
    const store = createSessionStore(root, { extractFacts: spy, index });
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });

    const a = await store.getFacts([UUID]);
    const b = await store.getFacts([UUID]);
    expect((a[UUID] as SessionFacts).messageCount).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1); // second call is a cache hit
    expect(b[UUID]).toEqual(a[UUID]); // value-equal (reconstructed from the entry)
  });
```

Add the import at the top of the file:

```ts
import { createSessionIndex } from "../../src/sessionIndex";
```

(b) Add a new test asserting facts survive into a fresh store over the same index (the headline persistence win):

```ts
  test("computed facts persist across a fresh store over the same index", async () => {
    const root = fixtureRoot();
    const userData = mkdtempSync(join(tmpdir(), "csm-facts-persist-"));
    createdRoots.push(userData);
    const index = createSessionIndex({ dir: userData, enabled: true, debounceMs: 0 });

    const spy1 = vi.fn(() => ({ sessionId: UUID, messageCount: 7, firstActivity: null, lastActivity: null, editedFileCount: 0, firstModel: null, distinctModelCount: 0, outputTokens: 3 }) as SessionFacts);
    const store1 = createSessionStore(root, { extractFacts: spy1, index });
    await store1.scan({ now: Date.parse("2026-07-01T00:00:00Z") });
    await store1.getFacts([UUID]);
    await index.flush();
    expect(spy1).toHaveBeenCalledTimes(1);

    // A brand-new index instance loads the persisted facts from disk.
    const index2 = createSessionIndex({ dir: userData, enabled: true, debounceMs: 0 });
    const spy2 = vi.fn(() => ({ sessionId: UUID, messageCount: 99, firstActivity: null, lastActivity: null, editedFileCount: 0, firstModel: null, distinctModelCount: 0, outputTokens: 0 }) as SessionFacts);
    const store2 = createSessionStore(root, { extractFacts: spy2, index: index2 });
    await store2.scan({ now: Date.parse("2026-07-01T00:00:00Z") });
    const res = await store2.getFacts([UUID]);
    expect((res[UUID] as SessionFacts).messageCount).toBe(7); // from disk, not recomputed
    expect(spy2).not.toHaveBeenCalled();
  });
```

Ensure `mkdtempSync` and `join`/`tmpdir` are imported (they already are in this file).

The existing tests `"rejects a non-UUID id..."`, `"re-parses when the file grows (new size)"`, and `"returns error (not cached) for an unknown/vanished id"` stay as-is and must remain green.

- [ ] **Step 2: Run the tests to verify the new/changed ones fail**

Run: `./node_modules/.bin/vitest run test/main/sessionStore.facts.test.ts`
Expected: FAIL — facts are not yet persisted to the index / `getFacts` still reads the removed `factCache`.

- [ ] **Step 3: Implement facts via the index**

In `src/sessionStore.ts`:

1. Import `IndexFacts`:

```ts
import {
  createSessionIndex,
  type IndexEntry,
  type IndexFacts,
  type SessionIndex,
} from "./sessionIndex";
```

2. Add two pure helpers next to `metaFromEntry`:

```ts
  // SessionFacts reconstructed from a warm entry: firstActivity from facts,
  // lastActivity from the entry level (de-duped, spec §5).
  function factsFromEntry(id: string, e: IndexEntry): SessionFacts {
    const f = e.facts!;
    return {
      sessionId: id,
      messageCount: f.messageCount,
      firstActivity: f.firstActivity,
      lastActivity: e.lastActivity,
      editedFileCount: f.editedFileCount,
      firstModel: f.firstModel,
      distinctModelCount: f.distinctModelCount,
      outputTokens: f.outputTokens,
    };
  }

  // The persisted facts subset (drops sessionId → the map key, and lastActivity
  // → stored once at entry level).
  function toIndexFacts(f: SessionFacts): IndexFacts {
    return {
      messageCount: f.messageCount,
      firstActivity: f.firstActivity,
      editedFileCount: f.editedFileCount,
      firstModel: f.firstModel,
      distinctModelCount: f.distinctModelCount,
      outputTokens: f.outputTokens,
    };
  }
```

3. Replace `getOneFacts` with the index-backed version:

```ts
  // Per-id worker. Returns cached/fresh facts, or { error: true } for any
  // validation or I/O failure. Errors are never persisted so transient failures
  // retry (the #115 rule).
  async function getOneFacts(
    id: string,
  ): Promise<SessionFacts | { error: true }> {
    // UUID gate BEFORE any path use — a hostile id can never reach the filesystem.
    if (!isValidSessionId(id)) return { error: true };
    const path = pathById.get(id);
    if (!path) return { error: true };

    let st;
    try {
      st = await stat(path);
    } catch {
      return { error: true };
    }

    const entry = index.get(id);
    const keyMatches =
      entry !== undefined && entry.mtime === st.mtimeMs && entry.size === st.size;
    // Warm hit: fresh entry that already carries facts.
    if (keyMatches && entry!.facts) return factsFromEntry(id, entry!);

    inFlight.add(id);
    try {
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch {
        return { error: true }; // NOT persisted: a transient failure retries.
      }
      const facts = extractFacts(id, content);
      // Persist facts ONLY when the scan-time metadata version still matches the
      // current file — so persisted facts always sit on fresh metadata. If the
      // file changed since scan (or has no entry yet), return transiently; the
      // next scan refreshes the entry and a later pull persists (spec §7.3).
      if (keyMatches) {
        index.upsert(id, { ...entry!, facts: toIndexFacts(facts) });
        return factsFromEntry(id, index.get(id)!);
      }
      return facts;
    } finally {
      inFlight.delete(id);
    }
  }
```

(No change needed to `getFacts` — it still fans `getOneFacts` over the id array.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run test/main/sessionStore.facts.test.ts`
Expected: PASS (all facts tests, including the new persistence test).

- [ ] **Step 5: Commit**

```bash
git add src/sessionStore.ts test/main/sessionStore.facts.test.ts
git commit -m "feat: serve and persist session facts through the index (#116)"
```

---

## Task 7: `sessionStore` — `startBackfill()` seam (built, not run)

**Files:**
- Modify: `src/sessionStore.ts`
- Test: `test/main/sessionStore.facts.test.ts` (a new `describe` block)

**Interfaces:**
- Consumes: `getOneFacts`, `pathById`, `inFlight`, `index` from Tasks 5–6.
- Produces: `createSessionStore(...)` return object gains `startBackfill(): Promise<void>` and `inFlight: Set<string>`. **Nothing in #116 invokes `startBackfill()`** — it is a seam (spec §7.4).

- [ ] **Step 1: Write the failing tests**

Append to `test/main/sessionStore.facts.test.ts`:

```ts
describe("sessionStore.startBackfill (seam — not auto-run in #116)", () => {
  test("computes + persists facts for every scanned session, and is idempotent", async () => {
    const root = fixtureRoot();
    const userData = mkdtempSync(join(tmpdir(), "csm-backfill-"));
    createdRoots.push(userData);
    const index = createSessionIndex({ dir: userData, enabled: true, debounceMs: 0 });
    const spy = vi.fn((id: string) => ({ sessionId: id, messageCount: 1, firstActivity: null, lastActivity: null, editedFileCount: 0, firstModel: null, distinctModelCount: 0, outputTokens: 0 }) as SessionFacts);
    const store = createSessionStore(root, { extractFacts: spy, index });
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });

    await store.startBackfill();
    expect(spy).toHaveBeenCalledTimes(1); // the one fixture session got facts
    expect(index.get(UUID)?.facts).toBeDefined();

    // Second run: everything is warm → no recompute (idempotent).
    spy.mockClear();
    await store.startBackfill();
    expect(spy).not.toHaveBeenCalled();
  });

  test("skips a session already in flight (in-flight Set de-dup)", async () => {
    const root = fixtureRoot();
    const userData = mkdtempSync(join(tmpdir(), "csm-backfill-inflight-"));
    createdRoots.push(userData);
    const index = createSessionIndex({ dir: userData, enabled: true, debounceMs: 0 });
    const spy = vi.fn((id: string) => ({ sessionId: id, messageCount: 1, firstActivity: null, lastActivity: null, editedFileCount: 0, firstModel: null, distinctModelCount: 0, outputTokens: 0 }) as SessionFacts);
    const store = createSessionStore(root, { extractFacts: spy, index });
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });

    // Simulate a concurrent lazy pull already computing this id.
    store.inFlight.add(UUID);
    await store.startBackfill();
    expect(spy).not.toHaveBeenCalled(); // skipped — owned by the in-flight pull
    store.inFlight.delete(UUID);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run test/main/sessionStore.facts.test.ts`
Expected: FAIL — `store.startBackfill is not a function` / `store.inFlight` undefined.

- [ ] **Step 3: Implement the seam**

In `src/sessionStore.ts`, add `startBackfill` just before the final `return`:

```ts
  // Facts-completion seam (spec §7.4): compute + persist facts for every scanned
  // session that lacks warm facts, yielding to the event loop between files. BUILT
  // but NOT auto-invoked in #116 — the first consumer that needs guaranteed-complete
  // facts (faceting / #118) calls it on demand.
  async function startBackfill(): Promise<void> {
    await index.load();
    for (const id of [...pathById.keys()]) {
      const e = index.get(id);
      if (e?.facts) continue; // already warm
      if (inFlight.has(id)) continue; // a concurrent lazy pull owns it
      await getOneFacts(id); // computes + persists via the shared path
      await new Promise<void>((r) => setImmediate(r)); // cooperative yield
    }
    await index.flush();
  }
```

and extend the return object:

```ts
  return { scan, getFacts, startBackfill, inFlight };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run test/main/sessionStore.facts.test.ts`
Expected: PASS (all facts + backfill tests).

- [ ] **Step 5: Full store suite + typecheck + commit**

```bash
./node_modules/.bin/vitest run test/main/sessionStore.test.ts test/main/sessionStore.facts.test.ts
npm run typecheck
git add src/sessionStore.ts test/main/sessionStore.facts.test.ts
git commit -m "feat: add startBackfill facts-completion seam to sessionStore (#116)"
```

Expected: PASS; typecheck clean.

---

## Task 8: `main.ts` — construct the index, wire the store factory and quit handshake

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `createSessionIndex` (`./sessionIndex`), `createBeforeQuitHandler` (`./quitFlush`), `settingsStore.getIndexEnabled`, `createSessionStore` (`./sessionStore`).
- Produces: no exported API (Electron entry point). Verified by typecheck + build; `main.ts` has no unit test in this repo (it is the Electron shell), consistent with the existing convention.

- [ ] **Step 1: Add imports**

At the top of `src/main.ts`, alongside the existing `createSessionStore`/`createSettingsStore` imports:

```ts
import { createSessionIndex } from "./sessionIndex";
import { createBeforeQuitHandler } from "./quitFlush";
```

- [ ] **Step 2: Move the session-bridge registration into `whenReady` and construct the index there**

`getIndexEnabled()` is async, so the index must be built after it resolves — inside `whenReady`, before the window loads (the renderer cannot invoke IPC until after its post-`createWindow` load). Remove the top-level `registerIpcHandlers({ ... })` call (the block starting `registerIpcHandlers({` and ending `});` near the `now: () => Date.now(),` line). Keep the top-level `const settingsStore = createSettingsStore(app.getPath("userData"));`, the `shellOpenExternal` handler, and `registerWindowControls` where they are.

Then, inside `app.whenReady().then(async () => { ... })`, after the existing `nativeTheme.themeSource = await settingsStore.getTheme();` line, insert:

```ts
    // Persistent session index (#116). Read the privacy opt-out, construct the
    // index against userData, and load it once before any scan. A disabled
    // setting degrades to an in-memory-only cache (no disk writes).
    const indexEnabled = await settingsStore.getIndexEnabled();
    const sessionIndex = createSessionIndex({
      dir: app.getPath("userData"),
      enabled: indexEnabled,
    });
    await sessionIndex.load();

    registerIpcHandlers({
      ipcMain,
      isTrustedSender: isMainWindowSender,
      // Bind the shared index into every store the bridge creates, so scan/getFacts
      // read and write the one persistent cache.
      createSessionStore: (root) =>
        createSessionStore(root, { index: sessionIndex }),
      settingsStore,
      reopen: reopenSession,
      setNativeTheme: (source) => {
        nativeTheme.themeSource = source;
      },
      tempRoots: () => tempRoots(),
      projectsRoot: defaultProjectsRoot(),
      platform: process.platform,
      now: () => Date.now(),
    });

    // Flush a dirty index on quit. Electron does not delay quit for a
    // fire-and-forget async task, so intercept before-quit, flush, then re-quit.
    app.on(
      "before-quit",
      createBeforeQuitHandler({
        isDirty: () => sessionIndex.isDirty(),
        flush: () => sessionIndex.flush(),
        quit: () => app.quit(),
      }),
    );
```

Leave the rest of `whenReady` (menu, `installCsp`, `createWindow`) unchanged and after this block.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean (0 errors). If `createSessionStore` is now only referenced inside the closure, confirm its top-level import is still used (it is — the bound factory calls it).

- [ ] **Step 4: Build the main bundle**

Run: `npm run build:main`
Expected: `tsc -p tsconfig.json` succeeds with no errors (compiles `src/*.ts` → `dist/`).

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire persistent index + before-quit flush into main (#116)"
```

---

## Task 9: Full-suite verification gate

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: `eslint . && prettier --check .` both clean. If prettier flags formatting, run `./node_modules/.bin/prettier --write .` on the changed files and re-check, then amend the touching commit or add a `style:` commit.

- [ ] **Step 2: Typecheck all three projects**

Run: `npm run typecheck`
Expected: `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.renderer.json && tsc -p tsconfig.node.json` all clean.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all suites green (the 3 modified test files + 2 new ones + every pre-existing suite). No skipped/only tests.

- [ ] **Step 4: Build everything**

Run: `npm run build`
Expected: `build:main` + `build:preload` + `build:renderer` all succeed.

- [ ] **Step 5: Confirm the read-only + userData-only invariants hold in the diff**

Manually re-read the diff of `src/sessionStore.ts` and `src/sessionIndex.ts`: confirm no write/rename/unlink targets anything other than the injected `userData` dir, and that no source `.jsonl` path is ever passed to a write. This mirrors the test-level assertion and is the hard CLAUDE.md constraint.

---

## Notes carried from the spec (decisions the implementer must not silently re-litigate)

- **`messageCount` is not persisted in the metadata tier** and is absent from `metaFromEntry` output. No consumer reads `SessionMetadata.messageCount` (the row uses `SessionFacts.messageCount`); the spec §5 de-dups it into `facts`. This is intentional, not an omission.
- **`lastActivity` is stored once at the entry level**, not duplicated in `facts`. `factsFromEntry` reconstructs `SessionFacts.lastActivity` from `entry.lastActivity`. The change from object-identity to value-equality in `sessionStore.facts.test.ts` (Task 6) follows directly from this reconstruction and is the only pre-existing assertion this plan changes.
- **Facts persist only when the scan-time key still matches the file** (Task 6, `keyMatches`). A file changed between scan and the facts pull returns facts transiently and self-heals on the next scan — this preserves the invariant that persisted facts always sit on fresh metadata.
- **`startBackfill()` is built but never invoked in #116** (Task 7). Do not add a caller. Its first consumer is a later issue (faceting / #118), tracked in spec §14.
- **No renderer / IPC changes.** `session:getFacts` and its `isValidSessionId` UUID gate are unchanged; the index is a main-process implementation detail behind the same IPC surface. A UI toggle for `indexEnabled` is out of scope (the setting is honored at startup; hand-editing `settings.json` is the opt-out this slice ships, per spec §8).
```
