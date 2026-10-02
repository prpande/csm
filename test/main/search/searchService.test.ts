// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openSearchDb,
  type PrDetails,
  type SearchDb,
} from "../../../src/search/searchDb";
import {
  createSearchService,
  IDLE_BEFORE_MAINTENANCE_MS,
  OPTIMIZE_AFTER_TURNS,
  type SearchServiceDeps,
  type ServiceTimers,
} from "../../../src/search/searchService";
import type { RunBatch } from "../../../src/search/ghEnrich";
import type { WorkerToHost } from "../../../src/search/protocol";

const SID = "3b9f1c2a-1e2d-4a5b-8c7d-0f1e2d3c4b5a";
const T0 = Date.parse("2026-10-01T10:00:00.000Z");

let tmp: string;
let root: string;
let db: SearchDb;
let clock: number;
let posted: WorkerToHost[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "csm-svc-"));
  root = join(tmp, "projects");
  mkdirSync(join(root, "proj-a"), { recursive: true });
  mkdirSync(join(tmp, "userData"));
  db = openSearchDb(join(tmp, "userData"), { platform: process.platform });
  clock = Date.parse("2026-10-01T12:00:00Z");
  posted = [];
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const rec = (o: object) => `${JSON.stringify(o)}\n`;
function writeTranscript(turns = 1) {
  const lines = [
    rec({
      type: "pr-link",
      sessionId: SID,
      prNumber: 12,
      prRepository: "o/r",
      prUrl: "https://github.com/o/r/pull/12",
      timestamp: new Date(T0).toISOString(),
    }),
  ];
  for (let i = 0; i < turns; i++)
    lines.push(
      rec({
        type: "user",
        uuid: `u${i}`,
        timestamp: new Date(T0 + i).toISOString(),
        message: { role: "user", content: `turn ${i}` },
      }),
    );
  writeFileSync(join(root, "proj-a", `${SID}.jsonl`), lines.join(""));
}

const details = (n: number): PrDetails => ({
  title: `PR ${n}`,
  state: "OPEN",
  isDraft: false,
  body: "",
});
const okBatch: RunBatch = async (_repo, numbers) => ({
  kind: "data",
  byNumber: new Map(numbers.map((n) => [n, details(n)])),
});

interface Pending {
  fn: () => void;
  ms: number;
  live: boolean;
}

function service(over: Partial<SearchServiceDeps> = {}) {
  const timeouts: Pending[] = [];
  const timers: ServiceTimers = {
    setTimeout(fn, ms) {
      const t = { fn, ms, live: true };
      timeouts.push(t);
      return () => {
        t.live = false;
      };
    },
    setInterval: () => () => {},
  };
  const fire = () => {
    const t = timeouts.find((x) => x.live);
    if (!t) throw new Error("no live timer");
    t.live = false;
    t.fn();
  };
  const live = () => timeouts.filter((t) => t.live).map((t) => t.ms);
  const log = vi.fn();
  const svc = createSearchService({
    db,
    root,
    post: (m) => posted.push(m),
    now: () => clock,
    runBatch: okBatch,
    log,
    timers,
    ...over,
  });
  return { svc, fire, live, log };
}

const changedCount = () => posted.filter((m) => m.type === "changed").length;

describe("createSearchService", () => {
  test("start ingests, then enriches, posting changed after each", async () => {
    writeTranscript();
    const { svc } = service();
    svc.start();
    await svc.whenIdle();
    expect(changedCount()).toBe(2);
    expect(db.prsForSessions(root, [SID])[SID][0]).toMatchObject({
      number: 12,
      title: "PR 12",
      state: "OPEN",
    });
  });

  test("prsFor replies with the session's links", async () => {
    writeTranscript();
    const { svc } = service();
    svc.start();
    await svc.whenIdle();
    svc.handle({ type: "prsFor", id: 7, sids: [SID] });
    expect(posted.at(-1)).toMatchObject({
      type: "result",
      id: 7,
      ok: true,
      value: { [SID]: [{ number: 12 }] },
    });
  });

  test("a pass that changes nothing posts no changed", async () => {
    writeTranscript();
    const { svc } = service();
    svc.start();
    await svc.whenIdle();
    posted.length = 0;
    svc.handle({ type: "ingest" });
    await svc.whenIdle();
    expect(changedCount()).toBe(0);
  });

  test("a failing query replies ok:false and logs", () => {
    const { svc, log } = service();
    db.close();
    svc.handle({ type: "prsFor", id: 3, sids: [SID] });
    expect(posted).toEqual([{ type: "result", id: 3, ok: false }]);
    expect(log).toHaveBeenCalled();
  });

  test("failed gh batches are logged", async () => {
    writeTranscript();
    const { svc, log } = service({
      runBatch: async () => ({ kind: "failed", reason: "ENOENT" }),
    });
    svc.start();
    await svc.whenIdle();
    expect(log.mock.calls.map((c) => c[0])).toContain(
      "gh enrichment: 1 batch(es) failed",
    );
  });

  test("shutdown closes the store, acks, and ignores later messages", () => {
    const { svc } = service();
    svc.handle({ type: "shutdown" });
    expect(posted).toEqual([{ type: "shutdownAck" }]);
    svc.handle({ type: "prsFor", id: 1, sids: [SID] });
    expect(posted).toHaveLength(1);
    expect(() => db.getMeta("x")).toThrow();
  });
});

describe("fts maintenance", () => {
  test("a large pass optimizes once the store is idle", async () => {
    writeTranscript(OPTIMIZE_AFTER_TURNS);
    const optimize = vi.spyOn(db, "optimizeFts");
    const { svc, fire, live } = service();
    svc.start();
    await svc.whenIdle();
    expect(live()).toEqual([IDLE_BEFORE_MAINTENANCE_MS]);
    fire();
    expect(optimize).toHaveBeenCalledTimes(1);
  });

  test("maintenance waits while queries keep arriving", async () => {
    writeTranscript(OPTIMIZE_AFTER_TURNS);
    const optimize = vi.spyOn(db, "optimizeFts");
    const { svc, fire, live } = service();
    svc.start();
    await svc.whenIdle();
    svc.handle({ type: "prsFor", id: 1, sids: [SID] });
    fire();
    expect(optimize).not.toHaveBeenCalled();
    expect(live()).toEqual([IDLE_BEFORE_MAINTENANCE_MS]);
    clock += IDLE_BEFORE_MAINTENANCE_MS;
    fire();
    expect(optimize).toHaveBeenCalledTimes(1);
  });

  test("a small pass schedules no maintenance", async () => {
    writeTranscript(1);
    const { svc, live } = service();
    svc.start();
    await svc.whenIdle();
    expect(live()).toEqual([]);
  });
});
