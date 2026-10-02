import type { SessionPrsResult } from "./ipcTypes";
import type { HostToWorker, WorkerToHost } from "./search/protocol";

export interface WorkerLike {
  postMessage(msg: HostToWorker): void;
  on(event: "message", listener: (msg: WorkerToHost) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export type SearchEvent =
  | { type: "changed"; generation: number }
  | { type: "progress"; done: number; total: number };

export type SearchHostState = "stopped" | "starting" | "running" | "failed";

export const RESTART_DELAYS_MS = [1_000, 5_000, 30_000];
export const STABLE_AFTER_MS = 60_000;
export const SHUTDOWN_ACK_MS = 2_000;
export const REQUEST_TIMEOUT_MS = 10_000;

export interface SearchHostDeps {
  createWorker: () => WorkerLike;
  emit: (e: SearchEvent) => void;
  log: (msg: string, err?: unknown) => void;
}

export interface SearchHost {
  readonly state: SearchHostState;
  start(): void;
  requestIngest(): void;
  prsFor(sids: string[]): Promise<SessionPrsResult>;
  stop(): Promise<void>;
}

type Timer = ReturnType<typeof setTimeout>;

export function createSearchHost(deps: SearchHostDeps): SearchHost {
  let state: SearchHostState = "stopped";
  let started = false;
  let stopping = false;
  let worker: WorkerLike | null = null;
  let generation = 0;
  let nextId = 1;
  let crashes = 0;
  let stableTimer: Timer | undefined;
  let restartTimer: Timer | undefined;
  let onAck: (() => void) | undefined;
  const pending = new Map<
    number,
    { resolve: (v: SessionPrsResult) => void; timer: Timer }
  >();

  function settle(id: number, value: SessionPrsResult): void {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(value);
  }

  function settleAll(): void {
    for (const id of [...pending.keys()]) settle(id, {});
  }

  function onMessage(msg: WorkerToHost): void {
    switch (msg.type) {
      case "ready":
        state = "running";
        if (msg.recovered)
          deps.log("search.db was corrupt and has been rebuilt");
        if (!msg.ftsOk)
          deps.log("FTS5 is unavailable; full-text search is off");
        stableTimer = setTimeout(() => {
          crashes = 0;
        }, STABLE_AFTER_MS);
        // A warm start may change nothing, so ready alone must refresh the renderer.
        deps.emit({ type: "changed", generation: ++generation });
        break;
      case "changed":
        deps.emit({ type: "changed", generation: ++generation });
        break;
      case "progress":
        deps.emit({ type: "progress", done: msg.done, total: msg.total });
        break;
      case "result":
        settle(msg.id, msg.ok ? msg.value : {});
        break;
      case "shutdownAck":
        onAck?.();
        break;
      case "fatal":
        state = "failed";
        deps.log(`search worker failed: ${msg.code}`);
        break;
    }
  }

  function onExit(code: number | string): void {
    worker = null;
    clearTimeout(stableTimer);
    settleAll();
    if (stopping || state === "failed") return;
    if (crashes >= RESTART_DELAYS_MS.length) {
      state = "failed";
      deps.log(`search worker exited (${code}); not restarting`);
      return;
    }
    const delay = RESTART_DELAYS_MS[crashes++];
    state = "starting";
    deps.log(`search worker exited (${code}); restarting in ${delay} ms`);
    restartTimer = setTimeout(spawn, delay);
  }

  function spawn(): void {
    restartTimer = undefined;
    if (stopping) return;
    state = "starting";
    let w: WorkerLike;
    try {
      w = deps.createWorker();
    } catch (err) {
      deps.log("search worker could not start", err);
      onExit("spawn");
      return;
    }
    worker = w;
    w.on("message", (msg) => {
      if (worker === w) onMessage(msg);
    });
    w.on("error", (err) => deps.log("search worker error", err));
    w.on("exit", (code) => {
      if (worker === w) onExit(code);
    });
  }

  return {
    get state() {
      return state;
    },
    start() {
      if (started) return;
      started = true;
      spawn();
    },
    requestIngest() {
      worker?.postMessage({ type: "ingest" });
    },
    prsFor(sids) {
      const w = worker;
      if (!w || sids.length === 0) return Promise.resolve({});
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, {}), REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        w.postMessage({ type: "prsFor", id, sids });
      });
    },
    async stop() {
      stopping = true;
      clearTimeout(restartTimer);
      clearTimeout(stableTimer);
      const w = worker;
      if (w) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, SHUTDOWN_ACK_MS);
          onAck = () => {
            clearTimeout(t);
            resolve();
          };
          w.postMessage({ type: "shutdown" });
        });
        onAck = undefined;
        worker = null;
        settleAll();
        await w.terminate().catch(() => 0);
      }
      state = "stopped";
    },
  };
}
