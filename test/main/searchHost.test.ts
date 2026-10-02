import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createSearchHost,
  REQUEST_TIMEOUT_MS,
  RESTART_DELAYS_MS,
  SHUTDOWN_ACK_MS,
  STABLE_AFTER_MS,
  type SearchEvent,
  type WorkerLike,
} from "../../src/searchHost";
import type { HostToWorker, WorkerToHost } from "../../src/search/protocol";

class FakeWorker implements WorkerLike {
  posted: HostToWorker[] = [];
  terminated = false;
  private listeners = new Map<string, ((arg: never) => void)[]>();

  postMessage(msg: HostToWorker): void {
    this.posted.push(msg);
  }
  on(
    event: "message" | "error" | "exit",
    listener: (arg: never) => void,
  ): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
  send(msg: WorkerToHost): void {
    this.fire("message", msg);
  }
  exit(code = 1): void {
    this.fire("exit", code);
  }
  private fire(event: string, arg: unknown): void {
    for (const l of this.listeners.get(event) ?? [])
      (l as (a: unknown) => void)(arg);
  }
}

const SID = "3b9f1c2a-1e2d-4a5b-8c7d-0f1e2d3c4b5a";
const READY: WorkerToHost = { type: "ready", ftsOk: true, recovered: false };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(createWorker?: () => WorkerLike) {
  const workers: FakeWorker[] = [];
  const events: SearchEvent[] = [];
  const log = vi.fn();
  const host = createSearchHost({
    createWorker:
      createWorker ??
      (() => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      }),
    emit: (e) => events.push(e),
    log,
  });
  return {
    host,
    workers,
    events,
    log,
    last: () => workers[workers.length - 1],
  };
}

