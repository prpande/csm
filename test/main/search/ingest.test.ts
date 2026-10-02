// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openSearchDb,
  SEARCH_DB_FILENAME,
  type SearchDb,
} from "../../../src/search/searchDb";
import {
  createIngester,
  EXTRACT_VERSION,
  type IngesterDeps,
} from "../../../src/search/ingest";
import { readCompleteLines } from "../../../src/search/lineReader";
import { MISSING_GRACE_MS } from "../../../src/search/tombstone";
import { parseSession } from "../../../src/sessionParser";

const SID = "3b9f1c2a-1e2d-4a5b-8c7d-0f1e2d3c4b5a";
const SID2 = "4c0a2d3b-2f3e-4b6c-9d8e-1a2b3c4d5e6f";
const T0 = Date.parse("2026-10-01T10:00:00.000Z");

let tmp: string;
let root: string;
let dbDir: string;
let db: SearchDb;
let clock: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "csm-ingest-"));
  root = join(tmp, "projects");
  dbDir = join(tmp, "userData");
  mkdirSync(join(root, "proj-a"), { recursive: true });
  mkdirSync(dbDir);
  db = openSearchDb(dbDir, { platform: process.platform });
  clock = Date.parse("2026-10-01T12:00:00Z");
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();
const line = (rec: object) => `${JSON.stringify(rec)}\n`;
const user = (uuid: string, text: string, ts = T0) => ({
  type: "user",
  uuid,
  timestamp: iso(ts),
  cwd: "D:\\src\\x",
  message: { role: "user", content: text },
});
const assistant = (uuid: string, text: string, ts = T0) => ({
  type: "assistant",
  uuid,
  timestamp: iso(ts),
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const prLink = (n: number, ts = T0) => ({
  type: "pr-link",
  sessionId: SID,
  prNumber: n,
  prRepository: "o/r",
  prUrl: `https://github.com/o/r/pull/${n}`,
  timestamp: iso(ts),
});
const transcript = (folder = "proj-a", sid = SID) =>
  join(root, folder, `${sid}.jsonl`);
const write = (recs: object[], path = transcript()) =>
  writeFileSync(path, recs.map(line).join(""));
const append = (recs: object[], path = transcript()) =>
  appendFileSync(path, recs.map(line).join(""));

function ingester(over: Partial<IngesterDeps> = {}) {
  return createIngester({ db, root, now: () => clock, ...over });
}

function q<T = Record<string, unknown>>(
  sql: string,
  ...args: (string | number)[]
): T[] {
  const ro = new DatabaseSync(join(dbDir, SEARCH_DB_FILENAME), {
    readOnly: true,
  });
  try {
    return ro.prepare(sql).all(...args) as T[];
  } finally {
    ro.close();
  }
}
const texts = () =>
  q<{ text: string }>("SELECT text FROM turn ORDER BY id").map((r) => r.text);
const matches = (term: string) =>
  q("SELECT rowid FROM fts WHERE fts MATCH ?", `"${term}"`);

describe("ingest", () => {
  test("a new transcript yields its turns, title and cwd", async () => {
    write([user("u1", "Fix getUserName"), assistant("a1", "Done")]);
    const r = await ingester().runPass();
    expect(r).toMatchObject({
      changed: true,
      rootReadable: true,
      filesIngested: 1,
      turnsInserted: 2,
    });
    expect(texts()).toEqual(["Fix getUserName", "Done"]);
    expect(matches("user")).toHaveLength(1);
    expect(db.getSession(root, SID)).toMatchObject({
      title: "Fix getUserName",
      cwd: "D:\\src\\x",
      extractVersion: EXTRACT_VERSION,
    });
  });

  test("an append reads only the new bytes", async () => {
    const readLines = vi.fn(readCompleteLines);
    const ing = ingester({ readLines });
    write([user("u1", "first")]);
    await ing.runPass();
    const firstSize = statSync(transcript()).size;
    append([user("u2", "second")]);
    await ing.runPass();
    expect(readLines.mock.calls.map((c) => c[1])).toEqual([0, firstSize]);
    expect(texts()).toEqual(["first", "second"]);
  });

  test("a half-written final line waits for the next pass", async () => {
    const second = line(user("u2", "second"));
    writeFileSync(
      transcript(),
      line(user("u1", "first")) + second.slice(0, 10),
    );
    await ingester().runPass();
    expect(texts()).toEqual(["first"]);
    appendFileSync(transcript(), second.slice(10));
    await ingester().runPass();
    expect(texts()).toEqual(["first", "second"]);
  });

  test("a tail that never completes reports no change on later passes", async () => {
    const second = line(user("u2", "second"));
    writeFileSync(
      transcript(),
      line(user("u1", "first")) + second.slice(0, 10),
    );
    const ing = ingester();
    expect((await ing.runPass()).changed).toBe(true);
    expect(await ing.runPass()).toMatchObject({
      changed: false,
      filesIngested: 0,
    });
    expect(texts()).toEqual(["first"]);
  });

  test("an in-place rewrite re-ingests from byte 0", async () => {
    write([user("u1", "alpha"), user("u2", "beta")]);
    await ingester().runPass();
    write([user("u3", "gamma"), user("u4", "delta"), user("u5", "epsilon")]);
    await ingester().runPass();
    expect(texts()).toEqual(["gamma", "delta", "epsilon"]);
    expect(matches("alpha")).toEqual([]);
  });

  test("a truncated transcript is re-ingested", async () => {
    write([user("u1", "one"), user("u2", "two"), user("u3", "three")]);
    await ingester().runPass();
    write([user("u9", "nine")]);
    await ingester().runPass();
    expect(texts()).toEqual(["nine"]);
  });

  test("a replayed uuid is stored once, within and across passes", async () => {
    write([user("u1", "same"), user("u1", "same")]);
    await ingester().runPass();
    append([user("u1", "same")]);
    await ingester().runPass();
    expect(texts()).toEqual(["same"]);
  });

  test("backwards timestamps keep the latest as last activity", async () => {
    write([user("u1", "a", T0 + 5000), user("u2", "b", T0 + 1000)]);
    await ingester().runPass();
    expect(db.getSession(root, SID)?.lastActivity).toBe(T0 + 5000);
  });

  test("a line over 1 MB is ingested", async () => {
    const big = "y".repeat(1_100_000);
    write([user("u1", big)]);
    await ingester().runPass();
    expect(texts()[0]).toHaveLength(1_100_000);
  });

  test("6000 repeated pr-link records collapse to one link", async () => {
    write(Array.from({ length: 6000 }, (_, i) => prLink(5, T0 + i * 1000)));
    await ingester().runPass();
    expect(
      q("SELECT number, first_seen, last_seen, created_here FROM session_pr"),
    ).toEqual([
      {
        number: 5,
        first_seen: T0,
        last_seen: T0 + 5999 * 1000,
        created_here: 0,
      },
    ]);
    expect(q("SELECT number, state FROM pr")).toEqual([
      { number: 5, state: null },
    ]);
  });

  test("bookkeeping and unknown leading types are skipped; a late type field still parses", async () => {
    const late = JSON.stringify({
      uuid: "a9",
      timestamp: iso(T0),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "late type" }],
      },
      type: "assistant",
    });
    writeFileSync(
      transcript(),
      [
        '{"type":"file-history-snapshot","snapshot":{"text":"nope"}}',
        '{"type":"brand-new","message":{"role":"user","content":"nope"}}',
        late,
        "{not json",
        "",
      ].join("\n"),
    );
    await ingester().runPass();
    expect(texts()).toEqual(["late type"]);
  });

  test("gh pr create pairs with its result across passes", async () => {
    write([
      {
        type: "assistant",
        timestamp: iso(T0),
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "PowerShell",
              input: { command: "gh pr create --fill" },
            },
          ],
        },
      },
    ]);
    await ingester().runPass();
    expect(db.getSession(root, SID)?.pendingPrCreate).toEqual(["t1"]);
    append([
      {
        type: "user",
        timestamp: iso(T0 + 1000),
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "https://github.com/o/r/pull/12\n",
            },
          ],
        },
      },
    ]);
    await ingester().runPass();
    expect(
      q("SELECT number, created_here, first_seen, last_seen FROM session_pr"),
    ).toEqual([
      { number: 12, created_here: 1, first_seen: T0 + 1000, last_seen: null },
    ]);
    expect(db.getSession(root, SID)?.pendingPrCreate).toEqual([]);
  });

  test("CRLF and BOM transcripts ingest every record", async () => {
    const body =
      [user("u1", "one"), user("u2", "two")]
        .map((r) => JSON.stringify(r))
        .join("\r\n") + "\r\n";
    writeFileSync(
      transcript(),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]),
    );
    await ingester().runPass();
    expect(texts()).toEqual(["one", "two"]);
  });

  test("a file under 4096 bytes that grows past it is appended, not rewritten", async () => {
    const readLines = vi.fn(readCompleteLines);
    const ing = ingester({ readLines });
    write([user("u1", "small")]);
    await ing.runPass();
    const firstSize = statSync(transcript()).size;
    expect(firstSize).toBeLessThan(4096);
    const firstId = q<{ id: number }>("SELECT id FROM turn")[0].id;
    append(
      Array.from({ length: 40 }, (_, i) => user(`m${i}`, "x".repeat(200))),
    );
    expect(statSync(transcript()).size).toBeGreaterThan(4096);
    await ing.runPass();
    expect(readLines.mock.calls.map((c) => c[1])).toEqual([0, firstSize]);
    expect(q<{ id: number }>("SELECT id FROM turn ORDER BY id")[0].id).toBe(
      firstId,
    );
  });

  test("a rename back to an earlier name across appends matches the browse title", async () => {
    write([
      { type: "ai-title", aiTitle: "AI words" },
      { type: "custom-title", customTitle: "a" },
    ]);
    await ingester().runPass();
    append([{ type: "custom-title", customTitle: "b" }]);
    await ingester().runPass();
    append([{ type: "custom-title", customTitle: "a" }]);
    await ingester().runPass();
    const browse = parseSession(SID, readFileSync(transcript(), "utf8")).title;
    expect(db.getSession(root, SID)?.title).toBe(browse);
  });
});

