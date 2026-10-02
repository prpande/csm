import { createEnricher, type RunBatch } from "./ghEnrich";
import { createIngester } from "./ingest";
import type { HostToWorker, WorkerToHost } from "./protocol";
import type { SearchDb } from "./searchDb";

export const ENRICH_INTERVAL_MS = 10 * 60_000;
export const IDLE_BEFORE_MAINTENANCE_MS = 2_000;
export const OPTIMIZE_AFTER_TURNS = 1_000;
export const PROGRESS_EVERY = 50;

export interface ServiceTimers {
  setTimeout(fn: () => void, ms: number): () => void;
  setInterval(fn: () => void, ms: number): () => void;
}

const realTimers: ServiceTimers = {
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
  setInterval(fn, ms) {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  },
};

export interface SearchServiceDeps {
  db: SearchDb;
  root: string;
  post: (msg: WorkerToHost) => void;
  now: () => number;
  runBatch: RunBatch;
  log: (msg: string, err?: unknown) => void;
  timers?: ServiceTimers;
}

export interface SearchService {
  start(): void;
  handle(msg: HostToWorker): void;
  whenIdle(): Promise<void>;
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
  const { db, root, post, now } = deps;
  const timers = deps.timers ?? realTimers;
  let closed = false;
  let lastQueryAt = Number.NEGATIVE_INFINITY;
  let turnsSinceOptimize = 0;
  let cancelMaintenance: (() => void) | null = null;
  let cancelEnrichTimer: (() => void) | null = null;
  const inflight = new Set<Promise<void>>();

  // Work still in flight at shutdown fails against the closed store; that is expected.
  const log = (msg: string, err?: unknown): void => {
    if (!closed) deps.log(msg, err);
  };

  const ingester = createIngester({
    db,
    root,
    now,
    log,
    onProgress: ({ done, total }) => {
      if (
        !closed &&
        (done === 0 || done === total || done % PROGRESS_EVERY === 0)
      )
        post({ type: "progress", done, total });
    },
  });
  const enricher = createEnricher({ db, runBatch: deps.runBatch, now });

  function track(task: () => Promise<void>): void {
    if (closed) return;
    const p: Promise<void> = task()
      .catch((err: unknown) => log("search task failed", err))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }

  // The ingester and enricher coalesce overlapping calls into one running
  // promise, so only the first caller owns the posts and counters.
  let enrichInFlight = false;
  let ingestInFlight = false;

  async function enrich(): Promise<void> {
    if (enrichInFlight) {
      void enricher.runDue();
      return;
    }
    enrichInFlight = true;
    try {
      const r = await enricher.runDue();
      if (r.failures > 0) log(`gh enrichment: ${r.failures} batch(es) failed`);
      if (!closed && r.wrote > 0) post({ type: "changed" });
    } finally {
      enrichInFlight = false;
    }
  }

  async function ingestThenEnrich(): Promise<void> {
    if (ingestInFlight) {
      void ingester.runPass();
      return;
    }
    ingestInFlight = true;
    try {
      const r = await ingester.runPass();
      if (closed) return;
      if (r.changed) {
        post({ type: "changed" });
        turnsSinceOptimize += r.turnsInserted;
        scheduleMaintenance();
      }
      await enrich();
    } finally {
      ingestInFlight = false;
    }
  }

  function scheduleMaintenance(): void {
    if (cancelMaintenance || turnsSinceOptimize < OPTIMIZE_AFTER_TURNS) return;
    cancelMaintenance = timers.setTimeout(
      runMaintenance,
      IDLE_BEFORE_MAINTENANCE_MS,
    );
  }

  // optimize blocks this thread, so it waits until PR-link queries go quiet.
  function runMaintenance(): void {
    cancelMaintenance = null;
    if (closed) return;
    const quietFor = now() - lastQueryAt;
    if (quietFor < IDLE_BEFORE_MAINTENANCE_MS) {
      cancelMaintenance = timers.setTimeout(
        runMaintenance,
        IDLE_BEFORE_MAINTENANCE_MS - quietFor,
      );
      return;
    }
    try {
      db.optimizeFts();
      turnsSinceOptimize = 0;
    } catch (err) {
      log("fts optimize failed", err);
    }
  }

  return {
    start() {
      track(ingestThenEnrich);
      cancelEnrichTimer = timers.setInterval(
        () => track(enrich),
        ENRICH_INTERVAL_MS,
      );
    },
    handle(msg) {
      if (closed) return;
      switch (msg.type) {
        case "ingest":
          track(ingestThenEnrich);
          break;
        case "prsFor":
          lastQueryAt = now();
          try {
            post({
              type: "result",
              id: msg.id,
              ok: true,
              value: db.prsForSessions(root, msg.sids),
            });
          } catch (err) {
            log("prsFor failed", err);
            post({ type: "result", id: msg.id, ok: false });
          }
          break;
        case "shutdown":
          closed = true;
          cancelMaintenance?.();
          cancelEnrichTimer?.();
          db.close();
          post({ type: "shutdownAck" });
          break;
      }
    },
    async whenIdle() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
