// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openSearchDb,
  SCHEMA_VERSION,
  SEARCH_DB_FILENAME,
  type ChunkWrite,
  type SearchDb,
} from "../../../src/search/searchDb";
import { emptySessionFields } from "../../../src/search/turnExtractor";
import type { PrLinkObs } from "../../../src/search/prExtractor";

const ROOT = "/projects";
let dir: string;
let db: SearchDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csm-searchdb-"));
  db = openSearchDb(dir, { platform: process.platform });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// A second, read-only connection, so assertions do not go through the API under test.
function q<T = Record<string, unknown>>(
  sql: string,
  ...args: (string | number)[]
): T[] {
  const ro = new DatabaseSync(join(dir, SEARCH_DB_FILENAME), {
    readOnly: true,
  });
  try {
    return ro.prepare(sql).all(...args) as T[];
  } finally {
    ro.close();
  }
}

const chunk = (over: Partial<ChunkWrite> = {}): ChunkWrite => ({
  root: ROOT,
  sid: "s1",
  path: "/projects/a/s1.jsonl",
  size: 100,
  cursor: { offset: 100, headLen: 100, headHash: "h", anchorHash: "a" },
  fields: {
    ...emptySessionFields(),
    cwd: "D:\\src\\x",
    titleValues: ["T1", "T2"],
  },
  title: "T1",
  turns: [],
  links: [],
  pending: [],
  extractVersion: 1,
  ...over,
});
const turn = (uuid: string | null, text: string) => ({
  uuid,
  role: "user" as const,
  ts: 1,
  text,
  searchText: text.toLowerCase(),
});
const link = (
  repo: string,
  n: number,
  over: Partial<PrLinkObs> = {},
): PrLinkObs => ({
  repo,
  number: n,
  url: `https://github.com/${repo}/pull/${n}`,
  createdHere: false,
  firstSeen: 10,
  lastSeen: 10,
  ...over,
});
const match = (term: string) =>
  q("SELECT rowid FROM fts WHERE fts MATCH ?", `"${term}"`);

describe("openSearchDb", () => {
  test("creates the schema in WAL mode at the current user_version", () => {
    expect(q("PRAGMA journal_mode")[0].journal_mode).toBe("wal");
    expect(q("PRAGMA user_version")[0].user_version).toBe(SCHEMA_VERSION);
    const tables = q<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "session",
        "turn",
        "fts",
        "pr",
        "session_pr",
        "meta",
      ]),
    );
    expect(db.ftsOk).toBe(true);
  });

  test.skipIf(process.platform === "win32")(
    "creates the file owner-only",
    () => {
      expect(statSync(join(dir, SEARCH_DB_FILENAME)).mode & 0o777).toBe(0o600);
    },
  );

  test("refuses a database written by a newer build", () => {
    db.close();
    const w = new DatabaseSync(join(dir, SEARCH_DB_FILENAME));
    w.exec("PRAGMA user_version = 99");
    w.close();
    expect(() => openSearchDb(dir, { platform: process.platform })).toThrow(
      /newer/,
    );
  });

  test("without FTS5 writes still land, and a later open rebuilds the index", () => {
    const sub = join(dir, "nofts");
    mkdirSync(sub);
    const noFts = openSearchDb(sub, {
      platform: process.platform,
      ftsDdl: "CREATE VIRTUAL TABLE fts USING no_such_module(search_text)",
    });
    expect(noFts.ftsOk).toBe(false);
    noFts.writeChunk(chunk({ turns: [turn("u1", "Rate limit")] }));
    expect(noFts.getMeta("fts_ok")).toBe("0");
    noFts.close();

    const again = openSearchDb(sub, { platform: process.platform });
    expect(again.ftsOk).toBe(true);
    again.close();
    const ro = new DatabaseSync(join(sub, SEARCH_DB_FILENAME), {
      readOnly: true,
    });
    expect(
      ro.prepare("SELECT rowid FROM fts WHERE fts MATCH '\"rate\"'").all(),
    ).toHaveLength(1);
    ro.close();
  });
});

