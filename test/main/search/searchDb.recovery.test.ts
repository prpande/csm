// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isBusyError,
  isCorruptionError,
  openSearchDb,
  openSearchDbSafe,
  SEARCH_DB_FILENAME,
  type ChunkWrite,
  type SearchDb,
} from "../../../src/search/searchDb";
import {
  CORRUPT_COPY_RE,
  corruptCopyName,
  SEARCH_FILE_RE,
} from "../../../src/search/searchFileNames";
import { emptySessionFields } from "../../../src/search/turnExtractor";

const ROOT = "/projects";
let dir: string;
const opened: SearchDb[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csm-recovery-"));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const write = (db: SearchDb, sid: string, text: string): void => {
  const w: ChunkWrite = {
    root: ROOT,
    sid,
    path: `/projects/a/${sid}.jsonl`,
    size: 1,
    cursor: { offset: 1, headLen: 1, headHash: "h", anchorHash: "a" },
    fields: emptySessionFields(),
    title: text,
    turns: [{ uuid: `${sid}-u`, role: "user", ts: 1, text, searchText: text }],
    links: [
      {
        repo: "o/r",
        number: sid === "gone" ? 1 : 2,
        url: `https://github.com/o/r/pull/${sid === "gone" ? 1 : 2}`,
        createdHere: false,
        firstSeen: 1,
        lastSeen: 1,
      },
    ],
    pending: [],
    extractVersion: 1,
  };
  db.writeChunk(w);
};

test("isCorruptionError recognises SQLITE_CORRUPT and SQLITE_NOTADB", () => {
  expect(isCorruptionError({ errcode: 11 })).toBe(true);
  expect(isCorruptionError({ errcode: 26 })).toBe(true);
  expect(isCorruptionError({ errcode: 267 })).toBe(true); // SQLITE_CORRUPT_VTAB
  expect(isCorruptionError({ errcode: 5 })).toBe(false);
  expect(isCorruptionError(new Error("x"))).toBe(false);
});

test("isBusyError recognises SQLITE_BUSY and SQLITE_LOCKED", () => {
  expect(isBusyError({ errcode: 5 })).toBe(true);
  expect(isBusyError({ errcode: 517 })).toBe(true); // SQLITE_BUSY_SNAPSHOT
  expect(isBusyError({ errcode: 6 })).toBe(true);
  expect(isBusyError({ errcode: 11 })).toBe(false);
  expect(isBusyError(new Error("x"))).toBe(false);
});

test("a healthy database opens while another connection holds the write lock", () => {
  openSearchDb(dir, { platform: process.platform }).close();
  const other = new DatabaseSync(join(dir, SEARCH_DB_FILENAME));
  other.exec("BEGIN IMMEDIATE");
  try {
    const db = openSearchDb(dir, { platform: process.platform });
    expect(db.ftsOk).toBe(true);
    db.close();
  } finally {
    other.exec("ROLLBACK");
    other.close();
  }
});