describe("files that move or disappear", () => {
  test("the same sid in two folders keeps the newest file", async () => {
    mkdirSync(join(root, "proj-b"));
    write([user("u1", "old copy")], transcript("proj-a"));
    write([user("u2", "new copy")], transcript("proj-b"));
    utimesSync(transcript("proj-a"), new Date(T0), new Date(T0));
    await ingester().runPass();
    expect(db.getSession(root, SID)?.path).toBe(transcript("proj-b"));
    expect(texts()).toEqual(["new copy"]);
  });

  test("a file moved to another project folder is not re-ingested", async () => {
    const readLines = vi.fn(readCompleteLines);
    const ing = ingester({ readLines });
    write([user("u1", "moved")]);
    await ing.runPass();
    mkdirSync(join(root, "proj-b"));
    renameSync(transcript("proj-a"), transcript("proj-b"));
    await ing.runPass();
    expect(readLines).toHaveBeenCalledTimes(1);
    expect(db.getSession(root, SID)?.path).toBe(transcript("proj-b"));
    expect(texts()).toEqual(["moved"]);
  });

  test("tombstones only after the 60 s floor, keeps rows, and clears on reappearance", async () => {
    write([user("u1", "keep me")]);
    const ing = ingester();
    await ing.runPass();
    const away = join(tmp, "away.jsonl");
    renameSync(transcript(), away);

    await ing.runPass();
    expect(db.getSession(root, SID)).toMatchObject({
      missingSince: clock,
      deletedAt: null,
    });
    clock += MISSING_GRACE_MS - 1;
    await ing.runPass();
    expect(db.getSession(root, SID)?.deletedAt).toBeNull();
    clock += 1;
    const r = await ing.runPass();
    expect(r.changed).toBe(true);
    expect(db.getSession(root, SID)?.deletedAt).toBe(clock);
    expect(texts()).toEqual(["keep me"]);

    renameSync(away, transcript());
    await ing.runPass();
    expect(db.getSession(root, SID)).toMatchObject({
      missingSince: null,
      deletedAt: null,
    });
  });

  test("deleting a whole project folder tombstones its sessions", async () => {
    mkdirSync(join(root, "proj-b"));
    write([user("u1", "a")], transcript("proj-a", SID));
    write([user("u2", "b")], transcript("proj-b", SID2));
    const ing = ingester();
    await ing.runPass();
    rmSync(join(root, "proj-a"), { recursive: true });
    await ing.runPass();
    clock += MISSING_GRACE_MS;
    await ing.runPass();
    expect(db.getSession(root, SID)?.deletedAt).toBe(clock);
    expect(db.getSession(root, SID2)?.deletedAt).toBeNull();
  });

  test("an unreadable projects root records nothing", async () => {
    write([user("u1", "a")]);
    const ing = ingester();
    await ing.runPass();
    rmSync(root, { recursive: true });
    const r = await ing.runPass();
    clock += 2 * MISSING_GRACE_MS;
    await ing.runPass();
    expect(r).toMatchObject({ rootReadable: false, changed: false });
    expect(db.getSession(root, SID)).toMatchObject({
      missingSince: null,
      deletedAt: null,
    });
  });

  test("a stale extract_version re-ingests a live file and restamps a tombstoned one", async () => {
    mkdirSync(join(root, "proj-b"));
    write([user("u1", "live")], transcript("proj-a", SID));
    write(
      [{ type: "ai-title", aiTitle: "Gone title" }, user("u2", "gone")],
      transcript("proj-b", SID2),
    );
    const readLines = vi.fn(readCompleteLines);
    const ing = ingester({ readLines });
    await ing.runPass();
    rmSync(transcript("proj-b", SID2));
    await ing.runPass();
    clock += MISSING_GRACE_MS;
    await ing.runPass();
    expect(db.getSession(root, SID2)?.deletedAt).toBe(clock);

    const w = new DatabaseSync(join(dbDir, SEARCH_DB_FILENAME));
    w.exec("UPDATE session SET extract_version = 0, title = 'stale'");
    w.close();
    readLines.mockClear();
    await ing.runPass();
    expect(readLines.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [transcript("proj-a", SID), 0],
    ]);
    expect(db.getSession(root, SID)).toMatchObject({
      extractVersion: EXTRACT_VERSION,
      title: "live",
    });
    expect(db.getSession(root, SID2)).toMatchObject({
      extractVersion: EXTRACT_VERSION,
      title: "Gone title",
    });
    expect(texts()).toEqual(expect.arrayContaining(["live", "gone"]));
  });
});

