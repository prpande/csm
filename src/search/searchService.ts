import { createEnricher, type RunBatch } from "./ghEnrich";
import { createIngester } from "./ingest";
import type { HostToWorker, WorkerToHost } from "./protocol";
import type { SearchDb } from "./searchDb";

export const ENRICH_INTERVAL_MS = 10 * 60_000;
export const IDLE_BEFORE_MAINTENANCE_MS = 2_000;
export const OPTIMIZE_AFTER_TURNS = 1_000;
export const MERGE_PAGES = 500;
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
  let coldBuild = !db.hasTurns();
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

  // A trigger that arrives mid-run is drained by the owner as one more round.
  let enrichInFlight = false;
  let enrichPending = false;
  let ingestInFlight = false;
  let ingestPending = false;

  async function enrich(): Promise<void> {
    if (enrichInFlight) {
      enrichPending = true;
      return;
    }
    enrichInFlight = true;
    try {
      do {
        enrichPending = false;
        const r = await enricher.runDue();
        if (r.failures > 0)
          log(`gh enrichment: ${r.failures} batch(es) failed`);
        if (!closed && r.wrote > 0) post({ type: "changed" });
      } while (enrichPending && !closed);
    } finally {
      enrichInFlight = false;
    }
  }

  async function ingestThenEnrich(): Promise<void> {
    if (ingestInFlight) {
      ingestPending = true;
      return;
    }
    ingestInFlight = true;
    try {
      do {
        ingestPending = false;
        const r = await ingester.runPass();
        if (closed) return;
        if (r.changed) {
          post({ type: "changed" });
          turnsSinceOptimize += r.turnsInserted;
          scheduleMaintenance();
        }
        await enrich();
      } while (ingestPending && !closed);
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

  // Index maintenance blocks this thread, so it waits until PR-link queries go quiet.
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
    const optimizing = coldBuild;
    try {
      if (optimizing) db.optimizeFts();
      else db.mergeFts(MERGE_PAGES);
      coldBuild = false;
      turnsSinceOptimize = 0;
    } catch (err) {
      log(optimizing ? "fts optimize failed" : "fts merge failed", err);
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