describe("openSearchDbSafe", () => {
  test("a healthy database opens without recovery", () => {
    const { db, recovered } = openSearchDbSafe(dir, {
      platform: process.platform,
      now: 1,
    });
    opened.push(db);
    expect(recovered).toBe(false);
  });

  test("a garbage file is moved aside and replaced with a working database", () => {
    writeFileSync(join(dir, SEARCH_DB_FILENAME), Buffer.alloc(8192, 7));
    const { db, recovered } = openSearchDbSafe(dir, {
      platform: process.platform,
      now: 42,
    });
    opened.push(db);
    expect(recovered).toBe(true);
    expect(existsSync(join(dir, "search.corrupt-42.db"))).toBe(true);
    write(db, "s1", "works");
    expect(db.getSession(ROOT, "s1")?.title).toBe("works");
  });

  test("only the newest corrupt copy is kept", () => {
    writeFileSync(join(dir, "search.corrupt-1.db"), "old");
    writeFileSync(join(dir, SEARCH_DB_FILENAME), Buffer.alloc(8192, 7));
    const { db } = openSearchDbSafe(dir, {
      platform: process.platform,
      now: 2,
    });
    opened.push(db);
    expect(
      readdirSync(dir).filter((n) => n.startsWith("search.corrupt-")),
    ).toEqual(["search.corrupt-2.db"]);
  });

  test("an old corrupt copy that cannot be deleted does not abort recovery", () => {
    mkdirSync(join(dir, "search.corrupt-1.db"));
    writeFileSync(join(dir, SEARCH_DB_FILENAME), Buffer.alloc(8192, 7));
    const { db, recovered } = openSearchDbSafe(dir, {
      platform: process.platform,
      now: 2,
    });
    opened.push(db);
    expect(recovered).toBe(true);
    expect(existsSync(join(dir, "search.corrupt-2.db"))).toBe(true);
    write(db, "s1", "works");
    expect(db.getSession(ROOT, "s1")?.title).toBe("works");
  });

  test("corruption met while rebuilding the FTS index is recovered, not reported as no FTS5", () => {
    const first = openSearchDb(dir, { platform: process.platform });
    for (let i = 0; i < 40; i++)
      write(first, `s${i}`, `words ${i} ${"x".repeat(2000)}`);
    first.close();
    const file = join(dir, SEARCH_DB_FILENAME);
    const raw = new DatabaseSync(file);
    raw.exec("UPDATE meta SET value = '0' WHERE key = 'fts_ok'");
    const { rootpage } = raw
      .prepare(
        "SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'turn'",
      )
      .get() as { rootpage: number };
    const { page_size } = raw.prepare("PRAGMA page_size").get() as {
      page_size: number;
    };
    raw.close();
    const fd = openSync(file, "r+");
    writeSync(
      fd,
      Buffer.alloc(page_size, 7),
      0,
      page_size,
      (rootpage - 1) * page_size,
    );
    closeSync(fd);
    const { db, recovered } = openSearchDbSafe(dir, {
      platform: process.platform,
      now: 9,
    });
    opened.push(db);
    expect(recovered).toBe(true);
    expect(db.ftsOk).toBe(true);
  });
});

describe("salvageTombstoned", () => {
  test("copies only tombstoned sessions, their turns, links and PRs", () => {
    const oldDir = join(dir, "old");
    mkdirSync(oldDir);
    const old = openSearchDb(oldDir, { platform: process.platform });
    write(old, "gone", "deleted words");
    write(old, "live", "live words");
    old.setTombstone(ROOT, "gone", { missingSince: 1, deletedAt: 2 });
    old.close();

    const fresh = openSearchDb(dir, { platform: process.platform });
    opened.push(fresh);
    fresh.salvageTombstoned(join(oldDir, SEARCH_DB_FILENAME));
    expect(fresh.listSessions(ROOT).map((s) => s.sid)).toEqual(["gone"]);
    expect(
      fresh.prsForSessions(ROOT, ["gone"]).gone.map((l) => l.number),
    ).toEqual([1]);

    const ro = new DatabaseSync(join(dir, SEARCH_DB_FILENAME), {
      readOnly: true,
    });
    expect(
      ro.prepare("SELECT rowid FROM fts WHERE fts MATCH '\"deleted\"'").all(),
    ).toHaveLength(1);
    expect(ro.prepare("SELECT number FROM pr").all()).toEqual([{ number: 1 }]);
    ro.close();
  });

  test("an unreadable source is ignored", () => {
    const fresh = openSearchDb(dir, { platform: process.platform });
    opened.push(fresh);
    const junk = join(dir, "junk.db");
    writeFileSync(junk, Buffer.alloc(4096, 7));
    expect(() => fresh.salvageTombstoned(junk)).not.toThrow();
    expect(fresh.listSessions(ROOT)).toEqual([]);
  });
});

test("the purge matcher accepts every file name the store can create", () => {
  const names = [
    SEARCH_DB_FILENAME,
    `${SEARCH_DB_FILENAME}-wal`,
    `${SEARCH_DB_FILENAME}-shm`,
    corruptCopyName(123),
  ];
  for (const name of names) {
    expect(SEARCH_FILE_RE.test(name), name).toBe(true);
  }
  expect(CORRUPT_COPY_RE.test(corruptCopyName(123))).toBe(true);
});