describe("invariants", () => {
  test("transcripts are never modified", async () => {
    write([user("u1", "a"), prLink(3)]);
    const before = readFileSync(transcript());
    const mtime = statSync(transcript()).mtimeMs;
    const ing = ingester();
    await ing.runPass();
    await ing.runPass();
    expect(readFileSync(transcript()).equals(before)).toBe(true);
    expect(statSync(transcript()).mtimeMs).toBe(mtime);
  });

  test("concurrent runPass calls share one promise and run exactly one more pass", async () => {
    write([user("u1", "a")]);
    const onProgress = vi.fn();
    const ing = ingester({ onProgress });
    const p1 = ing.runPass();
    const p2 = ing.runPass();
    const p3 = ing.runPass();
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    const r = await p1;
    expect(onProgress.mock.calls.filter(([p]) => p.done === 0)).toHaveLength(2);
    expect(r.filesIngested).toBe(1);
    expect(texts()).toEqual(["a"]);
  });

  test("a runPass requested at any microtask hop after the last pass starts still gets one more pass", async () => {
    write([user("u1", "a")]);
    for (let hops = 0; hops <= 12; hops++) {
      if (hops > 0) append([user(`u${hops + 1}`, `t${hops}`)]);
      let passes = 0;
      let late: Promise<unknown> | null = null;
      const ing = ingester({
        onProgress: ({ done, total }) => {
          if (done === 0) passes++;
          if (total === 0 || done !== total || passes !== 1) return;
          let chain: Promise<void> = Promise.resolve();
          for (let i = 0; i < hops; i++) chain = chain.then(() => undefined);
          void chain.then(() => {
            late = ing.runPass();
          });
        },
      });
      await ing.runPass();
      await new Promise((resolve) => setImmediate(resolve));
      await late;
      expect(passes, `hops=${hops}`).toBe(2);
    }
  });
});
