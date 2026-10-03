import type { BatchOutcome } from "./ghClient";
import type { SearchDb } from "./searchDb";

export const BATCH_SIZE = 50;
export const MAX_IN_FLIGHT = 2;
export const REPO_BACKOFF_MS = 15 * 60_000;

export type RunBatch = (
  repo: string,
  numbers: number[],
) => Promise<BatchOutcome>;

export interface EnrichResult {
  wrote: number;
  failures: number;
}

export interface EnricherDeps {
  db: Pick<SearchDb, "duePrs" | "applyPrDetails" | "markPrError">;
  runBatch: RunBatch;
  now: () => number;
}

interface Batch {
  repo: string;
  numbers: number[];
}

async function runPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
}

export function createEnricher(deps: EnricherDeps): {
  runDue(): Promise<EnrichResult>;
} {
  const backoffUntil = new Map<string, number>();
  let running: Promise<EnrichResult> | null = null;
  let rerun = false;

  function batchesDue(now: number): Batch[] {
    const groups = new Map<string, Batch>();
    for (const key of deps.db.duePrs(now)) {
      const k = key.repo.toLowerCase();
      if ((backoffUntil.get(k) ?? 0) > now) continue;
      let g = groups.get(k);
      if (!g) {
        g = { repo: key.repo, numbers: [] };
        groups.set(k, g);
      }
      g.numbers.push(key.number);
    }
    const batches: Batch[] = [];
    for (const g of groups.values())
      for (let i = 0; i < g.numbers.length; i += BATCH_SIZE)
        batches.push({
          repo: g.repo,
          numbers: g.numbers.slice(i, i + BATCH_SIZE),
        });
    return batches;
  }

  async function runOnce(): Promise<EnrichResult> {
    const result: EnrichResult = { wrote: 0, failures: 0 };
    await runPool(batchesDue(deps.now()), MAX_IN_FLIGHT, async (b) => {
      if ((backoffUntil.get(b.repo.toLowerCase()) ?? 0) > deps.now()) return;
      const outcome = await deps
        .runBatch(b.repo, b.numbers)
        .catch((): BatchOutcome => ({ kind: "failed", reason: "bad-output" }));
      const at = deps.now();
      if (outcome.kind === "failed") {
        result.failures++;
        backoffUntil.set(b.repo.toLowerCase(), at + REPO_BACKOFF_MS);
        for (const n of b.numbers)
          deps.db.markPrError({ repo: b.repo, number: n }, outcome.reason, at);
        return;
      }
      for (const n of b.numbers) {
        const d = outcome.byNumber.get(n) ?? null;
        if (d) {
          deps.db.applyPrDetails({ repo: b.repo, number: n }, d, at);
          result.wrote++;
        } else {
          deps.db.markPrError({ repo: b.repo, number: n }, "not-returned", at);
        }
      }
    });
    return result;
  }

  async function loop(): Promise<EnrichResult> {
    try {
      rerun = false;
      const total = await runOnce();
      while (rerun) {
        rerun = false;
        const more = await runOnce();
        total.wrote += more.wrote;
        total.failures += more.failures;
      }
      return total;
    } finally {
      running = null;
    }
  }

  return {
    runDue() {
      if (running) {
        rerun = true;
        return running;
      }
      running = loop();
      return running;
    },
  };
}
