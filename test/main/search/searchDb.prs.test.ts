// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CLOSED_REFRESH_MS,
  OPEN_REFRESH_MS,
  openSearchDb,
  SEARCH_DB_FILENAME,
  type ChunkWrite,
  type PrDetails,
  type SearchDb,
} from "../../../src/search/searchDb";
import { emptySessionFields } from "../../../src/search/turnExtractor";

const ROOT = "/projects";
const NOW = Date.parse("2026-10-01T12:00:00Z");
const MIN = 60_000;
let dir: string;
let db: SearchDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csm-searchdb-prs-"));
  db = openSearchDb(dir, { platform: process.platform });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function q<T = Record<string, unknown>>(sql: string): T[] {
  const ro = new DatabaseSync(join(dir, SEARCH_DB_FILENAME), {
    readOnly: true,
  });
  try {
    return ro.prepare(sql).all() as T[];
  } finally {
    ro.close();
  }
}

function linkSession(sid: string, numbers: number[]): void {
  const w: ChunkWrite = {
    root: ROOT,
    sid,
    path: `/projects/a/${sid}.jsonl`,
    size: 1,
    cursor: { offset: 1, headLen: 1, headHash: "h", anchorHash: "a" },
    fields: emptySessionFields(),
    title: "t",
    turns: [],
    links: numbers.map((n) => ({
      repo: "o/r",
      number: n,
      url: `https://github.com/o/r/pull/${n}`,
      createdHere: n === 1,
      firstSeen: 100 + n,
      lastSeen: n === 1 ? null : 200 + n,
    })),
    pending: [],
    extractVersion: 1,
  };
  db.writeChunk(w);
}

const details = (over: Partial<PrDetails> = {}): PrDetails => ({
  title: "Fix",
  state: "OPEN",
  isDraft: false,
  body: "b",
  ...over,
});
const key = (n: number) => ({ repo: "o/r", number: n });

describe("prsForSessions", () => {
  test("returns each requested session's links, newest number first, with PR details", () => {
    linkSession("s1", [1, 2]);
    linkSession("s2", [1]);
    db.applyPrDetails(
      { repo: "O/R", number: 1 },
      details({ isDraft: true }),
      NOW,
    );
    const out = db.prsForSessions(ROOT, ["s1", "s2", "nope"]);
    expect(Object.keys(out).sort()).toEqual(["s1", "s2"]);
    expect(out.s1.map((l) => l.number)).toEqual([2, 1]);
    expect(out.s1[1]).toEqual({
      repo: "o/r",
      number: 1,
      url: "https://github.com/o/r/pull/1",
      title: "Fix",
      state: "OPEN",
      isDraft: true,
      createdHere: true,
      firstSeen: 101,
      lastSeen: null,
    });
    expect(out.s1[0]).toMatchObject({
      title: null,
      state: null,
      isDraft: false,
    });
  });

  test("an empty id list returns nothing", () => {
    expect(db.prsForSessions(ROOT, [])).toEqual({});
  });
});

describe("duePrs", () => {
  test("follows the refetch rules", () => {
    linkSession("s1", [1, 2, 3, 4, 5, 6, 7, 8]);
    // 1: never attempted
    db.markPrError(key(2), "timeout", NOW - 5 * MIN); // unfetched, tried recently
    db.markPrError(key(3), "timeout", NOW - OPEN_REFRESH_MS); // unfetched, tried 10 min ago
    db.applyPrDetails(key(4), details(), NOW - 5 * MIN); // OPEN, fresh
    db.applyPrDetails(key(5), details(), NOW - OPEN_REFRESH_MS); // OPEN, stale
    db.applyPrDetails(
      key(6),
      details({ state: "CLOSED" }),
      NOW - CLOSED_REFRESH_MS + MIN,
    );
    db.applyPrDetails(
      key(7),
      details({ state: "CLOSED" }),
      NOW - CLOSED_REFRESH_MS,
    );
    db.applyPrDetails(
      key(8),
      details({ state: "MERGED" }),
      NOW - 365 * 24 * 60 * MIN,
    );
    expect(db.duePrs(NOW).map((k) => k.number)).toEqual([1, 3, 5, 7]);
  });
});

describe("enrichment writes", () => {
  test("applyPrDetails sets the fields and clears fetch_error", () => {
    linkSession("s1", [1]);
    db.markPrError(key(1), "timeout", NOW - MIN);
    db.applyPrDetails(key(1), details({ body: "body" }), NOW);
    expect(
      q("SELECT title, state, is_draft, body, fetched_at, fetch_error FROM pr"),
    ).toEqual([
      {
        title: "Fix",
        state: "OPEN",
        is_draft: 0,
        body: "body",
        fetched_at: NOW,
        fetch_error: null,
      },
    ]);
  });

  test("markPrError keeps an existing title and state", () => {
    linkSession("s1", [1]);
    db.applyPrDetails(key(1), details(), NOW - MIN);
    db.markPrError(key(1), "not-returned", NOW);
    expect(q("SELECT title, state, fetched_at, fetch_error FROM pr")).toEqual([
      {
        title: "Fix",
        state: "OPEN",
        fetched_at: NOW,
        fetch_error: "not-returned",
      },
    ]);
  });

  test("pruneOrphanPrs drops PRs no session links any more", () => {
    linkSession("s1", [9]);
    expect(db.pruneOrphanPrs()).toBe(0);
    db.resetSession(ROOT, "s1");
    expect(db.pruneOrphanPrs()).toBe(1);
    expect(q("SELECT number FROM pr")).toEqual([]);
  });
});
