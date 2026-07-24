import { test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
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

test("a pre-#176 (schemaVersion 1) index is discarded so renamed sessions rebuild", async () => {
  // The title derivation changed in #176 (custom-title/rename now composes into
  // the title). Closed sessions are served from the mtime+size cache and their
  // files never change, so the old cached titles must be invalidated by the bump
  // rather than served forever. schemaVersion 1 was the shipped production version.
  expect(INDEX_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  writeRaw(JSON.stringify({ schemaVersion: 1, entries: { "id-1": entry() } }));
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

test("two overlapping flushes where the write FAILS neither throw nor leak an unhandled rejection", async () => {
  // Point the index at a dir whose parent is a FILE, so writeAtomic's mkdir always
  // rejects — a portable stand-in for a real write failure (EPERM/disk-full). The
  // primary flush swallows the rejection (fail-soft, §11); the concurrent waiter
  // shares the same in-flight promise and must NOT re-throw it (bare `await
  // flushing` would surface as an unhandled rejection and crash the awaiting scan).
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x");
  const idx = createSessionIndex({
    dir: join(blocker, "sub"),
    enabled: true,
    debounceMs: 0,
  });
  idx.upsert("id-1", entry());

  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    // Primary + concurrent waiter over the same failing write. Neither rejects.
    await Promise.all([idx.flush(), idx.flush()]);
    // Give any stray rejection a macrotask to surface.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(rejections).toEqual([]);
    // Write failed → the index stays dirty so a later flush retries (§11).
    expect(idx.isDirty()).toBe(true);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
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