describe("createSearchHost", () => {
  test("ready and each worker change emit a rising generation", () => {
    const { host, last, events } = setup();
    host.start();
    expect(host.state).toBe("starting");
    last().send(READY);
    last().send({ type: "changed" });
    expect(host.state).toBe("running");
    expect(events).toEqual([
      { type: "changed", generation: 1 },
      { type: "changed", generation: 2 },
    ]);
  });

  test("start is idempotent", () => {
    const { host, workers } = setup();
    host.start();
    host.start();
    expect(workers).toHaveLength(1);
  });

  test("progress is forwarded", () => {
    const { host, last, events } = setup();
    host.start();
    last().send({ type: "progress", done: 3, total: 9 });
    expect(events).toEqual([{ type: "progress", done: 3, total: 9 }]);
  });

  test("prsFor resolves {} without a worker or without ids", async () => {
    const { host, workers } = setup();
    await expect(host.prsFor([SID])).resolves.toEqual({});
    host.start();
    await expect(host.prsFor([])).resolves.toEqual({});
    expect(workers[0].posted).toEqual([]);
  });

  test("prsFor relays a request and resolves with its reply", async () => {
    const { host, last } = setup();
    host.start();
    const a = host.prsFor([SID]);
    const b = host.prsFor([SID]);
    expect(last().posted).toEqual([
      { type: "prsFor", id: 1, sids: [SID] },
      { type: "prsFor", id: 2, sids: [SID] },
    ]);
    last().send({ type: "result", id: 1, ok: true, value: { [SID]: [] } });
    last().send({ type: "result", id: 2, ok: false });
    await expect(a).resolves.toEqual({ [SID]: [] });
    await expect(b).resolves.toEqual({});
  });

  test("an unanswered prsFor resolves {} after the timeout", async () => {
    const { host } = setup();
    host.start();
    const p = host.prsFor([SID]);
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await expect(p).resolves.toEqual({});
  });

  test("requestIngest posts an ingest once a worker exists", () => {
    const { host, last } = setup();
    host.requestIngest();
    host.start();
    host.requestIngest();
    expect(last().posted).toEqual([{ type: "ingest" }]);
  });

  test("a crash settles pending requests and restarts with backoff, then gives up", async () => {
    const { host, workers, last, log } = setup();
    host.start();
    const p = host.prsFor([SID]);
    last().exit(1);
    await expect(p).resolves.toEqual({});
    for (const [i, delay] of RESTART_DELAYS_MS.entries()) {
      vi.advanceTimersByTime(delay - 1);
      expect(workers).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(workers).toHaveLength(i + 2);
      last().exit(1);
    }
    expect(host.state).toBe("failed");
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    expect(workers).toHaveLength(RESTART_DELAYS_MS.length + 1);
    expect(log).toHaveBeenCalled();
  });

  test("a worker that stays up for a minute resets the backoff", () => {
    const { host, workers, last } = setup();
    host.start();
    last().exit(1);
    vi.advanceTimersByTime(RESTART_DELAYS_MS[0]);
    last().send(READY);
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    last().exit(1);
    vi.advanceTimersByTime(RESTART_DELAYS_MS[0]);
    expect(workers).toHaveLength(3);
  });

  test("a worker that cannot be created counts as a crash", () => {
    let calls = 0;
    const workers: FakeWorker[] = [];
    const { host, log } = setup(() => {
      if (calls++ === 0) throw new Error("bad path");
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    host.start();
    expect(log).toHaveBeenCalled();
    vi.advanceTimersByTime(RESTART_DELAYS_MS[0]);
    expect(workers).toHaveLength(1);
  });

  test("an open failure stops the host without restarting", () => {
    const { host, workers, last } = setup();
    host.start();
    last().send({ type: "fatal", code: "OPEN_FAILED" });
    last().exit(1);
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    expect(workers).toHaveLength(1);
    expect(host.state).toBe("failed");
  });

  test("stop waits for the ack, terminates, and never restarts", async () => {
    const { host, workers, last } = setup();
    host.start();
    last().send(READY);
    const stopping = host.stop();
    expect(last().posted.at(-1)).toEqual({ type: "shutdown" });
    last().send({ type: "shutdownAck" });
    await stopping;
    expect(last().terminated).toBe(true);
    expect(host.state).toBe("stopped");
    last().exit(0);
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    expect(workers).toHaveLength(1);
  });

  test("stop gives up waiting for the ack after 2 s", async () => {
    const { host, last } = setup();
    host.start();
    const stopping = host.stop();
    vi.advanceTimersByTime(SHUTDOWN_ACK_MS);
    await stopping;
    expect(last().terminated).toBe(true);
  });

  test("a fatal worker is terminated and no longer used", async () => {
    const { host, workers, last } = setup();
    host.start();
    const pending = host.prsFor([SID]);
    const w = last();
    w.send({ type: "fatal", code: "OPEN_FAILED" });
    await expect(pending).resolves.toEqual({});
    expect(w.terminated).toBe(true);
    const posted = w.posted.length;
    await expect(host.prsFor([SID])).resolves.toEqual({});
    host.requestIngest();
    expect(w.posted).toHaveLength(posted);
    w.exit(1);
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    expect(workers).toHaveLength(1);
    expect(host.state).toBe("failed");
  });

  test("a worker exit while stop waits for the ack ends the wait at once", async () => {
    const { host, last } = setup();
    host.start();
    const stopping = host.stop();
    last().exit(0);
    await stopping;
    expect(host.state).toBe("stopped");
    expect(last().terminated).toBe(true);
  });

  test("messages and exits from a replaced worker are ignored", () => {
    const { host, workers, last, events } = setup();
    host.start();
    const old = last();
    old.exit(1);
    vi.advanceTimersByTime(RESTART_DELAYS_MS[0]);
    expect(workers).toHaveLength(2);
    old.send({ type: "changed" });
    old.exit(1);
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    expect(events).toEqual([]);
    expect(workers).toHaveLength(2);
  });

  test("stop during a pending restart creates no new worker", async () => {
    const { host, workers, last } = setup();
    host.start();
    last().exit(1);
    await host.stop();
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    expect(workers).toHaveLength(1);
    expect(host.state).toBe("stopped");
  });

  test("stop settles a pending prsFor with {}", async () => {
    const { host, last } = setup();
    host.start();
    const p = host.prsFor([SID]);
    const stopping = host.stop();
    last().send({ type: "shutdownAck" });
    await stopping;
    await expect(p).resolves.toEqual({});
  });

  test("a reply clears the request timeout", () => {
    const { host, last } = setup();
    host.start();
    void host.prsFor([SID]);
    expect(vi.getTimerCount()).toBe(1);
    last().send({ type: "result", id: 1, ok: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a second ready replaces the stable timer", () => {
    const { host, last } = setup();
    host.start();
    last().send(READY);
    last().send(READY);
    expect(vi.getTimerCount()).toBe(1);
  });
});
