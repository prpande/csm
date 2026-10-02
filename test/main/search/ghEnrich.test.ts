// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import {
  BATCH_SIZE,
  createEnricher,
  REPO_BACKOFF_MS,
  type EnricherDeps,
  type RunBatch,
} from "../../../src/search/ghEnrich";
import type { PrDetails, PrKey } from "../../../src/search/searchDb";

const details = (n: number): PrDetails => ({
  title: `PR ${n}`,
  state: "OPEN",
  isDraft: false,
  body: "",
});

function fakeDb(due: PrKey[]) {
  return {
    duePrs: vi.fn(() => due),
    applyPrDetails: vi.fn(),
    markPrError: vi.fn(),
  } satisfies EnricherDeps["db"];
}

const allData: RunBatch = async (_repo, numbers) => ({
  kind: "data",
  byNumber: new Map(numbers.map((n) => [n, details(n)])),
});

describe("createEnricher", () => {
  test("groups due PRs by repo case-insensitively, keeping the first-seen case", async () => {
    const db = fakeDb([
      { repo: "O/R", number: 1 },
      { repo: "o/r", number: 2 },
      { repo: "x/y", number: 3 },
    ]);
    const runBatch = vi.fn(allData);
    const r = await createEnricher({ db, runBatch, now: () => 0 }).runDue();
    expect(runBatch.mock.calls).toEqual([
      ["O/R", [1, 2]],
      ["x/y", [3]],
    ]);
    expect(r).toEqual({ wrote: 3, failures: 0 });
    expect(db.applyPrDetails).toHaveBeenCalledWith(
      { repo: "O/R", number: 2 },
      details(2),
      0,
    );
  });

  test("splits a repo into batches of 50", async () => {
    const db = fakeDb(
      Array.from({ length: 120 }, (_, i) => ({ repo: "o/r", number: i + 1 })),
    );
    const runBatch = vi.fn(allData);
    await createEnricher({ db, runBatch, now: () => 0 }).runDue();
    expect(runBatch.mock.calls.map((c) => c[1].length)).toEqual([
      BATCH_SIZE,
      BATCH_SIZE,
      20,
    ]);
  });

  test("runs at most two batches at once", async () => {
    const db = fakeDb(
      ["a/a", "b/b", "c/c", "d/d"].map((repo) => ({ repo, number: 1 })),
    );
    let live = 0;
    let peak = 0;
    const runBatch: RunBatch = async (repo, numbers) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return allData(repo, numbers);
    };
    await createEnricher({ db, runBatch, now: () => 0 }).runDue();
    expect(peak).toBe(2);
  });

  test("not-returned PRs are marked without backing off the repo", async () => {
    const db = fakeDb([
      { repo: "o/r", number: 1 },
      { repo: "o/r", number: 2 },
    ]);
    const runBatch = vi.fn<RunBatch>(async () => ({
      kind: "data",
      byNumber: new Map([
        [1, details(1)],
        [2, null],
      ]),
    }));
    const enricher = createEnricher({ db, runBatch, now: () => 0 });
    expect(await enricher.runDue()).toEqual({ wrote: 1, failures: 0 });
    expect(db.markPrError).toHaveBeenCalledWith(
      { repo: "o/r", number: 2 },
      "not-returned",
      0,
    );
    await enricher.runDue();
    expect(runBatch).toHaveBeenCalledTimes(2);
  });

  test("a failed batch marks every PR and backs the repo off for 15 minutes", async () => {
    const db = fakeDb([{ repo: "o/r", number: 1 }]);
    let clock = 0;
    const runBatch = vi.fn<RunBatch>(async () => ({
      kind: "failed",
      reason: "timeout",
    }));
    const enricher = createEnricher({ db, runBatch, now: () => clock });
    expect(await enricher.runDue()).toEqual({ wrote: 0, failures: 1 });
    expect(db.markPrError).toHaveBeenCalledWith(
      { repo: "o/r", number: 1 },
      "timeout",
      0,
    );
    clock = REPO_BACKOFF_MS - 1;
    await enricher.runDue();
    expect(runBatch).toHaveBeenCalledTimes(1);
    clock = REPO_BACKOFF_MS;
    await enricher.runDue();
    expect(runBatch).toHaveBeenCalledTimes(2);
  });

  test("a throwing runBatch counts as bad output", async () => {
    const db = fakeDb([{ repo: "o/r", number: 1 }]);
    const runBatch: RunBatch = async () => {
      throw new Error("boom");
    };
    expect(
      await createEnricher({ db, runBatch, now: () => 0 }).runDue(),
    ).toEqual({
      wrote: 0,
      failures: 1,
    });
    expect(db.markPrError).toHaveBeenCalledWith(
      { repo: "o/r", number: 1 },
      "bad-output",
      0,
    );
  });

  test("a call while running shares the running promise and adds exactly one more round", async () => {
    const db = fakeDb([{ repo: "o/r", number: 1 }]);
    const runBatch = vi.fn(allData);
    const enricher = createEnricher({ db, runBatch, now: () => 0 });
    const a = enricher.runDue();
    expect(enricher.runDue()).toBe(a);
    expect(enricher.runDue()).toBe(a);
    expect(await a).toEqual({ wrote: 2, failures: 0 });
    expect(runBatch).toHaveBeenCalledTimes(2);
  });
});
