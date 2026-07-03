import { test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionStore,
  tierIndex,
  type GroupedSessions,
} from "../../src/sessionStore";
import type { SessionMetadata } from "../../src/sessionParser";

// sessionStore is the I/O layer: it walks <root>/<encoded-cwd>/<id>.jsonl, feeds
// each file's TEXT to the pure parser, groups by the authoritative in-file cwd,
// and caches by filepath+mtime. Tested against a real temp fixture dir (no
// Electron, no fs mocking) so the read-only invariant is exercised for real.

const DAY_MS = 86_400_000;
const NOW_MS = new Date("2026-06-30T12:00:00.000Z").getTime();

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "csm-store-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Write <root>/<folder>/<id>.jsonl from records, stamped `ageDays` before NOW.
function writeSession(
  folder: string,
  id: string,
  records: unknown[],
  ageDays: number,
): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"));
  const t = new Date(NOW_MS - ageDays * DAY_MS);
  utimesSync(file, t, t);
  return file;
}

const scanNow = (
  store: {
    scan: (o: {
      now: number;
      onBatch?: (s: SessionMetadata[]) => void;
    }) => Promise<GroupedSessions>;
  },
  onBatch?: (s: SessionMetadata[]) => void,
) => store.scan({ now: NOW_MS, onBatch });

test("tierIndex: boundaries and overflow", () => {
  expect(tierIndex(0)).toBe(0);
  expect(tierIndex(1 * DAY_MS)).toBe(0);
  expect(tierIndex(1 * DAY_MS + 1)).toBe(1);
  expect(tierIndex(3 * DAY_MS)).toBe(1);
  expect(tierIndex(7 * DAY_MS)).toBe(2);
  expect(tierIndex(14 * DAY_MS)).toBe(3);
  expect(tierIndex(30 * DAY_MS)).toBe(4);
  expect(tierIndex(30 * DAY_MS + 1)).toBe(5);
  expect(tierIndex(-DAY_MS)).toBe(0); // future mtime (clock skew) -> newest tier
});

test("happy path: groups by in-file cwd, most-recent-first within a folder", async () => {
  writeSession(
    "enc-a",
    "11111111-1111-1111-1111-111111111111",
    [
      { type: "system", cwd: "/proj/a", timestamp: "2026-06-30T09:00:00.000Z" },
      { type: "ai-title", aiTitle: "older A" },
    ],
    0,
  );
  writeSession(
    "enc-a",
    "22222222-2222-2222-2222-222222222222",
    [
      { type: "system", cwd: "/proj/a", timestamp: "2026-06-30T11:00:00.000Z" },
      { type: "ai-title", aiTitle: "newer A" },
    ],
    0,
  );
  const result = await scanNow(createSessionStore(root));
  expect(result.folders).toHaveLength(1);
  const folder = result.folders[0];
  expect(folder.cwd).toBe("/proj/a");
  expect(folder.sessions.map((s) => s.title)).toEqual(["newer A", "older A"]);
});

test("sort is chronological, not lexicographic, across mixed timestamp precision", async () => {
  // "…00Z" (no millis) is real-time OLDER than "…00.500Z" but sorts LATER as a
  // raw string (Z > .), so a lexicographic sort would order these backwards.
  writeSession(
    "e",
    "11111111-1111-1111-1111-111111111111",
    [
      { type: "system", cwd: "/p", timestamp: "2026-06-30T10:00:00Z" },
      { type: "ai-title", aiTitle: "no-millis (older)" },
    ],
    0,
  );
  writeSession(
    "e",
    "22222222-2222-2222-2222-222222222222",
    [
      { type: "system", cwd: "/p", timestamp: "2026-06-30T10:00:00.500Z" },
      { type: "ai-title", aiTitle: "with-millis (newer)" },
    ],
    0,
  );
  const result = await scanNow(createSessionStore(root));
  expect(result.folders[0].sessions.map((s) => s.title)).toEqual([
    "with-millis (newer)",
    "no-millis (older)",
  ]);
});

test("grouping: same in-file cwd across different encoded folders -> one folder", async () => {
  writeSession(
    "enc-x",
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    [{ type: "system", cwd: "/shared", timestamp: "2026-06-30T10:00:00.000Z" }],
    0,
  );
  writeSession(
    "enc-y",
    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    [{ type: "system", cwd: "/shared", timestamp: "2026-06-29T10:00:00.000Z" }],
    1,
  );
  const result = await scanNow(createSessionStore(root));
  expect(result.folders).toHaveLength(1);
  expect(result.folders[0].cwd).toBe("/shared");
  expect(result.folders[0].sessions).toHaveLength(2);
});

