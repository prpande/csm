import { parentPort, workerData } from "node:worker_threads";
import { ghEnv, runGhBatch } from "./ghClient";
import type { HostToWorker, WorkerInit, WorkerToHost } from "./protocol";
import { isBusyError, openSearchDbSafe } from "./searchDb";
import { createSearchService } from "./searchService";

const port = parentPort;
if (!port) throw new Error("searchWorker must run as a worker thread");
const init = workerData as WorkerInit;
const post = (msg: WorkerToHost): void => port.postMessage(msg);
const log = (msg: string, err?: unknown): void =>
  console.error(`[csm search] ${msg}`, err ?? "");

try {
  const { db, recovered } = openSearchDbSafe(init.dbDir, {
    platform: init.platform,
    now: Date.now(),
  });
  const ghPath = init.ghPath ?? undefined;
  const env = ghPath ? ghEnv(process.env, init.platform, ghPath) : process.env;
  const service = createSearchService({
    db,
    root: init.projectsRoot,
    post,
    now: Date.now,
    log,
    runBatch: (repo, numbers) => runGhBatch({ ghPath, env }, repo, numbers),
  });
  port.on("message", (msg: HostToWorker) => service.handle(msg));
  post({ type: "ready", ftsOk: db.ftsOk, recovered });
  service.start();
} catch (err) {
  log("could not open search.db", err);
  post({ type: "fatal", code: isBusyError(err) ? "OPEN_BUSY" : "OPEN_FAILED" });
  port.close();
}