describe("writes", () => {
  test("writeChunk round-trips session fields and the cursor", () => {
    db.writeChunk(chunk({ pending: ["t1"] }));
    expect(db.getSession(ROOT, "s1")).toMatchObject({
      cwd: "D:\\src\\x",
      title: "T1",
      titlesText: "T1\nT2",
      offset: 100,
      headLen: 100,
      headHash: "h",
      anchorHash: "a",
      pendingPrCreate: ["t1"],
      extractVersion: 1,
      missingSince: null,
      deletedAt: null,
    });
  });

  test("turns are searchable and a replayed uuid is stored once", () => {
    const r = db.writeChunk(
      chunk({
        turns: [
          turn("u1", "Rate limit"),
          turn("u1", "Rate limit"),
          turn(null, "x"),
          turn(null, "x"),
        ],
      }),
    );
    expect(r.turnsInserted).toBe(3);
    expect(q("SELECT id FROM turn")).toHaveLength(3);
    expect(
      q("SELECT rowid FROM fts WHERE fts MATCH ?", '"rate" AND "limit"'),
    ).toHaveLength(1);
  });

  test("resetSession removes turns, FTS rows and links, and rewinds the cursor", () => {
    db.writeChunk(
      chunk({
        turns: [turn("u1", "alpha")],
        links: [link("o/r", 1)],
        pending: ["t"],
      }),
    );
    db.resetSession(ROOT, "s1");
    expect(q("SELECT id FROM turn")).toEqual([]);
    expect(q("SELECT sid FROM session_pr")).toEqual([]);
    expect(match("alpha")).toEqual([]);
    expect(db.getSession(ROOT, "s1")).toMatchObject({
      offset: 0,
      headLen: 0,
      headHash: null,
      pendingPrCreate: [],
    });
  });

  test("links collapse case-insensitively and keep created_here, min first_seen, max last_seen", () => {
    db.writeChunk(
      chunk({ links: [link("O/R", 1, { firstSeen: 20, lastSeen: 20 })] }),
    );
    db.writeChunk(
      chunk({
        links: [
          link("o/r", 1, { createdHere: true, firstSeen: 10, lastSeen: null }),
        ],
      }),
    );
    db.writeChunk(
      chunk({ links: [link("O/R", 1, { firstSeen: 30, lastSeen: 30 })] }),
    );
    expect(
      q("SELECT created_here, first_seen, last_seen FROM session_pr"),
    ).toEqual([{ created_here: 1, first_seen: 10, last_seen: 30 }]);
    expect(q("SELECT repo, state FROM pr")).toEqual([
      { repo: "O/R", state: null },
    ]);
  });

  test("a write clears a tombstone", () => {
    db.writeChunk(chunk());
    db.setTombstone(ROOT, "s1", { missingSince: 5, deletedAt: 6 });
    expect(db.getSession(ROOT, "s1")).toMatchObject({
      missingSince: 5,
      deletedAt: 6,
    });
    db.writeChunk(chunk());
    expect(db.getSession(ROOT, "s1")).toMatchObject({
      missingSince: null,
      deletedAt: null,
    });
  });

  test("setPath, restampTitle and listSessions", () => {
    db.writeChunk(chunk());
    db.setPath(ROOT, "s1", "/projects/b/s1.jsonl");
    db.restampTitle(ROOT, "s1", "New", 2);
    expect(db.getSession(ROOT, "s1")).toMatchObject({
      path: "/projects/b/s1.jsonl",
      title: "New",
      extractVersion: 2,
    });
    expect(db.listSessions(ROOT).map((s) => s.sid)).toEqual(["s1"]);
    expect(db.listSessions("/other")).toEqual([]);
  });

  test("meta upserts and optimize keeps matches", () => {
    expect(db.getMeta("k")).toBeUndefined();
    db.setMeta("k", "v");
    db.setMeta("k", "w");
    expect(db.getMeta("k")).toBe("w");
    db.writeChunk(chunk({ turns: [turn("u1", "alpha")] }));
    db.optimizeFts();
    expect(match("alpha")).toHaveLength(1);
  });

  test("close is idempotent", () => {
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});