test("streaming: onBatch fires once per non-empty tier, newest-first, before resolve", async () => {
  writeSession(
    "e",
    "11111111-1111-1111-1111-111111111111",
    [{ type: "system", cwd: "/p", timestamp: "2026-06-30T10:00:00.000Z" }],
    0,
  ); // tier 0
  writeSession(
    "e",
    "22222222-2222-2222-2222-222222222222",
    [{ type: "system", cwd: "/p", timestamp: "2026-06-25T10:00:00.000Z" }],
    5,
  ); // tier 2 (<=7d)
  writeSession(
    "e",
    "33333333-3333-3333-3333-333333333333",
    [{ type: "system", cwd: "/p", timestamp: "2026-05-30T10:00:00.000Z" }],
    40,
  ); // tier 5 (>30d)

  const batches: string[][] = [];
  await scanNow(createSessionStore(root), (s) =>
    batches.push(s.map((m) => m.sessionId)),
  );

  expect(batches).toHaveLength(3); // one per non-empty tier, empty tiers skipped
  expect(batches[0]).toEqual(["11111111-1111-1111-1111-111111111111"]);
  expect(batches[1]).toEqual(["22222222-2222-2222-2222-222222222222"]);
  expect(batches[2]).toEqual(["33333333-3333-3333-3333-333333333333"]);
});

test("lastActivity falls back to file mtime (ISO) when parser yields null", async () => {
  // No timestamped record -> parser lastActivity is null.
  writeSession(
    "e",
    "cccccccc-cccc-cccc-cccc-cccccccccccc",
    [{ type: "ai-title", aiTitle: "no timestamp", cwd: "/p" }],
    2,
  );
  const result = await scanNow(createSessionStore(root));
  const expectedIso = new Date(NOW_MS - 2 * DAY_MS).toISOString();
  expect(result.folders[0].sessions[0].lastActivity).toBe(expectedIso);
});

test("cache: second scan re-parses only changed files", async () => {
  writeSession(
    "e",
    "11111111-1111-1111-1111-111111111111",
    [{ type: "system", cwd: "/p", timestamp: "2026-06-30T10:00:00.000Z" }],
    0,
  );
  const changing = writeSession(
    "e",
    "22222222-2222-2222-2222-222222222222",
    [{ type: "system", cwd: "/p", timestamp: "2026-06-29T10:00:00.000Z" }],
    1,
  );

  const parse = vi.fn((id: string) => {
    // A minimal metadata object good enough for grouping/sorting here; this test
    // only cares about how many times the store calls the parser, not its output.
    return {
      sessionId: id,
      cwd: "/p",
      title: id,
      permissionMode: "default" as const,
      lastActivity: "2026-06-30T10:00:00.000Z",
    } satisfies SessionMetadata;
  });
  const store = createSessionStore(root, { parse });

  await scanNow(store);
  expect(parse).toHaveBeenCalledTimes(2);

  parse.mockClear();
  await scanNow(store); // nothing changed -> all cache hits
  expect(parse).toHaveBeenCalledTimes(0);

  // Bump one file's mtime -> only that file re-parses.
  const later = new Date(NOW_MS - 0.5 * DAY_MS);
  utimesSync(changing, later, later);
  parse.mockClear();
  await scanNow(store);
  expect(parse).toHaveBeenCalledTimes(1);
});

test("skips non-.jsonl, empty, and non-dir entries; scan still completes", async () => {
  writeSession(
    "e",
    "11111111-1111-1111-1111-111111111111",
    [{ type: "system", cwd: "/p", timestamp: "2026-06-30T10:00:00.000Z" }],
    0,
  );
  writeFileSync(join(root, "e", "notes.txt"), "ignore me"); // non-jsonl
  writeFileSync(join(root, "e", "empty.jsonl"), ""); // empty -> full-fallback metadata
  writeFileSync(join(root, "loose.jsonl"), JSON.stringify({ type: "x" })); // file at root (not in a subdir)

  const result = await scanNow(createSessionStore(root));
  const ids = result.folders.flatMap((f) => f.sessions.map((s) => s.sessionId));
  expect(ids).toContain("11111111-1111-1111-1111-111111111111");
  expect(ids).not.toContain("notes"); // txt skipped
});

test("read-only: fixture dir is byte-identical after a scan", async () => {
  writeSession(
    "e",
    "11111111-1111-1111-1111-111111111111",
    [{ type: "system", cwd: "/p", timestamp: "2026-06-30T10:00:00.000Z" }],
    0,
  );
  writeSession(
    "e",
    "22222222-2222-2222-2222-222222222222",
    [{ type: "ai-title", aiTitle: "t", cwd: "/p" }],
    3,
  );

  const snapshot = () =>
    readdirSync(root, { recursive: true })
      .map(String)
      .sort()
      .map((rel) => {
        const abs = join(root, rel);
        const st = statSync(abs);
        return st.isDirectory()
          ? `${rel}/`
          : `${rel}:${st.mtimeMs}:${readFileSync(abs, "utf8")}`;
      });

  const before = snapshot();
  await scanNow(createSessionStore(root));
  expect(snapshot()).toEqual(before);
});

test("empty and missing root -> { folders: [] }, no batches", async () => {
  const empty = await scanNow(createSessionStore(root));
  expect(empty.folders).toEqual([]);

  const batches: unknown[] = [];
  const missing = await createSessionStore(join(root, "does-not-exist")).scan({
    now: NOW_MS,
    onBatch: (s) => batches.push(s),
  });
  expect(missing.folders).toEqual([]);
  expect(batches).toEqual([]);
});
